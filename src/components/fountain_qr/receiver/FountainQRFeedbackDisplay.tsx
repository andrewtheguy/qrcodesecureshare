/**
 * RECEIVER-SIDE COMPONENT
 *
 * This component handles the RECEIVER's feedback and acknowledgment phases of the Fountain Code transfer.
 * It generates feedback QR codes containing decoding progress information and scans for acknowledgment
 * QR codes from the sender. The component supports both statistics mode (compact progress info)
 * and targeted mode (specific missing block indices) for efficient communication.
 *
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import type { FountainMetadata } from '@/utils/fountainCodeHybrid'
import type { FountainFeedback, FountainFeedbackTargeted, SenderFeedback } from '@/types/fountainFeedback'
import { generateNonDataQR } from '@/utils/qrUtils'
import { getTargetedModeMaxMissingBlocks, ENABLE_TARGETED_MODE } from '@/utils/fountainConfig'
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner'
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
  feedbackSequence: number
  lastSenderFeedbackSequence: number
  receiverMode: 'data-scanning' | 'feedback-display' | 'ack-scanning'
  isActive: boolean
  onFeedbackGenerated: (feedbackUrl: string, mode: 'part-complete' | 'targeted', sequence: number) => void
  onAckReceived: (acknowledgedSequence: number, message: string) => void
  onModeChange: (mode: 'data-scanning' | 'feedback-display' | 'ack-scanning') => void
  onError: (error: string) => void
  onSequenceIncrement: () => void
  onSenderSequenceUpdate: (sequence: number) => void
  skipTargetedModeForSession: boolean
  onSkipTargetedMode: () => void
  lastAckTransitionSuccessful: boolean
  onAckTransitionStatus: (successful: boolean) => void
  partCompleteInfo: {
    partComplete: boolean
    partChecksumMatch: boolean
    computedChecksum: string
    currentPart: number
    totalParts: number
  } | null
}

export function FountainQRFeedbackDisplay({
  fountainMetadata,
  sessionId,
  decodedBlocks,
  decodedBlockIndices,
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
  onAckTransitionStatus,
  partCompleteInfo
}: FountainQRFeedbackDisplayProps) {
  const [feedbackQRUrl, setFeedbackQRUrl] = useState<string>('')
  const [feedbackMode, setFeedbackMode] = useState<'part-complete' | 'targeted'>('part-complete')
  const [feedbackData, setFeedbackData] = useState<FountainFeedback | null>(null)
  const [confirmationCode, setConfirmationCode] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [ackError, setAckError] = useState<string>('')

  const generatingRef = useRef<boolean>(false)
  const ackErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const transitionTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Refs for stable inputs to prevent mid-cycle re-generation
  const decodedBlockIndicesRef = useRef<number[]>(decodedBlockIndices)
  const fountainMetadataRef = useRef<FountainMetadata>(fountainMetadata)
  const sessionIdRef = useRef<number>(sessionId)
  const lastGeneratedSequenceRef = useRef<number>(-1)
  const pendingAckSequenceRef = useRef<number | null>(null)

  // Update refs when props change
  useEffect(() => {
    decodedBlockIndicesRef.current = decodedBlockIndices
    fountainMetadataRef.current = fountainMetadata
    sessionIdRef.current = sessionId
  }, [decodedBlockIndices, fountainMetadata, sessionId])

  const handleGenerateFeedbackQR = useCallback(async () => {
    if (generatingRef.current) return; generatingRef.current = true
    try {
      // Note: senderFeedbackMessage is now managed by parent component (FountainQRReceiver)
      // and will be cleared when ACK is received and new feedback cycle begins
      console.log('[FountainQRFeedbackDisplay] Starting new feedback generation cycle')

      // Read from refs for stable values
      const decodedBlockIndices = decodedBlockIndicesRef.current
      const fountainMetadata = fountainMetadataRef.current
      const sessionId = sessionIdRef.current
      // Use prop directly - parent owns this value
      const seq = feedbackSequence

      // Gate re-generation: only generate if we haven't already generated for this sequence
      if (seq === lastGeneratedSequenceRef.current) {
        generatingRef.current = false
        return
      }

      // Validate that partCompleteInfo is available for part-based mode
      if (!partCompleteInfo) {
        console.error('[FountainQRFeedbackDisplay] Part info is required for feedback generation')
        setError('Part information not available for feedback generation')
        generatingRef.current = false
        return
      }

      const missingBlocksCount = fountainMetadata.totalSourceBlocks - decodedBlockIndices.length
      const targetedModeThreshold = getTargetedModeMaxMissingBlocks()
      let feedback: FountainFeedback

      if (missingBlocksCount > targetedModeThreshold || skipTargetedModeForSession || !ENABLE_TARGETED_MODE) {
        // Part-complete mode - simplified feedback with minimal details
        //
        // SYNC REQUIREMENT: These fields MUST match exactly with:
        // 1. FountainQRFeedbackScanner.tsx - handleFeedbackScan() validation
        // 2. FountainQRManualFeedbackInput.tsx - validateInputs() and UI fields
        // 3. checksum.ts - generateFeedbackConfirmationCode()
        //
        // IMPORTANT: Only include REQUIRED fields. Do NOT include optional fields like computedChecksum.
        // Optional fields break confirmation code validation and cause manual input mismatches.
        feedback = {
          type: 'FOUNTAIN_FEEDBACK',
          mode: 'part-complete',
          sessionId: sessionId,
          sequence: seq,
          currentPart: partCompleteInfo.currentPart,
          totalParts: partCompleteInfo.totalParts,
          partChecksumMatch: partCompleteInfo.partChecksumMatch,
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

        // Targeted mode - includes specific missing block indices for final cleanup
        //
        // SYNC REQUIREMENT: These fields MUST match exactly with:
        // 1. FountainQRFeedbackScanner.tsx - handleFeedbackScan() validation for targeted mode
        // 2. FountainQRManualFeedbackInput.tsx - validateInputs() and UI fields for targeted mode
        // 3. checksum.ts - generateFeedbackConfirmationCode() for targeted mode
        //
        // IMPORTANT: Only include REQUIRED fields. Do NOT include optional fields.
        const feedbackBase = {
          type: 'FOUNTAIN_FEEDBACK' as const,
          mode: 'targeted' as const,
          sessionId: sessionId,
          sequence: seq,
          currentPart: partCompleteInfo.currentPart,
          totalParts: partCompleteInfo.totalParts,
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
      pendingAckSequenceRef.current = feedback.sequence

      // Generate confirmation code
      const code = await generateFeedbackConfirmationCode(feedback)
      setConfirmationCode(code)

      // Mark this sequence as generated atomically
      lastGeneratedSequenceRef.current = seq

      onFeedbackGenerated(dataUrl, feedback.mode, seq)
      onSequenceIncrement()
      onModeChange('feedback-display')
    } finally { generatingRef.current = false; }
  }, [feedbackSequence, onFeedbackGenerated, onSequenceIncrement, onModeChange, skipTargetedModeForSession])

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

  const handleSenderFeedbackScan = useCallback(async (data: string | Uint8Array): Promise<void> => {
    // Convert Uint8Array to string if needed
    const qrData = data instanceof Uint8Array ? new TextDecoder().decode(data) : data

    // it is necessary to prevent processing binary data by accident
    if (qrData[0] !== '{') {
      console.warn('[FountainQRFeedbackDisplay] Ignoring non-JSON data')
      showAckError('That QR is part of the data stream. Ask the sender for the ACK confirmation QR to continue.')
      return
    }

    try {
      const parsed = JSON.parse(qrData) as SenderFeedback

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

      switch (parsed.command) {

        case 'acknowledge': {
            // Validate acknowledgedSequence against the most recently generated feedback QR
            const expectedAcknowledgedSequence = pendingAckSequenceRef.current ?? lastGeneratedSequenceRef.current

            if (expectedAcknowledgedSequence < 0) {
              console.warn('[FountainQRFeedbackDisplay] ACK received before any feedback was generated')
              showAckError('Received an ACK before generating a feedback QR. Please return to data scanning.')
              return
            }

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
            onAckTransitionStatus(true)
            pendingAckSequenceRef.current = null
            // Note: senderFeedbackMessage is now managed by parent component (FountainQRReceiver)
            // and will be set when handleAckReceived is called

            // Add a 150ms delay before transitioning to data-scanning mode
            // This gives the ACK scanner time to release the camera
            console.log('[FountainQRFeedbackDisplay] Delaying transition to data-scanning mode by 150ms...')
            transitionTimeoutRef.current = setTimeout(() => {
              console.log('[FountainQRFeedbackDisplay] Executing delayed transition to data-scanning mode')
              onModeChange('data-scanning')

              onAckReceived(parsed.acknowledgedSequence, parsed.message)
            }, 150)
           break
        }

      }
    } catch (err) {
      console.error('[FountainQRFeedbackDisplay] Sender feedback parse error:', err)
      showAckError('Failed to read ACK QR code. The QR may be damaged or malformed. Please ask sender to regenerate the ACK QR and try scanning again.')
    }
  }, [sessionId, lastSenderFeedbackSequence, onSenderSequenceUpdate, onModeChange, onAckReceived, lastAckTransitionSuccessful, onAckTransitionStatus])

  const ackScannerIsScanning = receiverMode === 'ack-scanning'
  const { videoRef: ackVideoRefFromHook, canvasRef: ackCanvasRef } = useZXingQRScanner({
    onScan: (data) => handleSenderFeedbackScan(data[0]),
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

  // Cleanup for pending delayed transition on mode change
  useEffect(() => {
    if (receiverMode !== 'ack-scanning' && transitionTimeoutRef.current) {
      console.log('[FountainQRFeedbackDisplay] Mode changed, canceling pending transition to data-scanning')
      clearTimeout(transitionTimeoutRef.current)
      transitionTimeoutRef.current = null
    }
  }, [receiverMode])

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
    // Note: We no longer clear senderFeedbackMessage here since it should persist until new feedback is generated
    console.log('[FountainQRFeedbackDisplay] Entering ack-scanning mode')
    onAckTransitionStatus(false) // Report that we are in a potential retry scenario
    onModeChange('ack-scanning')
    setError('')
    setAckError('')
  }

  const handleShowFeedbackQR = () => {
    onModeChange('feedback-display')
  }

  if (receiverMode === 'feedback-display' && feedbackQRUrl) {
    const totalBlocks = fountainMetadata.totalSourceBlocks
    const decodedPercent = totalBlocks > 0 ? Math.round((decodedBlocks / totalBlocks) * 100) : 0
    const missingBlocksCount = fountainMetadata.totalSourceBlocks - decodedBlocks
    const modeMessage = skipTargetedModeForSession
      ? 'Part-complete mode locked for this session to keep QR payloads compact.'
      : missingBlocksCount > getTargetedModeMaxMissingBlocks()
        ? 'Part-complete mode: signaling part completion and checksum validation.'
        : feedbackMode === 'targeted'
          ? 'Targeted mode: sharing precise missing block ranges for final cleanup.'
          : 'Part-complete mode: compact payload for easy scanning.'

    return (
      <div className="space-y-4">
        <Card className="border border-amber-500/60 bg-amber-950 text-amber-100 shadow-2xl">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <Badge
                  variant="outline"
                  className="border-amber-400/70 bg-amber-500/10 text-amber-100 uppercase tracking-wider"
                >
                  Feedback QR
                </Badge>
                <CardTitle className="text-xl font-semibold text-amber-50">Share This With The Sender</CardTitle>
                <p className="text-sm text-amber-200/70">
                  Hold this screen steady so the sender can scan your progress update. Once they respond, switch to ACK scan to continue.
                </p>
              </div>
              <Button
                onClick={handleStartAckScan}
                variant="secondary"
                className="bg-amber-900 text-amber-100 border border-amber-400/70 hover:bg-amber-800"
              >
                Scan ACK Next
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-amber-500/40 bg-black/85 p-6 shadow-inner">
              <div className="absolute inset-3 rounded-2xl border border-amber-400/40" />
              <img
                src={feedbackQRUrl}
                alt="Feedback QR Code"
                className="relative z-10 w-full h-auto"
              />
            </div>
            <div className="space-y-3 text-sm">
              <div className="text-center">
                <p className="font-medium text-amber-50">
                  Decoded {decodedBlocks} / {totalBlocks} blocks ({decodedPercent}%)
                </p>
                <p className="text-xs text-amber-200/70 mt-1">{modeMessage}</p>
              </div>
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-100/80 space-y-1">
                <p>• Ask the sender to scan this amber QR right away.</p>
                <p>• After they process it, tap <span className="font-semibold text-amber-100">Scan ACK Next</span> to capture their confirmation.</p>
                <p>• Confirmation code below helps them verify manual entry.</p>
              </div>
              {feedbackMode === 'targeted' && !skipTargetedModeForSession && (
                <Button
                  onClick={onSkipTargetedMode}
                  variant="secondary"
                  className="w-full border border-amber-400/70 bg-amber-500 text-amber-950 font-semibold hover:bg-amber-400 focus-visible:ring-amber-300"
                >
                  Disable Targeted Mode for This Session
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
        {skipTargetedModeForSession && (
          <Alert className="border border-amber-500/40 bg-amber-500/10 text-amber-950">
            <AlertDescription>
              <p className="font-medium text-amber-900">ℹ️ Targeted Mode Disabled</p>
              <p className="text-sm text-amber-900/80">
                This session stays in statistics mode to keep QR codes smaller. It may take a few more feedback cycles near the end.
              </p>
            </AlertDescription>
          </Alert>
        )}
        {feedbackData && (
          <Card>
            <CardHeader>
              <CardTitle>Feedback Details</CardTitle>
            </CardHeader>
            <CardContent>
              {/* align with sender feedback display */}
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <span className="text-muted-foreground font-medium text-sm">Session ID:</span>
                <span className="font-mono text-sm cursor-text select-all">{feedbackData.sessionId}</span>

                <span className="text-muted-foreground font-medium text-sm">Sequence:</span>
                <span className="font-mono text-sm cursor-text select-all">{feedbackData.sequence}</span>

                {/* SYNC REQUIREMENT: Display fields MUST match feedback generation above
                    Part-complete mode: type, mode, sessionId, sequence, currentPart, totalParts, partChecksumMatch
                    Targeted mode: type, mode, sessionId, sequence, currentPart, totalParts, missingBlocks
                    Do NOT display optional fields - they are not included in feedback QR or confirmation code */}

                <span className="text-muted-foreground font-medium text-sm">Mode:</span>
                <span className="font-mono text-sm cursor-text select-all">
                  {feedbackData.mode === 'part-complete' ? 'Part Complete' : 'Targeted'}
                </span>

                <span className="text-muted-foreground font-medium text-sm">Current Part:</span>
                <span className="font-mono text-sm cursor-text select-all">
                  {(feedbackData.mode === 'part-complete' ? feedbackData.currentPart : feedbackData.currentPart) + 1} / {feedbackData.mode === 'part-complete' ? feedbackData.totalParts : feedbackData.totalParts}
                </span>

                {feedbackData.mode === 'part-complete' && (
                  <>
                    <span className="text-muted-foreground font-medium text-sm">Checksum Match:</span>
                    <span className="font-mono text-sm cursor-text select-all">
                      {feedbackData.partChecksumMatch ? 'Yes' : 'No'}
                    </span>
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

                <span className="text-muted-foreground font-medium text-sm">Confirmation Code:</span>
                <span className="font-mono text-sm cursor-text select-all bg-blue-50 px-2 py-1 rounded border font-bold text-blue-800">{confirmationCode}</span>

                <span className="text-muted-foreground font-medium text-sm">Total Decoded:</span>
                <span className="font-mono text-sm cursor-text select-all">{decodedBlocks}</span>

                <span className="text-muted-foreground font-medium text-sm">Total Blocks:</span>
                <span className="font-mono text-sm cursor-text select-all">{fountainMetadata.totalSourceBlocks}</span>

              </div>
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  if (receiverMode === 'ack-scanning') {
    return (
      <div className="space-y-4">
        <Card className="border border-emerald-500/50 bg-emerald-950 text-emerald-100 shadow-2xl">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <Badge
                  variant="outline"
                  className="border-emerald-400/60 bg-emerald-500/10 text-emerald-100 tracking-wide uppercase"
                >
                  ACK Scan Mode
                </Badge>
                <CardTitle className="text-xl font-semibold text-emerald-50">Awaiting Sender Confirmation</CardTitle>
                <p className="text-sm text-emerald-200/70">
                  Scan the emerald confirmation QR the sender presents after they process your feedback update. This card completes the feedback loop so you can resume receiving data.
                </p>
              </div>
              <Button
                onClick={handleShowFeedbackQR}
                variant="secondary"
                size="sm"
                className="bg-emerald-900 text-emerald-100 hover:bg-emerald-800 border border-emerald-400/60"
              >
                Show Feedback QR
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative overflow-hidden rounded-2xl border border-emerald-500/40 bg-black shadow-2xl">
              <video
                ref={ackVideoRefFromHook}
                className="w-full max-h-[420px] object-cover"
              />
              <canvas ref={ackCanvasRef} style={{ display: 'none' }} />
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute inset-5 rounded-xl border-2 border-emerald-400/60 animate-pulse" />
                {ackScannerIsScanning && (
                  <div className="absolute top-4 left-4 flex items-center gap-2 rounded-full border border-emerald-400/80 bg-emerald-500/30 px-3 py-1 text-xs font-semibold text-emerald-50 shadow-md">
                    <span className="text-emerald-200">●</span>
                    Scanning for ACK
                  </div>
                )}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-emerald-950/90 via-emerald-950/10 to-transparent px-4 py-3 text-center text-sm text-emerald-50">
                  Align the sender&apos;s emerald QR inside the glowing frame to continue the transfer.
                </div>
              </div>
            </div>
            <Alert className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-100">
              <AlertDescription>
                <p className="text-sm font-medium">
                  Ack QR codes always contain JSON. If you see a dense black QR, it&apos;s part of the data stream—ask the sender to show the emerald confirmation QR instead.
                </p>
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
        {ackError && (
          <Alert variant="destructive" className="border border-red-500/60 bg-red-600/90 text-white">
            <AlertDescription>
              <div className="flex items-start gap-2">
                <p className="text-sm font-medium">⚠️ {ackError}</p>
                <button
                  onClick={() => {
                    setAckError('')
                    if (ackErrorTimeoutRef.current) {
                      clearTimeout(ackErrorTimeoutRef.current)
                      ackErrorTimeoutRef.current = null
                    }
                  }}
                  className="ml-auto text-sm font-bold hover:text-gray-200"
                >
                  ✕
                </button>
              </div>
            </AlertDescription>
          </Alert>
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
