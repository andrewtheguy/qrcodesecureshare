import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { FountainMetadata } from '@/utils/fountainCode'
import type { FountainFeedback, FountainFeedbackStatistics, FountainFeedbackTargeted, SenderFeedback } from '@/types/fountainFeedback'
import { generateNonDataQR } from '@/utils/qrUtils'
import { getTargetedModeMaxMissingBlocks, getWindowExpansionSizeBlocks } from '@/utils/fountainConfig'
import { useQRScanner } from '@/hooks/useQRScanner'

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
  onAckReceived: (acknowledgedSequence: number, windowExpanded: boolean, message: string) => void
  onModeChange: (mode: 'data-scanning' | 'feedback-display' | 'ack-scanning') => void
  onWindowExpansion: (newWindowEnd: number) => void
  onError: (error: string) => void
  onSequenceIncrement: () => void
  onSenderSequenceUpdate: (sequence: number) => void
}

export function FountainQRFeedbackDisplay({
  fountainMetadata,
  sessionId,
  decodedBlocks,
  decodedBlockIndices,
  currentWindow,
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
  onWindowExpansion,
  onError,
  onSequenceIncrement,
  onSenderSequenceUpdate
}: FountainQRFeedbackDisplayProps) {
  const [feedbackQRUrl, setFeedbackQRUrl] = useState<string>('')
  const [feedbackMode, setFeedbackMode] = useState<'statistics' | 'targeted'>('statistics')
  const [senderFeedbackMessage, setSenderFeedbackMessage] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState(false)

  const ackVideoRef = useRef<HTMLVideoElement>(null)
  const generatingRef = useRef<boolean>(false)

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
    setIsGenerating(true)
    try {
      const firstMissingBlock = calculateFirstMissingBlock(decodedBlockIndices)
      const decodedInWindow = decodedBlockIndices.filter((idx: number) => idx >= currentWindowStart && idx < currentWindowEnd).length
      const windowSize = Math.max(1, currentWindowEnd - currentWindowStart)
      const windowDecodePercent = decodedInWindow / windowSize
      const overallProgress = decodedBlockIndices.length / fountainMetadata.totalSourceBlocks

      const seq = feedbackSequence
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
        // Short-circuit: construct missing blocks by iterating over decoded indices instead of all blocks
        // This is more efficient when missingBlocksCount is small (≤ targetedModeThreshold)
        const missingBlocks: number[] = []
        const decodedSet = new Set(decodedBlockIndices)

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
          setError('Failed to generate feedback QR code - payload too large. Try again later.')
          return
        }
      }
      setFeedbackQRUrl(dataUrl)
      setFeedbackMode(feedback.mode)
      onFeedbackGenerated(dataUrl, feedback.mode, seq)
      onSequenceIncrement()
      onModeChange('feedback-display')
    } finally { generatingRef.current = false; setIsGenerating(false) }
  }, [feedbackSequence, sessionId, isWindowEnabled, currentWindowStart, currentWindowEnd, windowTriggerThreshold, fountainMetadata.totalSourceBlocks, decodedBlockIndices, onFeedbackGenerated, onSequenceIncrement, onModeChange])

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

      onSenderSequenceUpdate(parsed.sequence)

      switch (parsed.command) {

        case 'acknowledge':
            // Debug logging moved to subcomponent
            if (parsed.acknowledgedSequence === feedbackSequence - 1) {
              // Valid ACK - resume data scanning
              setFeedbackQRUrl('')
              onModeChange('data-scanning')
              setIsGenerating(false)
              setSenderFeedbackMessage(parsed.message)
              onAckReceived(parsed.acknowledgedSequence, parsed.windowExpanded, parsed.message)
              // Expand window only if sender actually expanded it
              if (parsed.windowExpanded) {
                const expansion = getWindowExpansionSizeBlocks(fountainMetadata.blockSize)
                const newWindowEnd = Math.min(currentWindowEnd + expansion, fountainMetadata.totalSourceBlocks)
                onWindowExpansion(newWindowEnd)
                // Debug logging moved to subcomponent
              }
              // Stop the ACK scanner before restarting data scanner
              // stopScannerRef moved to subcomponent
              // restartScannerRef moved to subcomponent
            } else {
              // Invalid or duplicate ACK - ignore and return early
              // Debug logging moved to subcomponent
              return
            }
           break

      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      // Debug logging moved to subcomponent
      console.error('Sender feedback parse error:', err)
    }
  }, [sessionId, lastSenderFeedbackSequence, currentWindowStart, currentWindowEnd, feedbackSequence, fountainMetadata.totalSourceBlocks, onSenderSequenceUpdate, onModeChange, onWindowExpansion, onAckReceived])

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

  const handleStartAckScan = () => {
    onModeChange('ack-scanning')
    setError('')
  }

  const handleShowFeedbackQR = () => {
    onModeChange('feedback-display')
  }

  if (receiverMode === 'feedback-display' && feedbackQRUrl) {
    return (
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
              {(fountainMetadata.totalSourceBlocks - decodedBlocks) > getTargetedModeMaxMissingBlocks(fountainMetadata.blockSize) ? 'Sharing window progress (compact format)' : feedbackMode === 'targeted' ? 'Sharing decoded blocks for targeted transfer' : 'Sharing progress summary (fallback mode due to payload size)'}
            </p>
            <p className="text-xs text-muted-foreground text-center">
              Show this QR to sender, then click the button below to scan for ACK
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