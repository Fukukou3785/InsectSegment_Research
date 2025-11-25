"use client"

import type React from "react"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ArrowLeft, Eraser, Paintbrush, RotateCcw, Sparkles, ZoomIn, ZoomOut } from "lucide-react"
import Link from "next/link"

type BodyPartType = "head" | "thorax" | "abdomen" | "legs"
type BrushSizeType = "small" | "medium" | "large"
type ToolType = "brush" | "eraser" | "zoom-in" | "zoom-out"

const bodyPartColors = {
  head: "rgb(31, 119, 180)",
  thorax: "rgb(44, 160, 44)",
  abdomen: "rgb(214, 39, 40)",
  legs: "rgb(148, 103, 189)",
}

const bodyPartLabels = {
  head: "まえ",
  thorax: "まんなか",
  abdomen: "うしろ",
  legs: "あし",
}

const bodyPartEmojis = {
  head: "🦗",
  thorax: "🐛",
  abdomen: "🐜",
  legs: "🦵",
}

const brushSizes: Record<BrushSizeType, number> = {
  small: 12,
  medium: 24,
  large: 40,
}

const brushSizeLabels: Record<BrushSizeType, string> = {
  small: "ちいさい",
  medium: "ふつう",
  large: "おおきい",
}

export default function EditorPage() {
  const router = useRouter()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const guardCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [isDrawing, setIsDrawing] = useState(false)
  const [brushSize, setBrushSize] = useState<BrushSizeType>("medium")
  const [tool, setTool] = useState<ToolType>("brush")
  const [selectedPart, setSelectedPart] = useState<BodyPartType>("head")
  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null)
  const [history, setHistory] = useState<ImageData[]>([])
  const [lastPos, setLastPos] = useState<{ x: number; y: number } | null>(null)
  
  const [zoom, setZoom] = useState(1.0)

  useEffect(() => {
    const handleResize = () => {
      if (originalImage) {
        redrawCanvas()
      }
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [originalImage])

  useEffect(() => {
    const imageData = sessionStorage.getItem("insectImage")
    const maskData = sessionStorage.getItem("segmentedImage")

    if (!imageData) {
      router.push("/upload")
      return
    }

    const canvas = canvasRef.current
    const maskCanvas = maskCanvasRef.current
    const guardCanvas = guardCanvasRef.current
    const container = containerRef.current // ★コンテナ取得
    if (!canvas || !maskCanvas || !guardCanvas || !container) return

    const ctx = canvas.getContext("2d")
    const maskCtx = maskCanvas.getContext("2d")
    const guardCtx = guardCanvas.getContext("2d")
    if (!ctx || !maskCtx || !guardCtx) return

    const img = new Image()
    img.onload = () => {
      // 1. まずはキャンバス自体の解像度を決定 (800pxルール)
      const MAX_SIZE = 800
      let width = img.width
      let height = img.height

      if (width > height) {
        if (width > MAX_SIZE) {
          height = Math.round(height * (MAX_SIZE / width))
          width = MAX_SIZE
        }
      } else {
        if (height > MAX_SIZE) {
          width = Math.round(width * (MAX_SIZE / height))
          height = MAX_SIZE
        }
      }

      canvas.width = width
      canvas.height = height
      maskCanvas.width = width
      maskCanvas.height = height
      guardCanvas.width = width
      guardCanvas.height = height

      // 2. ★修正: 初期ズームの計算
      // コンテナの大きさ(padding分を引く)と、画像の大きさを比較して、
      // 画面に収まるような倍率 (fitScale) を計算します。
      const availableW = container.clientWidth - 32 // p-4 = 16px*2
      const availableH = container.clientHeight - 32
      
      const scaleW = availableW / width
      const scaleH = availableH / height
      
      // 小さい方の倍率に合わせる（ただし最大1.0倍まで）
      const fitScale = Math.min(scaleW, scaleH, 1.0)
      
      // 計算した倍率をセット！これで最初はピッタリ収まります
      setZoom(fitScale)
      
      setOriginalImage(img)

      if (maskData) {
        const maskImg = new Image()
        maskImg.onload = () => {
          maskCtx.drawImage(maskImg, 0, 0, width, height)
          guardCtx.clearRect(0, 0, width, height)
          guardCtx.drawImage(maskImg, 0, 0, width, height)
          redrawCanvas(img) 
          saveToHistory() 
        }
        maskImg.src = maskData
      } else {
        redrawCanvas(img)
        saveToHistory()
      }
    }
    img.src = imageData
  }, [router])

  const redrawCanvas = (img: HTMLImageElement | null = null) => {
    const canvas = canvasRef.current
    const maskCanvas = maskCanvasRef.current
    const targetImage = img || originalImage 

    if (!canvas || !maskCanvas || !targetImage) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(targetImage, 0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.globalAlpha = 0.6
    ctx.drawImage(maskCanvas, 0, 0)
    ctx.restore()
  }
  
  const saveToHistory = () => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas) return
    const maskCtx = maskCanvas.getContext("2d")
    if (!maskCtx) return

    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    setHistory((prev) => [...prev.slice(-9), imageData])
  }

  const handleZoom = (delta: number) => {
    setZoom((prev) => {
      const newZoom = prev + delta
      return Math.min(Math.max(newZoom, 0.5), 3.0)
    })
  }

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (tool === "zoom-in") {
      handleZoom(0.5)
      return
    }
    if (tool === "zoom-out") {
      handleZoom(-0.5)
      return
    }

    setIsDrawing(true)
    const pos = getCanvasPosition(e)
    if (pos) {
      setLastPos(pos)
      drawAtPosition(pos.x, pos.y)
    }
  }

  const stopDrawing = () => {
    if (isDrawing) {
      setIsDrawing(false)
      setLastPos(null)
      saveToHistory()
    }
  }

  const getCanvasPosition = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height

    let clientX: number, clientY: number

    if ("touches" in e) {
      if (e.touches.length === 0) return null
      clientX = e.touches[0].clientX
      clientY = e.touches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }

    const x = (clientX - rect.left) * scaleX
    const y = (clientY - rect.top) * scaleY

    return { x, y }
  }

  const drawAtPosition = (x: number, y: number) => {
    const maskCanvas = maskCanvasRef.current
    const guardCanvas = guardCanvasRef.current
    if (!maskCanvas || !guardCanvas) return

    const maskCtx = maskCanvas.getContext("2d")
    if (!maskCtx) return

    maskCtx.globalCompositeOperation = tool === "brush" ? "source-over" : "destination-out"
    maskCtx.fillStyle = tool === "brush" ? bodyPartColors[selectedPart] : "rgba(0, 0, 0, 1)"
    maskCtx.beginPath()
    maskCtx.arc(x, y, brushSizes[brushSize], 0, Math.PI * 2)
    maskCtx.fill()

    maskCtx.globalCompositeOperation = "destination-in"
    maskCtx.drawImage(guardCanvas, 0, 0, maskCanvas.width, maskCanvas.height)
    maskCtx.globalCompositeOperation = "source-over"
  }

  const interpolatePoints = (x1: number, y1: number, x2: number, y2: number) => {
    const distance = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
    const steps = Math.max(Math.floor(distance / 2), 1)

    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = x1 + (x2 - x1) * t
      const y = y1 + (y2 - y1) * t
      drawAtPosition(x, y)
    }
  }

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return

    const pos = getCanvasPosition(e)
    if (!pos) return

    if (lastPos) {
      interpolatePoints(lastPos.x, lastPos.y, pos.x, pos.y)
    } else {
      drawAtPosition(pos.x, pos.y)
    }

    setLastPos(pos)
    redrawCanvas()
  }

  const handleUndo = () => {
    if (history.length <= 1) return

    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas) return
    const maskCtx = maskCanvas.getContext("2d")
    if (!maskCtx) return

    const newHistory = history.slice(0, -1)
    const previousState = newHistory[newHistory.length - 1]

    if (previousState) {
      maskCtx.putImageData(previousState, 0, 0)
      setHistory(newHistory)
      redrawCanvas()
    }
  }

  const handleNext = async () => {
    const canvas = canvasRef.current
    const maskCanvas = maskCanvasRef.current
    if (!canvas || !maskCanvas) return

    // 1. ユーザーが編集したマスクを取得して保存 (次の画面用)
    const userMaskData = maskCanvas.toDataURL("image/png")
    sessionStorage.setItem("editedMask", userMaskData)

    // 2. 保存するかどうかユーザーに聞く
    const shouldSave = window.confirm("研究のためにデータを保存しますか？\n（「はい」で保存、「いいえ」で保存せずに進みます）")

    if (shouldSave) {
      // 「はい」の場合：データを準備してバックエンドに送信
      const originalData = sessionStorage.getItem("insectImage")
      const aiMaskData = sessionStorage.getItem("segmentedImage")
      const tTop = sessionStorage.getItem("thoraxTop")
      const tBottom = sessionStorage.getItem("thoraxBottom")

      if (originalData && aiMaskData) {
        try {
          console.log("Saving logs to backend...")
          // 非同期で送信 (awaitをつけると保存完了まで待つ。待たせたくなければawaitを外す)
          await fetch('http://localhost:8000/api/save_log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              original_base64: originalData,
              ai_mask_base64: aiMaskData,
              user_mask_base64: userMaskData,
              thorax_top: Number(tTop) || 0,
              thorax_bottom: Number(tBottom) || 0
            }),
          })
          alert("データを保存しました！ご協力ありがとうございます。")
        } catch (e) {
          console.error("Failed to save log:", e)
          alert("保存に失敗しましたが、次へ進みます。")
        }
      }
    }

    // 3. 次の画面へ
    router.push("/result")
  }

  const getCursorStyle = () => {
    if (tool === "zoom-in") return "zoom-in"
    if (tool === "zoom-out") return "zoom-out"
    return "crosshair"
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-b from-green-50 to-blue-50 overflow-hidden">
      <header className="bg-gradient-to-r from-green-500 to-blue-500 text-white py-4 px-4 flex items-center gap-3 shadow-lg flex-shrink-0">
        <Link href="/upload">
          <Button variant="ghost" size="icon" className="text-white hover:bg-white/20 rounded-full h-12 w-12">
            <ArrowLeft className="w-6 h-6" />
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <Sparkles className="w-6 h-6" />
          <h1 className="text-xl md:text-2xl font-bold">こんちゅうをぬろう！</h1>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="w-32 sm:w-48 md:w-56 lg:w-64 xl:w-72 flex-shrink-0 flex flex-col p-1.5 sm:p-2 md:p-3 bg-white border-r border-gray-200 overflow-hidden">
          {/* Sidebar content... (変更なし) */}
          <div className="flex flex-col h-full gap-1.5 sm:gap-2 md:gap-3 overflow-y-auto">
            <Card className="p-1.5 sm:p-2 md:p-3 bg-gradient-to-br from-blue-50 to-green-50 shadow-md flex-shrink-0">
              <h2 className="text-[10px] sm:text-xs md:text-sm font-bold mb-1 sm:mb-2 text-center text-gray-800">
                どこをぬる？
              </h2>
              <div className="grid grid-cols-2 gap-1 sm:gap-1.5">
                {(Object.keys(bodyPartColors) as BodyPartType[]).map((part) => (
                  <button
                    key={part}
                    className={`p-1 sm:p-2 rounded-lg font-bold text-[9px] sm:text-xs transition-all transform hover:scale-105 ${
                      selectedPart === part ? "ring-2 ring-yellow-400 shadow-lg scale-105" : "hover:shadow-md"
                    }`}
                    style={{
                      backgroundColor: bodyPartColors[part].replace("0.6", selectedPart === part ? "0.9" : "0.5"),
                      color: "white",
                      textShadow: "1px 1px 2px rgba(0,0,0,0.3)",
                    }}
                    onClick={() => {
                      setSelectedPart(part)
                      setTool("brush")
                    }}
                  >
                    <div className="text-base sm:text-xl mb-0.5">{bodyPartEmojis[part]}</div>
                    <div className="text-[8px] sm:text-[10px]">{bodyPartLabels[part]}</div>
                  </button>
                ))}
              </div>
            </Card>

            <Card className="p-1.5 sm:p-2 md:p-3 bg-gradient-to-br from-purple-50 to-pink-50 shadow-md flex-shrink-0">
              <h3 className="text-[10px] sm:text-xs md:text-sm font-bold mb-1 sm:mb-2 text-center text-gray-800">
                どうぐ
              </h3>
              <div className="grid grid-cols-2 gap-1 sm:gap-1.5">
                <Button
                  size="sm"
                  className={`h-10 sm:h-12 md:h-14 flex flex-col gap-0.5 text-[9px] sm:text-xs font-bold transition-all transform hover:scale-105 ${
                    tool === "brush"
                      ? "bg-blue-500 hover:bg-blue-600 shadow-lg scale-105 ring-2 ring-yellow-400"
                      : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                  onClick={() => setTool("brush")}
                >
                  <Paintbrush className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="text-[8px] sm:text-[10px]">ブラシ</span>
                </Button>
                <Button
                  size="sm"
                  className={`h-10 sm:h-12 md:h-14 flex flex-col gap-0.5 text-[9px] sm:text-xs font-bold transition-all transform hover:scale-105 ${
                    tool === "eraser"
                      ? "bg-orange-500 hover:bg-orange-600 shadow-lg scale-105 ring-2 ring-yellow-400"
                      : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                  onClick={() => setTool("eraser")}
                >
                  <Eraser className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="text-[8px] sm:text-[10px]">けしゴム</span>
                </Button>
                
                <Button
                  size="sm"
                  className={`h-10 sm:h-12 md:h-14 flex flex-col gap-0.5 text-[9px] sm:text-xs font-bold transition-all transform hover:scale-105 ${
                    tool === "zoom-in"
                      ? "bg-teal-500 hover:bg-teal-600 shadow-lg scale-105 ring-2 ring-yellow-400"
                      : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                  onClick={() => setTool("zoom-in")}
                >
                  <ZoomIn className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="text-[8px] sm:text-[10px]">かくだい</span>
                </Button>
                <Button
                  size="sm"
                  className={`h-10 sm:h-12 md:h-14 flex flex-col gap-0.5 text-[9px] sm:text-xs font-bold transition-all transform hover:scale-105 ${
                    tool === "zoom-out"
                      ? "bg-teal-500 hover:bg-teal-600 shadow-lg scale-105 ring-2 ring-yellow-400"
                      : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                  onClick={() => setTool("zoom-out")}
                >
                  <ZoomOut className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="text-[8px] sm:text-[10px]">しゅくしょう</span>
                </Button>
              </div>
              <div className="mt-1 text-center text-[10px] text-gray-600 font-bold">
               {/* ばいりつ: {Math.round(zoom * 100)}% */}
              </div>
            </Card>

            <Card className="p-1.5 sm:p-2 md:p-3 bg-gradient-to-br from-yellow-50 to-orange-50 shadow-md flex-shrink-0">
              <h3 className="text-[10px] sm:text-xs md:text-sm font-bold mb-1 sm:mb-2 text-center text-gray-800">
                おおきさ
              </h3>
              <div className="flex flex-col gap-1 sm:gap-1.5">
                {(Object.keys(brushSizes) as BrushSizeType[]).reverse().map((size) => (
                  <Button
                    key={size}
                    size="sm"
                    className={`h-8 sm:h-10 flex items-center justify-between px-1.5 sm:px-2 text-[9px] sm:text-xs font-bold transition-all transform hover:scale-105 ${
                      brushSize === size
                        ? "bg-purple-500 hover:bg-purple-600 text-white shadow-lg scale-105 ring-2 ring-yellow-400"
                        : "bg-white text-gray-700 hover:bg-gray-100 border-2 border-gray-300"
                    }`}
                    onClick={() => setBrushSize(size)}
                  >
                    <span className="text-[8px] sm:text-[10px]">{brushSizeLabels[size]}</span>
                    <div
                      className="rounded-full flex-shrink-0"
                      style={{
                        backgroundColor: brushSize === size ? "white" : "#6b7280",
                        width: size === "small" ? "8px" : size === "medium" ? "14px" : "24px",
                        height: size === "small" ? "8px" : size === "medium" ? "14px" : "24px",
                      }}
                    />
                  </Button>
                ))}
              </div>
            </Card>

            <div className="flex-1 min-h-1" />

            <Button
              size="sm"
              variant="outline"
              className="h-8 sm:h-10 md:h-12 flex items-center justify-center gap-1 font-bold text-[9px] sm:text-xs bg-white hover:bg-gray-50 border-2 border-gray-300 flex-shrink-0"
              onClick={handleUndo}
              disabled={history.length <= 1}
            >
              <RotateCcw className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="text-[8px] sm:text-[10px]">もどす</span>
            </Button>

            <Button
              size="sm"
              className="h-10 sm:h-12 md:h-14 text-[9px] sm:text-xs md:text-sm font-bold bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600 shadow-xl transform hover:scale-105 transition-all flex-shrink-0"
              onClick={handleNext}
            >
              できた！つぎへ →
            </Button>
          </div>
        </aside>

        <main className="flex-1 min-w-0 min-h-0 flex overflow-hidden bg-gradient-to-br from-green-50 via-blue-50 to-purple-50">
          {/* ★修正: items-center / justify-center を削除し、flex のみにする */}
          <div ref={containerRef} className="flex-1 w-full h-full overflow-auto flex p-4">
            
            <div 
              // ★修正: m-auto を追加して、小さい時は中央、大きい時は左上基準にする
              className="relative shadow-2xl bg-white transition-all duration-200 ease-out m-auto"
              style={{
                width: canvasRef.current ? canvasRef.current.width * zoom : "auto",
                height: canvasRef.current ? canvasRef.current.height * zoom : "auto",
              }}
            >
              <canvas
                ref={canvasRef}
                className="w-full h-full touch-none rounded-lg"
                style={{ cursor: getCursorStyle() }}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                onTouchStart={startDrawing}
                onTouchMove={draw}
                onTouchEnd={stopDrawing}
              />
              <canvas ref={maskCanvasRef} className="hidden" />
              <canvas ref={guardCanvasRef} className="hidden" />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}