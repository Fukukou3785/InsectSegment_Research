# -*- coding: utf-8 -*-
import uvicorn
from fastapi import FastAPI, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import base64
import io
import tempfile
from pathlib import Path
import shutil
import json
from typing import Dict, Tuple, List, Union
import numpy as np
from PIL import Image
from datetime import datetime
# ★重要: 線引きロジック用のライブラリ
from scipy.ndimage import label, find_objects, binary_dilation

# --- maphis関連 ---
import maphis
from maphis.common.label_hierarchy import LabelHierarchy
from maphis.common.label_image import LabelImg, LabelImgInfo
from maphis.common.local_storage import LocalStorage
from maphis.plugins.pekar.regions.segmentation import UNetRegions

# --- SAM関連 ---
import torch
import cv2
from segment_anything import sam_model_registry, SamPredictor

# === 1. アプリとモデルのグローバル初期化 ===
app = FastAPI()

origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://10.124.66.6:3000"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- AIモデルのロード設定 ---
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Using device: {device}")

# A. MAPHISモデル
print("Loading UNetRegions model...")
comp = UNetRegions()
ok, msg = comp.initialize()
if not ok:
    print(f"FATAL: Failed to initialize UNetRegions: {msg}")
print("MAPHIS loaded.")

# B. SAMモデル
SAM_CHECKPOINT = "sam_vit_b_01ec64.pth"  
SAM_MODEL_TYPE = "vit_b"

print("Loading SAM model...")
try:
    sam = sam_model_registry[SAM_MODEL_TYPE](checkpoint=SAM_CHECKPOINT)
    sam.to(device=device)
    predictor = SamPredictor(sam)
    print("SAM loaded successfully.")
except Exception as e:
    print(f"WARNING: Failed to load SAM ({e}). SAM features will not work.")
    predictor = None

# --- グローバル状態管理 ---
class AppState:
    def __init__(self):
        self.image_np = None # オリジナル画像(OpenCV形式)
        self.id_mask = None  # 現在のセグメンテーションIDマップ
        self.lh = None       # ラベル階層情報
        self.has_sam_embedding = False # SAMにセット済みか

state = AppState()

# === 2. 型定義 ===
class SegmentRequest(BaseModel):
    image_base64: str

class SegmentResponse(BaseModel):
    segmented_image_base64: str
    thorax_top: float    # 比率(0.0~1.0)
    thorax_bottom: float # 比率(0.0~1.0)

class LogData(BaseModel):
    original_base64: str
    ai_mask_base64: str
    user_mask_base64: str
    thorax_top: float
    thorax_bottom: float

# === 3. ヘルパー関数群 ===
PALETTE = { "head": (31,119,180), "thorax": (44,160,44), "abdomen": (214,39,40), "appendages": (148,103,189) }

def reconstruct_id_mask_from_image(mask_b64: str) -> np.ndarray:
    if "," in mask_b64: _, b64_data = mask_b64.split(",", 1)
    else: b64_data = mask_b64
    img_data = base64.b64decode(b64_data)
    img = Image.open(io.BytesIO(img_data)).convert("RGBA")
    
    arr = np.array(img)
    h, w = arr.shape[:2]
    
    # 色定義
    colors = [
        [0, 0, 0],       # 0: 背景
        [31, 119, 180],  # 1: head
        [44, 160, 44],   # 2: thorax
        [214, 39, 40],   # 3: abdomen
        [148, 103, 189], # 4: legs
        [200, 200, 200]  # 5: その他(gray)
    ]
    
    alpha = arr[:, :, 3]
    rgb = arr[:, :, :3]
    
    id_mask = np.zeros((h, w), dtype=np.uint32)
    
    valid_mask = alpha > 128
    
    if np.any(valid_mask):
        valid_rgb = rgb[valid_mask]
        colors_np = np.array(colors)
        distances = np.linalg.norm(valid_rgb[:, None] - colors_np[None, :], axis=2)
        closest_ids = np.argmin(distances, axis=1)
        
        id_mask[valid_mask] = closest_ids.astype(np.uint32)

    return id_mask

def resize_image_matching_frontend(image_pil: Image.Image, max_size=800) -> Image.Image:
    w, h = image_pil.size
    if w > h:
        if w > max_size:
            h = int(h * (max_size / w) + 0.5)
            w = max_size
    else:
        if h > max_size:
            w = int(w * (max_size / h) + 0.5)
            h = max_size
    return image_pil.resize((w, h), Image.Resampling.LANCZOS)

def _pkg_root() -> Path:
    return Path(maphis.__file__).parent

def _copy_if_available(dst_dir: Path, filename: str, *aliases: str):
    pt = _pkg_root() / "plugins" / "maphis" / "project_types"
    for fn in (filename, *aliases):
        src = pt / fn
        if src.exists():
            out = dst_dir / fn
            if not out.exists():
                shutil.copy2(src, out)
            return

def _ensure_project_defs(project_dir: Path):
    project_dir.mkdir(parents=True, exist_ok=True)
    _copy_if_available(project_dir, "arthropods_project_info.json")
    _copy_if_available(project_dir, "arthropods_label_hierarchy.json")
    _copy_if_available(project_dir,
        "arthropods_reflections_hierarchy.json", "arthropods_reflection_hierarchy.json", "reflections_hierarchy.json")

def _ensure_photo_info_with_labels(project_dir: Path, img_name: str, label_names: list[str]):
    jf = project_dir / "photo_info.json"
    try:
        data = json.loads(jf.read_text(encoding="utf-8"))
        if not isinstance(data, dict): data = {}
    except Exception: data = {}
    d = data.setdefault(img_name, {})
    d.setdefault("tags", [])
    li = d.setdefault("label_images_info", {})
    for ln in label_names:
        li.setdefault(ln, {}).setdefault("approved", True)
    d.setdefault("scale_info", {"unit":"px", "pixels_per_unit":1.0})
    jf.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def _load_label_images_info(project_dir: Path) -> Dict[str, LabelImgInfo]:
    pinfo = json.loads((project_dir / "arthropods_project_info.json").read_text(encoding="utf-8"))
    infos: Dict[str, LabelImgInfo] = {}
    li_info = pinfo.get("label_images_info", {})
    if isinstance(li_info, dict) and "label_images" in li_info:
        for it in li_info["label_images"]:
            li = LabelImgInfo.from_dict(it)
            lh_path = project_dir / it["label_hierarchy_file"]
            if not lh_path.exists():
                fb = _pkg_root() / "plugins" / "maphis" / "project_types" / it["label_hierarchy_file"]
                shutil.copy2(fb, lh_path)
            li.label_hierarchy = LabelHierarchy.load_from(lh_path)
            infos[it["name"]] = li
    else:
        lh_file = li_info.get("label_hierarchy_file", "arthropods_label_hierarchy.json")
        lh_path = project_dir / lh_file
        if not lh_path.exists():
            fb = _pkg_root() / "plugins" / "maphis" / "project_types" / lh_file
            shutil.copy2(fb, lh_path)
        lh = LabelHierarchy.load_from(lh_path)
        infos["Labels"] = LabelImgInfo(name="Labels", label_hierarchy=lh)
    return infos

def _build_storage(project_dir: Path, image_path: Path):
    _ensure_project_defs(project_dir)
    images_dir = project_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    img_abs = image_path.resolve()
    img_name = img_abs.name
    if not (images_dir / img_name).exists():
        shutil.copy2(img_abs, images_dir / img_name)

    infos = _load_label_images_info(project_dir)
    _ensure_photo_info_with_labels(project_dir, img_name, list(infos.keys()))
    storage = LocalStorage.load_from(project_dir, label_images_info=infos)

    photo = None
    for i in range(100): 
        try: p = storage.get_photo_by_idx(i)
        except Exception: break
        cand = Path(getattr(p, "_image_path", getattr(p, "image_path", "")) or "")
        if cand and cand.resolve().name == img_name:
            photo = p; break
    
    if photo is None:
        try: photo = storage.get_photo_by_idx(0)
        except: pass
        
    if photo is None: raise RuntimeError(f"プロジェクト内で画像が見つかりません: {img_name}")

    lh = infos["Labels"].label_hierarchy if "Labels" in infos else next(iter(infos.values())).label_hierarchy
    return storage, photo, lh

def _safe_id2name(lh) -> Dict[int, str]:
    id2name: Dict[int, str] = {}
    nodes_dict = getattr(lh, "nodes_dict", None)
    if isinstance(nodes_dict, dict) and nodes_dict:
        for node in nodes_dict.values():
            try: id2name[int(node.label)] = str(node.name)
            except Exception: pass
    if not id2name:
        for lab in range(1, 6000):
            try: node = lh[lab]; id2name[int(lab)] = str(node.name)
            except Exception: continue
    return id2name

def _id_to_color_map(id_mask: np.ndarray, lh) -> Dict[int, Tuple[int,int,int]]:
    id2name = _safe_id2name(lh)
    cmap: Dict[int, Tuple[int,int,int]] = {}
    
    for lab in np.unique(id_mask):
        lab = int(lab)
        if lab in (0, 65535, 0xFFFFFFFF): continue
        
        if lab == 1:
            cmap[lab] = PALETTE["head"]
            continue
        if lab == 2:
            cmap[lab] = PALETTE["thorax"]
            continue
        if lab == 3:
            cmap[lab] = PALETTE["abdomen"]
            continue
        if lab == 4:
            cmap[lab] = PALETTE["appendages"]
            continue

        n = id2name.get(lab, "").lower()
        if "head" in n:        cmap[lab] = PALETTE["head"]
        elif "thorax" in n:    cmap[lab] = PALETTE["thorax"]
        elif "abdomen" in n:   cmap[lab] = PALETTE["abdomen"]
        elif ("leg" in n) or ("append" in n) or ("a1" in n) or ("a2" in n) or ("a3" in n):
            cmap[lab] = PALETTE["appendages"]
        else:                  cmap[lab] = (200,200,200)
        
    return cmap

def _create_transparent_mask(image_shape: Tuple[int, int], id_mask: np.ndarray, cmap: Dict[int, Tuple[int,int,int]]) -> Image.Image:
    height, width = image_shape[:2]
    out_rgba = np.zeros((height, width, 4), dtype=np.uint8)
    
    for lab, color in cmap.items():
        m = (id_mask == lab)
        if not m.any(): continue
        out_rgba[m, :3] = color 
        out_rgba[m, 3] = 255
        
    return Image.fromarray(out_rgba, 'RGBA')

# ★修正: 境界線ロジック（後ろ足基準の完全版）
def detect_thorax_band(id_mask: np.ndarray, lh: LabelHierarchy) -> Tuple[float, float]:
    H, W = id_mask.shape[:2]
    
    # マスクの抽出
    mask_head = (id_mask == 1)
    mask_thorax = (id_mask == 2)
    mask_abdomen = (id_mask == 3)
    mask_legs = (id_mask == 4)

    # ==================================================
    # 1. 「首のライン」 (Head / Thorax)
    #    ここは従来のロジック（緑の開始点 or 青の終了点）で安定しているのでそのまま
    # ==================================================
    y_neck = int(H * 0.33) # デフォルト
    ys_thorax = np.where(mask_thorax)[0]
    ys_head = np.where(mask_head)[0]

    if len(ys_thorax) > 10:
        y_neck = int(np.percentile(ys_thorax, 1))
    elif len(ys_head) > 10:
        y_neck = int(np.percentile(ys_head, 99))
    
    # ==================================================
    # 2. 「腰のライン」 (Thorax / Abdomen)
    #    ★ここをご提案の「後ろ足基準」ロジックに変更
    # ==================================================
    y_waist = int(H * 0.66) # デフォルト
    found_waist_by_legs = False
    
    # (1) 足の連結成分（塊）を見つける
    labeled_legs, num_features = label(mask_legs)
    
    if num_features > 0:
        objects = find_objects(labeled_legs)
        leg_centroids = []
        
        # 各足の「中心Y座標」を計算してリスト化
        for idx, slice_tuple in enumerate(objects):
            if slice_tuple is None: continue
            # slice_tuple = (slice(y_start, y_end), slice(x_start, x_end))
            cy = (slice_tuple[0].start + slice_tuple[0].stop) / 2
            # ノイズ（小さすぎるゴミ）は除外
            height = slice_tuple[0].stop - slice_tuple[0].start
            if height < H * 0.02: continue 
            leg_centroids.append((cy, idx + 1)) # (Y座標, ラベルID)
        
        # Y座標が大きい順（下にある順）にソートして、下位2つ（後ろ足）を取得
        leg_centroids.sort(key=lambda x: x[0], reverse=True)
        hind_legs_indices = [x[1] for x in leg_centroids[:2]] # 最大2本
        
        if len(hind_legs_indices) > 0:
            # 後ろ足だけのマスクを作成
            mask_hind_legs = np.isin(labeled_legs, hind_legs_indices)
            
            # (2) 足を少し膨張させて、体との接触判定をしやすくする
            #     (構造化要素 structure=None で 3x3 の十字型)
            dilated_legs = binary_dilation(mask_hind_legs, iterations=3)
            
            # (3) 接触判定と優先順位
            #     ご提案: 「緑優先、なければ赤」
            
            # 緑(むね)との重なり
            intersect_green = dilated_legs & mask_thorax
            # 赤(おなか)との重なり
            intersect_red = dilated_legs & mask_abdomen
            
            target_intersection = None
            debug_reason = ""

            if np.any(intersect_green):
                # 緑色に触れている -> 緑優先
                target_intersection = intersect_green
                debug_reason = "Hind Legs touching Green(Thorax)"
            elif np.any(intersect_red):
                # 緑なし、赤に触れている -> 赤採用
                target_intersection = intersect_red
                debug_reason = "Hind Legs touching Red(Abdomen)"
            
            if target_intersection is not None:
                # 重なっている領域の「一番下 (max Y)」を境界線とする
                ys_intersect = np.where(target_intersection)[0]
                y_waist = int(np.max(ys_intersect))
                found_waist_by_legs = True
                print(f"  [Logic] Waist determined by LEGS: {debug_reason} at Y={y_waist}")

    # ==================================================
    # 3. フォールバック (足で見つからなかった場合の保険)
    #    従来の「色の変わり目」ロジックを使う
    # ==================================================
    if not found_waist_by_legs:
        print("  [Logic] Legs not valid, fallback to Color Boundary.")
        ys_abdomen = np.where(mask_abdomen)[0]
        if len(ys_abdomen) > 10:
            y_waist = int(np.percentile(ys_abdomen, 1))
        elif len(ys_thorax) > 10:
            y_waist = int(np.percentile(ys_thorax, 99))

    # ==================================================
    # 4. 安全装置と補正
    # ==================================================
    # 画面外補正
    y_neck = max(0, min(H-1, y_neck))
    y_waist = max(0, min(H-1, y_waist))
    
    # 順序補正 (首より腰が上にある場合など)
    margin = int(H * 0.05)
    if y_waist <= y_neck + margin:
        if len(ys_thorax) > 10:
            center = int(np.mean(ys_thorax))
            y_neck = max(0, center - margin)
            y_waist = min(H-1, center + margin)
        else:
            y_neck = int(H * 0.33)
            y_waist = int(H * 0.66)

    # デバッグ画像保存
    try:
        debug_img = np.zeros((H, W, 3), dtype=np.uint8)
        debug_img[mask_head] = [255, 0, 0]
        debug_img[mask_thorax] = [0, 255, 0]
        debug_img[mask_abdomen] = [0, 0, 255]
        debug_img[mask_legs] = [255, 0, 255]
        # 後ろ足として判定された部分を白く塗ってみる(デバッグ用)
        cv2.line(debug_img, (0, y_neck), (W, y_neck), (255, 255, 255), 2)
        cv2.line(debug_img, (0, y_waist), (W, y_waist), (255, 255, 255), 2)
        cv2.imwrite("debug_segmentation.png", debug_img)
    except Exception as e:
        print(f"Debug save failed: {e}")

    # 比率で返す
    return float(y_neck) / H, float(y_waist) / H

def _generate_response_from_state():
    """現在のstate.id_maskから画像を生成して返す"""
    cmap = _id_to_color_map(state.id_mask, state.lh)
    mask_image_pil = _create_transparent_mask(state.image_np.shape, state.id_mask, cmap)
    
    buffered = io.BytesIO()
    mask_image_pil.save(buffered, format="PNG") 
    segmented_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
    
    return f"data:image/png;base64,{segmented_b64}"

# === 4. APIエンドポイント ===

@app.post("/api/segment", response_model=SegmentResponse)
async def segment_image(request: SegmentRequest):
    torch.cuda.empty_cache()
    
    with tempfile.TemporaryDirectory() as temp_dir_str:
        try:
            temp_dir = Path(temp_dir_str)
            print("--- Processing new image ---")
            
            if "," in request.image_base64:
                header, b64_data = request.image_base64.split(",", 1)
            else:
                b64_data = request.image_base64
            image_data = base64.b64decode(b64_data)
            original_image_pil = Image.open(io.BytesIO(image_data)).convert("RGB")
            
            # リサイズ
            resized_image_pil = resize_image_matching_frontend(original_image_pil, max_size=800)
            original_image_np = np.array(resized_image_pil)

            # MAPHIS推論準備
            images_subdir = temp_dir / "images"
            images_subdir.mkdir(parents=True, exist_ok=True)
            image_path = images_subdir / "input_image.png"
            resized_image_pil.save(image_path)
            
            storage, photo, lh = _build_storage(temp_dir, image_path)
            
            # MAPHIS推論
            print("Running MAPHIS...")
            res = comp(photo)
            
            id_full = None
            if isinstance(res, LabelImg): id_full = res.label_image
            elif isinstance(res, dict): id_full = next(iter(res.values())).label_image
            elif isinstance(res, (list, tuple, set)): id_full = list(res)[0].label_image
            
            if id_full is None: raise RuntimeError("Segmentation failed.")

            id_mask = id_full.astype(np.uint32)

            # SAMセットアップ
            if predictor is not None:
                print("Setting image to SAM...")
                predictor.set_image(original_image_np)
                state.has_sam_embedding = True
                print("SAM embedding calculated.")
            
            state.image_np = original_image_np
            state.id_mask = id_mask
            state.lh = lh
            
            # 帯検出（新ロジック）
            thorax_top, thorax_bottom = detect_thorax_band(id_mask, lh)
            
            segmented_b64 = _generate_response_from_state()
            
            return SegmentResponse(
                segmented_image_base64=segmented_b64,
                thorax_top=thorax_top,
                thorax_bottom=thorax_bottom
            )

        except Exception as e:
            print(f"Error: {e}")
            import traceback
            traceback.print_exc()
            return JSONResponse(status_code=500, content={"detail": str(e)})

@app.post("/api/refine")
async def refine_segmentation(
    x: int = Form(...),
    y: int = Form(...),
    label_part: str = Form(...) ,
    current_mask: str = Form(...) 
):
    if not state.has_sam_embedding or predictor is None:
        return JSONResponse(status_code=400, content={"detail": "Image not loaded in SAM."})

    try:
        print(f"SAM Refine Click: ({x}, {y}) -> {label_part}")

        new_id_mask = reconstruct_id_mask_from_image(current_mask)
        h_mask, w_mask = new_id_mask.shape[:2]
        
        if state.image_np is not None:
             h_img, w_img = state.image_np.shape[:2]
             if (h_img != h_mask) or (w_img != w_mask):
                 print(f"DEBUG: Resizing Backend State to match Frontend...")
                 img_pil = Image.fromarray(state.image_np)
                 img_pil = img_pil.resize((w_mask, h_mask), Image.Resampling.LANCZOS)
                 state.image_np = np.array(img_pil)
                 predictor.set_image(state.image_np)
        
        state.id_mask = new_id_mask
        
        target_id = 0
        if label_part == "head": target_id = 1
        elif label_part == "thorax": target_id = 2
        elif label_part == "abdomen": target_id = 3
        elif label_part == "legs": target_id = 4
        
        masks, _, _ = predictor.predict(
            point_coords=np.array([[x, y]]),
            point_labels=np.array([1]),
            multimask_output=False 
        )
        sam_mask = masks[0]
        
        if target_id > 0:
            state.id_mask[sam_mask == True] = target_id
            
        segmented_b64 = _generate_response_from_state()

        # 帯検出再計算（新ロジック）
        new_thorax_top, new_thorax_bottom = detect_thorax_band(state.id_mask, state.lh)
        
        return {
            "segmented_image_base64": segmented_b64,
            "thorax_top": new_thorax_top,
            "thorax_bottom": new_thorax_bottom
        }

    except Exception as e:
        print(f"Refine Error: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"detail": str(e)})


@app.post("/api/save_log")
async def save_log(data: LogData):
    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_dir = Path("logs") / timestamp
        log_dir.mkdir(parents=True, exist_ok=True)

        print(f"=== [LOG SAVED] Location: {log_dir.resolve()} ===")
        
        def save_b64_image(b64_str: str, filename: str):
            if "," in b64_str: _, b64_data = b64_str.split(",", 1)
            else: b64_data = b64_str
            img_data = base64.b64decode(b64_data)
            img = Image.open(io.BytesIO(img_data))
            img.save(log_dir / filename)

        save_b64_image(data.original_base64, "original.png")
        save_b64_image(data.ai_mask_base64, "mask_ai.png")
        save_b64_image(data.user_mask_base64, "mask_user.png")

        meta_info = {
            "timestamp": timestamp,
            "thorax_top": data.thorax_top,
            "thorax_bottom": data.thorax_bottom
        }
        with open(log_dir / "data.json", "w", encoding="utf-8") as f:
            json.dump(meta_info, f, indent=4)

        return {"status": "success", "path": str(log_dir)}
    except Exception as e:
        print(f"Error saving log: {e}")
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.post("/api/recalc_lines")
async def recalculate_lines(current_mask: str = Form(...)):
    # ステートが空ならエラー
    if state.image_np is None:
        return JSONResponse(status_code=400, content={"detail": "No image loaded."})

    try:
        # 1. フロントエンドから送られてきたマスク画像を復元
        new_id_mask = reconstruct_id_mask_from_image(current_mask)
        
        # 2. 念のためバックエンドの画像サイズと合わせる（リサイズ処理）
        h_mask, w_mask = new_id_mask.shape[:2]
        h_img, w_img = state.image_np.shape[:2]
        
        # サイズがずれていたらバックエンドの画像をリサイズして合わせる（安全策）
        if (h_img != h_mask) or (w_img != w_mask):
             img_pil = Image.fromarray(state.image_np)
             img_pil = img_pil.resize((w_mask, h_mask), Image.Resampling.LANCZOS)
             state.image_np = np.array(img_pil)
             if predictor is not None:
                 predictor.set_image(state.image_np)

        # 3. サーバーのステート（現在のマスク）を更新
        # これをしておかないと、次にSAMを使った時にブラシの修正が消えてしまいます
        state.id_mask = new_id_mask

        # 4. 線引きロジック（後ろ足ロジック）を実行
        new_thorax_top, new_thorax_bottom = detect_thorax_band(state.id_mask, state.lh)

        return {
            "thorax_top": new_thorax_top,
            "thorax_bottom": new_thorax_bottom
        }

    except Exception as e:
        print(f"Recalc Error: {e}")
        return JSONResponse(status_code=500, content={"detail": str(e)})

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)