import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import QRCode from 'qrcode'
import { computeChecksum } from '@/utils/checksum'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainDecoder, type FountainMetadata } from '@/utils/fountainCode'
import { useQRScanner } from '@/hooks/useQRScanner'
import type { FountainFeedback, SenderFeedback } from '@/types/fountainFeedback'
import { DEFRAG_MAX_TARGETS, DEFRAG_MAX_MISSING_COUNT, TARGETED_MODE_MAX_MISSING_BLOCKS } from '@/utils/fountainConfig'

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
  const [showFeedbackQR, setShowFeedbackQR] = useState(false)
  const [feedbackQRUrl, setFeedbackQRUrl] = useState<string>('')
  const [feedbackMode, setFeedbackMode] = useState<'statistics' | 'targeted'>('statistics')
  const [receiverMode, setReceiverMode] = useState<'data-scanning' | 'feedback-display' | 'ack-scanning'>('data-scanning')

  // Window state tracking
  const [currentWindowStart, setCurrentWindowStart] = useState<number>(initialMetadata.windowStart ?? 0)
  const [currentWindowEnd, setCurrentWindowEnd] = useState<number>(initialMetadata.initialWindowBlocks ?? fountainMetadata.totalSourceBlocks)
  const [windowExpansionFactor] = useState<number>(initialMetadata.windowExpansionFactor ?? 0.5)
  const [windowTriggerThreshold] = useState<number>(initialMetadata.windowTriggerThreshold ?? 0.5)
  const [isWindowEnabled] = useState<boolean>(initialMetadata.windowEnabled ?? false)
  const [isAwaitingFeedback, setIsAwaitingFeedback] = useState<boolean>(false)
  const [feedbackSequence, setFeedbackSequence] = useState<number>(0)
  const [expectingSenderFeedback, setExpectingSenderFeedback] = useState(false)
  const [lastSenderFeedbackSequence, setLastSenderFeedbackSequence] = useState(-1)
  const [senderFeedbackMessage, setSenderFeedbackMessage] = useState<string>('')
  const prevMissingBlocksRef = useRef<number>(Infinity)
  const sessionId = initialMetadata.sessionId
  const [error, setError] = useState<string>('')

  const receivedChunkSeedsRef = useRef<Set<number>>(new Set())
  const fountainDecoderRef = useRef<FountainDecoder>(new FountainDecoder(initialMeta))
  const generatingRef = useRef(false)
  const lastDefragTargetsRef = useRef<number[]>([])

  const addDebugLog = useCallback((message: string) => {
    setDebugLog(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${message}`])
  }, [])

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

  const detectFragmentation = (decodedBlockIndices: number[], firstMissingBlock: number): { isFragmented: boolean, fragmentationScore: number, defragTargets: number[] } => {
    // Compute missing blocks below firstMissingBlock via Set
    const decodedSet = new Set(decodedBlockIndices)
    const missingBlocks: number[] = []
    for (let i = 0; i < firstMissingBlock; i++) {
      if (!decodedSet.has(i)) {
        missingBlocks.push(i)
      }
    }

    // Respect DEFRAG_MAX_MISSING_COUNT and DEFRAG_MAX_TARGETS
    if (missingBlocks.length > DEFRAG_MAX_MISSING_COUNT) {
      return { isFragmented: false, fragmentationScore: 0, defragTargets: [] }
    }

    const fragmentationScore = missingBlocks.length / firstMissingBlock
    const isFragmented = missingBlocks.length > 0 && missingBlocks.length <= DEFRAG_MAX_TARGETS

    return {
      isFragmented,
      fragmentationScore,
      defragTargets: isFragmented ? missingBlocks : []
    }
  }


  const computeContiguousChecksum = async (decoder: FountainDecoder, startIdx: number, endIdx: number): Promise<string> => {
    const data = decoder.getContiguousBlocksData(startIdx, endIdx)
    if (!data) return ''
    return await computeChecksum(data, 'crc32')
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
   setIsAwaitingFeedback(true)
   try {
     stopScannerRef.current?.()
     const decodedBlockIndices = fountainDecoderRef.current.getDecodedBlockIndices()
     const firstMissingBlock = calculateFirstMissingBlock(decodedBlockIndices)
     const decodedInWindow = decodedBlockIndices.filter(idx => idx >= currentWindowStart && idx < currentWindowEnd).length
     const windowSize = Math.max(1, currentWindowEnd - currentWindowStart)
     const windowDecodePercent = decodedInWindow / windowSize
     const overallProgress = decodedBlockIndices.length / fountainMetadata.totalSourceBlocks

     // Detect fragmentation and compute checksum
     const fragmentation = detectFragmentation(decodedBlockIndices, firstMissingBlock)
     const contiguousChecksum = firstMissingBlock > 0 ? await computeContiguousChecksum(fountainDecoderRef.current, 0, firstMissingBlock) : ''
     const contiguousChecksumRange: [number, number] = [0, firstMissingBlock]

     // Defensive fallback: clear expectingSenderFeedback if no fragmentation
     if (!fragmentation.isFragmented) {
       setExpectingSenderFeedback(false)
     }

     // Update last defrag targets if fragmentation detected
     if (fragmentation.isFragmented) {
       lastDefragTargetsRef.current = fragmentation.defragTargets
     }

     // Check if defrag is complete using persisted targets
     const decodedSet = new Set(decodedBlockIndices)
     const defragComplete = lastDefragTargetsRef.current.length > 0 &&
       lastDefragTargetsRef.current.every(t => decodedSet.has(t))

     const seq = feedbackSequence; // or compute next via ref
     const missingBlocksCount = fountainMetadata.totalSourceBlocks - decodedBlockIndices.length
     let feedback: FountainFeedback
     if (missingBlocksCount > TARGETED_MODE_MAX_MISSING_BLOCKS) {
       // Statistics-only feedback - compact format
       feedback = {
         type: 'FOUNTAIN_FEEDBACK',
         mode: 'statistics',
         sessionId: sessionId,
         sequence: seq,
         decodedInWindow: decodedInWindow,
         totalDecoded: decodedBlockIndices.length,
         totalBlocks: fountainMetadata.totalSourceBlocks,
         windowStart: currentWindowStart,
         windowEnd: currentWindowEnd,
         progress: overallProgress * 100,
         requestWindowExpansion: isWindowEnabled && windowSize > 0 && windowDecodePercent >= windowTriggerThreshold,
         firstMissingBlock: firstMissingBlock,
         defragTargets: fragmentation.defragTargets,
         fragmentationScore: fragmentation.fragmentationScore,
         contiguousChecksum: contiguousChecksum,
         contiguousChecksumRange: contiguousChecksumRange,
         defragComplete: defragComplete
       }
     } else {
       // Targeted feedback with block indices - for final stage
       // Try compact representation first
       const feedbackBase = {
         type: 'FOUNTAIN_FEEDBACK' as const,
         mode: 'targeted' as const,
         sessionId: sessionId,
         sequence: seq,
         totalBlocks: fountainMetadata.totalSourceBlocks,
         windowStart: currentWindowStart,
         windowEnd: currentWindowEnd,
         progress: overallProgress * 100,
         firstMissingBlock: firstMissingBlock,
         defragTargets: fragmentation.defragTargets,
         fragmentationScore: fragmentation.fragmentationScore,
         contiguousChecksum: contiguousChecksum,
         contiguousChecksumRange: contiguousChecksumRange,
         defragComplete: defragComplete
       }

       // Attempt compact ranges representation
       const ranges: [number, number][] = []
       let start = decodedBlockIndices[0]
       let prev = start
       for (let i = 1; i < decodedBlockIndices.length; i++) {
         if (decodedBlockIndices[i] !== prev + 1) {
           ranges.push([start, prev])
           start = decodedBlockIndices[i]
         }
         prev = decodedBlockIndices[i]
       }
       if (decodedBlockIndices.length > 0) {
         ranges.push([start, prev])
       }
       const compactFeedback = { ...feedbackBase, receivedBlocks: { ranges } }
       const compactJson = JSON.stringify(compactFeedback)

       // Check if compact version fits (rough estimate: QR capacity ~3KB for version 40)
       if (compactJson.length <= 2500) {
         feedback = compactFeedback
       } else {
         // Fallback to statistics mode with expansion request
         addDebugLog(`📊 Payload too large (${compactJson.length} bytes), falling back to statistics mode with window expansion request`)
         feedback = {
           type: 'FOUNTAIN_FEEDBACK' as const,
           mode: 'statistics' as const,
           sessionId: sessionId,
           sequence: seq,
           decodedInWindow: decodedInWindow,
           totalDecoded: decodedBlockIndices.length,
           totalBlocks: fountainMetadata.totalSourceBlocks,
           windowStart: currentWindowStart,
           windowEnd: currentWindowEnd,
           progress: overallProgress * 100,
           requestWindowExpansion: true, // Force expansion
           firstMissingBlock: firstMissingBlock,
           defragTargets: fragmentation.defragTargets,
           fragmentationScore: fragmentation.fragmentationScore,
           contiguousChecksum: contiguousChecksum,
           contiguousChecksumRange: contiguousChecksumRange,
           defragComplete: defragComplete
         }
       }
     }

     // Set expecting sender feedback if fragmentation detected
     if (fragmentation.isFragmented) {
       setExpectingSenderFeedback(true)
       addDebugLog(`🔧 Fragmentation detected: ${fragmentation.defragTargets.length} targets, requesting defrag mode`)
     }

     // Clear expecting sender feedback if defrag is complete
     if (defragComplete) {
       setExpectingSenderFeedback(false)
       lastDefragTargetsRef.current = []
       addDebugLog(`✅ Defrag complete: all ${lastDefragTargetsRef.current.length} targets decoded`)
     }

     const feedbackJson = JSON.stringify(feedback)
     let dataUrl: string
     try {
       dataUrl = await QRCode.toDataURL(feedbackJson, { width: 400, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000', light: '#FFF' } })
     } catch (qrError) {
       addDebugLog(`❌ QR generation failed: ${qrError instanceof Error ? qrError.message : 'Unknown error'}`)
       // Fallback: set error state and return without generating QR
       setError('Failed to generate feedback QR code - payload too large. Try again later or use statistics mode.')
       return
     }
     setFeedbackQRUrl(dataUrl)
     setFeedbackMode(feedback.mode)
     setShowFeedbackQR(true)
     setReceiverMode('feedback-display')
     setIsScanning(false)
     setFeedbackSequence(prev => prev + 1)
     addDebugLog(`📤 Generated feedback QR (${feedback.mode}, session ${sessionId}, seq ${seq}): ${decodedBlockIndices.length}/${fountainMetadata.totalSourceBlocks} blocks, ${feedbackJson.length} bytes`)
     addDebugLog(`📊 Contiguous blocks: 0-${firstMissingBlock - 1} (${firstMissingBlock} blocks), checksum: ${contiguousChecksum}`)
     if (fragmentation.isFragmented) {
       addDebugLog(`🔧 Defrag targets: ${fragmentation.defragTargets.join(', ')}`)
     }
     if (defragComplete) {
       addDebugLog(`✅ Defrag complete: signaling sender to exit defrag mode`)
     }
     if (feedback.mode === 'statistics') {
       addDebugLog(`🪟 Window progress: ${decodedInWindow}/${currentWindowEnd - currentWindowStart} blocks (${(windowDecodePercent * 100).toFixed(1)}%)`)
     }
     // Log the decision
     addDebugLog(`📊 Missing blocks: ${missingBlocksCount}, threshold: ${TARGETED_MODE_MAX_MISSING_BLOCKS}, mode: ${missingBlocksCount > TARGETED_MODE_MAX_MISSING_BLOCKS ? 'statistics' : 'targeted'}`)
   } finally { generatingRef.current = false }
 }, [feedbackSequence, sessionId, isWindowEnabled, currentWindowStart, currentWindowEnd, windowTriggerThreshold, fountainMetadata.totalSourceBlocks, addDebugLog])

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
         addDebugLog(`🛑 Window saturation detected - feedback required (${decodedInWindow}/${currentWindowEnd - currentWindowStart} blocks, ${(windowDecodePercentage * 100).toFixed(1)}%)`)
         // Auto-open feedback QR to streamline user flow
         handleGenerateFeedbackQR()
         setReceiverMode('feedback-display')
         setIsScanning(false)
       }
     }

    if (decoded) {
      reconstructFountainFile(fountainDecoderRef.current)
    }
  }, [addDebugLog, fountainMetadata.totalSourceBlocks, reconstructFountainFile, isWindowEnabled, currentWindowStart, currentWindowEnd, windowTriggerThreshold, setIsScanning, handleGenerateFeedbackQR])

  const handleSenderFeedbackScan = useCallback(async (data: string): Promise<void> => {
    try {
      const parsed = JSON.parse(data) as SenderFeedback
      if (parsed.type !== 'SENDER_FEEDBACK') {
        addDebugLog('⚠ Ignoring non-sender-feedback QR content')
        return
      }

      if (parsed.sessionId !== sessionId) {
        addDebugLog(`⚠ Ignoring sender feedback for different session: ${parsed.sessionId} vs ${sessionId}`)
        return
      }

      if (parsed.sequence <= lastSenderFeedbackSequence) {
        addDebugLog(`⚠ Ignoring duplicate or old sender feedback sequence: ${parsed.sequence} <= ${lastSenderFeedbackSequence}`)
        return
      }

      setLastSenderFeedbackSequence(parsed.sequence)

      switch (parsed.command) {
        // case 'defrag_complete': // Removed - receiver now handles completion internally

        case 'rollback':
           addDebugLog(`⚠️ Rolling back to block ${parsed.rollbackToBlock}: ${parsed.reason}`)
           fountainDecoderRef.current.rollbackToBlock(parsed.rollbackToBlock)
           setDecodedBlocks(fountainDecoderRef.current.getDecodedBlockCount())
           // Clear receivedChunkSeedsRef and reset chunk counters
           receivedChunkSeedsRef.current.clear()
           setReceivedFountainChunks(0)
           setSenderFeedbackMessage(parsed.reason)
           break

        case 'acknowledge':
          addDebugLog(`✅ ACK received for feedback sequence ${parsed.acknowledgedSequence}`)
          if (parsed.acknowledgedSequence === feedbackSequence - 1) {
            // Valid ACK - resume data scanning
            setShowFeedbackQR(false)
            setFeedbackQRUrl('')
            setReceiverMode('data-scanning')
            setIsScanning(true)
            setIsAwaitingFeedback(false)
            // Expand window if needed
            const expansion = Math.ceil((currentWindowEnd - currentWindowStart) * windowExpansionFactor)
            const newWindowEnd = Math.min(currentWindowEnd + expansion, fountainMetadata.totalSourceBlocks)
            setCurrentWindowEnd(newWindowEnd)
            addDebugLog(`🪟 Window expanded to ${currentWindowStart}-${newWindowEnd} blocks`)
            await restartScannerRef.current?.()
          } else {
            addDebugLog(`⚠️ ACK sequence mismatch: expected ${feedbackSequence - 1}, got ${parsed.acknowledgedSequence}`)
          }
          setSenderFeedbackMessage(parsed.message)
          break
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Error parsing sender feedback: ${errorMsg}`)
      console.error('Sender feedback parse error:', err)
    }
  }, [sessionId, lastSenderFeedbackSequence, addDebugLog, currentWindowStart, currentWindowEnd, windowExpansionFactor, feedbackSequence, fountainMetadata.totalSourceBlocks])

  const handleScan = useCallback((data: string) => {
    try {
      addDebugLog(`Scanned chunk, length: ${data.length} bytes`)

      // Try to check if it is JSON first by checking
      // if it begins with { (sender feedback)
      if (data.startsWith('{')) {
        const parsed = JSON.parse(data)
        if (parsed.type === 'SENDER_FEEDBACK') {
          addDebugLog('🔁 Processing sender feedback')
          handleSenderFeedbackScan(data)
          return
        }
      }

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
  }, [addDebugLog, handleBinaryFountainChunk, handleSenderFeedbackScan])

  const handleScanError = useCallback((errorMessage: string) => {
    setError(errorMessage)
  }, [])

  const { videoRef, stopScanner, restartScanner } = useQRScanner({
    onScan: handleScan,
    isScanning: receiverMode === 'ack-scanning' || (receiverMode === 'data-scanning' && isScanning && !isAwaitingFeedback),
    onError: handleScanError
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

  // Detect missing blocks threshold crossing for targeted mode and auto-generate feedback
  useEffect(() => {
    const currentMissingBlocks = fountainMetadata.totalSourceBlocks - decodedBlocks
    const crossedToTargeted = prevMissingBlocksRef.current > TARGETED_MODE_MAX_MISSING_BLOCKS && currentMissingBlocks <= TARGETED_MODE_MAX_MISSING_BLOCKS
    if (crossedToTargeted && !showFeedbackQR && !success && !isAwaitingFeedback) {
      addDebugLog(`🎯 Targeted mode threshold reached (${currentMissingBlocks} blocks remaining) - auto-generating feedback`)
      handleGenerateFeedbackQR()
      setReceiverMode('feedback-display')
      setIsScanning(false)
    }
    prevMissingBlocksRef.current = currentMissingBlocks
  }, [decodedBlocks, fountainMetadata.totalSourceBlocks, showFeedbackQR, success, isAwaitingFeedback, handleGenerateFeedbackQR, addDebugLog])

  // Detect fragmentation and auto-generate feedback
  useEffect(() => {
    const decodedBlockIndices = fountainDecoderRef.current.getDecodedBlockIndices()
    const firstMissingBlock = calculateFirstMissingBlock(decodedBlockIndices)
    const fragmentation = detectFragmentation(decodedBlockIndices, firstMissingBlock)
    if (fragmentation.isFragmented && !showFeedbackQR && !success && !isAwaitingFeedback) {
      addDebugLog(`🔧 Fragmentation detected (${fragmentation.defragTargets.length} gaps) - auto-generating feedback`)
      handleGenerateFeedbackQR()
      setReceiverMode('feedback-display')
      setIsScanning(false)
    }
  }, [decodedBlocks, fountainMetadata.totalSourceBlocks, showFeedbackQR, success, isAwaitingFeedback, handleGenerateFeedbackQR, addDebugLog])

  const handleStartScan = () => {
    setIsScanning(true)
    setReceivedFountainChunks(0)
    setDecodedBlocks(0)
    receivedChunkSeedsRef.current = new Set()
    setError('')
    setSuccess(false)
    setDownloadUrl('')
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
    setIsAwaitingFeedback(false)
    setShowFeedbackQR(false)
    setFeedbackQRUrl('')
    setReceiverMode('data-scanning')
    setCurrentWindowStart(initialMetadata.windowStart ?? 0)
    setCurrentWindowEnd(initialMetadata.initialWindowBlocks ?? fountainMetadata.totalSourceBlocks)
    setFeedbackSequence(0)
    setExpectingSenderFeedback(false)
    setLastSenderFeedbackSequence(-1)
    setSenderFeedbackMessage('')
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



  const progress = (decodedBlocks / fountainMetadata.totalSourceBlocks) * 100
  const currentMissingBlocks = fountainMetadata.totalSourceBlocks - decodedBlocks
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
  }, [isWindowEnabled, currentWindowStart, currentWindowEnd])

  return (
    <div className="space-y-4">
      {/* Feedback QR Display */}
      {receiverMode === 'feedback-display' && feedbackQRUrl && (
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
                {currentMissingBlocks > TARGETED_MODE_MAX_MISSING_BLOCKS ? 'Sharing window progress (compact format)' : feedbackMode === 'targeted' ? 'Sharing decoded blocks for targeted transfer' : 'Sharing progress summary (fallback mode due to payload size)'}
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Show this QR to sender, then switch to ACK scanning mode to receive acknowledgment. You can toggle back if needed.
              </p>
              <Button onClick={() => setReceiverMode('ack-scanning')} variant="default" className="w-full">
                Switch to ACK Scanning Mode
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* ACK Scanning Mode */}
      {receiverMode === 'ack-scanning' && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium">📷 Scanning for ACK QR Code</p>
              <p className="text-sm">
                Waiting for sender to scan feedback and generate ACK QR. Point camera at sender's ACK QR code.
              </p>
              <p className="text-xs text-muted-foreground">
                After scanning ACK, data scanning will resume automatically. You can switch back to view the feedback QR if needed.
              </p>
              <Button onClick={() => setReceiverMode('feedback-display')} variant="outline" className="w-full">
                Switch Back to Feedback QR Display
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
                onClick={() => { handleGenerateFeedbackQR(); setReceiverMode('feedback-display'); setIsScanning(false) }}
                variant="default"
                className="w-full"
              >
                📊 Generate Feedback QR (Required to Continue)
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Expecting Sender Feedback Alert */}
      {expectingSenderFeedback && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium">⏳ Waiting for Sender Response</p>
              <p className="text-sm">
                Defrag mode requested. Waiting for sender to complete defragmentation and signal completion via feedback QR.
              </p>
              <p className="text-xs text-muted-foreground">
                Keep scanning - sender will display a feedback QR when defrag is complete.
              </p>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Sender Feedback Message Alert */}
      {senderFeedbackMessage && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium">📬 Sender Message</p>
              <p className="text-sm">{senderFeedbackMessage}</p>
              <Button
                onClick={() => setSenderFeedbackMessage('')}
                variant="outline"
                size="sm"
              >
                OK
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Video Preview */}
      {(receiverMode === 'data-scanning' || receiverMode === 'ack-scanning') && (
        <div className="relative bg-black rounded-lg overflow-hidden">
          <video
            ref={videoRef}
            className="w-full h-auto"
            style={{ maxHeight: '400px' }}
          />
          {receiverMode === 'ack-scanning' && (
            <div className="absolute top-2 right-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium">
              ● SCANNING
            </div>
          )}
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
              <li>When feedback is required, you'll be prompted to generate a feedback QR</li>
              <li>Show it to sender, then switch to ACK scanning mode to receive acknowledgment</li>
              <li>You can toggle between showing feedback QR and scanning for ACK at any time</li>
              <li>Data scanning is blocked until ACK is received from sender</li>
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
        {receiverMode === 'data-scanning' && !isScanning && !success && !isAwaitingFeedback && (
          <Button onClick={handleStartScan} className="flex-1">
            📷 Start Scanning
          </Button>
        )}
        {receiverMode === 'data-scanning' && !isScanning && !success && isAwaitingFeedback && (
          <Button disabled className="flex-1" variant="secondary">
            ⏸️ Provide Feedback to Resume
          </Button>
        )}
        {receiverMode === 'data-scanning' && isScanning && !success && (
          <>
            <Button onClick={handleStopScan} variant="destructive" className="flex-1">
              ⏹ Stop Scanning
            </Button>
            <Button onClick={handleReset} variant="outline">
              Reset
            </Button>
          </>
        )}
        {receiverMode === 'feedback-display' && !success && (
          <Button disabled className="flex-1" variant="secondary">
            📊 Showing Feedback QR - Toggle above to scan ACK
          </Button>
        )}
        {receiverMode === 'ack-scanning' && !success && (
          <Button disabled className="flex-1" variant="secondary">
            📷 Scanning for ACK QR - Toggle above to view feedback
          </Button>
        )}
      </div>

    </div>
  )
}
