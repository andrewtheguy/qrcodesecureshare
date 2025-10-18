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
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FountainEncoder } from '@/utils/fountainCode';
import type { FountainFeedback, SenderFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import type { default as QrScannerType } from 'qr-scanner';
import { WINDOW_BASELINE_THRESHOLD, calculateWindowExpansionSize, DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig';
import { isMobileDevice } from '@/lib/utils';

const startQrScanner = async (scanner: QrScannerType, constraints?: MediaTrackConstraints) => {
  const startFn = scanner.start as unknown as (mediaTrackConstraints?: MediaTrackConstraints) => Promise<void>;
  if (constraints && Object.keys(constraints).length > 0) {
    await startFn.call(scanner, constraints);
  } else {
    await startFn.call(scanner);
  }
};

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
  const scannerRef = useRef<QrScannerType | null>(null);
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
          QrScanner.WORKER_PATH = '/qr-scanner-worker.min.js';
          if (!scannerRef.current && videoRef.current) {
            // Mobile optimization: feedback scanning is brief, use 10 fps with conditional highlights
            const isMobile = isMobileDevice();
            const scanRate = isMobile ? 10 : 15;
            const showHighlights = !isMobile;

            scannerRef.current = new QrScanner(videoRef.current, handleFeedbackScan, {
              returnDetailedScanResult: true,
              maxScansPerSecond: scanRate,
              highlightScanRegion: showHighlights,
              highlightCodeOutline: showHighlights,
              preferredCamera: 'environment',
            });

            // Start scanner with video constraints for mobile optimization
            if (isMobile) {
              await startQrScanner(scannerRef.current, {
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 720 }
              });
            } else {
              await startQrScanner(scannerRef.current);
            }
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
