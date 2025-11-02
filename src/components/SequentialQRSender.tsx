import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Slider } from '@/components/ui/slider'
import QRWorker from '@/workers/qrGenerator.worker?worker'

interface SequentialQRSenderProps {
  file: File
  sessionId: number
}

// Maximum bytes per QR code chunk - using binary mode instead of base64
// QR max ~2953 bytes (byte mode, error correction M)
// Binary mode is more efficient (no base64 overhead)
// Increased from 600 to 800 bytes with zxing-wasm binary QR encoding
export const CHUNK_SIZE = 800 // bytes of raw binary data
const PREFETCH_AHEAD = 6
const QR_WIDTH = 400
const QR_MARGIN = 4

export function SequentialQRSender({ file }: SequentialQRSenderProps) {
  // Metadata removed: parent component is responsible for metadata QR
  const [dataChunks, setDataChunks] = useState<Uint8Array[]>([]) // Data chunks only (0-based)
  const [currentChunk, setCurrentChunk] = useState(0)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(5) // frames per second
  const [error, setError] = useState<string>('')
  const [repeatMode, setRepeatMode] = useState(true) // Auto-repeat animation
  const [loopCount, setLoopCount] = useState(0)
  const [hasStarted, setHasStarted] = useState(false) // User has pressed play at least once
  // Removed showMetadata state – always showing data chunks
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const pendingRequests = useRef<
    Map<number, { resolve: (value: string) => void; reject: (reason: Error) => void }>
  >(new Map())
  const requestIdRef = useRef(0)
  const qrCacheRef = useRef<Map<number, string>>(new Map())
  const generationQueueRef = useRef<Map<number, Promise<string>>>(new Map())
  const cleanupCache = useCallback(() => {
    for (const url of qrCacheRef.current.values()) {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url)
      }
    }
    qrCacheRef.current.clear()
  }, [])

  const getQrUrlForIndex = useCallback(async (index: number) => {
    const cached = qrCacheRef.current.get(index)
    if (cached) {
      return cached
    }

    const chunk = dataChunks[index]
    if (!chunk) {
      throw new Error('Chunk not found')
    }

    let pending = generationQueueRef.current.get(index)
    if (!pending) {
      const worker = workerRef.current
      if (!worker) {
        throw new Error('QR worker unavailable')
      }

      pending = new Promise<string>((resolve, reject) => {
        const id = requestIdRef.current++
        pendingRequests.current.set(id, { resolve, reject })

        try {
          const payload = chunk.slice()
          worker.postMessage(
            {
              type: 'generate',
              id,
              binaryBuffer: payload.buffer,
              options: {
                errorCorrectionLevel: 'M',
                width: QR_WIDTH,
                margin: QR_MARGIN
              }
            },
            [payload.buffer]
          )
        } catch (err) {
          pendingRequests.current.delete(id)
          reject(err as Error)
        }
      }).catch((err) => {
        console.error('QR worker failed for chunk', index, err)
        throw err
      })

      generationQueueRef.current.set(index, pending)
    }

    try {
      const url = await pending
      qrCacheRef.current.set(index, url)
      return url
    } finally {
      generationQueueRef.current.delete(index)
    }
  }, [dataChunks])

  useEffect(() => {
    try {
      const worker = new QRWorker()
      workerRef.current = worker
      worker.onmessage = (event: MessageEvent) => {
        const { type, id, buffer, mimeType, error } = event.data as {
          type: 'success' | 'error'
          id: number
          buffer?: ArrayBuffer
          mimeType?: string
          error?: string
        }

        const pending = pendingRequests.current.get(id)
        if (!pending) return

        if (type === 'success' && buffer) {
          try {
            const blob = new Blob([buffer], { type: mimeType || 'image/png' })
            const url = URL.createObjectURL(blob)
            pending.resolve(url)
          } catch (err) {
            pending.reject(err as Error)
          }
        } else {
          pending.reject(new Error(error || 'Worker error'))
        }

        pendingRequests.current.delete(id)
      }
    } catch (err) {
      console.warn('QR worker initialization failed; QR generation unavailable.', err)
      workerRef.current = null
    }

    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
      pendingRequests.current.forEach(({ reject }) =>
        reject(new Error('QR worker terminated'))
      )
      pendingRequests.current.clear()
      cleanupCache()
    }
  }, [cleanupCache])

  // Process file into chunks
  useEffect(() => {
    cleanupCache()
    generationQueueRef.current.clear()
    setQrCodeUrl('')

    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer
        const bytes = new Uint8Array(arrayBuffer)

        // Calculate number of data chunks needed & create data chunks (0-based indexing)
        const totalDataChunks = Math.ceil(bytes.length / CHUNK_SIZE)
        // Format: [type=1 (1 byte)][chunk index (2 bytes)][data (up to CHUNK_SIZE bytes)]
        const newDataChunks: Uint8Array[] = []
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

          // Store binary data directly (no base64 encoding)
          newDataChunks.push(chunkWithHeader)
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
  }, [file, cleanupCache])

  // Generate QR code for current chunk, sourcing from cache or worker
  useEffect(() => {
    if (dataChunks.length === 0) {
      setQrCodeUrl('')
      return
    }

    if (!hasStarted) {
      return
    }

    let isCancelled = false

    getQrUrlForIndex(currentChunk)
      .then((url) => {
        if (!isCancelled) {
          setQrCodeUrl(url)
        }
      })
      .catch((err) => {
        console.error('QR generation error:', err)
        if (!isCancelled) {
          setError('Failed to generate QR code')
        }
      })

    return () => {
      isCancelled = true
    }
  }, [dataChunks, currentChunk, hasStarted, getQrUrlForIndex])

  // Warm up QR cache as soon as chunks are available
  useEffect(() => {
    if (dataChunks.length === 0) return

    let cancelled = false
    const warmUp = async () => {
      const limit = Math.min(PREFETCH_AHEAD, dataChunks.length)
      for (let idx = 0; idx < limit; idx++) {
        if (cancelled) break
        try {
          await getQrUrlForIndex(idx)
        } catch (err) {
          if (!cancelled) {
            console.warn('Prefetch QR failed:', err)
          }
        }

        if (cancelled) break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    warmUp()

    return () => {
      cancelled = true
    }
  }, [dataChunks, getQrUrlForIndex])

  // Prefetch upcoming chunks during playback to minimize stutter
  useEffect(() => {
    if (!hasStarted || dataChunks.length === 0) return

    let cancelled = false
    const prefetch = async () => {
      for (let offset = 1; offset <= PREFETCH_AHEAD; offset++) {
        const nextIndex = (currentChunk + offset) % dataChunks.length
        if (qrCacheRef.current.has(nextIndex)) continue
        if (cancelled) break

        try {
          await getQrUrlForIndex(nextIndex)
        } catch (err) {
          if (!cancelled) {
            console.warn('Prefetch QR failed:', err)
          }
        }

        if (cancelled) break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    prefetch()

    return () => {
      cancelled = true
    }
  }, [currentChunk, hasStarted, dataChunks.length, getQrUrlForIndex])

  // Animation loop
  useEffect(() => {
    if (!isPlaying || dataChunks.length === 0) return

    const interval = setInterval(() => {
      setCurrentChunk((prev) => {
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
  }, [isPlaying, dataChunks.length, fps, repeatMode])

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

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-4">

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
