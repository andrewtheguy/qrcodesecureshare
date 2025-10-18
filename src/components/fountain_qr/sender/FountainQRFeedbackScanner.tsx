/**
 * SENDER-SIDE COMPONENT
 *
 * This component handles the SENDER's feedback scanning and acknowledgment generation phases
 * of the Fountain Code transfer. It scans feedback QR codes from the receiver containing
 * decoding progress information and generates acknowledgment QR codes to confirm receipt
 * and potentially expand the transmission window.
 *
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FountainEncoder } from '@/utils/fountainCode';
import type { FountainFeedback, SenderFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import type QrScanner from 'qr-scanner';
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
  isActive: boolean;
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
}

export const FountainQRFeedbackScanner: React.FC<FountainQRFeedbackScannerProps> = ({
  encoder,
  sessionId,
  isActive,
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
}) => {
  const [currentMode, setCurrentMode] = useState<'scanning' | 'idle'>('idle');
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const processingRef = useRef(false);

  // Reset sequence on session change
  useEffect(() => {
    setSenderFeedbackSequence(0);
  }, [sessionId]);

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

  const handleFeedbackScan = useCallback(async (result: { data: string }) => {
    if (processingRef.current) return;
    // guard against non-JSON data triggering false ack received breaking the whole flow
    if (result.data[0] !== '{') {
      console.log('Ignoring non-JSON QR code');
      return;
    }

    processingRef.current = true;
    const data = JSON.parse(result.data) as FountainFeedback;
    if (data.type !== 'FOUNTAIN_FEEDBACK' || data.sessionId !== sessionId || typeof data.sequence !== 'number') {
      onError('Invalid feedback QR code: wrong type, session, or sequence.');
      setCurrentMode('idle');
      return;
    }

    // Validate progress field
    if (typeof data.progress !== 'number' || data.progress < 0 || data.progress > 100) {
      onError('Invalid feedback QR: progress field missing or out of range (0-100)');
      setCurrentMode('idle');
      processingRef.current = false;
      return;
    }

    if (data.sequence <= lastProcessedSequence) {
      console.log('Ignoring duplicate or stale feedback sequence:', data.sequence);
      onError('Stale feedback QR code: sequence already processed.');
      setCurrentMode('idle');
      return;
    }

    // Validate encoder exists before processing
    if (!encoder) {
      console.error('[FountainQRFeedbackScanner] CRITICAL: Encoder is null when processing feedback');
      onError('Encoder not available. Cannot process feedback.');
      processingRef.current = false;
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

      // SENDER: Single authority for window expansion
      // Sender derives expansion decisions from receiver progress metrics instead of explicit flags
      let windowExpanded = false;
      const effectiveWindowInfo = updatedWindowInfo ?? windowInfo ?? null;
      if (effectiveWindowInfo?.windowEnabled && !effectiveWindowInfo.isWindowComplete) {
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
        scannerRef.current?.stop();
        processingRef.current = false;
        return;
      }
      console.log('[FountainQRFeedbackScanner] ACK generated with window range:', finalWindowInfo.windowStart, '-', finalWindowInfo.windowEnd);
      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: data.sequence,
        message: `Statistics received. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`,
        windowExpanded,
        windowStart: finalWindowInfo.windowStart,
        windowEnd: finalWindowInfo.windowEnd,
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
      scannerRef.current?.stop();
      scannerRef.current?.destroy();
      scannerRef.current = null;
    } else if (data.mode === 'targeted') {
      if (!data.missingBlocks || !Array.isArray(data.missingBlocks)) {
        onError('Invalid targeted feedback: missingBlocks must be an array.');
        setCurrentMode('idle');
        processingRef.current = false;
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
        scannerRef.current?.stop();
        processingRef.current = false;
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
      scannerRef.current?.stop();
      scannerRef.current?.destroy();
      scannerRef.current = null;
    }
    processingRef.current = false;
    // setScanningFeedback(false);
    scannerRef.current?.stop();
   
  }, [sessionId, lastProcessedSequence, senderFeedbackSequence, windowInfo, lastDecodedInWindow, lastWindowExpansion, encoder, onFeedbackProcessed, onAckGenerated, onModeChange, onError, onUpdateWindowInfo, onUpdateLastDecodedInWindow, onUpdateLastWindowExpansion, generateSenderFeedbackQR]);

  useEffect(() => {
    if (isActive && currentMode === 'scanning') {
      const initScanner = async () => {
        try {
          const { default: QrScanner } = await import('qr-scanner');
          if (!scannerRef.current && videoRef.current) {
            scannerRef.current = new QrScanner(videoRef.current, handleFeedbackScan, {
              returnDetailedScanResult: true,
              highlightScanRegion: true,
              highlightCodeOutline: true,
            });
            await scannerRef.current.start();
            // setScanningFeedback(true);
          }
        } catch (error) {
          console.error('Failed to initialize feedback scanner:', error);
          onError('Failed to access camera for feedback scanning');
          // setScanningFeedback(false);
        }
      };

      initScanner();
    } else if (!isActive || currentMode !== 'scanning') {
      if (scannerRef.current) {
        scannerRef.current.stop();
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
      // setScanningFeedback(false);
    }

    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop();
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
    };
  }, [isActive, currentMode, onModeChange, onError, handleFeedbackScan]);

  const handleStartScan = () => {
    // setScanningFeedback(true);
    setCurrentMode('scanning');
    onModeChange('feedback-scanning');
  };

  const handleStopScan = () => {
    // setScanningFeedback(false);
    scannerRef.current?.stop();
    setCurrentMode('idle');
    onModeChange('data-display');
  };

  if (currentMode === 'scanning') {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>Scanning for receiver feedback QR code...</AlertDescription>
        </Alert>
        <div className="relative">
          <video
            ref={videoRef}
            className="w-full max-w-md mx-auto border rounded-lg"
            playsInline
            muted
          />
          <div className="absolute top-2 right-2 bg-red-500 text-white px-2 py-1 rounded text-sm">
            ● SCANNING
          </div>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Point your camera at the receiver's feedback QR code
        </p>
        <Button onClick={handleStopScan} variant="outline" className="w-full">
          Cancel Scan
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        onClick={handleStartScan}
        disabled={!encoder}
        className="w-full"
      >
        Scan Feedback QR
      </Button>
    </div>
  );
};
