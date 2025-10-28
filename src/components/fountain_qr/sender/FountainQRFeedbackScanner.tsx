/**
 * SENDER-SIDE COMPONENT
 *
 * This component handles the SENDER's feedback scanning and acknowledgment generation phases
 * of the Fountain Code transfer. It scans feedback QR codes from the receiver containing
 * decoding progress information and generates acknowledgment QR codes to confirm receipt
 * and potentially expand the transmission window.
 *
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FountainEncoder } from '@/utils/fountainCode';
import type { FountainFeedback, SenderFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner';
import { WINDOW_BASELINE_THRESHOLD, calculateWindowExpansionSize, DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig';

interface WindowInfo {
  windowEnabled: boolean;
  windowStart: number;
  windowEnd: number;
  windowSize: number;
  totalBlocks: number;
  isWindowComplete: boolean;
  skipBlocksBelow: number;
  currentSegment: number;
  totalSegments: number;
  segmentProgress: number;
  segmentSizeBlocks: number;
}

interface ProcessedFeedbackData {
  sequence: number;
  mode: 'statistics' | 'targeted';
  receivedBlocks?: Set<number>;
  lastStats?: { totalDecoded: number; totalBlocks: number; windowStart?: number | undefined; windowEnd?: number | undefined; progress?: number };
  windowExpanded: boolean;
  message: string;
}

interface FountainQRFeedbackScannerProps {
  encoder: FountainEncoder | null;
  sessionId: number;
  lastProcessedSequence: number;
  windowInfo: WindowInfo | null;
  lastDecodedInWindow: number;
  lastWindowExpansion: number | null;
  onFeedbackProcessed: (feedbackData: ProcessedFeedbackData) => void;
  onAckGenerated: (ackUrl: string, sequence: number, message?: string) => void;
  onModeChange: (mode: 'data-display' | 'feedback-scanning' | 'ack-display') => void;
  onError: (error: string) => void;
  onUpdateWindowInfo: (windowInfo: WindowInfo) => void;
  onUpdateLastDecodedInWindow: (count: number) => void;
  onUpdateLastWindowExpansion: (timestamp: number) => void;
  autoStartScanning?: boolean;
}

export const FountainQRFeedbackScanner: React.FC<FountainQRFeedbackScannerProps> = ({
  encoder,
  sessionId,
  lastProcessedSequence,
  windowInfo,
  lastDecodedInWindow,
  lastWindowExpansion,
  onFeedbackProcessed,
  onAckGenerated,
  onModeChange,
  onError,
  onUpdateWindowInfo,
  onUpdateLastDecodedInWindow,
  onUpdateLastWindowExpansion,
  autoStartScanning = false,
}) => {
  const [currentMode, setCurrentMode] = useState<'scanning' | 'idle'>('idle');
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0);
  const [processingRef, setProcessingRef] = useState(false);

  // Auto-start scanning if parent is in feedback-scanning mode
  useEffect(() => {
    if (autoStartScanning && currentMode === 'idle') {
      setCurrentMode('scanning');
    }
  }, [autoStartScanning]);

  const generateSenderFeedbackQR = useCallback(async (feedback: SenderFeedback) => {
    try {
      const dataUrl = await generateNonDataQR(feedback);
      // Increment sequence only after successfully generating ACK
      setSenderFeedbackSequence(prev => prev + 1);
      onAckGenerated(dataUrl, feedback.sequence, feedback.message);
    } catch (error) {
      console.error('Failed to generate ACK QR:', error);
      onError('Failed to generate acknowledgment QR code');
    }
  }, [onAckGenerated, onError]);

  const handleFeedbackScan = useCallback(async (qrCodeData: string | Uint8Array) => {
    if (processingRef) return;

    // Convert Uint8Array to string if needed
    const qrCode = qrCodeData instanceof Uint8Array ? new TextDecoder().decode(qrCodeData) : qrCodeData

    // guard against non-JSON data triggering false ack received breaking the whole flow
    if (qrCode[0] !== '{') {
      console.log('Ignoring non-JSON QR code');
      return;
    }

    setProcessingRef(true);
    const data = JSON.parse(qrCode) as FountainFeedback;
    if (data.type !== 'FOUNTAIN_FEEDBACK' || data.sessionId !== sessionId || typeof data.sequence !== 'number') {
      onError('Invalid feedback QR code: wrong type, session, or sequence.');
      setCurrentMode('idle');
      return;
    }

    // Validate progress field
    if (typeof data.progress !== 'number' || data.progress < 0 || data.progress > 100) {
      onError('Invalid feedback QR: progress field missing or out of range (0-100)');
      setCurrentMode('idle');
      setProcessingRef(false);
      return;
    }

    if (data.sequence <= lastProcessedSequence) {
      console.log('Ignoring duplicate or stale feedback sequence:', data.sequence);
      onError('Stale feedback QR code: sequence already processed.');
      setCurrentMode('idle');
      setProcessingRef(false);
      return;
    }

    // Validate encoder exists before processing
    if (!encoder) {
      console.error('[FountainQRFeedbackScanner] CRITICAL: Encoder is null when processing feedback');
      onError('Encoder not available. Cannot process feedback.');
      setProcessingRef(false);
      return;
    }

    const firstMissingBlock = data.firstMissingBlock || 0;

    if (data.mode === 'statistics') {
      console.log('Processing statistics feedback:', 'N/A', '/', 'N/A');
      console.log('Receiver progress:', data.progress, '%');
      encoder?.setReceivedBlocks([]);
      encoder?.setSkipBlocksBelow(firstMissingBlock);

      const updatedWindowInfo = encoder?.getWindowInfo();
      if (updatedWindowInfo) {
        onUpdateWindowInfo(updatedWindowInfo);
      }

      const lastStats = {
        totalDecoded: 0,
        totalBlocks: updatedWindowInfo?.totalBlocks ?? 0,
        windowStart: updatedWindowInfo?.windowStart,
        windowEnd: updatedWindowInfo?.windowEnd,
        progress: data.progress,
      };

      // Check for part completion in part-based mode
      let partTransition = false;
      let newPartIndex: number | undefined;
      if (data.partComplete && data.partChecksumMatch) {
        console.log(`[FountainQRFeedbackScanner] Part ${(data.currentPart ?? 0) + 1}/${data.totalParts ?? 0} completed successfully`);

        // Move encoder to next part
        const moved = encoder?.moveToNextPart();
        if (moved) {
          partTransition = true;
          const partInfo = encoder?.getPartInfo();
          newPartIndex = partInfo?.currentPartIndex;
          console.log(`[FountainQRFeedbackScanner] Moved to part ${(newPartIndex ?? 0) + 1}`);

          // Update window info after part transition
          const newWindowInfo = encoder?.getWindowInfo();
          if (newWindowInfo) {
            onUpdateWindowInfo(newWindowInfo);
          }
        } else {
          console.log('[FountainQRFeedbackScanner] Part complete, but this was the last part');
        }
      } else if (data.partComplete && !data.partChecksumMatch) {
        // Part checksum mismatch - fail the transfer
        onError(`Part ${(data.currentPart ?? 0) + 1} checksum validation failed on receiver`);
        setCurrentMode('idle');
        setProcessingRef(false);
        return;
      }

      // SENDER: Single authority for window expansion
      // Sender derives expansion decisions from receiver progress metrics instead of explicit flags
      // Skip window expansion in part-based mode (use part transitions instead)
      let windowExpanded = false;
      const effectiveWindowInfo = updatedWindowInfo ?? windowInfo ?? null;
      const isPartBasedMode = data.currentPart !== undefined && data.totalParts !== undefined;
      if (effectiveWindowInfo?.windowEnabled && !effectiveWindowInfo.isWindowComplete && !isPartBasedMode) {
        const { windowEnd } = effectiveWindowInfo;
        const effectiveWindowSize = windowEnd - firstMissingBlock;
        const clampedEffectiveWindowSize = Math.max(effectiveWindowSize, 0);
        // Use decodedInWindow from feedback (required field)
        const decodedInWindow = data.decodedInWindow;
        const hasProgressed = decodedInWindow > lastDecodedInWindow;

        const meetsExpansionThreshold =
          hasProgressed && clampedEffectiveWindowSize > 0 && decodedInWindow >= clampedEffectiveWindowSize * WINDOW_BASELINE_THRESHOLD;

        if (clampedEffectiveWindowSize === 0) {
          // Skip expansion when clamped effective window size is 0
          console.log('[FountainQRFeedbackScanner] Skipping expansion: clampedEffectiveWindowSize is 0');
          if (hasProgressed) {
            onUpdateLastDecodedInWindow(decodedInWindow);
          }
        } else if (meetsExpansionThreshold) {
          const now = Date.now();
          if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
            const blockSize = encoder?.getMetadata()?.blockSize ?? DEFAULT_BLOCK_SIZE;
            const expansionCalc = calculateWindowExpansionSize(
              firstMissingBlock,
              firstMissingBlock,
              windowEnd,
              clampedEffectiveWindowSize,
              data.progress,
              blockSize,
              effectiveWindowInfo.totalBlocks
            );
            console.log(
              `[FountainQRFeedbackScanner] Expansion calculation (statistics): decodedInWindow=${decodedInWindow}, effectiveWindowSize=${effectiveWindowSize}, clampedEffectiveWindowSize=${clampedEffectiveWindowSize}, threshold=${Math.round(clampedEffectiveWindowSize * WINDOW_BASELINE_THRESHOLD)}, effective=${expansionCalc.effectivePercent.toFixed(2)}, extra=${expansionCalc.extraPercent.toFixed(2)}, blocks=${expansionCalc.expansionBlocks}`
            );
            const oldWindowInfo = encoder?.getWindowInfo();
            const oldWindowEnd = oldWindowInfo?.windowEnd;
            encoder?.expandWindow(expansionCalc.expansionBlocks);
            const newWindowInfo = encoder?.getWindowInfo();
            const expansionSucceeded =
              !!newWindowInfo &&
              (typeof oldWindowEnd === 'number'
                ? newWindowInfo.windowEnd > oldWindowEnd
                : expansionCalc.expansionBlocks > 0);

            if (newWindowInfo) {
              onUpdateWindowInfo(newWindowInfo);
              if (expansionSucceeded) {
                console.log(
                  `[FountainQRFeedbackScanner] Window expanded (statistics mode): new end=${newWindowInfo.windowEnd}, expansion=${expansionCalc.expansionBlocks} blocks`
                );
              } else {
                console.log(
                  '[FountainQRFeedbackScanner] Window expansion requested but window end did not change; retaining decodedInWindow state.'
                );
              }
            }

            if (expansionSucceeded) {
              windowExpanded = true;
              onUpdateLastDecodedInWindow(0);
              onUpdateLastWindowExpansion(now);
            } else if (hasProgressed) {
              onUpdateLastDecodedInWindow(decodedInWindow);
            }
          } else if (hasProgressed) {
            onUpdateLastDecodedInWindow(decodedInWindow);
          }
        } else if (hasProgressed) {
          onUpdateLastDecodedInWindow(decodedInWindow);
        }
      }

      // Get the current (possibly expanded) window info to send to receiver
      console.log('[FountainQRFeedbackScanner] Getting final window info for ACK generation');
      console.log('[FountainQRFeedbackScanner] Encoder state:', encoder ? 'valid' : 'NULL');
      const finalWindowInfo = encoder.getWindowInfo();
      if (!finalWindowInfo) {
        console.error('[FountainQRFeedbackScanner] CRITICAL: getWindowInfo() returned null/undefined');
        console.error('[FountainQRFeedbackScanner] Encoder metadata:', encoder.getMetadata());
        onError('Failed to get window info from encoder. Cannot generate ACK.');
        setCurrentMode('idle');
        setProcessingRef(false);
        return;
      }
      console.log('[FountainQRFeedbackScanner] ACK generated with window range:', finalWindowInfo.windowStart, '-', finalWindowInfo.windowEnd);

      // Determine message based on part transition or window expansion
      let ackMessage = `Statistics received. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`;
      if (partTransition && newPartIndex !== undefined) {
        ackMessage = `Part ${(data.currentPart ?? 0) + 1} complete. Moving to part ${newPartIndex + 1}.`;
      }

      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: data.sequence,
        message: ackMessage,
        windowExpanded,
        windowStart: finalWindowInfo.windowStart,
        windowEnd: finalWindowInfo.windowEnd,
        ...(partTransition && { partTransition, newPartIndex })
      };

      await generateSenderFeedbackQR(ackFeedback);
      setCurrentMode('idle');

      onFeedbackProcessed({
        sequence: data.sequence,
        mode: 'statistics',
        lastStats,
        windowExpanded,
        message: ackFeedback.message,
      });

      onModeChange('ack-display');
      setProcessingRef(false);
    } else if (data.mode === 'targeted') {
      if (!data.missingBlocks || !Array.isArray(data.missingBlocks)) {
        onError('Invalid targeted feedback: missingBlocks must be an array.');
        setCurrentMode('idle');
        setProcessingRef(false);
        return;
      }
      const missingBlocks = data.missingBlocks;
      console.log('Processing targeted feedback with', missingBlocks.length, 'missing blocks');
      console.log('Receiver progress:', data.progress, '%');
      encoder?.setMissingBlocks(missingBlocks);
      encoder?.setSkipBlocksBelow(firstMissingBlock);

      const updatedWindowInfo = encoder?.getWindowInfo();
      if (updatedWindowInfo) {
        onUpdateWindowInfo(updatedWindowInfo);
      }

      // Generate ACK without expansion (targeted mode is final cleanup)
      console.log('[FountainQRFeedbackScanner] Getting final window info for targeted mode ACK');
      console.log('[FountainQRFeedbackScanner] Encoder state:', encoder ? 'valid' : 'NULL');
      const finalWindowInfo = encoder.getWindowInfo();
      if (!finalWindowInfo) {
        console.error('[FountainQRFeedbackScanner] CRITICAL: getWindowInfo() returned null in targeted mode');
        onError('Failed to get window info from encoder. Cannot generate ACK.');
        setCurrentMode('idle');
        setProcessingRef(false);
        return;
      }
      console.log('[FountainQRFeedbackScanner] Targeted mode ACK generated with window range:', finalWindowInfo.windowStart, '-', finalWindowInfo.windowEnd);
      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: data.sequence,
        message: `Targeted feedback received. ${missingBlocks.length} blocks still missing. Final cleanup mode.`,
        windowExpanded: false,
        windowStart: finalWindowInfo.windowStart,
        windowEnd: finalWindowInfo.windowEnd,
      };

      await generateSenderFeedbackQR(ackFeedback);
      setCurrentMode('idle');

      onFeedbackProcessed({
        sequence: data.sequence,
        mode: 'targeted',
        receivedBlocks: new Set(),
        windowExpanded: false,
        message: ackFeedback.message,
      });

      onModeChange('ack-display');
      setProcessingRef(false);
    }
    setProcessingRef(false);

  }, [sessionId, lastProcessedSequence, senderFeedbackSequence, windowInfo, lastDecodedInWindow, lastWindowExpansion, encoder, onFeedbackProcessed, onModeChange, onError, onUpdateWindowInfo, onUpdateLastDecodedInWindow, onUpdateLastWindowExpansion, generateSenderFeedbackQR, processingRef]);

  // Initialize scanner hook after handleFeedbackScan is defined
  const { videoRef, canvasRef } = useZXingQRScanner({
    onScan: (data) => handleFeedbackScan(data[0]),
    isScanning: currentMode === 'scanning',
    onError: (error) => onError(error),
    scanInterval: 100 // 10 fps for brief feedback scanning
  });

  const handleStartScan = () => {
    setCurrentMode('scanning');
    onModeChange('feedback-scanning');
  };

  const handleStopScan = () => {
    setCurrentMode('idle');
    onModeChange('data-display');
  };

  if (currentMode === 'scanning') {
    return (
      <Card className="border border-amber-500/60 bg-amber-950 text-amber-100 shadow-2xl">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <Badge
                variant="outline"
                className="border-amber-400/70 bg-amber-500/10 text-amber-100 uppercase tracking-wider"
              >
                Feedback Scan
              </Badge>
              <CardTitle className="text-xl font-semibold text-amber-50">Capture Receiver Feedback</CardTitle>
              <p className="text-sm text-amber-200/70">
                Align the camera with the receiver&apos;s amber QR card. This update lets you adjust the transmission window and send the next chunk batch.
              </p>
            </div>
            <Button
              onClick={handleStopScan}
              variant="secondary"
              className="bg-amber-900 text-amber-100 border border-amber-400/70 hover:bg-amber-800"
            >
              Cancel Scan
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative overflow-hidden rounded-2xl border border-amber-500/40 bg-black shadow-2xl">
            <video
              ref={videoRef}
              className="w-full max-h-[420px] object-cover"
              playsInline
              muted
            />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-5 rounded-xl border-2 border-amber-400/70 animate-pulse" />
              <div className="absolute top-4 left-4 flex items-center gap-2 rounded-full border border-amber-400/80 bg-amber-500/30 px-3 py-1 text-xs font-semibold text-amber-50 shadow-md">
                <span className="text-amber-200">●</span>
                Scanning Feedback
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-amber-950/90 via-amber-950/10 to-transparent px-4 py-3 text-center text-sm text-amber-50">
                Fill the glowing frame with the receiver&apos;s feedback QR to continue.
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-100/80 space-y-1">
            <p>• Ask the receiver to show the amber progress card you just shared.</p>
            <p>• Once scanned, an ACK QR will appear for them automatically.</p>
            <p>• If the QR looks dark with dense data, it&apos;s not feedback—stop and resume when ready.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        onClick={handleStartScan}
        disabled={!encoder}
        className="w-full bg-amber-600 hover:bg-amber-500 text-white"
      >
        Scan Feedback QR
      </Button>
    </div>
  );
};
