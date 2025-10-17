import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { FountainMetadata } from '@/utils/fountainCode'
import { getTargetedModeMaxMissingBlocks, getFeedbackFileSizeThresholdBlocks, getWindowExpansionSizeBlocks, WINDOW_BASELINE_THRESHOLD, WINDOW_MIN_PROGRESS_DELTA } from '@/utils/fountainConfig'
import FountainDecoderWorker from '@/workers/fountainDecoder.worker?worker'
import { FountainQRDataScanner } from './FountainQRDataScanner'
import { FountainQRFeedbackDisplay } from './FountainQRFeedbackDisplay'

interface FountainQRReceiverProps {
  initialMetadata: {
    name: string
    size: number
    type: string
    sessionId: number
    totalSourceBlocks: number
    blockSize?: number // for windowed fountain
    checksum: string
    checksumAlg: string
    windowEnabled: boolean
    initialWindowBlocks?: number // for windowed fountain
    windowTriggerThreshold?: number // for windowed fountain
    windowStart?: number // for windowed fountain
    feedbackEnabled: boolean
  }
}

export function FountainQRReceiver({ initialMetadata }: FountainQRReceiverProps) {
  const feedbackEnabled = initialMetadata.feedbackEnabled ?? true

  // Initialize metadata and decoder immediately (always provided by parent)
  const initialMeta: FountainMetadata = {
    name: initialMetadata.name,
    size: initialMetadata.size,
    type: initialMetadata.type,
    timestamp: Date.now(),
    totalSourceBlocks: initialMetadata.totalSourceBlocks,
    blockSize: initialMetadata.blockSize || 600,
    checksum: initialMetadata.checksum,
    checksumAlg: initialMetadata.checksumAlg,
  }

  // Metadata is immutable for this mount (component remounted per file)
  const fountainMetadata: FountainMetadata = initialMeta
  const [decodedBlocks, setDecodedBlocks] = useState(0)
  const [success, setSuccess] = useState(false)
  const [integrityOk, setIntegrityOk] = useState<boolean | null>(null)
  const [actualChecksum, setActualChecksum] = useState<string>('')
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [receiverMode, setReceiverMode] = useState<'data-scanning' | 'feedback-display' | 'ack-scanning'>('data-scanning')
   const [invalidChecksumCount, setInvalidChecksumCount] = useState(0)
   const [isTargetedModeActive, setIsTargetedModeActive] = useState(false)

  // Window state tracking
  const [currentWindowStart, setCurrentWindowStart] = useState<number>(initialMetadata.windowStart ?? 0)
  const [currentWindowEnd, setCurrentWindowEnd] = useState<number>(initialMetadata.initialWindowBlocks ?? fountainMetadata.totalSourceBlocks)
  const [windowTriggerThreshold] = useState<number>(initialMetadata.windowTriggerThreshold ?? 0.5)
  const [isWindowEnabled] = useState<boolean>(initialMetadata.windowEnabled ?? false)
  const [isAwaitingFeedback, setIsAwaitingFeedback] = useState<boolean>(false)
  const [feedbackSequence, setFeedbackSequence] = useState<number>(0)
  const feedbackSequenceRef = useRef<number>(0)
  const [lastSenderFeedbackSequence, setLastSenderFeedbackSequence] = useState(-1)
  const prevMissingBlocksRef = useRef<number>(Infinity)
  const sessionId = initialMetadata.sessionId
  const [error, setError] = useState<string>('')

  // Adaptive window threshold state
  const [lastTriggeredWindowPercentage, setLastTriggeredWindowPercentage] = useState<number>(0)

  // Subcomponent state
  const [isScanning, setIsScanning] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  const messageIdCounterRef = useRef<number>(0)
  const decodedBlockIndicesRef = useRef<number[]>([])

  // Refs for worker onmessage handler to avoid stale closures
  const isWindowEnabledRef = useRef(isWindowEnabled)
  const currentWindowStartRef = useRef(currentWindowStart)
  const currentWindowEndRef = useRef(currentWindowEnd)
  const windowTriggerThresholdRef = useRef(windowTriggerThreshold)
  const isAwaitingFeedbackRef = useRef(isAwaitingFeedback)
  const isTargetedModeActiveRef = useRef(isTargetedModeActive)
  const triggeredFeedbackRef = useRef(false)
  const lastTriggeredWindowPercentageRef = useRef<number>(0)
  const lastObservedWindowPercentageRef = useRef<number>(0)

  // Worker initialization and cleanup
  useEffect(() => {
    let worker: Worker | null = null
    try {
      worker = new FountainDecoderWorker()
      workerRef.current = worker

      worker.onerror = () => {
        setError('Worker runtime error')
        // Debug logging moved to subcomponent
      }

      worker.onmessage = (event: MessageEvent) => {
      const { type, ...data } = event.data

      switch (type) {
        case 'initialized':
          // Debug logging moved to subcomponent
          break

        case 'chunkProcessed': {
          const { duplicate, decodedBlockCount, decodedBlockIndices } = data
          if (duplicate) {
            // Debug logging moved to subcomponent
            return
          }
          // setReceivedFountainChunks moved to subcomponent
          setDecodedBlocks(decodedBlockCount)
          decodedBlockIndicesRef.current = decodedBlockIndices
          // Debug logging moved to subcomponent

          // Window saturation check with adaptive threshold
          const isFileLargeEnoughForFeedback = fountainMetadata.totalSourceBlocks >= getFeedbackFileSizeThresholdBlocks(fountainMetadata.blockSize)
          // Disable window saturation feedback when targeted mode is active
          if (isWindowEnabledRef.current && currentWindowEndRef.current < fountainMetadata.totalSourceBlocks && !isAwaitingFeedbackRef.current && !isTargetedModeActiveRef.current && isFileLargeEnoughForFeedback && feedbackEnabled) {
            const decodedInWindow = decodedBlockIndices.filter((idx: number) => idx >= currentWindowStartRef.current && idx < currentWindowEndRef.current).length
            const windowDecodePercentage = decodedInWindow / (currentWindowEndRef.current - currentWindowStartRef.current)

            // Adaptive threshold calculation
            const adaptiveThreshold = WINDOW_BASELINE_THRESHOLD + Math.max(0, lastTriggeredWindowPercentageRef.current - WINDOW_BASELINE_THRESHOLD)
            const progressDelta = windowDecodePercentage - lastObservedWindowPercentageRef.current

            console.log(`[FountainQRReceiver] Adaptive threshold check: current=${(windowDecodePercentage * 100).toFixed(1)}%, adaptive threshold=${(adaptiveThreshold * 100).toFixed(1)}%, progress delta=${(progressDelta * 100).toFixed(1)}%`)

            if (windowDecodePercentage >= adaptiveThreshold && progressDelta >= WINDOW_MIN_PROGRESS_DELTA) {
              // Guard: Prevent rapid mode switching by ensuring transition occurs only once per feedback cycle
              if (triggeredFeedbackRef.current) {
                return
              }
              // Debug logging moved to subcomponent
              triggeredFeedbackRef.current = true
              setLastTriggeredWindowPercentage(windowDecodePercentage)
              // Update lastObservedWindowPercentageRef when feedback is triggered, so progressDelta measures progress since last feedback
              lastObservedWindowPercentageRef.current = windowDecodePercentage
              setReceiverMode('feedback-display')
              setIsScanning(false)
              setIsAwaitingFeedback(true)
            }
          }
          break
        }

        case 'complete': {
          const { data: reconstructedData, integrityOk, calculatedChecksum } = data
          const blob = new Blob([reconstructedData], { type: fountainMetadata.type || 'application/octet-stream' })
          const url = URL.createObjectURL(blob)

          setDownloadUrl(url)
          setSuccess(true)
          setIsScanning(false)
          setIntegrityOk(integrityOk)
          setActualChecksum(calculatedChecksum)

          // Debug logging moved to subcomponent
          break
        }

        case 'error': {
          const { error } = data
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
    } catch {
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

  const handleFeedbackGenerated = useCallback(() => {
    setReceiverMode('feedback-display')
    setIsAwaitingFeedback(true)
  }, [])

  const handleAckReceived = useCallback((_acknowledgedSequence: number, windowExpanded: boolean) => {
    // RECEIVER: Rely on sender's ACK windowExpanded flag to update window state
    // Sender is the single authority for window expansion - receiver only reflects it
    if (windowExpanded) {
      const expansion = getWindowExpansionSizeBlocks(fountainMetadata.blockSize)
      const newWindowEnd = Math.min(currentWindowEnd + expansion, fountainMetadata.totalSourceBlocks)
      setCurrentWindowEnd(newWindowEnd)
      console.log(`[FountainQRReceiver] Window expanded by sender: new end=${newWindowEnd}`)
    }
    setIsTargetedModeActive(true)
    triggeredFeedbackRef.current = false
    setIsAwaitingFeedback(false)
    setIsScanning(true)
    // Reset lastObservedWindowPercentageRef to 0 so progressDelta measures progress since window expansion
    lastObservedWindowPercentageRef.current = 0
  }, [fountainMetadata.blockSize, fountainMetadata.totalSourceBlocks, currentWindowEnd])

  const handleFeedbackModeChange = useCallback((mode: 'data-scanning' | 'feedback-display' | 'ack-scanning') => {
    console.log('[FountainQRReceiver] handleFeedbackModeChange called with mode:', mode, 'current mode:', receiverMode)
    setReceiverMode(mode)
    if (mode === 'data-scanning') {
      triggeredFeedbackRef.current = false
      setIsAwaitingFeedback(false)
      setIsScanning(true)
      console.log('[FountainQRReceiver] Transitioned to data-scanning mode, isScanning set to true')
    } else if (mode === 'feedback-display') {
      setIsAwaitingFeedback(true)
      setIsScanning(false)
    } else if (mode === 'ack-scanning') {
      setIsAwaitingFeedback(true)
      setIsScanning(false)
    }
  }, [receiverMode])

  // Window expansion callback - kept for backwards compatibility but unused
  // Receiver now relies solely on ACK windowExpanded flag from sender
  const handleWindowExpansion = useCallback(() => {
    // This callback is deprecated - window expansion handled in handleAckReceived
    console.warn('[FountainQRReceiver] handleWindowExpansion called but is deprecated - use handleAckReceived instead')
  }, [])

  const handleFeedbackError = useCallback((error: string) => {
    setError(error)
  }, [])

  const handleSequenceIncrement = useCallback(() => {
    feedbackSequenceRef.current += 1
    setFeedbackSequence(feedbackSequenceRef.current)
  }, [])

  const handleSenderSequenceUpdate = useCallback((sequence: number) => {
    setLastSenderFeedbackSequence(sequence)
  }, [])








 // handleBinaryFountainChunk moved to subcomponent


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
    isAwaitingFeedbackRef.current = isAwaitingFeedback
  }, [isAwaitingFeedback])

  useEffect(() => {
    lastTriggeredWindowPercentageRef.current = lastTriggeredWindowPercentage
  }, [lastTriggeredWindowPercentage])

  useEffect(() => {
    isTargetedModeActiveRef.current = isTargetedModeActive
  }, [isTargetedModeActive])

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
    if (success || isAwaitingFeedback) return

    // Skip all feedback logic if feedback is disabled
    if (!feedbackEnabled) return

    // Priority 0: Skip ALL feedback for very small files
    // Files smaller than 5x the targeted mode threshold don't benefit from feedback
    const targetedModeThreshold = getTargetedModeMaxMissingBlocks(fountainMetadata.blockSize)
    const isFileLargeEnoughForFeedback = fountainMetadata.totalSourceBlocks >= getFeedbackFileSizeThresholdBlocks(fountainMetadata.blockSize) && feedbackEnabled
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
      setReceiverMode('feedback-display')
      setIsScanning(false)
      setIsAwaitingFeedback(true)
      setIsTargetedModeActive(true)
      prevMissingBlocksRef.current = currentMissingBlocks
      return
    }

    // Prevent getting stuck in targeted mode when window expansion is needed
    // If we're in targeted mode but have many missing blocks, switch back to statistics mode
    // NOTE: This check was causing erroneous mode switches due to stale ref reads
    // Removed to prevent unpredictable feedback mode transitions


    prevMissingBlocksRef.current = currentMissingBlocks
  }, [decodedBlocks, fountainMetadata.totalSourceBlocks, fountainMetadata.blockSize, success, isAwaitingFeedback, fountainMetadata.type, initialMeta])

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
    setReceiverMode('data-scanning')
    setCurrentWindowStart(initialMetadata.windowStart ?? 0)
    setCurrentWindowEnd(initialMetadata.initialWindowBlocks ?? fountainMetadata.totalSourceBlocks)
    feedbackSequenceRef.current = 0
    setFeedbackSequence(0)
    setLastSenderFeedbackSequence(-1)
    setInvalidChecksumCount(0)
    setIsTargetedModeActive(false)
    triggeredFeedbackRef.current = false
    setLastTriggeredWindowPercentage(0)
    lastObservedWindowPercentageRef.current = 0
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




  return (
    <div className="space-y-4">
      {/* No-feedback mode alert */}
      {!feedbackEnabled && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">📱 No-feedback mode: Continue scanning until transfer completes</p>
            <p className="text-sm">Sender cannot scan QR codes. Transfer will complete using random chunk generation only. No feedback QR codes will be generated.</p>
          </AlertDescription>
        </Alert>
      )}

      {/* Add the subcomponent */}
      {feedbackEnabled && (
        <FountainQRFeedbackDisplay
          fountainMetadata={fountainMetadata}
          sessionId={sessionId}
          decodedBlocks={decodedBlocks}
          decodedBlockIndices={decodedBlockIndicesRef.current}
          currentWindow={{ start: currentWindowStart, end: currentWindowEnd }}
          currentWindowStart={currentWindowStart}
          currentWindowEnd={currentWindowEnd}
          isWindowEnabled={isWindowEnabled}
          windowTriggerThreshold={windowTriggerThreshold}
          feedbackSequence={feedbackSequence}
          lastSenderFeedbackSequence={lastSenderFeedbackSequence}
          receiverMode={receiverMode}
          isActive={receiverMode === 'feedback-display' || receiverMode === 'ack-scanning'}
          onFeedbackGenerated={handleFeedbackGenerated}
          onAckReceived={handleAckReceived}
          onModeChange={handleFeedbackModeChange}
          onWindowExpansion={handleWindowExpansion}
          onError={handleFeedbackError}
          onSequenceIncrement={handleSequenceIncrement}
          onSenderSequenceUpdate={handleSenderSequenceUpdate}
        />
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
              <p className={`text-sm font-medium ${integrityOk === null ? 'text-yellow-600' : integrityOk ? 'text-green-600' : 'text-red-600'}`}>
                {integrityOk ? `🔐 Integrity verified (checksum matches ${initialMetadata.checksum})` : `❌ Integrity check failed, expected ${initialMetadata.checksum}, but got ${actualChecksum}`}
              </p>
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
        isTargetedModeActive={isTargetedModeActive}
        onChunkScanned={() => {
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
        onToggleMetadataInfo={() => {
          // Optional: handle metadata info toggle if needed
        }}
        onModeChange={handleFeedbackModeChange}
      />

    </div>
  )
}
