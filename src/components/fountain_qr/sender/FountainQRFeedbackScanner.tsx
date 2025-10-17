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
  onAckGenerated: (ackUrl: string, sequence: number) => void;
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
  const [ackQRUrl, setAckQRUrl] = useState('');
  const [currentMode, setCurrentMode] = useState<'scanning' | 'ack-display' | 'idle'>('idle');
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const processingRef = useRef(false);

  // Reset sequence on session change
  useEffect(() => {
    setSenderFeedbackSequence(0);
  }, [sessionId]);

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
        const { windowStart, windowEnd, windowSize } = effectiveWindowInfo;
        const boundedFirstMissing = Math.min(firstMissingBlock, windowEnd);
        const contiguousDecoded = Math.max(0, boundedFirstMissing - windowStart);
        const hasProgressed = contiguousDecoded > lastDecodedInWindow;

        if (hasProgressed) {
          onUpdateLastDecodedInWindow(contiguousDecoded);
        }

        if (hasProgressed && contiguousDecoded >= windowSize * WINDOW_BASELINE_THRESHOLD) {
          const now = Date.now();
          if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
            const blockSize = encoder?.getMetadata()?.blockSize ?? DEFAULT_BLOCK_SIZE;
            const expansionCalc = calculateWindowExpansionSize(
              firstMissingBlock,
              windowStart,
              windowEnd,
              windowSize,
              data.progress,
              blockSize,
              effectiveWindowInfo.totalBlocks
            );
            console.log(
              `[FountainQRFeedbackScanner] Expansion calculation (statistics): contiguous=${expansionCalc.contiguousDecoded}, effective=${expansionCalc.effectivePercent.toFixed(2)}, extra=${expansionCalc.extraPercent.toFixed(2)}, blocks=${expansionCalc.expansionBlocks}`
            );
            encoder?.expandWindow(expansionCalc.expansionBlocks);
            windowExpanded = true;
            const newWindowInfo = encoder?.getWindowInfo();
            if (newWindowInfo) {
              onUpdateWindowInfo(newWindowInfo);
              console.log(
                `[FountainQRFeedbackScanner] Window expanded (statistics mode): new end=${newWindowInfo.windowEnd}, expansion=${expansionCalc.expansionBlocks} blocks`
              );
            }
            onUpdateLastWindowExpansion(now);
          }
        }
      }

      // Get the current (possibly expanded) window info to send to receiver
      const finalWindowInfo = encoder?.getWindowInfo();
      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: data.sequence,
        message: `Statistics received. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`,
        windowExpanded,
        windowStart: finalWindowInfo?.windowStart ?? 0,
        windowEnd: finalWindowInfo?.windowEnd ?? (updatedWindowInfo?.totalBlocks ?? 0),
      };

      await generateSenderFeedbackQR(ackFeedback);
      setCurrentMode('ack-display');

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

      // SENDER: Single authority for window expansion in targeted mode
      // Sender evaluates decoded blocks in current window and decides whether to expand
      let windowExpanded = false;
      if (updatedWindowInfo?.windowEnabled && !updatedWindowInfo?.isWindowComplete) {
        const missingInWindow = missingBlocks.filter(block => block >= updatedWindowInfo.windowStart && block <= updatedWindowInfo.windowEnd);
        const decodedInWindow = updatedWindowInfo.windowSize - missingInWindow.length;

        if (decodedInWindow > lastDecodedInWindow) {
          onUpdateLastDecodedInWindow(decodedInWindow);
          const windowDecodePercent = decodedInWindow / updatedWindowInfo.windowSize;
          if (windowDecodePercent >= WINDOW_BASELINE_THRESHOLD) {
            const now = Date.now();
            if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
              const blockSize = encoder?.getMetadata()?.blockSize ?? DEFAULT_BLOCK_SIZE;
              const expansionCalc = calculateWindowExpansionSize(
                firstMissingBlock,
                updatedWindowInfo.windowStart,
                updatedWindowInfo.windowEnd,
                updatedWindowInfo.windowSize,
                data.progress,
                blockSize,
                updatedWindowInfo.totalBlocks
              );
              console.log(
                `[FountainQRFeedbackScanner] Expansion calculation (targeted): decoded=${decodedInWindow}, effective=${expansionCalc.effectivePercent.toFixed(2)}, extra=${expansionCalc.extraPercent.toFixed(2)}, blocks=${expansionCalc.expansionBlocks}`
              );
              encoder?.expandWindow(expansionCalc.expansionBlocks);
              windowExpanded = true;
              const newWindowInfo = encoder?.getWindowInfo();
              if (newWindowInfo) {
                onUpdateWindowInfo(newWindowInfo);
                console.log(
                  `[FountainQRFeedbackScanner] Window expanded (targeted mode): new end=${newWindowInfo.windowEnd}, expansion=${expansionCalc.expansionBlocks} blocks`
                );
              }
              onUpdateLastWindowExpansion(now);
            }
          }
        }
      }

      // Get the current (possibly expanded) window info to send to receiver
      const finalWindowInfo = encoder?.getWindowInfo();
      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: data.sequence,
        message: `Targeted feedback received. ${missingBlocks.length} blocks still missing. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`,
        windowExpanded,
        windowStart: finalWindowInfo?.windowStart ?? 0,
        windowEnd: finalWindowInfo?.windowEnd ?? (updatedWindowInfo?.totalBlocks ?? 0),
      };

      await generateSenderFeedbackQR(ackFeedback);
      setCurrentMode('ack-display');

      onFeedbackProcessed({
        sequence: data.sequence,
        mode: 'targeted',
        receivedBlocks: new Set(),
        windowExpanded,
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

  async function generateSenderFeedbackQR(feedback: SenderFeedback) {
    try {
      const dataUrl = await generateNonDataQR(feedback);
      setAckQRUrl(dataUrl);
      // Increment sequence only after successfully generating ACK
      setSenderFeedbackSequence(prev => prev + 1);
      onAckGenerated(dataUrl, feedback.sequence);
    } catch (error) {
      console.error('Failed to generate ACK QR:', error);
      onError('Failed to generate acknowledgment QR code');
    }
  }

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

  const handleResumeDataDisplay = () => {
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

  if (currentMode === 'ack-display' && ackQRUrl) {
    return (
      <div className="flex flex-col items-center space-y-4 p-6 bg-white rounded-lg border">
        <img src={ackQRUrl} alt="ACK QR Code" className="max-w-xs" />
        <p className="text-center font-medium">ACK QR Code - Show to receiver</p>
        <p className="text-center text-sm text-muted-foreground">
          Receiver must scan this before resuming data scanning
        </p>
        <Button onClick={handleResumeDataDisplay} className="w-full">
          Resume Data Display
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
      {ackQRUrl && (
        <Button
          onClick={() => setCurrentMode('ack-display')}
          variant="outline"
          className="w-full"
        >
          Show Last ACK QR
        </Button>
      )}
    </div>
  );
};
