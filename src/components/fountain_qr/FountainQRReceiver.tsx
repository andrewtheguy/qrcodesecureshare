/**
 * This is the main RECEIVER component that orchestrates the entire fountain code
 * transfer process from the receiver's perspective. It coordinates between data
 * scanning, feedback generation, and acknowledgment handling to successfully
 * decode files sent via fountain-coded QR streams.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { FountainMetadata } from '@/utils/fountainCode'
import { DEFAULT_BLOCK_SIZE, getTargetedModeMaxMissingBlocks, ENABLE_TARGETED_MODE } from '@/utils/fountainConfig'
import FountainDecoderWorker from '@/workers/fountainDecoder.worker?worker'
import { FountainQRDataScanner } from './receiver/FountainQRDataScanner'
import { FountainQRFeedbackDisplay } from './receiver/FountainQRFeedbackDisplay'

interface FountainQRReceiverProps {
  initialMetadata: {
    name: string
    size: number
    type: string
    sessionId: number
    totalSourceBlocks: number
    blockSize?: number
    checksum: string
    checksumAlg: string
    feedbackEnabled: boolean
    partBasedMode?: boolean
    partSize?: number
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
    blockSize: initialMetadata.blockSize || DEFAULT_BLOCK_SIZE,
    checksum: initialMetadata.checksum,
    checksumAlg: initialMetadata.checksumAlg,
    partBasedMode: initialMetadata.partBasedMode,
    partSize: initialMetadata.partSize,
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
   const [skipTargetedModeForSession, setSkipTargetedModeForSession] = useState(false)

  // Window mode removed - no window logic

  const [isAwaitingFeedback, setIsAwaitingFeedback] = useState<boolean>(false)
  const [feedbackSequence, setFeedbackSequence] = useState<number>(0)
  const feedbackSequenceRef = useRef<number>(0)
  const [lastSenderFeedbackSequence, setLastSenderFeedbackSequence] = useState(-1)
  const prevMissingBlocksRef = useRef<number>(Infinity)
  const sessionId = initialMetadata.sessionId
  const [error, setError] = useState<string>('')
  const [lastAckTransitionSuccessful, setLastAckTransitionSuccessful] = useState<boolean>(true)
  const [senderFeedbackMessage, setSenderFeedbackMessage] = useState<string>('')

  // Part-based transfer state
  const [partCompleteInfo, setPartCompleteInfo] = useState<{
    partComplete: boolean
    partChecksumMatch: boolean
    computedChecksum: string
    currentPart: number
    totalParts: number
  } | null>(null)
  const [currentPartIndex, setCurrentPartIndex] = useState<number>(0)
  const [totalParts, setTotalParts] = useState<number>(1)
  const [currentPartDecodedBlocks, setCurrentPartDecodedBlocks] = useState<number>(0)
  const [currentPartTotalBlocks, setCurrentPartTotalBlocks] = useState<number>(0)

  // Subcomponent state
  const [isScanning, setIsScanning] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  const messageIdCounterRef = useRef<number>(0)
  const decodedBlockIndicesRef = useRef<number[]>([])

  // Refs for worker onmessage handler to avoid stale closures
  const isAwaitingFeedbackRef = useRef(isAwaitingFeedback)
  const isTargetedModeActiveRef = useRef(isTargetedModeActive)
  const triggeredFeedbackRef = useRef(false)
  const skipTargetedModeForSessionRef = useRef<boolean>(skipTargetedModeForSession)

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
          const { duplicate, decodedBlockCount, decodedBlockIndices, partCompleteInfo, currentPartIndex: partIndex, totalParts: numParts, currentPartDecodedBlocks: partDecodedBlocks, currentPartTotalBlocks: partTotalBlocks } = data
          if (duplicate) {
            // Debug logging moved to subcomponent
            return
          }
          // setReceivedFountainChunks moved to subcomponent
          setDecodedBlocks(decodedBlockCount)
          decodedBlockIndicesRef.current = decodedBlockIndices

          // Update part-specific state if in part-based mode
          if (partIndex !== undefined && numParts !== undefined) {
            setCurrentPartIndex(partIndex)
            setTotalParts(numParts)
          }
          if (partDecodedBlocks !== undefined && partTotalBlocks !== undefined) {
            setCurrentPartDecodedBlocks(partDecodedBlocks)
            setCurrentPartTotalBlocks(partTotalBlocks)
          }
          // Debug logging moved to subcomponent

          // Handle part completion if in part-based mode
          if (partCompleteInfo && partCompleteInfo.partComplete) {
            console.log(`[FountainQRReceiver] Part ${partCompleteInfo.currentPart + 1}/${partCompleteInfo.totalParts} complete. Checksum match: ${partCompleteInfo.partChecksumMatch}`)

            // Store part completion info in state
            setPartCompleteInfo(partCompleteInfo)

            if (!partCompleteInfo.partChecksumMatch) {
              // Part checksum mismatch - fail the transfer
              console.error(`[FountainQRReceiver] Part checksum mismatch! Computed: ${partCompleteInfo.computedChecksum}, partCompleteInfo:`, partCompleteInfo)
              setError(`Part ${partCompleteInfo.currentPart + 1} checksum mismatch. Computed: ${partCompleteInfo.computedChecksum}, but expected different value from sender`)
              setIsScanning(false)
              return
            }

            // Check if this was the last part
            const isLastPart = (partCompleteInfo.currentPart + 1) === partCompleteInfo.totalParts

            if (isLastPart) {
              // Last part completed - the transfer should be complete now
              // The worker will send a 'complete' message when all parts are assembled
              console.log('[FountainQRReceiver] Last part completed, waiting for final assembly...')
              // Don't trigger feedback, just continue scanning to let the worker finish
            } else {
              // Not the last part - trigger feedback to move to next part
              console.log(`[FountainQRReceiver] Part ${partCompleteInfo.currentPart + 1}/${partCompleteInfo.totalParts} completed, triggering feedback for next part`)
              triggeredFeedbackRef.current = true
              setReceiverMode('feedback-display')
              setIsScanning(false)
              setIsAwaitingFeedback(true)
            }
            break
          }

          // Window logic removed - no saturation checks
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

        case 'partTransitioned': {
          const { newPartIndex, totalParts } = data
          console.log(`[FountainQRReceiver] Transitioned to part ${newPartIndex + 1}/${totalParts}`)
          // Clear part completion info to allow new part processing
          setPartCompleteInfo(null)
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
    console.log('[FountainQRReceiver] Initializing worker with:', {
      partBasedMode: initialMeta.partBasedMode,
      partSize: initialMeta.partSize,
      metadata: initialMeta
    })
    worker.postMessage({
      type: 'initialize',
      id: messageIdCounterRef.current++,
      metadata: initialMeta,
      partBasedMode: initialMeta.partBasedMode || false,
      partSize: initialMeta.partSize || 0
    })
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

  const handleAckReceived = useCallback((_acknowledgedSequence: number, message: string) => {
    // Window logic removed - no window synchronization
    console.log(`[FountainQRReceiver] ACK received: ${message}`)

    // If a part was just completed, trigger move to next part
    if (partCompleteInfo && partCompleteInfo.partChecksumMatch) {
      const msgId = messageIdCounterRef.current++
      workerRef.current?.postMessage({ type: 'moveToNextPart', id: msgId })
      console.log(`[FountainQRReceiver] Moving to next part after ACK received`)
    }

    triggeredFeedbackRef.current = false
    setIsAwaitingFeedback(false)
    setIsScanning(true)
    setSenderFeedbackMessage(message)
  }, [partCompleteInfo])

  const handleFeedbackModeChange = useCallback((mode: 'data-scanning' | 'feedback-display' | 'ack-scanning') => {
    console.log('[FountainQRReceiver] handleFeedbackModeChange called with mode:', mode, 'current mode:', receiverMode)
    setReceiverMode(mode)
    if (mode === 'data-scanning') {
      triggeredFeedbackRef.current = false
      setIsAwaitingFeedback(false)
      setIsScanning(true)
      // setLastAckTransitionSuccessful(true) // Optimistically marking success is deprecated
      console.log('[FountainQRReceiver] Transitioned to data-scanning mode, isScanning set to true')
    } else if (mode === 'feedback-display') {
      setIsAwaitingFeedback(true)
      setIsScanning(false)
    } else if (mode === 'ack-scanning') {
      setIsAwaitingFeedback(true)
      setIsScanning(false)
      setLastAckTransitionSuccessful(false) // Mark as not successful when entering ack-scanning
      console.log('[FountainQRReceiver] Transitioned to ack-scanning mode, lastAckTransitionSuccessful set to false')
    }
  }, [receiverMode])


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

  const handleAckTransitionStatus = useCallback((successful: boolean) => {
    console.log(`[FountainQRReceiver] ACK transition status reported: ${successful}`)
    setLastAckTransitionSuccessful(successful)
  }, [])

  const handleSkipTargetedMode = useCallback(() => {
    console.log('[FountainQRReceiver] User requested to skip targeted mode for session')
    setSkipTargetedModeForSession(true)
    setIsTargetedModeActive(false)
    // Transition back to data-scanning mode
    setReceiverMode('data-scanning')
    setIsScanning(true)
    setIsAwaitingFeedback(false)
    triggeredFeedbackRef.current = false
  }, [])








 // handleBinaryFountainChunk moved to subcomponent


  // handleScan moved to subcomponent

  // Scanner integration moved to subcomponent

  // Keep refs in sync with state for worker onmessage handler
  useEffect(() => {
    isAwaitingFeedbackRef.current = isAwaitingFeedback
  }, [isAwaitingFeedback])

  useEffect(() => {
    isTargetedModeActiveRef.current = isTargetedModeActive
  }, [isTargetedModeActive])

  useEffect(() => {
    skipTargetedModeForSessionRef.current = skipTargetedModeForSession
  }, [skipTargetedModeForSession])

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
  //   1. PART COMPLETION (HIGHEST PRIORITY - MANDATORY)
  //      Location: Inline in handleBinaryFountainChunk
  //      When: Part is fully decoded and checksum validated
  //      Why highest: Required for part-based transfers to continue; blocking operation
  //      Guards: !showFeedbackQR && !isAwaitingFeedback
  //
  //   2. TARGETED MODE (SECOND PRIORITY - EFFICIENCY)
  //      Location: This useEffect
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
    const targetedModeThreshold = getTargetedModeMaxMissingBlocks()
    const minBlocksForFeedback = targetedModeThreshold * 5 // ~50 blocks minimum
    const isFileLargeEnoughForFeedback = fountainMetadata.totalSourceBlocks >= minBlocksForFeedback && feedbackEnabled
    if (!isFileLargeEnoughForFeedback) {
      // No feedback QR needed for very small files - they decode quickly without it
      return
    }

    const currentMissingBlocks = fountainMetadata.totalSourceBlocks - decodedBlocks

    // Add guard to prevent feedback when all blocks are decoded
    if (decodedBlocks >= fountainMetadata.totalSourceBlocks) return

    // Priority 2: Check for targeted mode threshold (only if enabled)
    const crossedToTargeted = prevMissingBlocksRef.current > targetedModeThreshold && currentMissingBlocks <= targetedModeThreshold && !skipTargetedModeForSession
    if (crossedToTargeted && ENABLE_TARGETED_MODE) {
      // Debug logging moved to subcomponent
      setReceiverMode('feedback-display')
      setIsScanning(false)
      setIsAwaitingFeedback(true)
      setIsTargetedModeActive(true)
      prevMissingBlocksRef.current = currentMissingBlocks
      return
    }

    // Part-based mode ensures proper progression without needing to switch back
    // Targeted mode only activates at the very end for final cleanup
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
    // Window mode removed
    feedbackSequenceRef.current = 0
    setFeedbackSequence(0)
    setLastSenderFeedbackSequence(-1)
    setInvalidChecksumCount(0)
    setIsTargetedModeActive(false)
    triggeredFeedbackRef.current = false
    setSkipTargetedModeForSession(false)
    setLastAckTransitionSuccessful(true) // Guard against stale success state across resets
    setSenderFeedbackMessage('') // Clear sender feedback message on reset
    // Reinitialize worker state without recreating the worker instance
    workerRef.current?.postMessage({
      type: 'initialize',
      id: messageIdCounterRef.current++,
      metadata: initialMeta,
      partBasedMode: initialMeta.partBasedMode || false,
      partSize: initialMeta.partSize || 0
    })
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
          feedbackSequence={feedbackSequence}
          lastSenderFeedbackSequence={lastSenderFeedbackSequence}
          receiverMode={receiverMode}
          isActive={receiverMode === 'feedback-display' || receiverMode === 'ack-scanning'}
          onFeedbackGenerated={handleFeedbackGenerated}
          onAckReceived={handleAckReceived}
          onModeChange={handleFeedbackModeChange}
          onError={handleFeedbackError}
          onSequenceIncrement={handleSequenceIncrement}
          onSenderSequenceUpdate={handleSenderSequenceUpdate}
          skipTargetedModeForSession={skipTargetedModeForSession}
          onSkipTargetedMode={handleSkipTargetedMode}
          lastAckTransitionSuccessful={lastAckTransitionSuccessful}
          onAckTransitionStatus={handleAckTransitionStatus}
          partCompleteInfo={partCompleteInfo}
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
        senderFeedbackMessage={senderFeedbackMessage}
        decodedBlockIndices={decodedBlockIndicesRef.current}
        currentPartIndex={currentPartIndex}
        totalParts={totalParts}
        currentPartDecodedBlocks={currentPartDecodedBlocks}
        currentPartTotalBlocks={currentPartTotalBlocks}
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
        onToggleMetadataInfo={() => {
          // Optional: handle metadata info toggle if needed
        }}
        onModeChange={handleFeedbackModeChange}
        onAckTransitionStatus={handleAckTransitionStatus}
      />

    </div>
  )
}
