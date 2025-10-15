import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { FountainMetadata } from '@/utils/fountainCode'
import { useQRScanner } from '@/hooks/useQRScanner'
import type { FountainFeedback, FountainFeedbackStatistics, SenderFeedback } from '@/types/fountainFeedback'
import { getTargetedModeMaxMissingBlocks, getFeedbackFileSizeThresholdBlocks, getWindowExpansionSizeBlocks } from '@/utils/fountainConfig'
import FountainDecoderWorker from '@/workers/fountainDecoder.worker?worker'
import { generateNonDataQR } from '@/utils/qrUtils'

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
  const [windowTriggerThreshold] = useState<number>(initialMetadata.windowTriggerThreshold ?? 0.5)
  const [isWindowEnabled] = useState<boolean>(initialMetadata.windowEnabled ?? false)
  const [isAwaitingFeedback, setIsAwaitingFeedback] = useState<boolean>(false)
  const [feedbackSequence, setFeedbackSequence] = useState<number>(0)
  const feedbackSequenceRef = useRef<number>(0)
  const [lastSenderFeedbackSequence, setLastSenderFeedbackSequence] = useState(-1)
  const [senderFeedbackMessage, setSenderFeedbackMessage] = useState<string>('')
  const prevMissingBlocksRef = useRef<number>(Infinity)
  const sessionId = initialMetadata.sessionId
  const [error, setError] = useState<string>('')
  const [invalidChecksumCount, setInvalidChecksumCount] = useState(0)
  const [showMetadataInfo, setShowMetadataInfo] = useState<boolean>(false)

  // Targeted mode testing state
  const [isTargetedModeTestActive, setIsTargetedModeTestActive] = useState(false)

  // Overlay positioning flags
  const showScanningBadge = receiverMode === 'ack-scanning'
  const showSenderMsg = senderFeedbackMessage && senderFeedbackMessage.trim() !== ''

  const workerRef = useRef<Worker | null>(null)
  const messageIdCounterRef = useRef<number>(0)
  const decodedBlockIndicesRef = useRef<number[]>([])
  const generatingRef = useRef(false)

  // Refs for worker onmessage handler to avoid stale closures
  const isWindowEnabledRef = useRef(isWindowEnabled)
  const currentWindowStartRef = useRef(currentWindowStart)
  const currentWindowEndRef = useRef(currentWindowEnd)
  const windowTriggerThresholdRef = useRef(windowTriggerThreshold)
  const showFeedbackQRRef = useRef(showFeedbackQR)
  const isAwaitingFeedbackRef = useRef(isAwaitingFeedback)

  const addDebugLog = useCallback((message: string) => {
    setDebugLog(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${message}`])
  }, [])

  // Worker initialization and cleanup
  useEffect(() => {
    let worker: Worker | null = null
    try {
      worker = new FountainDecoderWorker()
      workerRef.current = worker

      worker.onerror = (e) => {
        setError('Worker runtime error')
        addDebugLog(`Worker runtime error: ${e.message || 'Unknown error'}`)
      }

      worker.onmessage = (event: MessageEvent) => {
      const { type, id, ...data } = event.data

      switch (type) {
        case 'initialized':
          addDebugLog('✓ Fountain decoder worker initialized')
          break

        case 'chunkProcessed': {
          const { duplicate, seed, decodedBlockCount, progress, isComplete, decodedBlockIndices } = data
          if (duplicate) {
            addDebugLog(`⊗ Duplicate chunk seed ${seed}, ignoring`)
            return
          }
          setReceivedFountainChunks(prev => prev + 1)
          setDecodedBlocks(decodedBlockCount)
          decodedBlockIndicesRef.current = decodedBlockIndices
          addDebugLog(`✓ Fountain chunk #${seed} - decoded ${decodedBlockCount}/${fountainMetadata.totalSourceBlocks} blocks`)

          // Window saturation check
          const isFileLargeEnoughForFeedback = fountainMetadata.totalSourceBlocks >= getFeedbackFileSizeThresholdBlocks(fountainMetadata.blockSize)
          if (isWindowEnabledRef.current && currentWindowEndRef.current < fountainMetadata.totalSourceBlocks && !showFeedbackQRRef.current && !isAwaitingFeedbackRef.current && isFileLargeEnoughForFeedback) {
            const decodedInWindow = decodedBlockIndices.filter((idx: number) => idx >= currentWindowStartRef.current && idx < currentWindowEndRef.current).length
            const windowDecodePercentage = decodedInWindow / (currentWindowEndRef.current - currentWindowStartRef.current)

            if (windowDecodePercentage >= windowTriggerThresholdRef.current) {
              addDebugLog(`🛑 Window saturation detected - feedback required (${decodedInWindow}/${currentWindowEndRef.current - currentWindowStartRef.current} blocks, ${(windowDecodePercentage * 100).toFixed(1)}%)`)
              handleGenerateFeedbackQR()
              setReceiverMode('feedback-display')
              setIsScanning(false)
            }
          }
          break
        }

        case 'complete': {
          const { data: reconstructedData, integrityOk, checksum } = data
          const blob = new Blob([reconstructedData], { type: fountainMetadata.type || 'application/octet-stream' })
          const url = URL.createObjectURL(blob)

          setDownloadUrl(url)
          setSuccess(true)
          setIsScanning(false)

          if (integrityOk !== undefined) {
            setIntegrityOk(integrityOk)
            addDebugLog(integrityOk
              ? `🔐 Integrity OK (${checksum})`
              : `❌ Integrity FAILED (expected ${checksum}, got computed checksum)`)
          } else {
            setIntegrityOk(null)
          }

          addDebugLog(`✓ File reconstructed successfully: ${reconstructedData.length} bytes`)
          break
        }

        case 'error': {
          const { error, seed } = data
          if (error === 'Invalid checksum') {
            setInvalidChecksumCount(prev => prev + 1)
            addDebugLog(`❌ Invalid checksum for chunk #${seed}`)
          } else {
            addDebugLog(`❌ Worker error: ${error}`)
            setError(`Worker error: ${error}`)
          }
          break
        }

        case 'rollbackComplete': {
          const { blockIndex, decodedBlockCount, decodedBlockIndices } = data
          setDecodedBlocks(decodedBlockCount)
          decodedBlockIndicesRef.current = decodedBlockIndices
          addDebugLog(`⚠️ Rollback complete to block ${blockIndex}`)
          break
        }
      }
    }

    // Initialize worker
    worker.postMessage({ type: 'initialize', id: messageIdCounterRef.current++, metadata: initialMeta })
    addDebugLog('🔧 Initializing fountain decoder worker')
    } catch (error) {
      setError('Failed to initialize decoding worker')
      addDebugLog(`Failed to initialize decoding worker: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return
    }

    // Cleanup
    return () => {
      if (worker) {
        worker.terminate()
        workerRef.current = null
      }
    }
  }, []) // Empty dependency array - only run on mount/unmount

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







 const handleGenerateFeedbackQR = useCallback(async () => {
  if (generatingRef.current) return; generatingRef.current = true
  setIsAwaitingFeedback(true)
  try {
    stopScannerRef.current?.()
    const decodedBlockIndices = decodedBlockIndicesRef.current
    const firstMissingBlock = calculateFirstMissingBlock(decodedBlockIndices)
    const decodedInWindow = decodedBlockIndices.filter((idx: number) => idx >= currentWindowStart && idx < currentWindowEnd).length
    const windowSize = Math.max(1, currentWindowEnd - currentWindowStart)
    const windowDecodePercent = decodedInWindow / windowSize
    const overallProgress = decodedBlockIndices.length / fountainMetadata.totalSourceBlocks

    // Compute checksum

    const seq = feedbackSequenceRef.current; // Use ref for atomic increment
    const missingBlocksCount = fountainMetadata.totalSourceBlocks - decodedBlockIndices.length
    const targetedModeThreshold = getTargetedModeMaxMissingBlocks(fountainMetadata.blockSize)
    let feedback: FountainFeedback
    if (missingBlocksCount > targetedModeThreshold) {
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
      }
    } else {
      if (isTargetedModeTestActive) {
        setIsTargetedModeTestActive(false)
        addDebugLog('🎯 [TARGETED MODE TEST] Deactivated block ignoring to allow recovery.')
      }
      // Targeted feedback with missing block indices - for final stage
      const decodedSet = new Set(decodedBlockIndices)
      const missingBlocks: number[] = []
      for (let i = 0; i < fountainMetadata.totalSourceBlocks; i++) {
        if (!decodedSet.has(i)) {
          missingBlocks.push(i)
        }
      }

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
      }

      const targetedFeedback = { ...feedbackBase, missingBlocks }
      const targetedJson = JSON.stringify(targetedFeedback)

      // Check if targeted version fits (rough estimate: QR capacity ~3KB for version 40)
      if (targetedJson.length <= 2500) {
        feedback = targetedFeedback
      } else {
        // Since threshold is so small, disable fallback to statistics mode
        addDebugLog(`📊 Payload too large (${targetedJson.length} bytes), but threshold is small - keeping targeted mode`)
        feedback = targetedFeedback // No fallback - threshold is small enough
      }
    }


    const feedbackJson = JSON.stringify(feedback)
    let dataUrl: string
    try {
      // Feedback QR generation intentionally uses main thread (not worker) for reliability
      // These are small JSON payloads generated infrequently, so main thread is reliable and performant
      dataUrl = await generateNonDataQR(feedback)
    } catch (qrError) {
      addDebugLog(`❌ QR generation failed: ${qrError instanceof Error ? qrError.message : 'Unknown error'}`)

      // Recovery action: if targeted mode failed due to payload size, auto-switch to statistics mode
      if (feedback.mode === 'targeted') {
        addDebugLog('🔄 Auto-switching to statistics mode due to payload size limit')
        // Create statistics feedback as fallback
        const statisticsFeedback: FountainFeedbackStatistics = {
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
        }

        try {
          dataUrl = await generateNonDataQR(statisticsFeedback)
          feedback = statisticsFeedback // Update feedback reference for later use
          setError('') // Clear any previous error
          addDebugLog('✅ Successfully generated statistics feedback QR after targeted mode failed')
        } catch (retryError) {
          addDebugLog(`❌ Statistics mode QR generation also failed: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`)
          setError('Failed to generate feedback QR code - both targeted and statistics modes exceeded payload capacity. Try again later.')
          return
        }
      } else {
        // Statistics mode failed - no recovery possible
        setError('Failed to generate feedback QR code - payload too large. Try again later or use statistics mode.')
        return
      }
    }
    setFeedbackQRUrl(dataUrl)
    setFeedbackMode(feedback.mode)
    setShowFeedbackQR(true)
    setReceiverMode('feedback-display')
    setIsScanning(false)
    feedbackSequenceRef.current += 1 // Atomic increment using ref
    setFeedbackSequence(feedbackSequenceRef.current) // Update state for UI consistency
    addDebugLog(`📤 Generated feedback QR (${feedback.mode}, session ${sessionId}, seq ${seq}): ${decodedBlockIndices.length}/${fountainMetadata.totalSourceBlocks} blocks, ${feedbackJson.length} bytes`)
    if (feedback.mode === 'statistics') {
      addDebugLog(`🪟 Window progress: ${decodedInWindow}/${currentWindowEnd - currentWindowStart} blocks (${(windowDecodePercent * 100).toFixed(1)}%)`)
    }
    // Log the decision
    addDebugLog(`📊 Missing blocks: ${missingBlocksCount}, threshold: ${targetedModeThreshold}, mode: ${missingBlocksCount > targetedModeThreshold ? 'statistics' : 'targeted'}`)
  } finally { generatingRef.current = false }
}, [feedbackSequence, sessionId, isWindowEnabled, currentWindowStart, currentWindowEnd, windowTriggerThreshold, fountainMetadata.totalSourceBlocks, addDebugLog, isTargetedModeTestActive])

 const handleBinaryFountainChunk = useCallback(async (bytes: Uint8Array) => {
   // ════════════════════════════════════════════════════════════════════════════
   // TARGETED MODE TEST LOGIC: IGNORE BLOCKS TO SIMULATE TARGETED MODE
   // To use: uncomment the array and add the block indices you want to ignore
   // Suggested test file size: 60KB (100 blocks) for meaningful targeted mode testing
   // ════════════════════════════════════════════════════════════════════════════
   if (process.env.NODE_ENV === 'development' && isTargetedModeTestActive) {
     // Parse just enough to check indices
     let offset = 2 // Skip magic bytes
     const seed = (bytes[offset++] << 8) | bytes[offset++]
     const degree = bytes[offset++]
     const numIndices = bytes[offset++]
     const indices: number[] = []
     for (let i = 0; i < numIndices; i++) {
       const idx = (bytes[offset++] << 8) | bytes[offset++]
       indices.push(idx)
     }

     const targetedModeTestIgnoreBlocks: number[] = [190,197] // Ignore blocks to simulate targeted mode (leave <= TARGETED_MODE_MAX_MISSING_BLOCKS blocks missing)
     if (targetedModeTestIgnoreBlocks.length > 0) {
       const containsIgnoredBlock = indices.some(i => targetedModeTestIgnoreBlocks.includes(i))
       if (containsIgnoredBlock) {
         addDebugLog(`🎯 [TARGETED MODE TEST] Ignoring chunk #${seed} because it contains a blocked index.`)
         return
       }
     }
   }
   // ════════════════════════════════════════════════════════════════════════════

   // Send binary data to worker for processing
   workerRef.current?.postMessage({ type: 'processChunk', id: messageIdCounterRef.current++, binaryData: bytes }, [bytes.buffer])
   addDebugLog('📤 Sent chunk to worker for processing')
  }, [addDebugLog, isTargetedModeTestActive])

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
        case 'rollback':
           addDebugLog(`⚠️ Rolling back to block ${parsed.rollbackToBlock}: ${parsed.reason}`)
           workerRef.current?.postMessage({ type: 'rollback', id: messageIdCounterRef.current++, blockIndex: parsed.rollbackToBlock })
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
             // Expand window only if sender actually expanded it
             if (parsed.windowExpanded) {
               const expansion = getWindowExpansionSizeBlocks(fountainMetadata.blockSize)
               const newWindowEnd = Math.min(currentWindowEnd + expansion, fountainMetadata.totalSourceBlocks)
               setCurrentWindowEnd(newWindowEnd)
               addDebugLog(`🪟 Window expanded by fixed segment to ${currentWindowStart}-${newWindowEnd} blocks`)
             }
             await restartScannerRef.current?.()
           } else {
             addDebugLog(`⚠️ ACK sequence mismatch: expected ${feedbackSequence - 1}, got ${parsed.acknowledgedSequence}`)
           }
           setSenderFeedbackMessage(parsed.message)
           break

        case 'requestHigherECC': {
          addDebugLog(`📈 Receiver requested higher ECC level due to scan failures`)
          // Generate feedback QR requesting higher ECC level
          const decodedBlockIndices = decodedBlockIndicesRef.current
          const currentDecodedInWindow = decodedBlockIndices.filter((idx: number) => idx >= currentWindowStart && idx < currentWindowEnd).length
          const currentProgress = (decodedBlocks / fountainMetadata.totalSourceBlocks) * 100
          const eccFeedback: FountainFeedbackStatistics = {
            type: 'FOUNTAIN_FEEDBACK',
            mode: 'statistics',
            sessionId: sessionId,
            sequence: feedbackSequence,
            decodedInWindow: currentDecodedInWindow,
            totalDecoded: decodedBlocks,
            totalBlocks: fountainMetadata.totalSourceBlocks,
            windowStart: currentWindowStart,
            windowEnd: currentWindowEnd,
            progress: currentProgress,
            requestWindowExpansion: false,
            firstMissingBlock: calculateFirstMissingBlock(decodedBlockIndices),
            requestHigherECC: true
          }
          const eccFeedbackJson = JSON.stringify(eccFeedback)
          const eccDataUrl = await generateNonDataQR(eccFeedback)
          setFeedbackQRUrl(eccDataUrl)
          setFeedbackMode('statistics')
          setShowFeedbackQR(true)
          setReceiverMode('feedback-display')
          setIsScanning(false)
          feedbackSequenceRef.current += 1 // Atomic increment using ref
          setFeedbackSequence(feedbackSequenceRef.current) // Update state for UI consistency
          addDebugLog(`📤 Generated ECC upgrade request feedback QR (${eccFeedbackJson.length} bytes)`)
          break
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Error parsing sender feedback: ${errorMsg}`)
      console.error('Sender feedback parse error:', err)
    }
  }, [sessionId, lastSenderFeedbackSequence, addDebugLog, currentWindowStart, currentWindowEnd, feedbackSequence, fountainMetadata.totalSourceBlocks])

  const handleScan = useCallback((data: string) => {
    try {
      addDebugLog(`Scanned chunk, length: ${data.length} bytes`)

      if (receiverMode === 'ack-scanning') {
        if (data.startsWith('{')) {
          const parsed = JSON.parse(data)
          if (parsed.type === 'SENDER_FEEDBACK') {
            addDebugLog('🔁 Processing sender feedback (ACK scan mode)')
            handleSenderFeedbackScan(data)
          }
        }
        return
      }

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

  // Keep refs in sync with state for worker onmessage handler
  useEffect(() => {
    isWindowEnabledRef.current = isWindowEnabled
  }, [isWindowEnabled])

  useEffect(() => {
    currentWindowStartRef.current = currentWindowStart
  }, [currentWindowStart])

  useEffect(() => {
    currentWindowEndRef.current = currentWindowEnd
  }, [currentWindowEnd])

  useEffect(() => {
    windowTriggerThresholdRef.current = windowTriggerThreshold
  }, [windowTriggerThreshold])

  useEffect(() => {
    showFeedbackQRRef.current = showFeedbackQR
  }, [showFeedbackQR])

  useEffect(() => {
    isAwaitingFeedbackRef.current = isAwaitingFeedback
  }, [isAwaitingFeedback])

  // Auto-start scanning when component mounts (after metadata is scanned)
  useEffect(() => {
    if (!isScanning && !success && !isAwaitingFeedback && receiverMode === 'data-scanning') {
      addDebugLog('🚀 Auto-starting data scanning after metadata initialization')
      handleStartScan()
    }
  }, []) // Empty dependency array - only run once on mount

  // ═══════════════════════════════════════════════════════════════════════════════
  // FEEDBACK QR GENERATION - MUTUALLY EXCLUSIVE TRIGGERS WITH PRIORITY ORDERING
  // ═══════════════════════════════════════════════════════════════════════════════
  //
  // ⚠️  CRITICAL: All feedback QR generation triggers MUST be mutually exclusive!
  //     Only ONE trigger should fire at a time to prevent sequence conflicts and
  //     ensure predictable sender/receiver synchronization.
  //
  // Priority Order (highest to lowest):
  //
  //   0. FILE SIZE CHECK (PRE-FILTER)
  //      When: totalSourceBlocks < TARGETED_MODE_MAX_MISSING_BLOCKS * 3
  //      Why: Skip ALL feedback mechanisms for very small files (< ~50 blocks / ~30KB)
  //           These files are small enough to decode quickly without any feedback overhead
  //      Action: Early return - no feedback QR generation for small files
  //
  //   1. WINDOW SATURATION (HIGHEST PRIORITY - MANDATORY)
  //      Location: Inline in handleBinaryFountainChunk (lines ~368-382)
  //      When: windowDecodePercentage >= windowTriggerThreshold
  //      Why highest: Required for windowed transfers to continue; blocking operation
  //      Guards: !showFeedbackQR && !isAwaitingFeedback
  //
  //   2. TARGETED MODE (SECOND PRIORITY - EFFICIENCY)
  //      Location: This useEffect (lines ~515-523)
  //      When: currentMissingBlocks <= TARGETED_MODE_MAX_MISSING_BLOCKS
  //      Why: Optimize final blocks transfer efficiency
  //
  // ⚠️  FUTURE DEVELOPERS: When adding new feedback triggers:
  //     1. Add priority-based guards to prevent conflicts with existing triggers
  //     2. Use early returns to enforce priority ordering
  //     3. Ensure new trigger checks !showFeedbackQR && !isAwaitingFeedback
  //     4. Document the priority level and mutual exclusivity conditions
  //     5. Test that only ONE trigger fires in edge cases
  //
  // ═══════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    // Skip all checks if already showing feedback, transfer complete, or awaiting feedback
    if (showFeedbackQR || success || isAwaitingFeedback) return

    // Priority 0: Skip ALL feedback for very small files
    // Files smaller than 5x the targeted mode threshold don't benefit from feedback
    const targetedModeThreshold = getTargetedModeMaxMissingBlocks(fountainMetadata.blockSize)
    const isFileLargeEnoughForFeedback = fountainMetadata.totalSourceBlocks >= getFeedbackFileSizeThresholdBlocks(fountainMetadata.blockSize)
    if (!isFileLargeEnoughForFeedback) {
      // No feedback QR needed for very small files - they decode quickly without it
      return
    }

    const currentMissingBlocks = fountainMetadata.totalSourceBlocks - decodedBlocks

    // Add guard to prevent feedback when all blocks are decoded
    if (decodedBlocks >= fountainMetadata.totalSourceBlocks) return

    // Priority 2: Check for targeted mode threshold
    const crossedToTargeted = prevMissingBlocksRef.current > targetedModeThreshold && currentMissingBlocks <= targetedModeThreshold
    if (crossedToTargeted) {
      addDebugLog(`🎯 Targeted mode threshold reached (${currentMissingBlocks} blocks remaining) - auto-generating feedback`)
      handleGenerateFeedbackQR()
      setReceiverMode('feedback-display')
      setIsScanning(false)
      prevMissingBlocksRef.current = currentMissingBlocks
      return
    }


    prevMissingBlocksRef.current = currentMissingBlocks
  }, [decodedBlocks, fountainMetadata.totalSourceBlocks, showFeedbackQR, success, isAwaitingFeedback, handleGenerateFeedbackQR, addDebugLog])

  const handleStartScan = () => {
    setIsScanning(true)
    setReceivedFountainChunks(0)
    setDecodedBlocks(0)
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
    decodedBlockIndicesRef.current = []
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
    feedbackSequenceRef.current = 0
    setFeedbackSequence(0)
    setLastSenderFeedbackSequence(-1)
    setSenderFeedbackMessage('')
    setInvalidChecksumCount(0)
    setShowMetadataInfo(false)
    // Reinitialize worker state without recreating the worker instance
    workerRef.current?.postMessage({ type: 'initialize', id: messageIdCounterRef.current++, metadata: initialMeta })
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
    const decodedBlockIndices = decodedBlockIndicesRef.current
    return decodedBlockIndices.filter((idx: number) => idx >= currentWindowStart && idx < currentWindowEnd).length
  }, [isWindowEnabled, currentWindowStart, currentWindowEnd])

  return (
    <div className="space-y-4">
      {/* Unified Feedback/ACK UI */}
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
                {currentMissingBlocks > getTargetedModeMaxMissingBlocks(fountainMetadata.blockSize) ? 'Sharing window progress (compact format)' : feedbackMode === 'targeted' ? 'Sharing decoded blocks for targeted transfer' : 'Sharing progress summary (fallback mode due to payload size)'}
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Show this QR to sender, then click the button below to scan for ACK
              </p>
              <Button
                onClick={() => setReceiverMode('ack-scanning')}
                variant="default"
                className="w-full"
              >
                Start Scanning for ACK
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
          {showScanningBadge && (
            <div className="absolute top-2 left-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium z-20">
              ● SCANNING
            </div>
          )}
          {receiverMode === 'ack-scanning' && (
            <div className="absolute bottom-2 left-2 right-2 bg-black/70 text-white px-3 py-2 rounded-lg shadow-lg z-20">
              <p className="text-sm text-center">
                Scanning for ACK QR from sender. Point camera at sender's ACK QR code
              </p>
            </div>
          )}
          {showSenderMsg && (
            <div className={`absolute ${showScanningBadge ? 'top-12' : 'top-2'} right-2 bg-blue-500/90 text-white px-3 py-2 rounded-lg shadow-lg max-w-xs z-20`}>
              <div className="flex items-start gap-2">
                <p className="text-sm font-medium">{senderFeedbackMessage}</p>
                <button
                  onClick={() => setSenderFeedbackMessage('')}
                  className="text-white hover:text-gray-200 text-sm font-bold"
                >
                  ✕
                </button>
              </div>
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
            {invalidChecksumCount > 0 && (
              <div className="text-red-600">
                Invalid checksums: {invalidChecksumCount} chunks skipped
              </div>
            )}
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
      {!success && showMetadataInfo && (
        <Alert>
          <AlertDescription>
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium">{fountainMetadata.name}</p>
                <p className="text-sm text-muted-foreground">
                  Expected size: {(fountainMetadata.size / 1024).toFixed(2)}KB |
                  Blocks: {fountainMetadata.totalSourceBlocks}
                </p>
              </div>
              <button
                onClick={() => setShowMetadataInfo(false)}
                className="text-muted-foreground hover:text-foreground text-sm"
              >
                ✕
              </button>
            </div>
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
          <>
            <Button disabled className="flex-1" variant="secondary">
              📊 Showing Feedback QR - Toggle above to scan ACK
            </Button>
            <Button onClick={() => setReceiverMode('ack-scanning')} className="flex-1">
              📷 Switch to ACK Scanning
            </Button>
          </>
        )}
        {receiverMode === 'ack-scanning' && !success && (
          <>
            <Button onClick={() => setReceiverMode('feedback-display')} className="flex-1">
              📊 Switch to Feedback QR
            </Button>
            <Button disabled className="flex-1" variant="secondary">
              📷 Scanning for ACK QR - Toggle above to view feedback qr
            </Button>
          </>
        )}
        {!success && (
          <Button
            onClick={() => setShowMetadataInfo(!showMetadataInfo)}
            variant="ghost"
            size="sm"
          >
            {showMetadataInfo ? '▼' : '▶'} File Info
          </Button>
        )}
      </div>

    </div>
  )
}
