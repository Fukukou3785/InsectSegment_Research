# -*- coding: utf-8 -*-
import uvicorn
from fastapi import FastAPI
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

# ラベリングとスライス取得、膨張
from scipy.ndimage import label, find_objects, binary_dilation

# --- maphis関連のインポート ---
import maphis
from maphis.common.label_hierarchy import LabelHierarchy
from maphis.common.label_image import LabelImg, LabelImgInfo
from maphis.common.local_storage import LocalStorage
from maphis.plugins.pekar.regions.segmentation import UNetRegions

# === 1. アプリとモデルのグローバル初期化 ===
app = FastAPI()

# CORS設定
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

# モデルのロード
print("Loading UNetRegions model...")
comp = UNetRegions()
ok, msg = comp.initialize()
if not ok:
    print(f"FATAL: Failed to initialize UNetRegions: {msg}")
print("Model loaded successfully.")

# === 2. 型定義 ===
class SegmentRequest(BaseModel):
    image_base64: str

class SegmentResponse(BaseModel):
    segmented_image_base64: str
    thorax_top: int
    thorax_bottom: int

# === 3. ヘルパー関数群 ===

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

PALETTE = { "head": (31,119,180), "thorax": (44,160,44), "abdomen": (214,39,40), "appendages": (148,103,189) }

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

# === ★最終最強版: 脚の先端判定＋体幹交差判定 ===
def detect_thorax_band(id_mask: np.ndarray, lh: LabelHierarchy) -> Tuple[int, int]:
    H, W = id_mask.shape[:2]
    id2name = _safe_id2name(lh)

    head_ids, thorax_ids, abdomen_ids, leg_ids = set(), set(), set(), set()
    for lab in np.unique(id_mask):
        lab = int(lab)
        if lab in (0, 65535, 0xFFFFFFFF): continue
        n = id2name.get(lab, "").lower()
        if "head" in n: head_ids.add(lab)
        elif "thorax" in n: thorax_ids.add(lab)
        elif "abdomen" in n: abdomen_ids.add(lab)
        elif ("leg" in n) or ("append" in n) or ("a1" in n) or ("a2" in n) or ("a3" in n):
            leg_ids.add(lab)

    mask_head = np.isin(id_mask, list(head_ids))
    mask_thorax = np.isin(id_mask, list(thorax_ids))
    mask_abdomen = np.isin(id_mask, list(abdomen_ids))
    mask_legs = np.isin(id_mask, list(leg_ids))
    
    # 1. 上の線 (頭と胸の境界)
    y_top = int(H * 0.35)
    ys_head = np.where(mask_head)[0]
    ys_thorax = np.where(mask_thorax)[0]
    if ys_head.size > 0 and ys_thorax.size > 0:
        y_top = int((ys_head.max() + ys_thorax.min()) / 2)
    elif ys_head.size > 0:
        y_top = int(ys_head.max())
    elif ys_thorax.size > 0:
        y_top = int(ys_thorax.min())

    # 2. 下の線 (脚の付け根の下端)
    y_bot = int(H * 0.65) # デフォルト

    # 脚をラベリング (侵食はしない！)
    labeled_legs, num_legs = label(mask_legs)
    
    leg_candidates = []
    
    if num_legs > 0:
        slices = find_objects(labeled_legs)
        
        for i, sl in enumerate(slices):
            if sl is None: continue
            
            # 「つま先」の位置 (Y座標最大値)
            tip_y = sl[0].stop
            
            # 小さすぎるノイズは除外
            height = sl[0].stop - sl[0].start
            if height < 10: continue
            
            leg_candidates.append({
                "id": i + 1,
                "tip_y": tip_y,
                "mask": (labeled_legs == i + 1)
            })
        
        if len(leg_candidates) > 0:
            # つま先が下にある順にソート
            # くっついていても「一番下まである塊」が選ばれるのでOK
            leg_candidates.sort(key=lambda x: x["tip_y"], reverse=True)
            
            # 下位2本（または塊）を採用
            target_legs = leg_candidates[:2]
            
            intersection_bottoms = []
            
            # 体幹（胸＋腹）の定義
            mask_body = mask_thorax | mask_abdomen
            
            for leg in target_legs:
                # 脚を膨張させて体幹と接触させる (隙間対策)
                # アリの細い脚も、オケラの離れた脚も、これで捕まえる
                dilated_leg = binary_dilation(leg["mask"], iterations=10)
                
                # 体幹との重なり（交差エリア）を取得
                intersection = dilated_leg & mask_body
                ys_inter = np.where(intersection)[0]
                
                if ys_inter.size > 0:
                    # 交差エリアの「一番下」＝「脚の付け根の下端」
                    inter_bottom = np.max(ys_inter)
                    intersection_bottoms.append(inter_bottom)
            
            if len(intersection_bottoms) > 0:
                # 左右の脚で低い方（Yが大きい方）に合わせるか、平均を取る
                # ここでは平均を採用して安定させる
                y_bot = int(sum(intersection_bottoms) / len(intersection_bottoms))
                
                # 安全装置: 胸の上端より上ならおかしいので補正
                if ys_thorax.size > 0:
                    thorax_top_val = int(ys_thorax.min())
                    thorax_bottom_val = int(ys_thorax.max())
                    if y_bot < (thorax_top_val + thorax_bottom_val) / 2:
                         y_bot = thorax_bottom_val

    else:
        # 脚が見つからない場合のフォールバック
        if ys_thorax.size > 0:
            y_bot = int(ys_thorax.max())

    # 3. 最終チェック
    if y_bot <= y_top + 10:
        y_bot = max(y_bot, y_top + 30)
        
    y_top = max(0, min(H-1, y_top))
    y_bot = max(0, min(H-1, y_bot))

    return y_top, y_bot


# === 4. APIエンドポイント ===
@app.post("/api/segment", response_model=SegmentResponse)
async def segment_image(request: SegmentRequest):
    with tempfile.TemporaryDirectory() as temp_dir_str:
        try:
            temp_dir = Path(temp_dir_str)
            print(f"Created temporary project in: {temp_dir}")
            
            if "," in request.image_base64:
                header, b64_data = request.image_base64.split(",", 1)
            else:
                b64_data = request.image_base64
            image_data = base64.b64decode(b64_data)
            original_image_pil = Image.open(io.BytesIO(image_data)).convert("RGB")
            original_image_np = np.array(original_image_pil)
            
            images_subdir = temp_dir / "images"
            images_subdir.mkdir(parents=True, exist_ok=True)
            image_filename = "input_image.png"
            image_path = images_subdir / image_filename
            original_image_pil.save(image_path)
            
            print("Building maphis storage...")
            storage, photo, lh = _build_storage(temp_dir, image_path)
            
            print("Running UNetRegions segmentation...")
            res = comp(photo)
            
            id_full = None
            if isinstance(res, LabelImg):
                id_full = res.label_image
            elif isinstance(res, dict):
                id_full = next(iter(res.values())).label_image
            elif isinstance(res, (list, tuple, set)):
                id_full = list(res)[0].label_image
            else:
                raise RuntimeError(f"Unexpected UNet result type: {type(res)}")
            
            if id_full is None:
                 raise RuntimeError("Could not retrieve segmentation result (id_full is None).")

            print("Result retrieved successfully.")
            id_mask = id_full.astype(np.uint32)
            
            # === 胸の縦帯を計算 ===
            print("Calculating thorax band...")
            thorax_top, thorax_bottom = detect_thorax_band(id_mask, lh)
            print(f"Thorax band detected: {thorax_top} - {thorax_bottom}")
            # =========================

            print("Creating transparent mask image...")
            cmap = _id_to_color_map(id_mask, lh)
            mask_image_pil = _create_transparent_mask(original_image_np.shape, id_mask, cmap)
            
            buffered = io.BytesIO()
            mask_image_pil.save(buffered, format="PNG") 
            segmented_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
            
            print("Segmentation successful.")
            
            # 座標も一緒に返す
            return SegmentResponse(
                segmented_image_base64=f"data:image/png;base64,{segmented_b64}",
                thorax_top=thorax_top,
                thorax_bottom=thorax_bottom
            )

        except Exception as e:
            print(f"Error during segmentation: {e}")
            import traceback
            traceback.print_exc()
            return JSONResponse(status_code=500, content={"detail": str(e)})

# === 5. サーバー起動 ===
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)