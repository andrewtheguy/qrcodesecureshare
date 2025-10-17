import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import type { FountainMetadata } from '@/utils/fountainCode'
import type { FountainFeedback, FountainFeedbackStatistics, FountainFeedbackTargeted, SenderFeedback } from '@/types/fountainFeedback'
import { generateNonDataQR } from '@/utils/qrUtils'
import { getTargetedModeMaxMissingBlocks } from '@/utils/fountainConfig'
import { useQRScanner } from '@/hooks/useQRScanner'
import { generateFeedbackConfirmationCode } from '@/utils/checksum'

/**
 * Formats an array of missing block indices into a human-readable range string.
 * Compresses consecutive blocks into ranges (e.g., "1-5, 8, 10-12").
 * @param blocks - Sorted array of missing block indices
 * @returns Formatted string or "None" if empty
 */
const formatMissingBlocksAsRanges = (blocks: number[]): string => {
  if (blocks.length === 0) return 'None'

  const ranges: string[] = []
  let start = blocks[0]
  let end = blocks[0]

  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i] === end + 1) {
      end = blocks[i]
    } else {
      ranges.push(start === end ? start.toString() : `${start}-${end}`)
      start = blocks[i]
      end = blocks[i]
    }
  }
  ranges.push(start === end ? start.toString() : `${start}-${end}`)

  return ranges.join(', ')
}

interface FountainQRFeedbackDisplayProps {
  fountainMetadata: FountainMetadata
  sessionId: number
  decodedBlocks: number
  decodedBlockIndices: number[]
  currentWindow?: { start: number; end: number }
  currentWindowStart: number
  currentWindowEnd: number
  isWindowEnabled: boolean
  windowTriggerThreshold: number
  feedbackSequence: number
  lastSenderFeedbackSequence: number
  receiverMode: 'data-scanning' | 'feedback-display' | 'ack-scanning'
  isActive: boolean
  onFeedbackGenerated: (feedbackUrl: string, mode: 'statistics' | 'targeted', sequence: number) => void
  onAckReceived: (acknowledgedSequence: number, windowExpanded: boolean, message: string, windowStart?: number, windowEnd?: number) => void
  onModeChange: (mode: 'data-scanning' | 'feedback-display' | 'ack-scanning') => void
  onWindowExpansion: (newWindowEnd: number) => void
  onError: (error: string) => void
  onSequenceIncrement: () => void
  onSenderSequenceUpdate: (sequence: number) => void
  skipTargetedModeForSession: boolean
  onSkipTargetedMode: () => void
  lastAckTransitionSuccessful: boolean
  onAckTransitionStatus: (successful: boolean) => void
}

export function FountainQRFeedbackDisplay({
  fountainMetadata,
  sessionId,
  decodedBlocks,
  decodedBlockIndices,
  currentWindowStart,
  currentWindowEnd,
  isWindowEnabled,
  windowTriggerThreshold,
  feedbackSequence,
  lastSenderFeedbackSequence,
  receiverMode,
  isActive,
  onFeedbackGenerated,
  onAckReceived,
  onModeChange,
  onError,
  onSequenceIncrement,
  onSenderSequenceUpdate,
  skipTargetedModeForSession,
  onSkipTargetedMode,
  lastAckTransitionSuccessful,
  onAckTransitionStatus
}: FountainQRFeedbackDisplayProps) {
  const [feedbackQRUrl, setFeedbackQRUrl] = useState<string>('')
  const [feedbackMode, setFeedbackMode] = useState<'statistics' | 'targeted'>('statistics')
  const [feedbackData, setFeedbackData] = useState<FountainFeedback | null>(null)
  const [confirmationCode, setConfirmationCode] = useState<string>('')
  const [senderFeedbackMessage, setSenderFeedbackMessage] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [ackError, setAckError] = useState<string>('')

  const generatingRef = useRef<boolean>(false)
  const ackErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const transitionTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Refs for stable inputs to prevent mid-cycle re-generation
  const decodedBlockIndicesRef = useRef<number[]>(decodedBlockIndices)
  const currentWindowStartRef = useRef<number>(currentWindowStart)
  const currentWindowEndRef = useRef<number>(currentWindowEnd)
  const isWindowEnabledRef = useRef<boolean>(isWindowEnabled)
  const windowTriggerThresholdRef = useRef<number>(windowTriggerThreshold)
  const fountainMetadataRef = useRef<FountainMetadata>(fountainMetadata)
  const sessionIdRef = useRef<number>(sessionId)
  const lastGeneratedSequenceRef = useRef<number>(-1)

  // Update refs when props change
  useEffect(() => {
    decodedBlockIndicesRef.current = decodedBlockIndices
    currentWindowStartRef.current = currentWindowStart
    currentWindowEndRef.current = currentWindowEnd
    isWindowEnabledRef.current = isWindowEnabled
    windowTriggerThresholdRef.current = windowTriggerThreshold
    fountainMetadataRef.current = fountainMetadata
    sessionIdRef.current = sessionId
  }, [decodedBlockIndices, currentWindowStart, currentWindowEnd, isWindowEnabled, windowTriggerThreshold, fountainMetadata, sessionId])

  /**
   * Calculate the first missing block index in a sequence.
   *
   * PRECONDITION: decodedBlockIndices MUST be sorted in ascending order.
   * This is guaranteed by FountainDecoder.getDecodedBlockIndices() in fountainCode.ts:547,
   * which sorts the array before returning it.
   *
   * @param decodedBlockIndices - Sorted array of decoded block indices
   * @returns The index of the first missing block in the sequence
   */
  const calculateFirstMissingBlock = (decodedBlockIndices: number[]): number => {
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
    try {
      // Clear stale sender feedback message from previous cycle
      setSenderFeedbackMessage('')
      console.log('[FountainQRFeedbackDisplay] Cleared stale sender feedback message for new feedback cycle')

      // Read from refs for stable values
      const decodedBlockIndices = decodedBlockIndicesRef.current
      const currentWindowStart = currentWindowStartRef.current
      const currentWindowEnd = currentWindowEndRef.current
      const isWindowEnabled = isWindowEnabledRef.current
      const windowTriggerThreshold = windowTriggerThresholdRef.current
      const fountainMetadata = fountainMetadataRef.current
      const sessionId = sessionIdRef.current
      // Use prop directly - parent owns this value
      const seq = feedbackSequence

      // Calculate overall file progress as rounded integer (0-100)
      const overallProgress = Math.round((decodedBlockIndices.length / fountainMetadata.totalSourceBlocks) * 100)

      // Gate re-generation: only generate if we haven't already generated for this sequence
      if (seq === lastGeneratedSequenceRef.current) {
        generatingRef.current = false
        return
      }

      const firstMissingBlock = calculateFirstMissingBlock(decodedBlockIndices)
      const decodedInWindow = decodedBlockIndices.filter((idx: number) => idx >= currentWindowStart && idx < currentWindowEnd).length
      const windowSize = Math.max(1, currentWindowEnd - currentWindowStart)
      const windowDecodePercent = decodedInWindow / windowSize

      const missingBlocksCount = fountainMetadata.totalSourceBlocks - decodedBlockIndices.length
      const targetedModeThreshold = getTargetedModeMaxMissingBlocks(fountainMetadata.blockSize)
      let feedback: FountainFeedback
      if (missingBlocksCount > targetedModeThreshold || skipTargetedModeForSession) {
        // Statistics-only feedback - compact format
        feedback = {
          type: 'FOUNTAIN_FEEDBACK',
          mode: 'statistics',
          sessionId: sessionId,
          sequence: seq,
          requestWindowExpansion: isWindowEnabled && windowSize > 0 && windowDecodePercent >= windowTriggerThreshold,
          firstMissingBlock: firstMissingBlock,
          progress: overallProgress,
          totalDecoded: decodedBlockIndices.length,
          totalBlocks: fountainMetadata.totalSourceBlocks,
          decodedInWindow: decodedInWindow,
        }
      } else {
        // Targeted feedback with missing block indices - for final stage
        // Short-circuit: construct missing blocks by iterating over decoded indices instead of all blocks
        // This is more efficient when missingBlocksCount is small (≤ targetedModeThreshold)
        const missingBlocks: number[] = []

        // Optimization: iterate over decoded indices to construct missing indices
        // Since we know missingBlocksCount <= targetedModeThreshold (small), this is faster
        // than iterating over all totalSourceBlocks
        let lastDecoded = -1
        for (const idx of decodedBlockIndices) {
          // Add all missing blocks between lastDecoded and current idx
          for (let i = lastDecoded + 1; i < idx; i++) {
            missingBlocks.push(i)
            // Short-circuit: stop if we exceed the threshold (shouldn't happen, but defensive)
            if (missingBlocks.length > targetedModeThreshold) {
              break
            }
          }
          lastDecoded = idx

          // Short-circuit: stop if we exceed the threshold
          if (missingBlocks.length > targetedModeThreshold) {
            break
          }
        }

        // Add any remaining missing blocks after the last decoded index
        if (missingBlocks.length <= targetedModeThreshold) {
          for (let i = lastDecoded + 1; i < fountainMetadata.totalSourceBlocks; i++) {
            missingBlocks.push(i)
            // Short-circuit: stop if we exceed the threshold
            if (missingBlocks.length > targetedModeThreshold) {
              break
            }
          }
        }

        const feedbackBase = {
          type: 'FOUNTAIN_FEEDBACK' as const,
          mode: 'targeted' as const,
          sessionId: sessionId,
          sequence: seq,
          firstMissingBlock: firstMissingBlock,
          progress: overallProgress,
          totalDecoded: decodedBlockIndices.length,
          totalBlocks: fountainMetadata.totalSourceBlocks,
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


      let dataUrl: string
      try {
        //TODO: need to limit targeted mode maximum block earlier to avoid data too large errors
        dataUrl = await generateNonDataQR(feedback)
      } catch(err) {
        console.error('[FountainQRFeedbackDisplay] Feedback QR generation error:', err)
        setError('Failed to generate feedback QR code - please try again, error:' + (err as Error).message)
        return
      }
      setFeedbackQRUrl(dataUrl)
      setFeedbackMode(feedback.mode)
      setFeedbackData(feedback)

      // Generate confirmation code
      const code = generateFeedbackConfirmationCode(feedback)
      setConfirmationCode(code)

      // Mark this sequence as generated atomically
      lastGeneratedSequenceRef.current = seq

      onFeedbackGenerated(dataUrl, feedback.mode, seq)
      onSequenceIncrement()
      onModeChange('feedback-display')
    } finally { generatingRef.current = false; }
  }, [feedbackSequence, onFeedbackGenerated, onSequenceIncrement, onModeChange])

  const showAckError = (message: string) => {
    // Clear any existing timeout
    if (ackErrorTimeoutRef.current) {
      clearTimeout(ackErrorTimeoutRef.current)
    }

    setAckError(message)

    // Auto-clear after 5 seconds
    ackErrorTimeoutRef.current = setTimeout(() => {
      setAckError('')
      ackErrorTimeoutRef.current = null
    }, 5000)
  }

  const handleSenderFeedbackScan = useCallback(async (data: string): Promise<void> => {
    // it is necessary to prevent processing binary data by accident
    if (data[0] !== '{') {
      console.warn('[FountainQRFeedbackDisplay] Ignoring non-JSON data')
      return
    }

    try {
      const parsed = JSON.parse(data) as SenderFeedback

      if (parsed.sequence < lastSenderFeedbackSequence || (parsed.sequence === lastSenderFeedbackSequence && lastAckTransitionSuccessful)) {
        console.warn(`[FountainQRFeedbackDisplay] Duplicate ACK rejected: sequence=${parsed.sequence}, lastSenderFeedbackSequence=${lastSenderFeedbackSequence}, lastAckTransitionSuccessful=${lastAckTransitionSuccessful}`)
        return
      } else if (parsed.sequence === lastSenderFeedbackSequence && !lastAckTransitionSuccessful) {
        console.log(`[FountainQRFeedbackDisplay] Allowing duplicate ACK re-scan: sequence=${parsed.sequence}, lastAckTransitionSuccessful=${lastAckTransitionSuccessful}`)
      }

      if (parsed.type !== 'SENDER_FEEDBACK') {
        console.warn('[FountainQRFeedbackDisplay] Invalid QR type - expecting ACK')
        showAckError('Invalid QR code scanned. Expected an ACK QR from sender. Please scan the correct ACK QR code.')
        return
      }

      if (parsed.sessionId !== sessionId) {
        // Debug logging moved to subcomponent
        showAckError(`Session mismatch: Expected session ${sessionId}, but got ${parsed.sessionId}. Please ensure you're scanning the ACK QR from the current transfer session.`)
        return
      }

      // Add window range validation
      if (parsed.command === 'acknowledge' && parsed.windowExpanded !== undefined) {
        // Note: Window validation is defensive since sender should generate valid ACKs
        // This protects against corrupted data
        // No specific window range data in ACK, so we skip detailed validation here
      }

      switch (parsed.command) {

        case 'acknowledge': {
            // Validate acknowledgedSequence using parent's latest feedbackSequence prop
            // The ACK should acknowledge the feedback we just sent (feedbackSequence - 1)
            // because we already incremented feedbackSequence after generating the feedback QR
            const expectedAcknowledgedSequence = feedbackSequence - 1
            console.log('[FountainQRFeedbackDisplay] Validating ACK sequence: expected', expectedAcknowledgedSequence, 'got', parsed.acknowledgedSequence)

            if (parsed.acknowledgedSequence !== expectedAcknowledgedSequence) {
              // Invalid or duplicate ACK - reject and log
              console.warn(
                `[FountainQRFeedbackDisplay] Rejecting ACK: expected acknowledgedSequence=${expectedAcknowledgedSequence}, got ${parsed.acknowledgedSequence}`
              )
              showAckError(`ACK sequence mismatch: Expected acknowledgment for sequence ${expectedAcknowledgedSequence}, but received ${parsed.acknowledgedSequence}. This may be an old or duplicate ACK. Please scan the latest ACK QR from sender.`)
              return
            }

            // Valid ACK - resume data scanning
            console.log('[FountainQRFeedbackDisplay] Valid ACK received, transitioning to data-scanning')
            setFeedbackQRUrl('')
            onSenderSequenceUpdate(parsed.sequence)
            setSenderFeedbackMessage(parsed.message)

            // Add a 150ms delay before transitioning to data-scanning mode
            // This gives the ACK scanner time to release the camera
            console.log('[FountainQRFeedbackDisplay] Delaying transition to data-scanning mode by 150ms...')
            transitionTimeoutRef.current = setTimeout(() => {
              console.log('[FountainQRFeedbackDisplay] Executing delayed transition to data-scanning mode')
              onModeChange('data-scanning')

              // RECEIVER: Adopt sender's window range as the absolute source of truth
              // Sender is the single authority for window state - receiver must sync to sender's range
              onAckReceived(parsed.acknowledgedSequence, parsed.windowExpanded, parsed.message, parsed.windowStart, parsed.windowEnd)
            }, 150)
           break
        }

      }
    } catch (err) {
      console.error('[FountainQRFeedbackDisplay] Sender feedback parse error:', err)
      showAckError('Failed to read ACK QR code. The QR may be damaged or malformed. Please ask sender to regenerate the ACK QR and try scanning again.')
    }
  }, [sessionId, lastSenderFeedbackSequence, feedbackSequence, onSenderSequenceUpdate, onModeChange, onAckReceived, lastAckTransitionSuccessful])

  const ackScannerIsScanning = receiverMode === 'ack-scanning'
  const { videoRef: ackVideoRefFromHook } = useQRScanner({
    onScan: handleSenderFeedbackScan,
    isScanning: ackScannerIsScanning,
    onError: (errorMessage) => {
      setError(errorMessage)
      onError(errorMessage)
    }
  })

  useEffect(() => {
    if (isActive && receiverMode === 'feedback-display' && !feedbackQRUrl) {
      handleGenerateFeedbackQR()
    }
  }, [isActive, receiverMode, feedbackQRUrl, handleGenerateFeedbackQR])

  // Cleanup ACK error timeout on unmount to prevent setState on unmounted component
  useEffect(() => {
    return () => {
      if (ackErrorTimeoutRef.current) {
        clearTimeout(ackErrorTimeoutRef.current)
        ackErrorTimeoutRef.current = null
      }
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current)
        transitionTimeoutRef.current = null
      }
    }
  }, [])

  const handleStartAckScan = () => {
    // Clear previous sender feedback message as defensive measure when starting new ACK scan
    setSenderFeedbackMessage('')
    console.log('[FountainQRFeedbackDisplay] Entering ack-scanning mode, cleared previous sender feedback message')
    onAckTransitionStatus(false) // Report that we are in a potential retry scenario
    onModeChange('ack-scanning')
    setError('')
    setAckError('')
  }

  const handleShowFeedbackQR = () => {
    onModeChange('feedback-display')
  }

  if (receiverMode === 'feedback-display' && feedbackQRUrl) {
    return (
      <div className="space-y-4">
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
                Decoded {decodedBlocks}/{fountainMetadata.totalSourceBlocks} blocks ({Math.round((decodedBlocks / fountainMetadata.totalSourceBlocks) * 100)}%)
              </p>
              <p className="text-xs text-muted-foreground text-center">
                {skipTargetedModeForSession
                  ? 'Statistics mode (targeted mode disabled for session)'
                  : (fountainMetadata.totalSourceBlocks - decodedBlocks) > getTargetedModeMaxMissingBlocks(fountainMetadata.blockSize) ? 'Sharing window progress (compact format)' : feedbackMode === 'targeted' ? 'Sharing decoded blocks for targeted transfer' : 'Sharing progress summary (fallback mode due to payload size)'}
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Show this QR to sender, then click the button below to scan for ACK
              </p>
              <p className="text-xs text-muted-foreground text-center">
                The confirmation code acts as a checksum to verify all fields are entered correctly when manually inputting feedback
              </p>
              <Button
                onClick={handleStartAckScan}
                variant="default"
                className="w-full"
              >
                Start Scanning for ACK
              </Button>
            </div>
          </AlertDescription>
        </Alert>
        {skipTargetedModeForSession && (
          <Alert>
            <AlertDescription>
              <p className="font-medium">ℹ️ Targeted Mode Disabled for Session</p>
              <p className="text-sm text-muted-foreground">
                Using statistics mode for all feedback. This prevents large QR codes but may require more scans.
              </p>
            </AlertDescription>
          </Alert>
        )}
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              {feedbackMode === 'targeted' && !skipTargetedModeForSession && (
                <Button
                  onClick={onSkipTargetedMode}
                  variant="outline"
                  className="w-full"
                >
                  Skip Targeted Mode for Session
                </Button>
              )}
            </div>
          </AlertDescription>
        </Alert>
        {feedbackData && (
          <Card>
            <CardHeader>
              <CardTitle>Feedback Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <span className="text-muted-foreground font-medium text-sm">Session ID:</span>
                <span className="font-mono text-sm cursor-text select-all">{feedbackData.sessionId}</span>

                <span className="text-muted-foreground font-medium text-sm">Sequence:</span>
                <span className="font-mono text-sm cursor-text select-all">{feedbackData.sequence}</span>

                <span className="text-muted-foreground font-medium text-sm">Mode:</span>
                <span className="font-mono text-sm cursor-text select-all">{feedbackData.mode.charAt(0).toUpperCase() + feedbackData.mode.slice(1)}</span>

                <span className="text-muted-foreground font-medium text-sm">First Missing Block:</span>
                <span className="font-mono text-sm cursor-text select-all">{feedbackData.firstMissingBlock}</span>

                <span className="text-muted-foreground font-medium text-sm">Confirmation Code:</span>
                <span className="font-mono text-sm cursor-text select-all bg-blue-50 px-2 py-1 rounded border font-bold text-blue-800">{confirmationCode}</span>

                <span className="text-muted-foreground font-medium text-sm">Window Start:</span>
                <span className="font-mono text-sm cursor-text select-all">{currentWindowStart}</span>

                <span className="text-muted-foreground font-medium text-sm">Window End:</span>
                <span className="font-mono text-sm cursor-text select-all">{currentWindowEnd}</span>

                <span className="text-muted-foreground font-medium text-sm">Total Decoded:</span>
                <span className="font-mono text-sm cursor-text select-all">{decodedBlocks}</span>

                <span className="text-muted-foreground font-medium text-sm">Total Blocks:</span>
                <span className="font-mono text-sm cursor-text select-all">{fountainMetadata.totalSourceBlocks}</span>

                <span className="text-muted-foreground font-medium text-sm">Progress:</span>
                <span className="font-mono text-sm cursor-text select-all">{Math.round((decodedBlocks / fountainMetadata.totalSourceBlocks) * 100)}%</span>

                {feedbackData.mode === 'statistics' && (
                  <>
                    <span className="text-muted-foreground font-medium text-sm">Decoded in Window:</span>
                    <span className="font-mono text-sm cursor-text select-all">{(feedbackData as FountainFeedbackStatistics).decodedInWindow ?? 'N/A'}</span>

                    <span className="text-muted-foreground font-medium text-sm">Request Expansion:</span>
                    <span className="font-mono text-sm cursor-text select-all">{(feedbackData as FountainFeedbackStatistics).requestWindowExpansion ? 'Yes' : 'No'}</span>
                  </>
                )}

                {feedbackData.mode === 'targeted' && (
                  <>
                    <span className="text-muted-foreground font-medium text-sm">Missing Blocks:</span>
                    <span className="font-mono text-sm cursor-text select-all break-all">
                      {(() => {
                        const formatted = formatMissingBlocksAsRanges((feedbackData as FountainFeedbackTargeted).missingBlocks)
                        return formatted.length > 100 ? formatted.substring(0, 100) + '...' : formatted
                      })()}
                      {(feedbackData as FountainFeedbackTargeted).missingBlocks.length > 0 && formatMissingBlocksAsRanges((feedbackData as FountainFeedbackTargeted).missingBlocks).length > 100 && (
                        <span className="text-xs text-muted-foreground block">(showing first blocks)</span>
                      )}
                    </span>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  if (receiverMode === 'ack-scanning') {
    return (
      <div className="relative bg-black rounded-lg overflow-hidden">
        <video
          ref={ackVideoRefFromHook}
          className="w-full h-auto"
          style={{ maxHeight: '400px' }}
        />
        {ackScannerIsScanning && (
          <div className="absolute top-2 left-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium z-20">
            ● SCANNING
          </div>
        )}
        <Button
          onClick={handleShowFeedbackQR}
          variant="secondary"
          size="sm"
          className="absolute top-2 right-2 z-20"
        >
          Show Feedback QR
        </Button>
        <div className="absolute bottom-2 left-2 right-2 bg-black/70 text-white px-3 py-2 rounded-lg shadow-lg z-20">
          <p className="text-sm text-center">
            Scanning for ACK QR from sender. Point camera at sender's ACK QR code
          </p>
        </div>
        {senderFeedbackMessage && senderFeedbackMessage.trim() !== '' && (
          <div className={`absolute top-12 right-2 bg-blue-500/90 text-white px-3 py-2 rounded-lg shadow-lg max-w-xs z-20`}>
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
        {ackError && (
          <div className="absolute top-12 left-2 right-2 z-20">
            <Alert variant="destructive" className="bg-red-500/90 text-white px-3 py-2 rounded-lg shadow-lg">
              <AlertDescription>
                <div className="flex items-start gap-2">
                  <p className="text-sm font-medium font-semibold">⚠️ {ackError}</p>
                  <button
                    onClick={() => {
                      setAckError('')
                      if (ackErrorTimeoutRef.current) {
                        clearTimeout(ackErrorTimeoutRef.current)
                        ackErrorTimeoutRef.current = null
                      }
                    }}
                    className="text-white hover:text-gray-200 text-sm font-bold ml-auto"
                  >
                    ✕
                  </button>
                </div>
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  return null
}
