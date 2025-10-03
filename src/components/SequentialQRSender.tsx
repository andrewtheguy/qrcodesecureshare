import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Slider } from '@/components/ui/slider'

interface SequentialQRSenderProps {
  file: File
}

// Maximum bytes per QR code chunk - using binary mode instead of base64
// QR max ~2953 bytes (byte mode, error correction M)
// Binary mode is more efficient (no base64 overhead)
export const CHUNK_SIZE = 600 // bytes of raw binary data

export function SequentialQRSender({ file }: SequentialQRSenderProps) {
  // Metadata removed: parent component is responsible for metadata QR
  const [dataChunks, setDataChunks] = useState<string[]>([]) // Data chunks only (0-based)
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
  const [hasStarted, setHasStarted] = useState(false) // User has pressed play at least once
  // Removed showMetadata state – always showing data chunks
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const feedbackVideoRef = useRef<HTMLVideoElement>(null)
  const feedbackScannerRef = useRef<QrScanner | null>(null)

  // Process file into chunks
  useEffect(() => {
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer
        const bytes = new Uint8Array(arrayBuffer)

        // Calculate number of data chunks needed & create data chunks (0-based indexing)
        const totalDataChunks = Math.ceil(bytes.length / CHUNK_SIZE)
        // Format: [type=1 (1 byte)][chunk index (2 bytes)][data (up to CHUNK_SIZE bytes)]
        const newDataChunks: string[] = []
        for (let i = 0; i < totalDataChunks; i++) {
          const start = i * CHUNK_SIZE
          const end = Math.min(start + CHUNK_SIZE, bytes.length)
          const dataBytes = bytes.slice(start, end)

          // Create chunk with type and index header
          const chunkWithHeader = new Uint8Array(1 + 2 + dataBytes.length)
          let chunkOffset = 0

          // Chunk type: 1 = data
          chunkWithHeader[chunkOffset++] = 1

          // Chunk index (2 bytes, big-endian)
          chunkWithHeader[chunkOffset++] = (i >> 8) & 0xFF
          chunkWithHeader[chunkOffset++] = i & 0xFF

          // Data payload
          chunkWithHeader.set(dataBytes, chunkOffset)

          // Convert to string using Latin-1 encoding (preserves all byte values)
          newDataChunks.push(String.fromCharCode(...chunkWithHeader))
        }

        setDataChunks(newDataChunks)
        setCurrentChunk(0)
        // Metadata handled externally – start directly at first data chunk
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
    if (dataChunks.length === 0 || !hasStarted) {
      setQrCodeUrl('')
      return
    }

    const generateQR = async () => {
      try {
        const chunkString = dataChunks[currentChunk]
        if (!chunkString) return

        // chunkString is already in Latin-1 encoding, pass directly to QRCode
        const dataUrl = await QRCode.toDataURL(chunkString, {
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
  }, [dataChunks, currentChunk, hasStarted])

  // Animation loop
  useEffect(() => {
    if (!isPlaying || dataChunks.length === 0) return

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

        // Normal playback - 0-based data chunks
        const next = prev + 1
        if (next >= dataChunks.length) {
          setLoopCount((count) => count + 1)
          return repeatMode ? 0 : prev // Loop back to first data chunk (index 0)
        }
        return next
      })
    }, 1000 / fps)

    return () => clearInterval(interval)
  }, [isPlaying, dataChunks.length, fps, repeatMode, playingMissingOnly, missingChunksQueue])

  const handlePlayPause = () => {
    if (!hasStarted) {
      setHasStarted(true)
    }
    setIsPlaying(!isPlaying)
  }

  const handleNext = () => {
    setCurrentChunk((prev) => {
      const next = prev + 1
      if (next >= dataChunks.length) return 0 // Loop
      return next
    })
  }

  const handlePrevious = () => {
    setCurrentChunk((prev) => {
      const prevChunk = prev - 1
      if (prevChunk < 0) return dataChunks.length - 1 // Loop to last data chunk
      return prevChunk
    })
  }

  const handleSpeedChange = (newFps: number) => {
    // Snap to common frame rates
    const snapPoints = [1, 2, 5, 10, 15, 20, 24, 25, 30, 45, 60]
    const threshold = 2 // pixels of "stickiness"

    // Find nearest snap point
    const nearest = snapPoints.reduce((prev, curr) =>
      Math.abs(curr - newFps) < Math.abs(prev - newFps) ? curr : prev
    )

    // Apply snap if close enough
    if (Math.abs(nearest - newFps) <= threshold) {
      setFps(nearest)
    } else {
      setFps(newFps)
    }
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
        // Receiver already uses 0-based data chunk indices, so use them directly
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

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-4">
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
                Showing only {missingChunksQueue.length} missing chunk(s) out of {dataChunks.length} total.
              </p>
              <Button onClick={handleResetToAllChunks} variant="outline" size="sm" className="w-full">
                ← Back to All Chunks
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* QR Code Display (clean container with no overlays) */}
      <div className="flex justify-center bg-white p-4 rounded-lg">
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        {!hasStarted ? (
          <div className="w-[400px] h-[400px] bg-gray-100 rounded" />
        ) : qrCodeUrl ? (
          <img
            src={qrCodeUrl}
            alt={`Data QR Code chunk ${currentChunk + 1}/${dataChunks.length}`}
            className="max-w-full h-auto"
          />
        ) : (
          <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
            <p className="text-muted-foreground">Generating QR code...</p>
          </div>
        )}
      </div>

      {/* Caption / Status (moved outside to avoid overlap) */}
      {!hasStarted ? (
        <div className="text-center text-xs text-muted-foreground leading-relaxed">
          <p className="font-medium mb-1">📥 Ready to Begin</p>
          <p>
            On the receiver, click <span className="font-semibold">Start Receiving Data</span> first.<br/>
            Then press <span className="font-semibold">Play</span> here to start sending chunks.
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 flex-wrap text-xs text-muted-foreground">
          <span className="font-medium">Chunk {currentChunk + 1} / {dataChunks.length}</span>
          {isPlaying && (
            <span className="px-2 py-0.5 rounded bg-red-500 text-white flex items-center gap-1 font-semibold">
              <span className="w-2 h-2 bg-white rounded-full animate-pulse" /> PLAYING
            </span>
          )}
          {loopCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-blue-500 text-white font-semibold">Loop #{loopCount + 1}</span>
          )}
          {playingMissingOnly && missingChunksQueue.length > 0 && (
            <span className="px-2 py-0.5 rounded bg-amber-500 text-white font-semibold">Missing Mode</span>
          )}
        </div>
      )}

      {/* Chunk Progress */}
      {hasStarted && dataChunks.length > 0 && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Data chunk {currentChunk + 1} of {dataChunks.length}</span>
            <span>{Math.round(((currentChunk + 1) / dataChunks.length) * 100)}%</span>
          </div>
          <Progress value={((currentChunk + 1) / dataChunks.length) * 100} />
        </div>
      )}

      {/* Controls */}
      <div className="space-y-3">
        <div className="flex gap-2 justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrevious}
            disabled={dataChunks.length === 0}
          >
            ← Previous
          </Button>
          <Button
            size="sm"
            onClick={handlePlayPause}
            disabled={dataChunks.length === 0}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNext}
            disabled={dataChunks.length === 0 || !hasStarted}
          >
            Next →
          </Button>
        </div>

        {/* Speed Control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-2">
            <span className="text-sm text-muted-foreground">Speed:</span>
            <span className="text-sm font-medium">{fps} fps</span>
          </div>
          <Slider
            value={[fps]}
            onValueChange={(value) => handleSpeedChange(value[0])}
            min={1}
            max={60}
            step={1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground px-2">
            <span>1 fps</span>
            <span>60 fps</span>
          </div>
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
          <p className="font-medium mb-2">📱 Sequential Transfer Mode:</p>
          <ol className="list-decimal list-inside space-y-1 text-sm">
            <li>Receiver should have already scanned the metadata QR</li>
            <li>Click "Play" to cycle through data QR codes automatically</li>
            <li>Enable "Repeat ON" to loop through all data chunks</li>
            <li>Receiver tracks which chunks are scanned (deduplication)</li>
            <li>Keep playing until receiver shows 100% complete</li>
          </ol>
        </AlertDescription>
      </Alert>
    </div>
  )
}
