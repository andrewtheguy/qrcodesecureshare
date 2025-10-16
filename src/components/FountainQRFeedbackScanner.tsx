import React, { useRef, useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FountainEncoder } from '@/utils/fountainCode';
import type { FountainFeedback, SenderFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import type QrScanner from 'qr-scanner';

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
  lastStats?: { totalDecoded: number; totalBlocks: number; windowStart?: number; windowEnd?: number };
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
  const [scanningFeedback, setScanningFeedback] = useState(false);
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
            setScanningFeedback(true);
          }
        } catch (error) {
          console.error('Failed to initialize feedback scanner:', error);
          onError('Failed to access camera for feedback scanning');
          setScanningFeedback(false);
        }
      };

      initScanner();
    } else if (!isActive || currentMode !== 'scanning') {
      if (scannerRef.current) {
        scannerRef.current.stop();
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
      setScanningFeedback(false);
    }

    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop();
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
    };
  }, [isActive, currentMode, onModeChange, onError]);

  const generateSenderFeedbackQR = async (feedback: SenderFeedback) => {
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
  };

  const handleFeedbackScan = async (result: { data: string }) => {
    if (processingRef.current) return;
    processingRef.current = true;

    let valid = true;
    try {
      const data = JSON.parse(result.data) as FountainFeedback;
      if (data.type !== 'FOUNTAIN_FEEDBACK' || data.sessionId !== sessionId || typeof data.sequence !== 'number') {
        valid = false;
        onError('Invalid feedback QR code: wrong type, session, or sequence.');
        setCurrentMode('idle');
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
        console.log('Processing statistics feedback:', data.totalDecoded, '/', data.totalBlocks);
        encoder?.setReceivedBlocks([]);
        encoder?.setSkipBlocksBelow(firstMissingBlock);

        const updatedWindowInfo = encoder?.getWindowInfo();
        if (updatedWindowInfo) {
          onUpdateWindowInfo(updatedWindowInfo);
        }

        const lastStats = {
          totalDecoded: data.totalDecoded,
          totalBlocks: data.totalBlocks,
          windowStart: updatedWindowInfo?.windowStart,
          windowEnd: updatedWindowInfo?.windowEnd,
        };

        // SENDER: Single authority for window expansion
        // Sender processes receiver statistics and decides whether to expand window
        // Window expansion is initiated ONLY by sender based on receiver's requestWindowExpansion flag
        let windowExpanded = false;
        if (data.requestWindowExpansion && windowInfo && !windowInfo.isWindowComplete) {
          const now = Date.now();
          if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
            encoder?.expandWindow();
            windowExpanded = true;
            const newWindowInfo = encoder?.getWindowInfo();
            if (newWindowInfo) {
              onUpdateWindowInfo(newWindowInfo);
              console.log(`[FountainQRFeedbackScanner] Window expanded: new end=${newWindowInfo.windowEnd}`);
            }
            onUpdateLastWindowExpansion(now);
          }
        }

        const ackFeedback: SenderFeedbackAcknowledge = {
          type: 'SENDER_FEEDBACK',
          sessionId,
          sequence: senderFeedbackSequence,
          command: 'acknowledge',
          acknowledgedSequence: data.sequence,
          message: `Statistics received. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`,
          windowExpanded,
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
        const missingBlocks = data.missingBlocks || [];
        console.log('Processing targeted feedback with', missingBlocks.length, 'missing blocks');
        encoder?.setMissingBlocks(missingBlocks);
        encoder?.setSkipBlocksBelow(firstMissingBlock);

        const updatedWindowInfo = encoder?.getWindowInfo();
        if (updatedWindowInfo) {
          onUpdateWindowInfo(updatedWindowInfo);
        }

        // SENDER: Single authority for window expansion in targeted mode
        // Sender evaluates decoded blocks in current window and decides whether to expand
        let windowExpanded = false;
        if (windowInfo?.windowEnabled && !windowInfo.isWindowComplete && updatedWindowInfo) {
          const missingInWindow = missingBlocks.filter(block => block >= updatedWindowInfo.windowStart && block <= updatedWindowInfo.windowEnd);
          const decodedInWindow = updatedWindowInfo.windowSize - missingInWindow.length;

          if (decodedInWindow > lastDecodedInWindow) {
            onUpdateLastDecodedInWindow(decodedInWindow);
            const windowDecodePercent = decodedInWindow / updatedWindowInfo.windowSize;
            if (windowDecodePercent >= 0.5) {
              const now = Date.now();
              if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
                encoder?.expandWindow();
                windowExpanded = true;
                const newWindowInfo = encoder?.getWindowInfo();
                if (newWindowInfo) {
                  onUpdateWindowInfo(newWindowInfo);
                  console.log(`[FountainQRFeedbackScanner] Window expanded in targeted mode: new end=${newWindowInfo.windowEnd}`);
                }
                onUpdateLastWindowExpansion(now);
              }
            }
          }
        }

        const ackFeedback: SenderFeedbackAcknowledge = {
          type: 'SENDER_FEEDBACK',
          sessionId,
          sequence: senderFeedbackSequence,
          command: 'acknowledge',
          acknowledgedSequence: data.sequence,
          message: `Targeted feedback received. ${missingBlocks.length} blocks still missing. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`,
          windowExpanded,
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

      setScanningFeedback(false);
      scannerRef.current?.stop();
    } catch (error) {
      console.error('Error processing feedback scan:', error);
      valid = false;
      onError('Error processing feedback QR code.');
    } finally {
      if (!valid) {
        setScanningFeedback(false);
        setCurrentMode('idle');
        if (scannerRef.current) {
          scannerRef.current.stop();
        }
      }
      processingRef.current = false;
    }
  };

  const handleStartScan = () => {
    setScanningFeedback(true);
    setCurrentMode('scanning');
    onModeChange('feedback-scanning');
  };

  const handleStopScan = () => {
    setScanningFeedback(false);
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