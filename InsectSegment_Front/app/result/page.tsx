"use client"

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ArrowLeft, Home, RotateCcw, Sparkles, Lightbulb } from "lucide-react"
import Link from "next/link"

type BodyPart = {
  name: string
  color: string
  description: string
  funFact: string
  targetRGB: [number, number, number]
}

const bodyParts: BodyPart[] = [
  {
    name: "あたま",
    color: "#3b82f6", // Blue
    description: "めやくち、しょっかくがあるよ",
    funFact: "こんちゅうのめは、たくさんのちいさなめがあつまってできているんだ！これを「ふくがん」っていうよ。",
    targetRGB: [31, 119, 180], 
  },
  {
    name: "むね",
    color: "#22c55e", // Green
    description: "あしやはねがついているよ",
    funFact: "こんちゅうのあしは、ぜんぶで6ほん！ぜんぶむねからはえているんだよ。はねもむねについているよ。",
    targetRGB: [44, 160, 44], 
  },
  {
    name: "おなか",
    color: "#ef4444", // Red
    description: "しょくもつをしょうかするよ",
    funFact: "おなかには、たべたものをしょうかするきかんや、たまごをつくるきかんがあるよ。",
    targetRGB: [214, 39, 40], 
  },
  {
    name: "あし",
    color: "#a855f7", // Purple
    description: "むねからはえているよ",
    funFact: "こんちゅうのあしは、まえあし・なかあし・うしろあしの3つのペアにわかれているよ。",
    targetRGB: [148, 103, 189], 
  },
]

const LEG_COLOR_RGB = [148, 103, 189]

export default function ResultPage() {
  const router = useRouter()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selectedPart, setSelectedPart] = useState<number | null>(null)
  const [quizMode, setQuizMode] = useState(false)
  const [drawnLines, setDrawnLines] = useState<number[]>([])
  const [quizResult, setQuizResult] = useState<string | null>(null)
  const [showHint, setShowHint] = useState(false) // ★追加: ヒント表示フラグ
  
  const [thoraxTop, setThoraxTop] = useState<number | null>(null)
  const [thoraxBottom, setThoraxBottom] = useState<number | null>(null)

  useEffect(() => {
    const imageData = sessionStorage.getItem("insectImage")
    const maskData = sessionStorage.getItem("editedMask")
    
    const storedTop = sessionStorage.getItem("thoraxTop")
    const storedBottom = sessionStorage.getItem("thoraxBottom")

    if (storedTop) setThoraxTop(Number(storedTop))
    if (storedBottom) setThoraxBottom(Number(storedBottom))

    if (!imageData) {
      router.push("/upload")
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return

    const img = new Image()
    img.onload = () => {
      canvas.width = img.width
      canvas.height = img.height
      
      ctx.drawImage(img, 0, 0)

      const currentThoraxTop = storedTop ? Number(storedTop) : img.height * 0.35
      const currentThoraxBottom = storedBottom ? Number(storedBottom) : img.height * 0.65

      if (maskData) {
        const maskImg = new Image()
        maskImg.onload = () => {
          
          // ★修正: クイズ中はマスクを非表示にする (ただしヒントONなら表示)
          // quizModeがオフ、または showHintがオンの場合のみマスクを描画
          if (!quizMode || showHint) {
              ctx.save()
              
              const tempCanvas = document.createElement("canvas")
              tempCanvas.width = canvas.width
              tempCanvas.height = canvas.height
              const tempCtx = tempCanvas.getContext("2d")
              if (tempCtx) {
                tempCtx.drawImage(maskImg, 0, 0, canvas.width, canvas.height)
                const imgData = tempCtx.getImageData(0, 0, canvas.width, canvas.height)
                const data = imgData.data
                const width = canvas.width;

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i]
                    const g = data[i + 1]
                    const b = data[i + 2]
                    const a = data[i + 3]

                    if (a === 0) continue 

                    const pixelIndex = i / 4;
                    const y = Math.floor(pixelIndex / width);

                    const distLeg = Math.abs(r - LEG_COLOR_RGB[0]) + Math.abs(g - LEG_COLOR_RGB[1]) + Math.abs(b - LEG_COLOR_RGB[2])
                    const isLeg = distLeg < 50; 

                    let shouldHighlight = false;

                    if (selectedPart === null) {
                        // クイズのヒント時は薄く表示
                        data[i + 3] = quizMode ? 80 : 100 
                        continue; 
                    }

                    if (selectedPart === 0) { 
                        if (y < currentThoraxTop && !isLeg) shouldHighlight = true;
                    } 
                    else if (selectedPart === 1) { 
                        if (y >= currentThoraxTop && y < currentThoraxBottom && !isLeg) shouldHighlight = true;
                    } 
                    else if (selectedPart === 2) { 
                        if (y >= currentThoraxBottom && !isLeg) shouldHighlight = true;
                    } 
                    else if (selectedPart === 3) { 
                        if (isLeg) shouldHighlight = true;
                    }

                    if (shouldHighlight) {
                        data[i + 3] = 220; 
                    } else {
                        data[i + 3] = 40;  
                    }
                }
                
                tempCtx.putImageData(imgData, 0, 0);
                ctx.drawImage(tempCanvas, 0, 0); 
              }
              
              ctx.restore()
          }

          if (!quizMode) {
            drawDividingLines(ctx, canvas.width, canvas.height, currentThoraxTop, currentThoraxBottom)
          } else {
            drawQuizLines(ctx, canvas.width)
          }
        }
        maskImg.src = maskData
      } else {
        if (quizMode) {
            drawQuizLines(ctx, canvas.width)
        } else {
            drawDividingLines(ctx, canvas.width, canvas.height, currentThoraxTop, currentThoraxBottom)
        }
      }
    }
    img.src = imageData
  }, [router, quizMode, drawnLines, selectedPart, showHint]) // showHint依存を追加

  const drawQuizLines = (ctx: CanvasRenderingContext2D, width: number) => {
    drawnLines.forEach((y) => {
      ctx.strokeStyle = "#f59e0b" 
      ctx.lineWidth = 6
      ctx.setLineDash([15, 15])
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.moveTo(20, y)
      ctx.lineTo(width - 20, y)
      ctx.stroke()
      ctx.setLineDash([])
    })
  }

  const drawDividingLines = (ctx: CanvasRenderingContext2D, width: number, height: number, tTop: number, tBottom: number) => {
    const headEnd = tTop
    const thoraxEnd = tBottom

    const lineColor = "#fbbf24" 
    const lineShadow = "rgba(0,0,0,0.2)"

    ctx.save()
    ctx.shadowColor = lineShadow
    ctx.shadowBlur = 4
    ctx.shadowOffsetY = 2

    ctx.strokeStyle = lineColor
    ctx.lineWidth = 5
    ctx.setLineDash([12, 10])
    ctx.lineCap = "round"

    ctx.beginPath()
    ctx.moveTo(10, headEnd)
    ctx.lineTo(width - 10, headEnd)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(10, thoraxEnd)
    ctx.lineTo(width - 10, thoraxEnd)
    ctx.stroke()
    
    ctx.setLineDash([])
    ctx.fillStyle = lineColor
    const dotSize = 6
    ;[headEnd, thoraxEnd].forEach(y => {
        ctx.beginPath(); ctx.arc(15, y, dotSize, 0, Math.PI*2); ctx.fill()
        ctx.beginPath(); ctx.arc(width-15, y, dotSize, 0, Math.PI*2); ctx.fill()
    })
    ctx.restore()

    drawRangeLabel(ctx, "あたま", bodyParts[0].color, 0, headEnd, width)
    drawRangeLabel(ctx, "むね", bodyParts[1].color, headEnd, thoraxEnd, width)
    drawRangeLabel(ctx, "おなか", bodyParts[2].color, thoraxEnd, height, width)
  }

  const drawRangeLabel = (ctx: CanvasRenderingContext2D, text: string, color: string, startY: number, endY: number, width: number) => {
      const centerY = (startY + endY) / 2
      const barX = width - 10
      
      if (endY - startY < 20) return

      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = 6
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.moveTo(barX, startY + 5)
      ctx.lineTo(barX, endY - 5)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(barX - 5, startY + 5); ctx.lineTo(barX, startY + 5)
      ctx.moveTo(barX - 5, endY - 5);   ctx.lineTo(barX, endY - 5)
      ctx.stroke()

      ctx.font = "bold 20px 'M PLUS Rounded 1c', sans-serif" 
      
      const metrics = ctx.measureText(text)
      const paddingX = 16
      const bgWidth = metrics.width + paddingX * 2
      const bgHeight = 36
      
      const bgX = barX - 15 - bgWidth
      const bgY = centerY - bgHeight / 2

      let safeBgY = bgY
      if (safeBgY < startY) safeBgY = startY
      if (safeBgY + bgHeight > endY) safeBgY = endY - bgHeight
      if (safeBgY < 0) safeBgY = 0

      ctx.shadowColor = "rgba(0,0,0,0.2)"
      ctx.shadowBlur = 4
      ctx.fillStyle = "white"
      
      roundRect(ctx, bgX, safeBgY, bgWidth, bgHeight, bgHeight / 2)
      ctx.fill()
      
      ctx.lineWidth = 2
      ctx.strokeStyle = color
      ctx.stroke()

      ctx.shadowBlur = 0
      ctx.fillStyle = color
      ctx.textAlign = "center"
      ctx.textBaseline = "middle" 
      ctx.fillText(text, bgX + bgWidth/2, safeBgY + bgHeight/2 + 1)

      ctx.restore()
  }

  const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    if (w < 2 * r) r = w / 2
    if (h < 2 * r) r = h / 2
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!quizMode || drawnLines.length >= 2) return

    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const scaleY = canvas.height / rect.height
    const y = (e.clientY - rect.top) * scaleY

    setDrawnLines([...drawnLines, y])
  }

  const checkQuizAnswer = () => {
    if (drawnLines.length < 2) {
      setQuizResult("せんを2ほんひいてね！")
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const sortedLines = [...drawnLines].sort((a, b) => a - b)
    const userLine1 = sortedLines[0]
    const userLine2 = sortedLines[1]

    // ★修正: 正解判定ロジック
    const correctTop = thoraxTop ?? canvas.height * 0.35
    const correctBottom = thoraxBottom ?? canvas.height * 0.65
    
    // 許容誤差 (画像の高さの10%くらい)
    const tolerance = canvas.height * 0.10

    const line1Correct = Math.abs(userLine1 - correctTop) < tolerance
    const line2Correct = Math.abs(userLine2 - correctBottom) < tolerance

    if (line1Correct && line2Correct) {
      setQuizResult("せいかい！とてもじょうずだね！")
    } else if (line1Correct || line2Correct) {
      setQuizResult("おしい！もういちどためしてみよう！")
    } else {
      setQuizResult("ざんねん...もういちどためしてみよう！")
    }
  }

  const startQuiz = () => {
    setQuizMode(true)
    setDrawnLines([])
    setQuizResult(null)
    setShowHint(false) // ヒントをリセット
  }

  const endQuiz = () => {
    setQuizMode(false)
    setDrawnLines([])
    setQuizResult(null)
    setShowHint(false)
  }

  const resetQuiz = () => {
    setDrawnLines([])
    setQuizResult(null)
    setShowHint(false) // リセット時はヒントも消す

    // 描画更新
    // (useEffectの依存配列に依存しているので、state更新だけで再描画が走るはずだが、
    // 即時反映のためにここで描画ロジックを呼んでも良い。今回はstate更新に任せる)
  }

  const handleRestart = () => {
    sessionStorage.clear()
    router.push("/")
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-b from-green-50 to-blue-50 overflow-hidden">
      <header className="bg-gradient-to-r from-green-500 to-blue-500 text-white py-3 px-4 flex items-center gap-3 shadow-lg flex-shrink-0">
        <Link href="/editor">
          <Button variant="ghost" size="icon" className="text-white hover:bg-white/20 rounded-full h-9 w-9">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          <h1 className="text-base md:text-lg font-bold">{quizMode ? "クイズにちょうせん！" : "からだのつくり"}</h1>
        </div>
      </header>

      <main className="flex-1 min-h-0 p-2 md:p-3 overflow-hidden">
        <div className="max-w-7xl mx-auto h-full flex flex-col lg:flex-row gap-2 md:gap-3">
          <Card className="p-2 md:p-3 bg-white shadow-lg flex-1 min-h-0 flex flex-col items-center justify-center overflow-hidden">
            <div className="relative w-full h-full flex items-center justify-center">
              <canvas
                ref={canvasRef}
                className={`max-w-full max-h-full object-contain ${quizMode ? "cursor-crosshair" : ""}`}
                onClick={handleCanvasClick}
              />
            </div>
            {quizMode && drawnLines.length < 2 && (
              <div className="mt-2 p-2 bg-blue-100 rounded-lg text-center flex-shrink-0">
                <p className="text-xs md:text-sm font-bold text-blue-800">
                  あと {2 - drawnLines.length} ほんひけるよ！
                </p>
              </div>
            )}
          </Card>

          <div className="w-full lg:w-80 xl:w-96 flex flex-col gap-2 md:gap-3 min-h-0 overflow-hidden">
            {quizMode ? (
              <>
                <Card className="p-2 md:p-3 bg-blue-50 border-2 border-blue-300 flex-shrink-0">
                  <h2 className="text-base md:text-lg font-bold text-center mb-1">クイズ</h2>
                  <p className="text-xs md:text-sm text-center mb-1 leading-snug">
                    こんちゅうのからだを、あたま・むね・おなかにわけるせんを2ほんひいてね！
                  </p>
                  <p className="text-xs text-center text-gray-600">がめんをタップして、せんをひこう</p>
                </Card>

                {quizResult && (
                  <Card
                    className={`p-2 md:p-3 flex-shrink-0 ${
                      quizResult.includes("せいかい")
                        ? "bg-green-100 border-2 border-green-500"
                        : quizResult.includes("おしい")
                          ? "bg-yellow-100 border-2 border-yellow-500"
                          : "bg-red-100 border-2 border-red-500"
                    }`}
                  >
                    <p className="text-sm md:text-base font-bold text-center mb-2">{quizResult}</p>
                    <div className="flex flex-col gap-2">
                        <div className="flex gap-2">
                            <Button size="sm" className="flex-1 h-10 text-xs md:text-sm font-bold" onClick={resetQuiz}>
                                もういちど
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="flex-1 h-10 text-xs md:text-sm font-bold bg-white"
                                onClick={endQuiz}
                            >
                                おわる
                            </Button>
                        </div>
                        {/* ★追加: 正解でない場合にヒントボタンを表示 */}
                        {!quizResult.includes("せいかい") && (
                            <Button 
                                size="sm" 
                                className="w-full bg-yellow-400 hover:bg-yellow-500 text-black font-bold"
                                onClick={() => setShowHint(true)}
                                disabled={showHint}
                            >
                                <Lightbulb className="w-4 h-4 mr-2" />
                                ヒントをみる
                            </Button>
                        )}
                    </div>
                  </Card>
                )}

                {!quizResult && (
                  <div className="flex gap-2 flex-shrink-0">
                    <Button
                      size="sm"
                      className="flex-1 h-10 md:h-12 text-xs md:text-sm font-bold bg-gradient-to-r from-green-500 to-blue-500"
                      onClick={checkQuizAnswer}
                      disabled={drawnLines.length < 2}
                    >
                      こたえあわせ
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-10 px-3 text-xs md:text-sm font-bold bg-white"
                      onClick={resetQuiz}
                    >
                      やりなおす
                    </Button>
                  </div>
                )}

                <div className="flex-1 min-h-0" />
              </>
            ) : (
              <>
                {/* 通常モード（学習画面） */}
                <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
                  {bodyParts.map((part, index) => (
                    <Card
                      key={index}
                      className={`p-2 cursor-pointer transition-all flex-shrink-0 ${
                        selectedPart === index ? "ring-2 ring-yellow-400 shadow-lg" : "hover:shadow-md"
                      }`}
                      onClick={() => setSelectedPart(selectedPart === index ? null : index)}
                    >
                      <div className="flex items-start gap-2">
                        <div
                          className="w-6 h-6 md:w-7 md:h-7 rounded-full flex-shrink-0 shadow-md"
                          style={{ backgroundColor: part.color }}
                        />
                        <div className="flex-1 min-w-0">
                          <h3 className="font-bold text-sm md:text-base mb-0.5">{part.name}</h3>
                          <p className="text-xs text-gray-700 mb-1">{part.description}</p>
                          {selectedPart === index && (
                            <div className="mt-1 p-2 bg-yellow-50 rounded-lg border border-yellow-300">
                              <p className="text-xs font-bold text-yellow-800 mb-0.5">💡 まめちしき</p>
                              <p className="text-xs text-gray-700 leading-snug">{part.funFact}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>

                <Card className="p-2 md:p-3 bg-gradient-to-r from-blue-50 to-green-50 border-2 border-blue-300 flex-shrink-0">
                  <p className="text-xs leading-snug">
                    <strong className="text-xs md:text-sm">こんちゅうのからだ：</strong>
                    <br />
                    こんちゅうのからだは、<strong>あたま・むね・はら</strong>の3つのぶぶんにわかれているよ！
                    あしは6ほんあって、ぜんぶむねからはえているんだ。
                  </p>
                </Card>

                <Button
                  size="sm"
                  className="w-full h-10 md:h-12 text-sm md:text-base font-bold bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 shadow-xl flex-shrink-0"
                  onClick={startQuiz}
                >
                  🎯 クイズにちょうせん！
                </Button>

                <div className="flex gap-2 flex-shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-9 md:h-10 text-xs md:text-sm font-bold gap-1 bg-white"
                    onClick={handleRestart}
                  >
                    <RotateCcw className="w-3 h-3 md:w-4 md:h-4" />
                    さいしょから
                  </Button>
                  <Link href="/" className="flex-1">
                    <Button
                      size="sm"
                      className="w-full h-9 md:h-10 text-xs md:text-sm font-bold gap-1 bg-gradient-to-r from-green-500 to-blue-500"
                    >
                      <Home className="w-3 h-3 md:w-4 md:h-4" />
                      ホームへ
                    </Button>
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}