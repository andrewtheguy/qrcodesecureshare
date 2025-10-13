import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import QRCode from 'qrcode'
import { computeChecksum } from '@/utils/checksum'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainDecoder, type FountainMetadata } from '@/utils/fountainCode'
import { useQRScanner } from '@/hooks/useQRScanner'
import type { FountainFeedback } from '@/types/fountainFeedback'

interface FountainQRReceiverProps {
  initialMetadata: {
    name: string
    size: number
    type: string
    sessionId: number
    totalSourceBlocks: number
    blockSize?: number
    checksum?: string
    checksumAlg?: string
    windowEnabled?: boolean
    initialWindowBlocks?: number
    windowExpansionFactor?: number
    windowTriggerThreshold?: number
    windowStart?: number
  }
}

export function FountainQRReceiver({ initialMetadata }: FountainQRReceiverProps) {
  // Initialize metadata and decoder immediately (always provided by parent)
  const initialMeta: FountainMetadata = {
    name: initialMetadata.name,
    size: initialMetadata.size,
    type: initialMetadata.type,
    timestamp: Date.now(),
    totalSourceBlocks: initialMetadata.totalSourceBlocks,
    blockSize: initialMetadata.blockSize || 600
  }

  const [isScanning, setIsScanning] = useState(false)
  // Metadata is immutable for this mount (component remounted per file)
  const fountainMetadata: FountainMetadata = initialMeta
  const [receivedFountainChunks, setReceivedFountainChunks] = useState(0)
  const [decodedBlocks, setDecodedBlocks] = useState(0)
  const [success, setSuccess] = useState(false)
  const [integrityOk, setIntegrityOk] = useState<boolean | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [debugLog, setDebugLog] = useState<string[]>([`[${new Date().toLocaleTimeString()}] 📦 Initialized with metadata: ${initialMeta.name} (${initialMeta.totalSourceBlocks} blocks, ${initialMeta.blockSize} bytes/block)`])
  const [showDebugLog, setShowDebugLog] = useState(false)
  const [decodeTime, setDecodeTime] = useState<number | null>(null)
  const [showFeedbackQR, setShowFeedbackQR] = useState(false)
  const [feedbackQRUrl, setFeedbackQRUrl] = useState<string>('')

  // Window state tracking
  const [currentWindowStart, setCurrentWindowStart] = useState<number>(initialMetadata.windowStart ?? 0)
  const [currentWindowEnd, setCurrentWindowEnd] = useState<number>(initialMetadata.initialWindowBlocks ?? fountainMetadata.totalSourceBlocks)
  const [windowExpansionFactor] = useState<number>(initialMetadata.windowExpansionFactor ?? 0.5)
  const [windowTriggerThreshold] = useState<number>(initialMetadata.windowTriggerThreshold ?? 0.5)
  const [isWindowEnabled] = useState<boolean>(initialMetadata.windowEnabled ?? false)
  const [isAwaitingFeedback, setIsAwaitingFeedback] = useState<boolean>(false)
  const [lastFeedbackTime, setLastFeedbackTime] = useState<number | null>(null)
  const [feedbackSequence, setFeedbackSequence] = useState<number>(0)
  const sessionId = initialMetadata.sessionId

  const receivedChunkSeedsRef = useRef<Set<number>>(new Set())
  const fountainDecoderRef = useRef<FountainDecoder>(new FountainDecoder(initialMeta))
  const generatingRef = useRef(false)
  const scanStartTimeRef = useRef<number | null>(null)

  const addDebugLog = (message: string) => {
    setDebugLog(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${message}`])
  }

  const calculateFirstMissingBlock = (decodedBlockIndices: number[]): number => {
    // Rely on the sorted order of getDecodedBlockIndices() - no re-sorting needed
    // Assumption: decodedBlockIndices is already sorted in ascending order

    // Find the first index where the sequence breaks
    for (let i = 0; i < decodedBlockIndices.length; i++) {
      if (decodedBlockIndices[i] !== i) {
        return i
      }
    }

    // If all blocks from 0 to length-1 are contiguous, return the length
    return decodedBlockIndices.length
  }

  const reconstructFountainFile = useCallback(async (decoder: FountainDecoder) => {
    try {
      const reconstructedData = decoder.getDecodedData()
      if (!reconstructedData) {
        throw new Error('Failed to get decoded data')
      }

      // Ensure we pass an ArrayBuffer or valid BlobPart; slice to detach if needed
      const uint8Copy = new Uint8Array(reconstructedData) // Ensures standard Uint8Array
      const blob = new Blob([uint8Copy], { type: fountainMetadata.type || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)

      setDownloadUrl(url)
      setSuccess(true)
      setIsScanning(false)

      if (initialMetadata.checksum && initialMetadata.checksumAlg === 'crc32') {
        const calc = await computeChecksum(uint8Copy, 'crc32')
        const match = calc === initialMetadata.checksum
        setIntegrityOk(match)
        addDebugLog(match
          ? `🔐 Integrity OK (crc32 ${calc})`
          : `❌ Integrity FAILED (expected ${initialMetadata.checksum}, got ${calc})`)
      } else setIntegrityOk(null)

      addDebugLog(`✓ File reconstructed successfully: ${reconstructedData.length} bytes`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error('Reconstruction error:', err)
      addDebugLog(`✗ Reconstruction error: ${errMsg}`)
      setError('Failed to reconstruct file from fountain chunks')
    }
  }, [fountainMetadata.type, initialMetadata.checksum, initialMetadata.checksumAlg, addDebugLog, setIsScanning])



 const handleGenerateFeedbackQR = useCallback(async () => {
   if (generatingRef.current) return; generatingRef.current = true
   try {
     if (showFeedbackQR || isAwaitingFeedback) {
       addDebugLog('⚠ Skipping duplicate feedback QR generation')
       return
     }
     stopScannerRef.current?.()
     const decodedBlockIndices = fountainDecoderRef.current.getDecodedBlockIndices()
     const firstMissingBlock = calculateFirstMissingBlock(decodedBlockIndices)
     const decodedInWindow = decodedBlockIndices.filter(idx => idx >= currentWindowStart && idx < currentWindowEnd).length
     const windowSize = Math.max(1, currentWindowEnd - currentWindowStart)
     const windowDecodePercent = decodedInWindow / windowSize
     const overallProgress = decodedBlockIndices.length / fountainMetadata.totalSourceBlocks

     let feedback: FountainFeedback
     if (overallProgress < 0.9) {
       // Statistics-only feedback - compact format
       feedback = {
         type: 'FOUNTAIN_FEEDBACK',
         mode: 'statistics',
         sessionId: sessionId,
         sequence: feedbackSequence,
         decodedInWindow: decodedInWindow,
         totalDecoded: decodedBlockIndices.length,
         totalBlocks: fountainMetadata.totalSourceBlocks,
         windowStart: currentWindowStart,
         windowEnd: currentWindowEnd,
         progress: overallProgress * 100,
         requestWindowExpansion: isWindowEnabled && windowSize > 0 && windowDecodePercent >= windowTriggerThreshold,
         firstMissingBlock: firstMissingBlock
       }
     } else {
       // Targeted feedback with block indices - for final stage
       feedback = {
         type: 'FOUNTAIN_FEEDBACK',
         mode: 'targeted',
         sessionId: sessionId,
         sequence: feedbackSequence,
         receivedBlocks: decodedBlockIndices,
         totalBlocks: fountainMetadata.totalSourceBlocks,
         windowStart: currentWindowStart,
         windowEnd: currentWindowEnd,
         progress: overallProgress * 100,
         firstMissingBlock: firstMissingBlock
       }
     }

     const feedbackJson = JSON.stringify(feedback)
     const dataUrl = await QRCode.toDataURL(feedbackJson, { width: 400, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000', light: '#FFF' } })
     setFeedbackQRUrl(dataUrl)
     setShowFeedbackQR(true)
     setLastFeedbackTime(Date.now())
     setFeedbackSequence(prev => prev + 1)
     addDebugLog(`📤 Generated feedback QR (${feedback.mode}, session ${sessionId}, seq ${feedbackSequence}): ${decodedBlockIndices.length}/${fountainMetadata.totalSourceBlocks} blocks, ${feedbackJson.length} bytes`)
     addDebugLog(`📊 Contiguous blocks: 0-${firstMissingBlock - 1} (${firstMissingBlock} blocks)`)
     if (feedback.mode === 'statistics') {
       addDebugLog(`🪟 Window progress: ${decodedInWindow}/${currentWindowEnd - currentWindowStart} blocks (${(windowDecodePercent * 100).toFixed(1)}%)`)
     }
   } finally { generatingRef.current = false }
 }, [showFeedbackQR, isAwaitingFeedback, fountainMetadata.totalSourceBlocks, addDebugLog, currentWindowStart, currentWindowEnd, windowTriggerThreshold])

 const handleBinaryFountainChunk = useCallback((bytes: Uint8Array) => {
    // Binary format: [0xFF][0xFD][seed(2)][degree(1)][numIndices(1)][indices...(2 each)][data...]
    let offset = 2 // Skip magic bytes

    // Read seed (2 bytes)
    const seed = (bytes[offset++] << 8) | bytes[offset++]

    // Check for duplicate seed
    if (receivedChunkSeedsRef.current.has(seed)) {
      addDebugLog(`⊗ Duplicate chunk seed ${seed}, ignoring`)
      return
    }
    receivedChunkSeedsRef.current.add(seed)

    // Start timer on first chunk received
    if (!scanStartTimeRef.current) {
      scanStartTimeRef.current = Date.now()
    }

    // Read degree (1 byte)
    const degree = bytes[offset++]

    // Read numIndices (1 byte)
    const numIndices = bytes[offset++]

    // Read indices (2 bytes each)
    const indices: number[] = []
    for (let i = 0; i < numIndices; i++) {
      const idx = (bytes[offset++] << 8) | bytes[offset++]
      indices.push(idx)
    }

    // Read chunk data (rest of bytes)
    const data = bytes.slice(offset)

    // Metadata is always available (provided by parent)
    const chunk = { seed, degree, indices, data }

    const decoded = fountainDecoderRef.current.addChunk(chunk)
    setReceivedFountainChunks(prev => prev + 1)
    setDecodedBlocks(fountainDecoderRef.current.getDecodedBlockCount())

    addDebugLog(`✓ Fountain chunk #${seed} (degree: ${degree}) - decoded ${fountainDecoderRef.current.getDecodedBlockCount()}/${fountainMetadata.totalSourceBlocks} blocks`)

    // Check for window saturation if windowing is enabled
    if (isWindowEnabled && currentWindowEnd < fountainMetadata.totalSourceBlocks) {
      const decodedBlockIndices = fountainDecoderRef.current.getDecodedBlockIndices()
      const decodedInWindow = decodedBlockIndices.filter(idx => idx >= currentWindowStart && idx < currentWindowEnd).length
      const windowDecodePercentage = decodedInWindow / (currentWindowEnd - currentWindowStart)

      if (windowDecodePercentage >= windowTriggerThreshold) {
        setIsAwaitingFeedback(true)
        setIsScanning(false)
        addDebugLog(`🛑 Window saturation detected - feedback required (${decodedInWindow}/${currentWindowEnd - currentWindowStart} blocks, ${(windowDecodePercentage * 100).toFixed(1)}%)`)
        // Auto-open feedback QR to streamline user flow
        handleGenerateFeedbackQR()
      }
    }

    if (decoded) {
      const elapsedTime = scanStartTimeRef.current ? Date.now() - scanStartTimeRef.current : 0
      setDecodeTime(elapsedTime)
      addDebugLog(`🎉 Decoding complete in ${(elapsedTime / 1000).toFixed(2)}s!`)
      reconstructFountainFile(fountainDecoderRef.current)
    }
  }, [addDebugLog, fountainMetadata.totalSourceBlocks, reconstructFountainFile, isWindowEnabled, currentWindowStart, currentWindowEnd, windowTriggerThreshold, setIsScanning, handleGenerateFeedbackQR])

  const handleScan = useCallback((data: string) => {
    try {
      addDebugLog(`Scanned chunk, length: ${data.length} bytes`)

      // Convert string to bytes
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xFF
      }
      // Expect only fountain data chunks now; metadata is JSON and handled by parent before this component mounts
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFD) {
        addDebugLog('🔁 Processing fountain chunk')
        handleBinaryFountainChunk(bytes)
      } else {
        addDebugLog('⚠ Ignoring non-fountain-chunk QR content')
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Error: ${errorMsg}`)
      console.error('Scan error:', err)
    }
  }, [addDebugLog, handleBinaryFountainChunk])

  const { videoRef, error, setError, stopScanner, restartScanner } = useQRScanner({
    onScan: handleScan,
    isScanning
  })

  const stopScannerRef = useRef(stopScanner)
  const restartScannerRef = useRef(restartScanner)

  // Update refs when functions change
  useEffect(() => {
    stopScannerRef.current = stopScanner
  }, [stopScanner])

  useEffect(() => {
    restartScannerRef.current = restartScanner
  }, [restartScanner])
  // Auto-start scanning on mount
  useEffect(() => {
    setIsScanning(true)
  }, [])

  const handleStartScan = () => {
    setIsScanning(true)
    setReceivedFountainChunks(0)
    setDecodedBlocks(0)
    receivedChunkSeedsRef.current = new Set()
    setError('')
    setSuccess(false)
    setDownloadUrl('')
    setDecodeTime(null)
    scanStartTimeRef.current = null
  }

  const handleStopScan = () => {
    setIsScanning(false)
    stopScannerRef.current?.()
  }

  const handleReset = () => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
    }
    setReceivedFountainChunks(0)
    setDecodedBlocks(0)
    receivedChunkSeedsRef.current.clear()
    setError('')
    setSuccess(false)
    setDownloadUrl('')
    setIsScanning(false)
    setDecodeTime(null)
    scanStartTimeRef.current = null
    setIsAwaitingFeedback(false)
    setShowFeedbackQR(false)
    setFeedbackQRUrl('')
    setLastFeedbackTime(null)
    setCurrentWindowStart(initialMetadata.windowStart ?? 0)
    setCurrentWindowEnd(initialMetadata.initialWindowBlocks ?? fountainMetadata.totalSourceBlocks)
    setFeedbackSequence(0)
  }

  const handleDownload = () => {
    if (!downloadUrl) return

    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = fountainMetadata.name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }


  const handleCloseFeedbackQR = async () => {
    setShowFeedbackQR(false)
    setFeedbackQRUrl('')

    // If we were awaiting feedback, expand the window and resume scanning
    if (isAwaitingFeedback) {
      const expansion = Math.ceil((currentWindowEnd - currentWindowStart) * windowExpansionFactor)
      const newWindowEnd = Math.min(currentWindowEnd + expansion, fountainMetadata.totalSourceBlocks)
      setCurrentWindowEnd(newWindowEnd)
      setIsAwaitingFeedback(false)
      setIsScanning(true)
      addDebugLog(`🪟 Window expanded to ${currentWindowStart}-${newWindowEnd} blocks`)
      await restartScannerRef.current?.()
    } else if (isScanning) {
      // Resume scanning if it was active before
      await restartScannerRef.current?.()
    }
  }

  const progress = (decodedBlocks / fountainMetadata.totalSourceBlocks) * 100
  // More accurate estimate based on robust soliton parameters (c=0.2, delta=0.01) + degree doping
  // Formula: k * (1 + c * ln(k/delta) / sqrt(k)) * 1.05 (accounting for degree doping overhead)
  const k = fountainMetadata.totalSourceBlocks
  const c = 0.2
  const delta = 0.01
  const theoreticalOverhead = c * Math.log(k / delta) / Math.sqrt(k)
  const dopingOverhead = 1.05 // Account for forced low-degree chunks
  const estimatedChunksNeeded = Math.ceil(k * (1 + theoreticalOverhead) * dopingOverhead)

  // Memoize decodedInWindow to avoid repeated filter calls
  const decodedInWindow = useMemo(() => {
    if (!isWindowEnabled) return 0
    const decodedBlockIndices = fountainDecoderRef.current.getDecodedBlockIndices()
    return decodedBlockIndices.filter(idx => idx >= currentWindowStart && idx < currentWindowEnd).length
  }, [isWindowEnabled, currentWindowStart, currentWindowEnd, decodedBlocks])

  return (
    <div className="space-y-4">
      {/* Feedback QR Display */}
      {showFeedbackQR && feedbackQRUrl && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium">📊 Feedback QR Code</p>
              <div className="flex justify-center bg-white p-4 rounded-lg">
                <img
                  src={feedbackQRUrl}
                  alt="Feedback QR Code"
                  className="max-w-full h-auto"
                />
              </div>
              <p className="text-sm text-center">
                Decoded {decodedBlocks}/{fountainMetadata.totalSourceBlocks} blocks ({Math.round(progress)}%)
              </p>
              <p className="text-xs text-muted-foreground text-center">
                {decodedBlocks / fountainMetadata.totalSourceBlocks < 0.9 ? 'Sharing window progress (compact format)' : 'Sharing decoded blocks for targeted transfer'}
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Show this QR code to the sender to share your progress
              </p>
              <Button onClick={handleCloseFeedbackQR} variant="outline" className="w-full">
                Close
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Window Saturation Alert */}
      {isAwaitingFeedback && (
        <Alert variant="destructive">
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium">⏸️ Transfer Paused - Feedback Required</p>
              <p className="text-sm">
                You've decoded {decodedInWindow}/{currentWindowEnd - currentWindowStart} blocks in the current window ({((decodedInWindow / (currentWindowEnd - currentWindowStart)) * 100).toFixed(1)}%). The sender needs to expand the transfer window. Please generate and scan the feedback QR code to continue.
              </p>
              <Button
                onClick={handleGenerateFeedbackQR}
                variant="default"
                className="w-full"
              >
                📊 Generate Feedback QR (Required to Continue)
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Video Preview */}
      {isScanning && (
        <div className="relative bg-black rounded-lg overflow-hidden" style={{ display: showFeedbackQR ? 'none' : 'block' }}>
          <video
            ref={videoRef}
            className="w-full h-auto"
            style={{ maxHeight: '400px' }}
          />
          <div className="absolute top-2 right-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium">
            ● SCANNING
          </div>
        </div>
      )}

      {/* Progress */}
      {!success && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Decoded {decodedBlocks} of {fountainMetadata.totalSourceBlocks} blocks</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
          <div className="text-xs text-muted-foreground">
            Received {receivedFountainChunks} chunks (est. {estimatedChunksNeeded} needed)
          </div>
          {isWindowEnabled && currentWindowEnd < fountainMetadata.totalSourceBlocks && (
            <div className="text-xs text-muted-foreground">
              Current window: {currentWindowStart}-{currentWindowEnd} blocks ({(((currentWindowEnd - currentWindowStart) / fountainMetadata.totalSourceBlocks) * 100).toFixed(1)}% of file) |
              Decoded in window: {decodedInWindow}/{currentWindowEnd - currentWindowStart} blocks
            </div>
          )}
        </div>
      )}

      {/* Metadata Info */}
      {!success && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">{fountainMetadata.name}</p>
            <p className="text-sm text-muted-foreground">
              Expected size: {(fountainMetadata.size / 1024).toFixed(2)}KB |
              Blocks: {fountainMetadata.totalSourceBlocks}
            </p>
          </AlertDescription>
        </Alert>
      )}


      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Success Alert */}
      {success && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium text-green-600">
                ✅ File decoded successfully!
                <span className="block text-sm font-normal text-muted-foreground mt-1">
                  Decoded using fountain codes ({receivedFountainChunks} chunks received)
                </span>
              </p>
              {decodeTime !== null && (
                <p className="text-sm font-medium text-blue-600">
                  ⏱️ Decode time: {(decodeTime / 1000).toFixed(2)}s
                </p>
              )}
              {integrityOk !== null && (
                <p className={`text-sm font-medium ${integrityOk ? 'text-green-600' : 'text-red-600'}`}>
                  {integrityOk ? '🔐 Integrity verified (checksum match)' : '❌ Integrity check failed'}
                </p>
              )}
              <div className="flex gap-2">
                <Button onClick={handleDownload} className="flex-1">
                  📥 Download {fountainMetadata.name}
                </Button>
                <Button onClick={handleReset} variant="outline">
                  Reset
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Instructions */}
      {!isScanning && !success && (
        <Alert>
          <AlertDescription>
            <p className="font-medium mb-2">📱 Fountain Code Transfer Mode:</p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Click "Start Scanning" to activate camera</li>
              <li>Scan the metadata QR code first</li>
              <li>Then scan fountain-coded chunks</li>
              <li>You only need ~110% of chunks (can miss some)</li>
              <li>Progress shows decoded blocks, not chunks scanned</li>
              <li>File will download when fully decoded</li>
            </ol>
          </AlertDescription>
        </Alert>
      )}

      {/* Debug Log */}
      <div className="border-t pt-3">
        <Button
          onClick={() => setShowDebugLog(!showDebugLog)}
          variant="ghost"
          size="sm"
          className="w-full text-xs"
        >
          {showDebugLog ? '▼' : '▶'} Debug Log ({debugLog.length})
        </Button>
        {showDebugLog && (
          <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono max-h-48 overflow-y-auto">
            {debugLog.length === 0 ? (
              <p className="text-muted-foreground">No logs yet...</p>
            ) : (
              debugLog.map((log, i) => (
                <div key={i} className="py-0.5">
                  {log}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Control Buttons */}
      <div className="flex gap-2">
        {!isScanning && !success && !isAwaitingFeedback && (
          <Button onClick={handleStartScan} className="flex-1">
            📷 Start Scanning
          </Button>
        )}
        {!isScanning && !success && isAwaitingFeedback && (
          <Button disabled className="flex-1" variant="secondary">
            ⏸️ Provide Feedback to Resume
          </Button>
        )}
        {isScanning && !success && (
          <>
            <Button onClick={handleStopScan} variant="destructive" className="flex-1">
              ⏹ Stop Scanning
            </Button>
            <Button onClick={handleReset} variant="outline">
              Reset
            </Button>
          </>
        )}
      </div>

      {/* Feedback QR Button */}
      {!success && decodedBlocks > 0 && !showFeedbackQR && (
        <div className="pt-2 border-t">
          <Button
            onClick={handleGenerateFeedbackQR}
            variant={isAwaitingFeedback ? "default" : "secondary"}
            size="sm"
            className="w-full"
          >
            {isAwaitingFeedback ? "📊 Generate Feedback QR (Required to Continue)" : "📊 Generate Feedback QR"}
          </Button>
          <p className="text-xs text-muted-foreground text-center mt-1">
            {isAwaitingFeedback ? "Required to resume scanning" : "Share your progress with the sender"}
          </p>
        </div>
      )}
    </div>
  )
}
