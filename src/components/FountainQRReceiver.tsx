import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { FountainMetadata } from '@/utils/fountainCode'
import type { FountainFeedback, FountainFeedbackStatistics, SenderFeedback } from '@/types/fountainFeedback'
import { getTargetedModeMaxMissingBlocks, getFeedbackFileSizeThresholdBlocks, getWindowExpansionSizeBlocks } from '@/utils/fountainConfig'
import FountainDecoderWorker from '@/workers/fountainDecoder.worker?worker'
import { generateNonDataQR } from '@/utils/qrUtils'
import { FountainQRDataScanner } from './FountainQRDataScanner'
import { useQRScanner } from '@/hooks/useQRScanner'

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

  // Metadata is immutable for this mount (component remounted per file)
  const fountainMetadata: FountainMetadata = initialMeta
  const [decodedBlocks, setDecodedBlocks] = useState(0)
  const [success, setSuccess] = useState(false)
  const [integrityOk, setIntegrityOk] = useState<boolean | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [showFeedbackQR, setShowFeedbackQR] = useState(false)
  const [feedbackQRUrl, setFeedbackQRUrl] = useState<string>('')
  const [feedbackMode, setFeedbackMode] = useState<'statistics' | 'targeted'>('statistics')
  const [receiverMode, setReceiverMode] = useState<'data-scanning' | 'feedback-display' | 'ack-scanning'>('data-scanning')
  const [invalidChecksumCount, setInvalidChecksumCount] = useState(0)

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

  // Subcomponent state
  const [isScanning, setIsScanning] = useState(false)

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

  // Worker initialization and cleanup
  useEffect(() => {
    let worker: Worker | null = null
    try {
      worker = new FountainDecoderWorker()
      workerRef.current = worker

      worker.onerror = (e) => {
        setError('Worker runtime error')
        // Debug logging moved to subcomponent
      }

      worker.onmessage = (event: MessageEvent) => {
      const { type, id, ...data } = event.data

      switch (type) {
        case 'initialized':
          // Debug logging moved to subcomponent
          break

        case 'chunkProcessed': {
          const { duplicate, seed, decodedBlockCount, progress, isComplete, decodedBlockIndices } = data
          if (duplicate) {
            // Debug logging moved to subcomponent
            return
          }
          // setReceivedFountainChunks moved to subcomponent
          setDecodedBlocks(decodedBlockCount)
          decodedBlockIndicesRef.current = decodedBlockIndices
          // Debug logging moved to subcomponent

          // Window saturation check
          const isFileLargeEnoughForFeedback = fountainMetadata.totalSourceBlocks >= getFeedbackFileSizeThresholdBlocks(fountainMetadata.blockSize)
          if (isWindowEnabledRef.current && currentWindowEndRef.current < fountainMetadata.totalSourceBlocks && !showFeedbackQRRef.current && !isAwaitingFeedbackRef.current && isFileLargeEnoughForFeedback) {
            const decodedInWindow = decodedBlockIndices.filter((idx: number) => idx >= currentWindowStartRef.current && idx < currentWindowEndRef.current).length
            const windowDecodePercentage = decodedInWindow / (currentWindowEndRef.current - currentWindowStartRef.current)

            if (windowDecodePercentage >= windowTriggerThresholdRef.current) {
              // Debug logging moved to subcomponent
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
            // Debug logging moved to subcomponent
          } else {
            setIntegrityOk(null)
          }

          // Debug logging moved to subcomponent
          break
        }

        case 'error': {
          const { error, seed } = data
          if (error === 'Invalid checksum') {
            setInvalidChecksumCount(prev => prev + 1)
            // Debug logging moved to subcomponent
          } else {
            // Debug logging moved to subcomponent
            setError(`Worker error: ${error}`)
          }
          break
        }

      }
    }

    // Initialize worker
    worker.postMessage({ type: 'initialize', id: messageIdCounterRef.current++, metadata: initialMeta })
    // Debug logging moved to subcomponent
    } catch (error) {
      setError('Failed to initialize decoding worker')
      // Debug logging moved to subcomponent
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
    // stopScannerRef moved to subcomponent
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
        // Debug logging moved to subcomponent
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
      // Debug logging moved to subcomponent

      // Recovery action: if targeted mode failed due to payload size, auto-switch to statistics mode
      if (feedback.mode === 'targeted') {
        // Debug logging moved to subcomponent
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
          // Debug logging moved to subcomponent
        } catch (retryError) {
          // Debug logging moved to subcomponent
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
    // Debug logging moved to subcomponent
    if (feedback.mode === 'statistics') {
      // Debug logging moved to subcomponent
    }
    // Log the decision
    // Debug logging moved to subcomponent
  } finally { generatingRef.current = false }
}, [feedbackSequence, sessionId, isWindowEnabled, currentWindowStart, currentWindowEnd, windowTriggerThreshold, fountainMetadata.totalSourceBlocks])

 // handleBinaryFountainChunk moved to subcomponent

  const handleSenderFeedbackScan = useCallback(async (data: string): Promise<void> => {
    try {
      const parsed = JSON.parse(data) as SenderFeedback
      if (parsed.type !== 'SENDER_FEEDBACK') {
        // Debug logging moved to subcomponent
        return
      }

      if (parsed.sessionId !== sessionId) {
        // Debug logging moved to subcomponent
        return
      }

      if (parsed.sequence <= lastSenderFeedbackSequence) {
        // Debug logging moved to subcomponent
        return
      }

      setLastSenderFeedbackSequence(parsed.sequence)

      switch (parsed.command) {

        case 'acknowledge':
            // Debug logging moved to subcomponent
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
                // Debug logging moved to subcomponent
              }
              // Stop the ACK scanner before restarting data scanner
              // stopScannerRef moved to subcomponent
              // restartScannerRef moved to subcomponent
            } else {
              // Debug logging moved to subcomponent
            }
           setSenderFeedbackMessage(parsed.message)
           break

      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      // Debug logging moved to subcomponent
      console.error('Sender feedback parse error:', err)
    }
  }, [sessionId, lastSenderFeedbackSequence, currentWindowStart, currentWindowEnd, feedbackSequence, fountainMetadata.totalSourceBlocks])

  // ACK scanner setup
  const ackScannerIsScanning = receiverMode === 'ack-scanning'
  const { videoRef: ackVideoRef } = useQRScanner({
    onScan: handleSenderFeedbackScan,
    isScanning: ackScannerIsScanning,
    onError: (errorMessage) => {
      setError(errorMessage)
    }
  })

  // handleScan moved to subcomponent

  // Scanner integration moved to subcomponent

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

  // Auto-start scanning moved to subcomponent

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
      // Debug logging moved to subcomponent
      handleGenerateFeedbackQR()
      setReceiverMode('feedback-display')
      setIsScanning(false)
      prevMissingBlocksRef.current = currentMissingBlocks
      return
    }

    // Prevent getting stuck in targeted mode when window expansion is needed
    // If we're in targeted mode but have many missing blocks, switch back to statistics mode
    const isStuckInTargetedMode = currentMissingBlocks > targetedModeThreshold * 2 && isWindowEnabled && currentWindowEnd < fountainMetadata.totalSourceBlocks
    if (isStuckInTargetedMode) {
      // Debug logging moved to subcomponent
      handleGenerateFeedbackQR()
      setReceiverMode('feedback-display')
      setIsScanning(false)
      return
    }


    prevMissingBlocksRef.current = currentMissingBlocks
  }, [decodedBlocks, fountainMetadata.totalSourceBlocks, showFeedbackQR, success, isAwaitingFeedback, handleGenerateFeedbackQR])

  // handleStartScan, handleStopScan moved to subcomponent

  const handleReset = () => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
    }
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



      {/* Video Preview for ACK scanning */}
      {receiverMode === 'ack-scanning' && (
        <div className="relative bg-black rounded-lg overflow-hidden">
          <video
            ref={ackVideoRef}
            className="w-full h-auto"
            style={{ maxHeight: '400px' }}
          />
          {showScanningBadge && (
            <div className="absolute top-2 left-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium z-20">
              ● SCANNING
            </div>
          )}
          <div className="absolute bottom-2 left-2 right-2 bg-black/70 text-white px-3 py-2 rounded-lg shadow-lg z-20">
            <p className="text-sm text-center">
              Scanning for ACK QR from sender. Point camera at sender's ACK QR code
            </p>
          </div>
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

      {/* Progress moved to subcomponent */}

      {/* Metadata Info moved to subcomponent */}


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
                  Decoded using fountain codes
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

      {/* Add the subcomponent */}
      <FountainQRDataScanner
        fountainMetadata={fountainMetadata}
        workerRef={workerRef}
        messageIdCounterRef={messageIdCounterRef}
        isScanning={isScanning}
        receiverMode={receiverMode}
        isAwaitingFeedback={isAwaitingFeedback}
        success={success}
        decodedBlocks={decodedBlocks}
        invalidChecksumCount={invalidChecksumCount}
        onChunkScanned={(seed) => {
          // Optional: handle chunk scanned callback if needed
        }}
        onScanError={(error) => {
          setError(error)
        }}
        onScanStart={() => {
          setIsScanning(true)
        }}
        onScanStop={() => {
          setIsScanning(false)
        }}
        onReset={() => {
          handleReset()
        }}
        onToggleMetadataInfo={(show) => {
          // Optional: handle metadata info toggle if needed
        }}
      />

    </div>
  )
}
