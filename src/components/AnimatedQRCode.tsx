import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface AnimatedQRCodeProps {
  file: File | null
  onReset?: () => void
}

// Maximum bytes per QR code chunk (conservative estimate for high error correction)
const CHUNK_SIZE = 1200 // bytes per QR code
const MAX_FILE_SIZE = 20 * 1024 // 20KB

export function AnimatedQRCode({ file, onReset }: AnimatedQRCodeProps) {
  const [chunks, setChunks] = useState<string[]>([])
  const [currentChunk, setCurrentChunk] = useState(0)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(2) // frames per second
  const [error, setError] = useState<string>('')
  const [repeatMode, setRepeatMode] = useState(true) // Auto-repeat animation
  const [loopCount, setLoopCount] = useState(0)
  const [scanningFeedback, setScanningFeedback] = useState(false)
  const [missingChunksQueue, setMissingChunksQueue] = useState<number[]>([])
  const [playingMissingOnly, setPlayingMissingOnly] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const feedbackVideoRef = useRef<HTMLVideoElement>(null)
  const feedbackScannerRef = useRef<QrScanner | null>(null)

  // Process file into chunks
  useEffect(() => {
    if (!file) {
      setChunks([])
      setError('')
      return
    }

    if (file.size > MAX_FILE_SIZE) {
      setError(`File size (${(file.size / 1024).toFixed(2)}KB) exceeds maximum of 20KB`)
      setChunks([])
      return
    }

    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer
        const bytes = new Uint8Array(arrayBuffer)

        // Convert to base64
        const base64Data = btoa(String.fromCharCode(...bytes))

        // Create metadata
        const metadata = {
          name: file.name,
          size: file.size,
          type: file.type,
          timestamp: Date.now()
        }

        // Calculate number of chunks needed
        const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE)
        const newChunks: string[] = []

        // Split data into chunks
        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE
          const end = Math.min(start + CHUNK_SIZE, base64Data.length)
          const chunkData = base64Data.slice(start, end)

          // Create chunk with metadata
          const chunk = {
            meta: metadata,
            index: i,
            total: totalChunks,
            data: chunkData
          }

          newChunks.push(JSON.stringify(chunk))
        }

        setChunks(newChunks)
        setCurrentChunk(0)
        setError('')
      } catch (err) {
        setError('Failed to process file')
        console.error(err)
      }
    }

    reader.onerror = () => {
      setError('Failed to read file')
    }

    reader.readAsArrayBuffer(file)
  }, [file])

  // Generate QR code for current chunk
  useEffect(() => {
    if (chunks.length === 0) {
      setQrCodeUrl('')
      return
    }

    const generateQR = async () => {
      try {
        const dataUrl = await QRCode.toDataURL(chunks[currentChunk], {
          width: 400,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
        setQrCodeUrl(dataUrl)
      } catch (err) {
        console.error('QR generation error:', err)
        setError('Failed to generate QR code')
      }
    }

    generateQR()
  }, [chunks, currentChunk])

  // Animation loop
  useEffect(() => {
    if (!isPlaying || chunks.length === 0) return

    const interval = setInterval(() => {
      setCurrentChunk((prev) => {
        // If playing only missing chunks, use the queue
        if (playingMissingOnly && missingChunksQueue.length > 0) {
          const currentIndexInQueue = missingChunksQueue.indexOf(prev)
          const nextIndexInQueue = currentIndexInQueue + 1

          if (nextIndexInQueue >= missingChunksQueue.length) {
            setLoopCount((count) => count + 1)
            return repeatMode ? missingChunksQueue[0] : prev
          }
          return missingChunksQueue[nextIndexInQueue]
        }

        // Normal playback
        const next = prev + 1
        if (next >= chunks.length) {
          setLoopCount((count) => count + 1)
          return repeatMode ? 0 : prev // Loop or stop at end
        }
        return next
      })
    }, 1000 / fps)

    return () => clearInterval(interval)
  }, [isPlaying, chunks.length, fps, repeatMode, playingMissingOnly, missingChunksQueue])

  const handlePlayPause = () => {
    setIsPlaying(!isPlaying)
  }

  const handleNext = () => {
    setCurrentChunk((prev) => (prev + 1) % chunks.length)
  }

  const handlePrevious = () => {
    setCurrentChunk((prev) => (prev - 1 + chunks.length) % chunks.length)
  }

  const handleSpeedChange = (newFps: number) => {
    setFps(newFps)
  }

  // Feedback scanner initialization
  useEffect(() => {
    if (!scanningFeedback || !feedbackVideoRef.current) {
      return
    }

    const scanner = new QrScanner(
      feedbackVideoRef.current,
      (result) => {
        handleFeedbackScan(result.data)
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      }
    )

    feedbackScannerRef.current = scanner
    scanner.start().catch((err) => {
      console.error('Feedback scanner start error:', err)
      setError('Failed to start camera for feedback scanning')
      setScanningFeedback(false)
    })

    return () => {
      scanner.stop()
      scanner.destroy()
    }
  }, [scanningFeedback])

  const handleFeedbackScan = (data: string) => {
    try {
      const feedback = JSON.parse(data)

      if (feedback.type === 'MISSING_CHUNKS_FEEDBACK' && Array.isArray(feedback.missingChunks)) {
        setMissingChunksQueue(feedback.missingChunks)
        setPlayingMissingOnly(true)
        setCurrentChunk(feedback.missingChunks[0] || 0)
        setScanningFeedback(false)
        setIsPlaying(false)
        setLoopCount(0)

        // Stop the scanner
        if (feedbackScannerRef.current) {
          feedbackScannerRef.current.stop()
        }
      }
    } catch (err) {
      console.error('Failed to parse feedback QR:', err)
    }
  }

  const handleStartFeedbackScan = () => {
    setScanningFeedback(true)
    setError('')
  }

  const handleStopFeedbackScan = () => {
    setScanningFeedback(false)
    if (feedbackScannerRef.current) {
      feedbackScannerRef.current.stop()
    }
  }

  const handleResetToAllChunks = () => {
    setPlayingMissingOnly(false)
    setMissingChunksQueue([])
    setCurrentChunk(0)
    setIsPlaying(false)
    setLoopCount(0)
  }

  if (!file) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-muted-foreground">No file selected</p>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          {onReset && (
            <Button onClick={onReset} className="mt-4 w-full">
              Try Another File
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">Animated QR Code Transfer</CardTitle>
        <div className="text-sm text-muted-foreground text-center space-y-1">
          <p className="font-medium">{file.name}</p>
          <p>Size: {(file.size / 1024).toFixed(2)}KB | Chunks: {chunks.length}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Feedback Scanner Mode */}
        {scanningFeedback && (
          <Alert>
            <AlertDescription>
              <div className="space-y-3">
                <p className="font-medium">📷 Scanning for Feedback QR</p>
                <div className="relative bg-black rounded-lg overflow-hidden">
                  <video
                    ref={feedbackVideoRef}
                    className="w-full h-auto"
                    style={{ maxHeight: '300px' }}
                  />
                  <div className="absolute top-2 right-2 bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium">
                    ● SCANNING
                  </div>
                </div>
                <p className="text-sm">
                  Point camera at the receiver's feedback QR code to see which chunks are missing.
                </p>
                <Button onClick={handleStopFeedbackScan} variant="outline" className="w-full">
                  Cancel Scan
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Missing Chunks Mode Alert */}
        {playingMissingOnly && missingChunksQueue.length > 0 && (
          <Alert>
            <AlertDescription>
              <div className="space-y-2">
                <p className="font-medium">🎯 Playing Missing Chunks Only</p>
                <p className="text-sm">
                  Showing only {missingChunksQueue.length} missing chunk(s) out of {chunks.length} total.
                </p>
                <Button onClick={handleResetToAllChunks} variant="outline" size="sm" className="w-full">
                  ← Back to All Chunks
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* QR Code Display */}
        <div className="relative">
          <div className="flex justify-center bg-white p-4 rounded-lg">
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {qrCodeUrl ? (
              <img
                src={qrCodeUrl}
                alt={`QR Code chunk ${currentChunk + 1}/${chunks.length}`}
                className="max-w-full h-auto"
              />
            ) : (
              <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
                <p className="text-muted-foreground">Generating QR code...</p>
              </div>
            )}
          </div>

          {/* Chunk ID Overlay */}
          <div className="absolute top-2 left-2 right-2 flex justify-between items-start">
            <div className="bg-black/80 text-white px-3 py-2 rounded-lg font-bold text-lg">
              QR {currentChunk + 1} / {chunks.length}
            </div>
            {isPlaying && (
              <div className="bg-red-500 text-white px-2 py-1 rounded text-xs font-medium flex items-center gap-1">
                <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                PLAYING
              </div>
            )}
          </div>

          {loopCount > 0 && (
            <div className="absolute bottom-2 right-2 bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium">
              Loop #{loopCount + 1}
            </div>
          )}
        </div>

        {/* Chunk Progress */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Chunk {currentChunk + 1} of {chunks.length}</span>
            <span>{Math.round(((currentChunk + 1) / chunks.length) * 100)}%</span>
          </div>
          <Progress value={((currentChunk + 1) / chunks.length) * 100} />
        </div>

        {/* Controls */}
        <div className="space-y-3">
          <div className="flex gap-2 justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrevious}
              disabled={chunks.length === 0}
            >
              ← Previous
            </Button>
            <Button
              size="sm"
              onClick={handlePlayPause}
              disabled={chunks.length === 0}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNext}
              disabled={chunks.length === 0}
            >
              Next →
            </Button>
          </div>

          {/* Speed Control */}
          <div className="flex items-center gap-2 justify-center flex-wrap">
            <span className="text-sm text-muted-foreground">Speed:</span>
            {[1, 2, 3, 4, 5].map((speed) => (
              <Button
                key={speed}
                variant={fps === speed ? 'default' : 'outline'}
                size="sm"
                onClick={() => handleSpeedChange(speed)}
                className="w-12"
              >
                {speed}fps
              </Button>
            ))}
          </div>

          {/* Repeat Mode Toggle */}
          <div className="flex items-center justify-center gap-2">
            <Button
              variant={repeatMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => setRepeatMode(!repeatMode)}
              className="flex items-center gap-2"
            >
              {repeatMode ? '🔁 Repeat ON' : '🔁 Repeat OFF'}
            </Button>
            {loopCount > 0 && (
              <span className="text-sm text-muted-foreground">
                Completed {loopCount} loop{loopCount > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Feedback QR Scanner Button */}
          <div className="pt-2 border-t">
            <Button
              onClick={handleStartFeedbackScan}
              variant="secondary"
              size="sm"
              className="w-full"
              disabled={scanningFeedback}
            >
              📷 Scan Receiver's Feedback QR
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-1">
              Get missing chunks from receiver
            </p>
          </div>
        </div>

        {/* Instructions */}
        <Alert>
          <AlertDescription>
            <p className="font-medium mb-2">📱 How to receive this file:</p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Each QR code shows its ID (e.g., "QR 1/100") at the top</li>
              <li>Enable "Repeat ON" to loop through all QR codes automatically</li>
              <li>Receiver will track which chunks are scanned (deduplication)</li>
              <li>Keep playing until receiver shows 100% complete</li>
              <li>Missing chunks will be filled on the next loop</li>
            </ol>
          </AlertDescription>
        </Alert>

        {onReset && (
          <Button onClick={onReset} variant="outline" className="w-full">
            Select Different File
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
