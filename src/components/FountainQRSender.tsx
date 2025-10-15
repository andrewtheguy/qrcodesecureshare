import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Slider } from '@/components/ui/slider'
import { FountainEncoder, type FountainChunk } from '@/utils/fountainCode'
import type { FountainFeedback, FountainFeedbackTargeted, SenderFeedback } from '@/types/fountainFeedback'
import { computeChecksum } from '@/utils/checksum'
import { DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig'
import QRWorker from '../workers/qrGenerator.worker.ts?worker'

interface FountainQRSenderProps {
  file: File
  sessionId: number
  qrOptions?: {
    errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'
    margin: number
  }
}

// Maximum QR code size in bytes (with some safety margin)
const MAX_QR_DATA_SIZE = 1300 // Increased due to lower error correction level

export function FountainQRSender({ file, sessionId, qrOptions = { errorCorrectionLevel: 'L', margin: 1 } }: FountainQRSenderProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(4)
  const [error, setError] = useState<string>('')
  const [chunkCount, setChunkCount] = useState(0)
  const [skippedChunks, setSkippedChunks] = useState(0)
  const [estimatedChunksNeeded, setEstimatedChunksNeeded] = useState(0)
  const [scanningFeedback, setScanningFeedback] = useState(false)
  const [receivedBlocks, setReceivedBlocks] = useState<Set<number>>(new Set())
  const [windowInfo, setWindowInfo] = useState<{
    windowEnabled: boolean
    windowStart: number
    windowEnd: number
    windowSize: number
    totalBlocks: number
    isWindowComplete: boolean
    skipBlocksBelow: number
  } | null>(null)
  const [lastWindowExpansion, setLastWindowExpansion] = useState<number | null>(null)
  const [lastDecodedInWindow, setLastDecodedInWindow] = useState<number>(0)
  const [lastStats, setLastStats] = useState<{
    totalDecoded: number
    totalBlocks: number
    windowStart?: number
    windowEnd?: number
  } | null>(null)
  const [lastProcessedSequence, setLastProcessedSequence] = useState<number>(-1)
  const [defragMode, setDefragMode] = useState(false)
  const [defragTargets, setDefragTargets] = useState<number[]>([])
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0)
  const [currentQROptions, setCurrentQROptions] = useState(qrOptions)
  const [senderFeedbackMessage, setSenderFeedbackMessage] = useState<string>('')
  const [senderMode, setSenderMode] = useState<'data-display' | 'feedback-scanning' | 'ack-display'>('data-display')
  const [lastAckQRUrl, setLastAckQRUrl] = useState<string>('')
  const [chunkBuffer, setChunkBuffer] = useState<Array<{chunk: FountainChunk, qrUrl: string, chunkNum: number}>>([])
  const [isGeneratingBuffer, setIsGeneratingBuffer] = useState(false)
  const bufferTargetSizeRef = useRef(5) // Dynamic buffer size based on FPS
  const lastBufferGenerationRef = useRef(0) // Track last buffer generation time
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const currentChunkRef = useRef<FountainChunk | null>(null)
  const lastSuccessfulQrRef = useRef<string>('')
  const feedbackVideoRef = useRef<HTMLVideoElement>(null)
  const feedbackScannerRef = useRef<QrScanner | null>(null)
  const processingRef = useRef(false)
  const workerRef = useRef<Worker | null>(null)
  const pendingRequests = useRef<Map<number, {resolve: (url: string) => void, reject: (err: Error) => void}>>(new Map())
  const requestIdRef = useRef(0)

  // Initialize fountain encoder when file is loaded
  useEffect(() => {
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer
        const bytes = new Uint8Array(arrayBuffer)

        const metadata = {
          name: file.name,
          size: file.size,
          type: file.type,
          timestamp: Date.now()
        }

        const fountainEncoder = new FountainEncoder(bytes, metadata, {
           blockSize: DEFAULT_BLOCK_SIZE,
           c: 0.2,
               delta: 0.01,
            // Optional: override doping rates here if experimenting
            degree1Rate: 0.08
         })

         // Runtime sanity check: compare fountainEncoder.getMetadata().blockSize with DEFAULT_BLOCK_SIZE
         const encoderBlockSize = fountainEncoder.getMetadata().blockSize
         if (encoderBlockSize !== DEFAULT_BLOCK_SIZE) {
           setError(`Block size mismatch: encoder has ${encoderBlockSize} bytes, expected ${DEFAULT_BLOCK_SIZE} bytes`)
           console.warn(`Block size mismatch detected: encoder=${encoderBlockSize}, DEFAULT_BLOCK_SIZE=${DEFAULT_BLOCK_SIZE}`)
           return
         }

        setEncoder(fountainEncoder)
        setWindowInfo(fountainEncoder.getWindowInfo())
        setError('')
        setChunkCount(0)
        setLastAckQRUrl('')

        // Estimate chunks needed: typically 105-110% of source blocks
        const meta = fountainEncoder.getMetadata()
        setEstimatedChunksNeeded(Math.ceil(meta.totalSourceBlocks * 1.1))
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

  // Auto-start playback once encoder is ready (no need to wait for receiver now)
  useEffect(() => {
    if (encoder && !isPlaying) {
      // Reset counters for fresh session
      setChunkCount(0)
      setSkippedChunks(0)
      setIsPlaying(true)
    }
    // We intentionally exclude isPlaying setters from deps to avoid restarting mid-session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoder])

  // Reset lastProcessedSequence on new session or file to avoid stale UI/state carryover
  useEffect(() => {
     setLastProcessedSequence(-1)
  }, [sessionId, file])

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
      console.warn('Module workers not supported, falling back to main thread QR generation:', err)
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

  // Background chunk generation effect for buffering with FPS-aware throttling
  useEffect(() => {
    const bufferTargetSize = bufferTargetSizeRef.current
    if (!encoder || isGeneratingBuffer || chunkBuffer.length >= bufferTargetSize) return

    // Throttle buffer generation based on FPS
    // Don't generate new chunks faster than the display rate
    const minTimeBetweenGenerations = 1000 / fps / 2 // Generate at most 2x the display rate
    const now = Date.now()
    const timeSinceLastGeneration = now - lastBufferGenerationRef.current

    if (timeSinceLastGeneration < minTimeBetweenGenerations && lastBufferGenerationRef.current > 0) {
      // Too soon to generate another chunk, schedule for later
      const timeoutId = setTimeout(() => {
        // Trigger re-check by updating a dummy state
        setChunkBuffer(prev => prev.slice()) // No-op update to trigger effect
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
        const chunksToGenerate = Math.min(1, bufferTargetSize - chunkBuffer.length)

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

              // Compute and append CRC32 checksum of chunk data
              const checksumHex = await computeChecksum(chunk.data, 'crc32')
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

              const chunkNum = chunkCount + chunkBuffer.length + batch.length + 1
              batch.push({ chunk, qrUrl: dataUrl, chunkNum })
              success = true

            } catch (err) {
              attempt++
              if (attempt >= maxRetries) {
                console.error('Failed to generate buffer chunk after max retries')
              }
            }
          }

          if (!success) break // Stop trying if we can't generate any more chunks
        }

        // Single batched state update
        if (batch.length > 0) {
          setChunkBuffer(prev => [...prev, ...batch])
        }
      } finally {
        setIsGeneratingBuffer(false)
      }
    }

    generateBufferChunk()
  }, [encoder, isGeneratingBuffer, chunkBuffer.length, chunkCount, fps])

  // Generate QR in worker
  const generateQRInWorker = (binaryString: string, options: object): Promise<string> => {
    const workerPromise = new Promise<string>((resolve, reject) => {
      if (!workerRef.current) {
        // Fallback to direct QRCode.toDataURL if worker is unavailable
        QRCode.toDataURL(binaryString, options).then(resolve).catch(reject)
        return
      }

      const id = requestIdRef.current++
      const timeout = setTimeout(() => {
        pendingRequests.current.delete(id)
        reject(new Error('Worker timeout'))
      }, 5000) // 5 second timeout

      pendingRequests.current.set(id, {
        resolve: (qrUrl: string) => {
          clearTimeout(timeout)
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
        clearTimeout(timeout)
        pendingRequests.current.delete(id)
        // Fallback to direct QRCode.toDataURL on worker error
        QRCode.toDataURL(binaryString, options).then(resolve).catch(reject)
      }
    })

    return workerPromise.catch((err) => {
      console.warn('QR worker failed, falling back to main thread:', err)
      return QRCode.toDataURL(binaryString, options)
    })
  }

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
        // [checksum(4 bytes)] - CRC32 checksum of chunk data

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
           setSkippedChunks(prev => prev + 1)
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

        // Compute and append CRC32 checksum of chunk data
        const checksumHex = await computeChecksum(chunk.data, 'crc32')
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
        setChunkCount(prev => prev + 1)
        setQrCodeUrl(dataUrl)
        lastSuccessfulQrRef.current = dataUrl
        return // Exit successfully

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)

        // Check if error is about data being too big
        if (errorMsg.includes('too big') || errorMsg.includes('too large') || errorMsg.includes('too much')) {
          console.warn(`Chunk too large for QR code (attempt ${attempt + 1}/${maxRetries}), generating new chunk...`)
          setSkippedChunks(prev => prev + 1)
          attempt++
          // Try again with a new chunk
          continue
        } else {
          // Other error, stop and report
          console.error('QR generation error:', err)
          setError('Failed to generate QR code: ' + errorMsg)
          return
        }
      }
    }

    // If we exhausted all retries, show warning but keep last successful QR
    console.error(`Failed to generate QR after ${maxRetries} attempts - data chunks too large`)
    setError(`Warning: Some chunks are too large for QR codes (${skippedChunks} skipped)`)
  }

  // Metadata generation removed – handled by parent component


  // Animation loop
  useEffect(() => {
     if (!isPlaying || !encoder || senderMode !== 'data-display') return

     // Generate first chunk immediately (from buffer if available, otherwise generate)
     if (chunkBuffer.length > 0) {
       const bufferedItem = chunkBuffer[0]
       currentChunkRef.current = bufferedItem.chunk
       setChunkCount(prev => prev + 1)
       setQrCodeUrl(bufferedItem.qrUrl)
       lastSuccessfulQrRef.current = bufferedItem.qrUrl
       setChunkBuffer(prev => prev.slice(1))
     } else {
       generateAndShowNextChunk()
     }

     const interval = setInterval(() => {
       if (chunkBuffer.length > 0) {
         const bufferedItem = chunkBuffer[0]
         currentChunkRef.current = bufferedItem.chunk
         setChunkCount(prev => prev + 1)
         setQrCodeUrl(bufferedItem.qrUrl)
         lastSuccessfulQrRef.current = bufferedItem.qrUrl
         setChunkBuffer(prev => prev.slice(1))
       } else {
         generateAndShowNextChunk()
       }
     }, 1000 / fps)

     return () => clearInterval(interval)
  }, [isPlaying, encoder, fps, senderMode, chunkBuffer])

  const handlePlayPause = () => {
     if (!isPlaying && encoder) {
       setChunkCount(0)
       setSkippedChunks(0)
       setChunkBuffer([]) // Clear buffer on restart
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
      setFps(closestSnap)
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


  const generateSenderFeedbackQR = async (feedback: SenderFeedback): Promise<void> => {
    const feedbackJson = JSON.stringify(feedback)
    const dataUrl = await generateQRInWorker(feedbackJson, { width: 400, margin: currentQROptions.margin, errorCorrectionLevel: 'M' })
    setSenderFeedbackSequence(prev => prev + 1)
    setLastAckQRUrl(dataUrl)
  }

  const handleFeedbackScan = async (data: string) => {
    // Guard against multiple rapid callbacks
    if (processingRef.current) {
      console.warn('Already processing feedback, ignoring duplicate callback')
      return
    }
    processingRef.current = true

    let valid = true
    try {
      const feedback: FountainFeedback = JSON.parse(data)

      // Early validation guard
      if (feedback.type !== 'FOUNTAIN_FEEDBACK' || typeof feedback.sessionId !== 'number' || feedback.sessionId !== sessionId) {
        console.warn(`Invalid feedback: expected type='FOUNTAIN_FEEDBACK' and sessionId=${sessionId}, got type='${feedback.type}' and sessionId=${feedback.sessionId}`)
        valid = false
      }

      const feedbackSequence = feedback.sequence

      // Validate sequence is a number
      if (typeof feedbackSequence !== 'number') {
        console.warn('Invalid feedback: missing or invalid sequence number')
        valid = false
      }

      // Reject duplicate or out-of-order feedback
      if (feedbackSequence <= lastProcessedSequence) {
        console.warn(`Ignoring duplicate/stale feedback: sequence ${feedbackSequence} (last processed: ${lastProcessedSequence})`)
        valid = false
      }

      if (!valid) {
        // cleanup
        feedbackScannerRef.current?.stop()
        setScanningFeedback(false)
        processingRef.current = false
        return
      }

       if (feedback.type === 'FOUNTAIN_FEEDBACK') {
        // Extract firstMissingBlock from feedback (default to 0 if not present)
        const firstMissingBlock = feedback.firstMissingBlock ?? 0

        console.log('Processing feedback sequence:', feedbackSequence, '(last:', lastProcessedSequence, ')')

        // Handle both statistics and targeted feedback modes
        if (feedback.mode === 'statistics') {
          // Statistics-only feedback - no targeted encoding
          console.log('Received statistics feedback:', feedback.totalDecoded, '/', feedback.totalBlocks, 'blocks')
  
          // Handle ECC level upgrade request
          if (feedback.requestHigherECC) {
            console.log('📈 Receiver requested higher ECC level due to scan failures')
            setCurrentQROptions(prev => ({ ...prev, errorCorrectionLevel: 'M' }))
            setSenderFeedbackMessage('Switched to higher error correction level (M) for better scan reliability')
          }
  
          // Handle defrag targets
          if (feedback.defragTargets && feedback.defragTargets.length > 0) {
            if (encoder) {
              encoder.setDefragTargets(feedback.defragTargets)
              setDefragMode(true)
              setDefragTargets(feedback.defragTargets)
              console.log('🔧 Defrag mode activated:', feedback.defragTargets.length, 'targets')
            }
          } else if (defragMode) {
            // Defrag was active but no longer requested - exit
            if (encoder) {
              encoder.exitDefragMode()
              setDefragMode(false)
              setDefragTargets([])
            }
          }
  
  
          // Clear targeted mode so encoder doesn't use stale missing-blocks information
          if (encoder) {
            encoder.setReceivedBlocks([])
          }
  
          // Clear buffer when state changes
          setChunkBuffer([])
  
          // Clear buffer when state changes
          setChunkBuffer([])
  
          // Apply skip threshold
          if (encoder) {
            encoder.setSkipBlocksBelow(firstMissingBlock)
            setWindowInfo(encoder.getWindowInfo())
            console.log('Skip blocks below:', firstMissingBlock, '(contiguous prefix)')
          }
  
          // Update UI state for progress display
          setReceivedBlocks(new Set()) // Clear targeted mode
          setLastStats({
            totalDecoded: feedback.totalDecoded,
            totalBlocks: feedback.totalBlocks,
            windowStart: feedback.windowStart,
            windowEnd: feedback.windowEnd,
          })
  
          // Check if window expansion is requested
          if (encoder && feedback.requestWindowExpansion) {
            const currentWindow = encoder.getWindowInfo()
            if (!currentWindow.isWindowComplete) {
              const now = Date.now()
              if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
                const expanded = encoder.expandWindow()
                if (expanded) {
                  setWindowInfo(encoder.getWindowInfo())
                  setLastWindowExpansion(now)
                  console.log('Window expanded based on statistics feedback:', encoder.getWindowInfo())
                }
              }
            }
          }
  
          // Update estimated chunks based on statistics
          const totalBlocks = encoder?.getMetadata().totalSourceBlocks || 0
          const missingBlocks = totalBlocks - feedback.totalDecoded
          if (missingBlocks > 0) {
            setEstimatedChunksNeeded(chunkCount + Math.ceil(missingBlocks * 1.1))
          }
  
          // Generate ACK QR
          const ackFeedback: SenderFeedback = {
            type: 'SENDER_FEEDBACK',
            sessionId: sessionId,
            sequence: senderFeedbackSequence,
            command: 'acknowledge',
            acknowledgedSequence: feedbackSequence,
            message: `Feedback processed successfully. Window expanded, ${feedback.totalDecoded}/${feedback.totalBlocks} blocks decoded.`
          }
          await generateSenderFeedbackQR(ackFeedback)
          setSenderMode('ack-display')
  
          // Update last processed sequence after successful processing
          setLastProcessedSequence(feedbackSequence)
          console.log('Feedback processed - ACK QR generated')
        } else if (feedback.mode === 'targeted') {
           // Targeted feedback with missing block indices
           const missingBlocks = (feedback as FountainFeedbackTargeted).missingBlocks
           console.log('Received targeted feedback:', missingBlocks.length, 'missing blocks')

           // Handle defrag targets
           if (feedback.defragTargets && feedback.defragTargets.length > 0) {
             if (encoder) {
               encoder.setDefragTargets(feedback.defragTargets)
               setDefragMode(true)
               setDefragTargets(feedback.defragTargets)
               console.log('🔧 Defrag mode activated:', feedback.defragTargets.length, 'targets')
             }
           } else if (defragMode) {
             // Defrag was active but no longer requested - exit
             if (encoder) {
               encoder.exitDefragMode()
               setDefragMode(false)
               setDefragTargets([])
             }
           }


           // Enable targeted encoding with missing blocks
           setReceivedBlocks(new Set()) // Clear received blocks since we're now using missing blocks
           setLastStats(null) // Clear statistics mode
           if (encoder) {
             encoder.setMissingBlocks(missingBlocks)
             encoder.setSkipBlocksBelow(firstMissingBlock)
             setWindowInfo(encoder.getWindowInfo())
             console.log('Skip blocks below:', firstMissingBlock, '/', missingBlocks.length, 'missing')

             // Check for window expansion
             const currentWindow = encoder.getWindowInfo()
             if (!currentWindow.windowEnabled || currentWindow.isWindowComplete) {
               // Skip expansion logic if windowing not enabled or already complete
             } else {
               // Calculate decoded blocks in current window (total - missing in window)
               const missingInWindow = missingBlocks.filter((blockIdx: number) =>
                 blockIdx >= currentWindow.windowStart && blockIdx < currentWindow.windowEnd
               ).length
               const decodedInWindow = currentWindow.windowSize - missingInWindow

               if (decodedInWindow > lastDecodedInWindow) {
                 // Update last decoded count
                 setLastDecodedInWindow(decodedInWindow)

                 // Calculate window decode percentage
                 const windowDecodePercent = decodedInWindow / currentWindow.windowSize

                 // Check expansion trigger (50% threshold)
                 if (windowDecodePercent >= 0.5) {
                   // Check if we haven't expanded too recently (minimum 2 seconds between expansions)
                   const now = Date.now()
                   if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
                     const expanded = encoder.expandWindow()
                     if (expanded) {
                       setWindowInfo(encoder.getWindowInfo())
                       setLastWindowExpansion(now)
                       console.log('Window expanded:', encoder.getWindowInfo())
                     }
                   }
                 }
               }
             }
           }

           // Update estimated chunks needed based on feedback
           const blocksMissing = missingBlocks.length

           // Adjust estimate based on how many blocks are missing
           if (blocksMissing > 0) {
             // For missing blocks, we need ~1.5x chunks (more conservative for targeted encoding)
             setEstimatedChunksNeeded(chunkCount + Math.ceil(blocksMissing * 1.5))
           }

           // Clear buffer when switching to targeted mode
           setChunkBuffer([])

           // Generate ACK QR
           const ackFeedback: SenderFeedback = {
             type: 'SENDER_FEEDBACK',
             sessionId: sessionId,
             sequence: senderFeedbackSequence,
             command: 'acknowledge',
             acknowledgedSequence: feedbackSequence,
             message: `Targeted mode activated. Focusing on ${blocksMissing} missing blocks.`
           }
           await generateSenderFeedbackQR(ackFeedback)
           setSenderMode('ack-display')

           // Update last processed sequence after successful processing
           setLastProcessedSequence(feedbackSequence)
           console.log('Feedback processed - ACK QR generated')
        }

        setScanningFeedback(false)

        // Stop the scanner immediately after validation to avoid multiple rapid callbacks
        if (feedbackScannerRef.current) {
          feedbackScannerRef.current.stop()
        }
      }
    } catch (err) {
      console.error('Failed to parse feedback QR:', err)
      valid = false
    } finally {
      if (!valid) {
        // cleanup
        feedbackScannerRef.current?.stop()
        setScanningFeedback(false)
      }
      processingRef.current = false
    }
  }

  const wasPlayingRef = useRef(false)
  const handleStartFeedbackScan = () => {
    wasPlayingRef.current = isPlaying
    if (isPlaying) setIsPlaying(false)
    setScanningFeedback(true)
    setSenderMode('feedback-scanning')
    setError('')
  }

  const handleStopFeedbackScan = () => {
    setScanningFeedback(false)
    feedbackScannerRef.current?.stop()
    setSenderMode('data-display')
    if (wasPlayingRef.current) setIsPlaying(true)
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const sourceBlocks = encoder?.getMetadata().totalSourceBlocks || 0
  const receivedBlocksCount = receivedBlocks.size
  const decodingProgress = sourceBlocks > 0 ? (receivedBlocksCount / sourceBlocks) * 100 : 0

  return (
    <div className="space-y-4">
      {/* Feedback Scanner Mode */}
      {senderMode === 'feedback-scanning' && (
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
                Point camera at the receiver's feedback QR code to see decoding progress.
              </p>
              <Button onClick={handleStopFeedbackScan} variant="outline" className="w-full">
                Cancel Scan
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Window Progress Alert */}
      {windowInfo && windowInfo.windowEnabled && (
        <Alert>
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">🪟 Window Progress</p>
              <div className="text-sm">
                <p>Window: blocks {windowInfo.windowStart}-{windowInfo.windowEnd} of {windowInfo.totalBlocks} ({((windowInfo.windowSize / windowInfo.totalBlocks) * 100).toFixed(1)}% of file)</p>
                <p className="text-xs text-muted-foreground">Session ID: {sessionId}</p>
                {windowInfo.isWindowComplete ? (
                  <p className="text-green-600 dark:text-green-400 font-medium mt-1">
                    ✅ Full file now in transfer window
                  </p>
                ) : (
                  <p className="text-blue-600 dark:text-blue-400 font-medium mt-1">
                    📈 Window will expand automatically as blocks are decoded
                  </p>
                )}
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}


      {/* Receiver Progress Alert */}
      {(lastStats || receivedBlocksCount > 0) && (
        <Alert>
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">📊 Receiver Progress {receivedBlocksCount === 0 ? '(Statistics Mode)' : '(Targeted Mode Active)'}</p>
              <div className="text-sm">
                {receivedBlocksCount === 0 && lastStats ? (
                  <>
                    <p>Overall: {lastStats.totalDecoded} / {lastStats.totalBlocks} blocks ({((lastStats.totalDecoded / lastStats.totalBlocks) * 100).toFixed(1)}%)</p>
                          {windowInfo?.windowEnabled && lastStats.windowStart != null && lastStats.windowEnd != null && (
                            <p>Current window: blocks {lastStats.windowStart}-{lastStats.windowEnd}</p>
                          )}
                          {windowInfo && windowInfo.skipBlocksBelow > 0 && (
                            <p>Skipping blocks 0-{windowInfo.skipBlocksBelow - 1} (contiguous prefix decoded)</p>
                          )}
                          {lastProcessedSequence >= 0 && (
                            <p>Last feedback: sequence {lastProcessedSequence}</p>
                          )}
                          <p className="text-blue-600 dark:text-blue-400 font-medium mt-1">📈 Sending random chunks - targeted encoding will activate when only a few blocks remain</p>
                          {defragMode && (
                            <p className="text-orange-600 dark:text-orange-400 font-medium mt-1">
                              🔧 Defrag mode active: targeting {defragTargets.length} blocks
                            </p>
                          )}
                  </>
                ) : (
                  <>
                    {windowInfo && windowInfo.windowEnabled ? (
                      <>
                        <p>Overall: {receivedBlocksCount} / {sourceBlocks} blocks ({decodingProgress.toFixed(1)}%)</p>
                        <p>Current window: {Array.from(receivedBlocks).filter((blockIdx: number) =>
                          blockIdx >= windowInfo.windowStart && blockIdx < windowInfo.windowEnd
                        ).length} / {windowInfo.windowSize} blocks</p>
                        {windowInfo && windowInfo.skipBlocksBelow > 0 && (
                          <p>Skipping blocks 0-{windowInfo.skipBlocksBelow - 1} (contiguous prefix decoded)</p>
                        )}
                      </>
                    ) : (
                      <p>Decoded {receivedBlocksCount} / {sourceBlocks} blocks ({decodingProgress.toFixed(1)}%)</p>
                    )}
                    {decodingProgress >= 100 ? (
                      <p className="text-green-600 dark:text-green-400 font-medium mt-1">
                        ✅ Transfer complete! You can stop sending.
                      </p>
                    ) : (
                      <p className="text-blue-600 dark:text-blue-400 font-medium mt-1">
                        🎯 Targeted Mode Active - Focusing on {sourceBlocks - receivedBlocksCount} missing blocks
                        {defragMode && (
                          <span className="block text-orange-600 dark:text-orange-400">
                            🔧 Defrag mode active: prioritizing {defragTargets.length} blocks
                          </span>
                        )}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}


      {/* QR Code Display (clean container without overlays) */}
      <div className="flex justify-center bg-white p-4 rounded-lg">
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        {senderMode === 'data-display' && qrCodeUrl ? (
          <img
            src={qrCodeUrl}
            alt={`Fountain coded chunk`}
            className="max-w-full h-auto"
          />
        ) : senderMode === 'feedback-scanning' ? (
          <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
            <p className="text-muted-foreground">Feedback scanning mode active<br/>Scan receiver's feedback QR below</p>
          </div>
        ) : senderMode === 'ack-display' && lastAckQRUrl ? (
          <div className="space-y-3">
            <img src={lastAckQRUrl} alt="ACK QR Code" className="max-w-full h-auto" />
            <p className="text-sm text-center font-medium">ACK QR Code - Show to receiver</p>
            <p className="text-xs text-center text-muted-foreground">Receiver must scan this before resuming data scanning</p>
          </div>
        ) : (
          <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
            <p className="text-muted-foreground">
              {encoder ? 'Generating fountain-coded QR stream…' : 'Processing file...'}
            </p>
          </div>
        )}
      </div>

      {/* Caption / Status outside the QR container */}
      <div className="flex items-center justify-center gap-2 flex-wrap text-xs text-muted-foreground">
        <span className="font-medium">{chunkCount === 0 ? 'Ready' : `Chunk #${chunkCount}`}</span>
        {isPlaying && senderMode === 'data-display' && (
          <span className="px-2 py-0.5 rounded bg-red-500 text-white flex items-center gap-1 font-semibold">
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" /> LIVE
          </span>
        )}
        {senderMode === 'feedback-scanning' && (
          <span className="px-2 py-0.5 rounded bg-blue-500 text-white font-semibold">MODE: Scanning Feedback</span>
        )}
        {senderMode === 'ack-display' && (
          <span className="px-2 py-0.5 rounded bg-green-500 text-white font-semibold">MODE: ACK Display - Show to receiver</span>
        )}
        {skippedChunks > 0 && (
          <span className="px-2 py-0.5 rounded bg-amber-500 text-white font-semibold">Skipped {skippedChunks}</span>
        )}
        {chunkBuffer.length > 0 && (
          <span className="px-2 py-0.5 rounded bg-blue-500 text-white font-semibold">Buffer: {chunkBuffer.length}</span>
        )}
      </div>

      {/* Chunk details */}
      {(currentChunkRef.current && encoder) && (() => {
        const stats = encoder.getStats()
        return (
          <div className="text-xs text-center text-muted-foreground space-y-1">
            <div>
              <span className="font-medium">Degree: {currentChunkRef.current.degree}</span>
              <span className="mx-2">|</span>
              <span>Blocks: {currentChunkRef.current.indices.slice(0, 10).join(', ')}{currentChunkRef.current.indices.length > 10 ? '...' : ''}</span>
            </div>
            <div className="opacity-80">
              avg degree {stats.avgDegree.toFixed(2)} • coverage {(stats.uniqueBlockCoverage * 100).toFixed(1)}%
            </div>
          </div>
        )
      })()}

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
            {skippedChunks > 0 && (
              <p className="text-amber-600 dark:text-amber-400 font-medium">
                ⚠️ Skipped {skippedChunks}
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
            disabled={!encoder || senderMode !== 'data-display'}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </Button>
          <Button
            size="sm"
            onClick={handleStartFeedbackScan}
            disabled={!encoder || senderMode === 'feedback-scanning' || senderMode === 'ack-display'}
            variant={senderMode === 'feedback-scanning' ? 'default' : 'outline'}
          >
            📷 Scan Feedback QR
          </Button>
          {senderMode === 'ack-display' && (
            <Button
              size="sm"
              onClick={() => { setSenderMode('data-display'); setIsPlaying(true) }}
              variant="default"
            >
              ▶ Resume Data Display
            </Button>
          )}
          {senderMode === 'data-display' && lastAckQRUrl && (
            <Button
              size="sm"
              onClick={() => setSenderMode('ack-display')}
              variant="outline"
            >
              📊 Show Last ACK QR
            </Button>
          )}
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
            defaultValue={[4]}
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
            <li>Use 'Scan Feedback QR' button to switch to feedback scanning mode</li>
            <li>After scanning feedback, sender will display ACK QR automatically</li>
            <li>Show ACK QR to receiver, then click 'Resume Data Display' to continue transfer</li>
            <li>If you resume data display accidentally, use 'Show Last ACK QR' button to return to ACK display</li>
            <li>Receiver must scan ACK before resuming data scanning</li>
            <li>Transfer speed is now optimized at 4 FPS (adjust with slider if needed)</li>
            {windowInfo && windowInfo.windowEnabled && (
              <li className="text-blue-600 dark:text-blue-400">For large files ({'>'}200KB), transfer uses a sliding window that expands as blocks are decoded</li>
              )}
              <li className="text-blue-600 dark:text-blue-400">For most of the transfer, feedback QR contains only statistics (compact)</li>
              <li className="text-blue-600 dark:text-blue-400">When only a few blocks remain (≤10), feedback includes block details for targeted encoding</li>
              <li className="text-blue-600 dark:text-blue-400">Feedback QR includes contiguous progress to skip already-decoded blocks</li>
              <li className="text-blue-600 dark:text-blue-400">Sender will display feedback QR codes to signal defrag completion or request rollback</li>
          </ol>
          {skippedChunks > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 pt-3 border-t">
              <span className="font-medium">⚠️ Note:</span> {skippedChunks} chunk{skippedChunks > 1 ? 's were' : ' was'} too large for QR encoding and {skippedChunks > 1 ? 'were' : 'was'} automatically skipped.
              This is normal - fountain coding generates new chunks on the fly.
            </p>
          )}
          {windowInfo && windowInfo.windowEnabled && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-3 pt-3 border-t">
              <span className="font-medium">🪟 Tip:</span> Scan feedback QR periodically to enable automatic window expansion for large files.
            </p>
          )}
        </AlertDescription>
      </Alert>
    </div>
  )
}
