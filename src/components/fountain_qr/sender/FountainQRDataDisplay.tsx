/**
 *
 * This component is responsible for the SENDER's side of the Fountain Code transfer.
 * It takes an encoded file (FountainEncoder) and displays a continuous stream of QR codes
 * that the receiver can scan. Each QR code contains a fountain-coded chunk that combines
 * multiple source blocks via XOR operations, allowing the receiver to decode the file
 * even if some chunks are missed or corrupted.
 *
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { writeBarcode } from 'zxing-wasm/full'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Slider } from '@/components/ui/slider'
import { FountainEncoder, type FountainChunk } from '@/utils/fountainCode'
import { computeChecksum } from '@/utils/checksum'
import { deriveQRCapacity } from '@/constants'
import QRWorker from '@/workers/qrGenerator.worker?worker'

interface WindowInfo {
  windowEnabled: boolean
  windowStart: number
  windowEnd: number
  windowSize: number
  totalBlocks: number
  isWindowComplete: boolean
  skipBlocksBelow: number
  currentSegment: number
  totalSegments: number
  segmentProgress: number
  segmentSizeBlocks: number
}

interface FountainQRDataDisplayProps {
  encoder: FountainEncoder | null
  sessionId: number
  qrOptions: {
    errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'
    margin: number
  }
  windowInfo: WindowInfo | null
  receivedBlocks: Set<number>
  lastStats: {
    totalDecoded: number
    totalBlocks: number
    windowStart?: number
    windowEnd?: number
  } | null
  isActive: boolean
  activationToken: number
  onChunkGenerated: (chunkNum: number, chunk: FountainChunk) => void
  onBufferUpdate: (bufferSize: number) => void
  onError: (error: string) => void
  fps: number
  onFpsChange: (fps: number) => void
}

export function FountainQRDataDisplay(props: FountainQRDataDisplayProps) {
  const {
    encoder,
    sessionId,
    qrOptions,
    receivedBlocks,
    isActive,
    activationToken,
    onChunkGenerated,
    onBufferUpdate,
    onError,
    fps,
    onFpsChange
  } = props
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [chunkCount, setChunkCount] = useState(0)
  const [estimatedChunksNeeded, setEstimatedChunksNeeded] = useState(0)
  const [bufferLength, setBufferLength] = useState(0) // Separate state for UI display
  const [isGeneratingBuffer, setIsGeneratingBuffer] = useState(false)
  const [workerFallbackHint, setWorkerFallbackHint] = useState('')

  const bufferTargetSizeRef = useRef(5) // Dynamic buffer size based on FPS
  const lastBufferGenerationRef = useRef(0) // Track last buffer generation time
  const currentChunkRef = useRef<FountainChunk | null>(null)
  const lastSuccessfulQrRef = useRef<string>('')
  const workerRef = useRef<Worker | null>(null)
  const pendingRequests = useRef<Map<number, {resolve: (url: string) => void, reject: (err: Error) => void}>>(new Map())
  const requestIdRef = useRef(0)
  const chunkBufferRef = useRef<Array<{chunk: FountainChunk, qrUrl: string, chunkNum: number}>>([])
  const chunkCountRef = useRef(chunkCount)
  const bufferLengthRef = useRef(bufferLength)
  const fpsRef = useRef(fps)

  // Update refs when state changes
  useEffect(() => {
    chunkCountRef.current = chunkCount
  }, [chunkCount])

  useEffect(() => {
    bufferLengthRef.current = bufferLength
  }, [bufferLength])

  useEffect(() => {
    fpsRef.current = fps
  }, [fps])

  // Worker failure tracking
  const consecutiveWorkerFailuresRef = useRef(0)
  const consecutiveWorkerSuccessesRef = useRef(0)
  const workerSkipUntilChunkRef = useRef(0)
  const originalFpsRef = useRef(fps)
  const originalBufferTargetRef = useRef(5)

  // Helper functions for atomic buffer mutations
  const pushToBuffer = useCallback((items: Array<{chunk: FountainChunk, qrUrl: string, chunkNum: number}>) => {
    chunkBufferRef.current.push(...items)
    const newLength = chunkBufferRef.current.length
    setBufferLength(newLength)
    onBufferUpdate(newLength)
  }, [onBufferUpdate])

  const consumeFromBuffer = useCallback((): {chunk: FountainChunk, qrUrl: string, chunkNum: number} | undefined => {
    const item = chunkBufferRef.current.shift()
    const newLength = chunkBufferRef.current.length
    setBufferLength(newLength)
    onBufferUpdate(newLength)
    return item
  }, [onBufferUpdate])

  const clearBuffer = useCallback(() => {
    chunkBufferRef.current = []
    setBufferLength(0)
    onBufferUpdate(0)
  }, [onBufferUpdate])

  const currentQROptions = useMemo(() => qrOptions, [qrOptions])

  // Dynamically compute max QR data size based on error correction level
  const MAX_QR_DATA_SIZE = useMemo(() => {
    const capacity = deriveQRCapacity(currentQROptions.errorCorrectionLevel, 400)
    if (import.meta.env.DEV) {
      console.log(`[FountainQRDataDisplay] Dynamic QR capacity for ECC ${currentQROptions.errorCorrectionLevel}: ${capacity} bytes`)
    }
    return capacity
  }, [currentQROptions.errorCorrectionLevel])

  // Initialize encoder state
  useEffect(() => {
    if (encoder) {
      const meta = encoder.getMetadata()
      setEstimatedChunksNeeded(Math.ceil(meta.totalSourceBlocks * 1.1))
      
      // Log QR capacity and max degree info for debugging
      if (import.meta.env.DEV) {
        console.log(`[FountainQRDataDisplay] QR capacity: ${MAX_QR_DATA_SIZE} bytes for ECC ${currentQROptions.errorCorrectionLevel}`)
      }
    }
  }, [encoder, MAX_QR_DATA_SIZE, currentQROptions.errorCorrectionLevel])

  // Auto-start playback once encoder is ready and activation token changes
  // This prevents auto-start during mode transitions in the parent component
  useEffect(() => {
    if (encoder && isActive && !isPlaying && activationToken > 0) {
      // Reset counters for fresh session
      setChunkCount(0)
      setIsPlaying(true)
    }
    // We intentionally exclude isPlaying setters from deps to avoid restarting mid-session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoder, isActive, activationToken])

  // Reset on session change
  useEffect(() => {
    setChunkCount(0)
    clearBuffer()
  }, [sessionId, clearBuffer])

  // Initialize QR generation worker
  useEffect(() => {
    try {
      workerRef.current = new QRWorker()
      workerRef.current.onmessage = (e) => {
        const { type, id, qrUrl, error } = e.data
        const resolver = pendingRequests.current.get(id)
        if (resolver) {
          if (type === 'success') resolver.resolve(qrUrl)
          else resolver.reject(new Error(error || 'Worker error'))
          pendingRequests.current.delete(id)
        }
      }
    } catch (err) {
      console.warn('QR worker initialization failed, falling back to main thread generation:', err)
      workerRef.current = null
    }

    return () => {
      workerRef.current?.terminate()
    }
  }, [])

  // Update buffer target size based on FPS
  useEffect(() => {
    // For low FPS (<=5), use smaller buffer to avoid over-generation
    // For high FPS, use larger buffer to ensure smooth playback
    if (fps <= 5) {
      bufferTargetSizeRef.current = 2 // Small buffer for low FPS
    } else if (fps <= 15) {
      bufferTargetSizeRef.current = 3
    } else {
      bufferTargetSizeRef.current = 5
    }
  }, [fps])

  // Generate QR in worker (for data chunks only)
  const generateQRInWorker = useCallback((binaryString: string, options: { errorCorrectionLevel?: string; width?: number; margin?: number; color?: { dark: string; light: string } }): Promise<string> => {
    // Check if we should skip worker due to recent failures (exponential backoff)
    const currentChunkNum = chunkCountRef.current + bufferLengthRef.current
    const shouldSkipWorker = currentChunkNum < workerSkipUntilChunkRef.current

    // Convert binary string back to Uint8Array for zxing-wasm
    const binaryData = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      binaryData[i] = binaryString.charCodeAt(i) & 0xFF
    }

    // Generate QR directly using zxing-wasm (writeBarcode is efficient enough)
    const generateZXingQR = async (): Promise<string> => {
      const result = await writeBarcode(binaryData, {
        format: 'QRCode',
        ecLevel: (options.errorCorrectionLevel as 'L' | 'M' | 'Q' | 'H') || 'M',
        sizeHint: options.width || 400,
        withQuietZones: true
      })

      if (result.error) {
        throw new Error(result.error)
      }

      // Convert Blob to data URL
      return URL.createObjectURL(result.image as Blob)
    }

    if (shouldSkipWorker) {
      // Direct generation during backoff period
      return generateZXingQR()
    }

    const workerPromise = new Promise<string>((resolve, reject) => {
      if (!workerRef.current) {
        // Fallback to direct zxing generation if worker is unavailable
        generateZXingQR().then(resolve).catch(reject)
        return
      }

      const id = requestIdRef.current++
      // Adaptive timeout: start at 8s for first few chunks, lower after consecutive successes
      const adaptiveTimeout = consecutiveWorkerSuccessesRef.current < 5 ? 8000 : 5000
      const timeout = setTimeout(() => {
        pendingRequests.current.delete(id)
        reject(new Error('Worker timeout'))
      }, adaptiveTimeout)

      pendingRequests.current.set(id, {
        resolve: (qrUrl: string) => {
          clearTimeout(timeout)
          // Success! Reset failure counter and increment success counter
          consecutiveWorkerFailuresRef.current = 0
          consecutiveWorkerSuccessesRef.current++
          setWorkerFallbackHint('')
          resolve(qrUrl)
        },
        reject: (err: Error) => {
          clearTimeout(timeout)
          reject(err)
        }
      })

      try {
        workerRef.current.postMessage({ type: 'generate', id, binaryString, options })
      } catch (err) {
        console.warn('Worker postMessage failed; falling back:', err)
        clearTimeout(timeout)
        pendingRequests.current.delete(id)
        // Fallback to direct zxing generation on worker error
        generateZXingQR().then(resolve).catch(reject)
      }
    })

    return workerPromise.catch((err) => {
      console.warn('QR worker failed, falling back to main thread:', err)

      // Track consecutive failures and reset success counter
      consecutiveWorkerFailuresRef.current++
      consecutiveWorkerSuccessesRef.current = 0
      const failures = consecutiveWorkerFailuresRef.current

      // Apply exponential backoff after N consecutive failures
      if (failures >= 3) {
        // Skip worker for next M chunks (exponential: 2^failures)
        const skipChunks = Math.min(Math.pow(2, failures - 2), 64) // Cap at 64 chunks
        workerSkipUntilChunkRef.current = currentChunkNum + skipChunks

        console.warn(`${failures} consecutive worker failures. Skipping worker for next ${skipChunks} chunks.`)

        // Reduce FPS temporarily on persistent failures
        if (failures >= 5) {
          originalFpsRef.current = fpsRef.current
          const reducedFps = Math.max(Math.floor(fpsRef.current * 0.7), 2)
          onFpsChange(reducedFps)
          console.warn(`Reducing FPS from ${fpsRef.current} to ${reducedFps} due to worker failures`)
        }

        // Increase buffer size target temporarily
        if (failures >= 4) {
          originalBufferTargetRef.current = bufferTargetSizeRef.current
          bufferTargetSizeRef.current = Math.min(bufferTargetSizeRef.current + 2, 10)
          console.warn(`Increasing buffer target to ${bufferTargetSizeRef.current}`)
        }

        // Set user-visible hint
        if (failures >= 5) {
          setWorkerFallbackHint(`Performance issues detected. Using slower QR generation (${failures} failures).`)
        } else if (failures >= 3) {
          setWorkerFallbackHint('Using zxing-wasm QR generation method.')
        }
      }

      return generateZXingQR()
    })
  }, [chunkCountRef, bufferLengthRef, fpsRef, onFpsChange])

  // Generate and display fountain-coded chunk in binary format
  useEffect(() => {
    const bufferTargetSize = bufferTargetSizeRef.current
    if (!isActive) return
    if (!encoder || isGeneratingBuffer || bufferLength >= bufferTargetSize) return

    // Throttle buffer generation based on FPS
    // Don't generate new chunks faster than the display rate
    const minTimeBetweenGenerations = 1000 / fps / 2 // Generate at most 2x the display rate
    const now = Date.now()
    const timeSinceLastGeneration = now - lastBufferGenerationRef.current

    if (timeSinceLastGeneration < minTimeBetweenGenerations && lastBufferGenerationRef.current > 0) {
      // Too soon to generate another chunk, schedule for later
      const timeoutId = setTimeout(() => {
        // Trigger re-check by updating buffer length state
        setBufferLength(chunkBufferRef.current.length)
      }, minTimeBetweenGenerations - timeSinceLastGeneration)
      return () => clearTimeout(timeoutId)
    }

    const generateBufferChunk = async () => {
      setIsGeneratingBuffer(true)
      lastBufferGenerationRef.current = Date.now()

      try {
        const batch: Array<{chunk: FountainChunk, qrUrl: string, chunkNum: number}> = []
        const maxRetries = 20

        // Generate only one chunk at a time to respect FPS throttling
        const chunksToGenerate = Math.min(1, bufferTargetSize - bufferLength)

        while (batch.length < chunksToGenerate) {
          let attempt = 0
          let success = false

          while (attempt < maxRetries && !success) {
            try {
              const chunk = encoder.generateChunk()

              const numIndices = chunk.indices.length
              const expectedSize =
                2 + // magic bytes
                2 + // seed
                1 + // degree
                1 + // numIndices
                (numIndices * 2) + // indices (2 bytes each)
                chunk.data.length + // chunk data
                4 // CRC32 checksum (4 bytes)

              if (expectedSize > MAX_QR_DATA_SIZE) {
                attempt++
                continue
              }

              const binaryData = new Uint8Array(expectedSize)
              let offset = 0
              binaryData[offset++] = 0xFF // Magic byte 1
              binaryData[offset++] = 0xFD // Magic byte 2

              // Seed (2 bytes)
              binaryData[offset++] = (chunk.seed >> 8) & 0xFF
              binaryData[offset++] = chunk.seed & 0xFF

              // Degree (1 byte)
              binaryData[offset++] = chunk.degree & 0xFF

              // Number of indices (1 byte)
              binaryData[offset++] = numIndices & 0xFF

              // Indices (2 bytes each)
              for (const idx of chunk.indices) {
                binaryData[offset++] = (idx >> 8) & 0xFF
                binaryData[offset++] = idx & 0xFF
              }

              // Chunk data
              binaryData.set(chunk.data, offset)
              offset += chunk.data.length

              // Compute and append CRC32 checksum over complete chunk metadata and data
              // Checksum is computed over: seed(2) + degree(1) + numIndices(1) + indices(2N) + data
              const checksumPayload = binaryData.slice(2, offset) // Everything except magic bytes
              const checksumHex = await computeChecksum(checksumPayload, 'crc32')
              // Convert hex string to 4 bytes (big-endian)
              for (let i = 0; i < 8; i += 2) {
                const byte = parseInt(checksumHex.slice(i, i + 2), 16)
                binaryData[offset++] = byte
              }

              const binaryString = String.fromCharCode(...binaryData)

              const dataUrl = await generateQRInWorker(binaryString, {
                  width: 400,
                  margin: currentQROptions.margin,
                  errorCorrectionLevel: currentQROptions.errorCorrectionLevel,
                  color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                  }
                })

              const chunkNum = chunkCount + bufferLength + batch.length + 1
              batch.push({ chunk, qrUrl: dataUrl, chunkNum })
              success = true

            } catch (err) {
              attempt++
              if (attempt >= maxRetries) {
                console.error('Failed to generate buffer chunk after max retries:', err)
              }
            }
          }

          if (!success) break // Stop trying if we can't generate any more chunks
        }

        // Single batched state update
        if (batch.length > 0) {
          pushToBuffer(batch)
        }
      } finally {
        setIsGeneratingBuffer(false)
      }
    }

    generateBufferChunk()
  }, [encoder, isGeneratingBuffer, bufferLength, chunkCount, fps, currentQROptions.margin, currentQROptions.errorCorrectionLevel, MAX_QR_DATA_SIZE, isActive, generateQRInWorker, pushToBuffer, chunkCountRef, bufferLengthRef, fpsRef])

  // Generate and display fountain-coded chunk in binary format
  const generateAndShowNextChunk = async () => {
    if (!encoder) return

    const maxRetries = 20 // Maximum attempts to find a chunk that fits
    let attempt = 0

    while (attempt < maxRetries) {
      try {
        // Generate next fountain-coded chunk (internally tuned distribution + doping)
        const chunk = encoder.generateChunk()

        // Binary format for fountain chunk:
        // [0xFF][0xFD] - magic bytes for fountain chunk
        // [seed(2 bytes)]
        // [degree(1 byte)]
        // [numIndices(1 byte)]
        // [indices... (2 bytes each)]
        // [chunk data...]
        // [checksum(4 bytes)] - CRC32 checksum over seed+degree+numIndices+indices+data

        const numIndices = chunk.indices.length
        const expectedSize =
          2 + // magic bytes
          2 + // seed
          1 + // degree
          1 + // numIndices
          (numIndices * 2) + // indices (2 bytes each)
          chunk.data.length + // chunk data
          4 // CRC32 checksum (4 bytes)

        // Guardrail test for worst-case data QR size (dev-only)
        if (import.meta.env.DEV) {
          console.assert(expectedSize <= 1204, `QR size ${expectedSize} exceeds limit 1204 for blockSize=400, maxDegree<=40`)
        }

        // Pre-check: Skip chunks that are too large before attempting QR generation
        if (expectedSize > MAX_QR_DATA_SIZE) {
          console.warn(`Pre-check: Chunk size ${expectedSize} bytes exceeds limit ${MAX_QR_DATA_SIZE}, skipping (attempt ${attempt + 1}/${maxRetries})`)
          attempt++
          continue
        }

        const binaryData = new Uint8Array(expectedSize)

        let offset = 0
        binaryData[offset++] = 0xFF // Magic byte 1
        binaryData[offset++] = 0xFD // Magic byte 2 (different from metadata)

        // Seed (2 bytes)
        binaryData[offset++] = (chunk.seed >> 8) & 0xFF
        binaryData[offset++] = chunk.seed & 0xFF

        // Degree (1 byte)
        binaryData[offset++] = chunk.degree & 0xFF

        // Number of indices (1 byte)
        binaryData[offset++] = numIndices & 0xFF

        // Indices (2 bytes each)
        for (const idx of chunk.indices) {
          binaryData[offset++] = (idx >> 8) & 0xFF
          binaryData[offset++] = idx & 0xFF
        }

        // Chunk data
        binaryData.set(chunk.data, offset)
        offset += chunk.data.length

        // Compute and append CRC32 checksum over complete chunk metadata and data
        // Checksum is computed over: seed(2) + degree(1) + numIndices(1) + indices(2N) + data
        const checksumPayload = binaryData.slice(2, offset) // Everything except magic bytes
        const checksumHex = await computeChecksum(checksumPayload, 'crc32')
        // Convert hex string to 4 bytes (big-endian)
        for (let i = 0; i < 8; i += 2) {
          const byte = parseInt(checksumHex.slice(i, i + 2), 16)
          binaryData[offset++] = byte
        }

        // Convert to string for QR encoding (ISO-8859-1/Latin1)
        const binaryString = String.fromCharCode(...binaryData)

        const dataUrl = await generateQRInWorker(binaryString, {
          width: 400,
          margin: currentQROptions.margin,
          errorCorrectionLevel: currentQROptions.errorCorrectionLevel,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })

        // Success! Update state and display
        currentChunkRef.current = chunk
        setChunkCount(prev => {
          const next = prev + 1
          onChunkGenerated(next, chunk)
          return next
        })
        setQrCodeUrl(dataUrl)
        lastSuccessfulQrRef.current = dataUrl
        return // Exit successfully

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)

        // Check if error is about data being too big
        if (errorMsg.includes('too big') || errorMsg.includes('too large') || errorMsg.includes('too much')) {
          console.warn(`Chunk too large for QR code (attempt ${attempt + 1}/${maxRetries}), generating new chunk...`)
          attempt++
          // Try again with a new chunk
          continue
        } else {
          // Other error, stop and report
          console.error('QR generation error:', err)
          onError('Failed to generate QR code: ' + errorMsg)
          return
        }
      }
    }

    // If we exhausted all retries, show warning but keep last successful QR
    console.error(`Failed to generate QR after ${maxRetries} attempts - data chunks too large`)
    onError(`Warning: Some chunks are too large for QR codes`)
  }

  // Animation loop
  useEffect(() => {
    if (!isPlaying || !encoder || !isActive) return

    // Generate first chunk immediately (from buffer if available, otherwise generate)
    const bufferedItem = consumeFromBuffer()
    if (bufferedItem) {
      currentChunkRef.current = bufferedItem.chunk
      setChunkCount(bufferedItem.chunkNum)
      setQrCodeUrl(bufferedItem.qrUrl)
      lastSuccessfulQrRef.current = bufferedItem.qrUrl
      onChunkGenerated(bufferedItem.chunkNum, bufferedItem.chunk)
    } else {
      generateAndShowNextChunk()
    }

    const interval = setInterval(() => {
      const bufferedItem = consumeFromBuffer()
      if (bufferedItem) {
        currentChunkRef.current = bufferedItem.chunk
        setChunkCount(bufferedItem.chunkNum)
        setQrCodeUrl(bufferedItem.qrUrl)
        lastSuccessfulQrRef.current = bufferedItem.qrUrl
        onChunkGenerated(bufferedItem.chunkNum, bufferedItem.chunk)
      } else {
        generateAndShowNextChunk()
      }
    }, 1000 / fps)

    return () => clearInterval(interval)
    // generateAndShowNextChunk is intentionally omitted from deps to prevent re-subscription churn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, encoder, fps, isActive, onChunkGenerated])

  const handlePlayPause = () => {
    if (!isPlaying && encoder) {
      setChunkCount(0)
      clearBuffer() // Clear buffer on restart
    }
    setIsPlaying(!isPlaying)
  }

  const handleSpeedChange = (newFps: number) => {
    // Snap to common frame rates
    const snapPoints = [1, 2, 5, 10, 15, 20, 24, 25, 30, 45, 60]
    const threshold = 2 // pixels of "stickiness"

    const closestSnap = snapPoints.reduce((closest, snap) => {
      return Math.abs(snap - newFps) < Math.abs(closest - newFps) ? snap : closest
    })

    if (Math.abs(closestSnap - newFps) <= threshold) {
      onFpsChange(closestSnap)
    } else {
      onFpsChange(newFps)
    }
  }

  const sourceBlocks = encoder?.getMetadata().totalSourceBlocks || 0
  const receivedBlocksCount = receivedBlocks.size
  const decodingProgress = sourceBlocks > 0 ? (receivedBlocksCount / sourceBlocks) * 100 : 0

  return (
    <div className="space-y-4">
      {/* QR Code Display (styled to match receiver scanning palette) */}
      <div className="relative mx-auto w-full max-w-md overflow-hidden rounded-2xl border border-sky-500/40 bg-slate-950/90 p-6 shadow-[0_35px_65px_-35px_rgba(56,189,248,0.7)]">
        <div className="pointer-events-none absolute inset-4 rounded-2xl border border-sky-400/30" />
        <div className="relative flex items-center justify-center">
          {qrCodeUrl ? (
            <img
              src={qrCodeUrl}
              alt="Fountain coded chunk"
              className="h-auto max-w-full drop-shadow-[0_15px_25px_rgba(14,165,233,0.35)]"
              width="400"
              height="400"
            />
          ) : (
            <div className="flex h-[340px] w-[340px] flex-col items-center justify-center rounded-xl border border-sky-400/30 bg-sky-500/10 text-sky-100/80 backdrop-blur-sm">
              <p className="text-center text-sm font-medium">
                {encoder ? 'Generating fountain-coded QR stream…' : 'Processing file...'}
              </p>
              <p className="mt-2 text-xs text-sky-200/70">Keep the display steady for best scan quality.</p>
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-12 bottom-8 h-16 rounded-full bg-sky-500/10 blur-3xl" />
      </div>

      {/* Caption / Status outside the QR container */}
      <div className="flex items-center justify-center gap-2 flex-wrap text-xs text-muted-foreground">
        <span className={`px-2 py-0.5 rounded flex items-center gap-1 font-semibold min-w-[60px] justify-center ${
          isPlaying ? 'bg-sky-600 text-white shadow-sm shadow-sky-500/40' : 'bg-sky-200 text-sky-700'
        }`}>
          <span className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-white animate-pulse shadow-[0_0_6px_theme(colors.white/70%)]' : 'bg-sky-500'}`} /> LIVE
        </span>
        <span className={`hidden`}>
          Buffer: {bufferLength || 0}
        </span>
      </div>

      {/* Worker fallback hint */}
      {workerFallbackHint && (
        <div className="text-center">
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {workerFallbackHint}
          </p>
        </div>
      )}

      {/* Progress */}
      {chunkCount > 0 && (
        <div className="space-y-1 text-sm">
          <div className="flex flex-wrap justify-center gap-2 text-center">
            <span className="font-medium">Sent {chunkCount} chunk{chunkCount === 1 ? '' : 's'}</span>
            <span className="opacity-70">(~{estimatedChunksNeeded} typically needed)</span>
          </div>
          <div className="flex items-center justify-center gap-3 text-xs flex-wrap">
            {receivedBlocksCount > 0 ? (
              <p className="text-muted-foreground">
                Receiver has decoded {receivedBlocksCount}/{sourceBlocks} blocks ({decodingProgress.toFixed(0)}%)
              </p>
            ) : (
              <p className="text-muted-foreground">
                {chunkCount >= estimatedChunksNeeded
                  ? '✅ Receiver should now be able to decode'
                  : `${estimatedChunksNeeded - chunkCount} more recommended for high success chance`}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="space-y-3">
        <div className="flex gap-2 justify-center">
          <Button
            size="sm"
            onClick={handlePlayPause}
            disabled={!encoder}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
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
      </div>

      {/* Instructions */}
      <Alert>
        <AlertDescription>
          <p className="font-medium mb-2">📱 Fountain Code Transfer Mode:</p>
          <ol className="list-decimal list-inside space-y-1 text-sm">
            <li>Each chunk combines multiple source blocks via XOR</li>
            <li>Receiver doesn't need ALL chunks - just enough (~110%)</li>
            <li>Can skip/miss chunks and still decode successfully</li>
            <li>Keep playing until receiver shows 100% decoded</li>
            <li>More robust than sequential chunk transfer</li>
          </ol>
        </AlertDescription>
      </Alert>
    </div>
  )
}
