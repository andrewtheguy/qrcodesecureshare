/**
 * SENDER-SIDE COMPONENT
 *
 * This component handles the SENDER's feedback scanning and acknowledgment generation phases
 * of the Fountain Code transfer. It scans feedback QR codes from the receiver containing
 * decoding progress information and generates acknowledgment QR codes to confirm receipt
 * and coordinate part transitions.
 *
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FountainEncoder } from '@/utils/fountainCodeWasm';
import type { FountainFeedback, SenderFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner';

interface ProcessedFeedbackData {
  sequence: number;
  message: string;
}

interface FountainQRFeedbackScannerProps {
  encoder: FountainEncoder | null;
  sessionId: number;
  lastProcessedSequence: number;
  onFeedbackProcessed: (feedbackData: ProcessedFeedbackData) => void;
  onAckGenerated: (ackUrl: string, sequence: number, message?: string) => void;
  onModeChange: (mode: 'data-display' | 'feedback-scanning' | 'ack-display') => void;
  onError: (error: string) => void;
  autoStartScanning?: boolean;
}

export const FountainQRFeedbackScanner: React.FC<FountainQRFeedbackScannerProps> = ({
  encoder,
  sessionId,
  lastProcessedSequence,
  onFeedbackProcessed,
  onAckGenerated,
  onModeChange,
  onError,
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
  }, [autoStartScanning, currentMode]);

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
    try {
      const data = JSON.parse(qrCode) as FountainFeedback;
      if (data.type !== 'FOUNTAIN_FEEDBACK' || data.sessionId !== sessionId || typeof data.sequence !== 'number') {
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

      // Validate encoder exists before processing
      if (!encoder) {
        console.error('[FountainQRFeedbackScanner] CRITICAL: Encoder is null when processing feedback');
        onError('Encoder not available. Cannot process feedback.');
        return;
      }

      if (data.mode === 'part-complete') {
        // SYNC REQUIREMENT: Validate these fields match exactly with:
        // 1. FountainQRFeedbackDisplay.tsx - feedback generation for part-complete mode
        // 2. FountainQRManualFeedbackInput.tsx - validateInputs() for part-complete mode
        // 3. checksum.ts - generateFeedbackConfirmationCode()
        //
        // Expected fields: type, mode, sessionId, sequence, currentPart, totalParts
        // NOTE: Checksum fields excluded - receiver only sends feedback if part is valid
        console.log(`[FountainQRFeedbackScanner] Processing part-complete feedback for part ${data.currentPart + 1}/${data.totalParts}`);

        // If receiver sent feedback, it means the part was completed successfully
        // (receiver aborts and doesn't send feedback if checksum is invalid)
        console.log(`[FountainQRFeedbackScanner] Part ${data.currentPart + 1}/${data.totalParts} completed successfully`);

        let partTransition = false;
        let newPartIndex: number | undefined;

        // Move encoder to next part (encoder is already null-checked above)
        const moved = encoder.moveToNextPart();
        if (moved) {
          partTransition = true;
          const partInfo = encoder.getPartInfo();
          newPartIndex = partInfo.currentPartIndex;
          console.log(`[FountainQRFeedbackScanner] Moved to part ${(newPartIndex ?? 0) + 1}`);
        } else {
          console.log('[FountainQRFeedbackScanner] Part complete, but this was the last part');
        }

        // Determine message based on part transition
        let ackMessage = `Part completion acknowledged.`;
        if (partTransition && newPartIndex !== undefined) {
          ackMessage = `Part ${data.currentPart + 1} complete. Moving to part ${newPartIndex + 1}.`;
        }

        const ackFeedback: SenderFeedbackAcknowledge = {
          type: 'SENDER_FEEDBACK',
          sessionId,
          sequence: senderFeedbackSequence,
          command: 'acknowledge',
          acknowledgedSequence: data.sequence,
          message: ackMessage,
          ...(partTransition && { partTransition, newPartIndex })
        };

        await generateSenderFeedbackQR(ackFeedback);
        setCurrentMode('idle');

        onFeedbackProcessed({
          sequence: data.sequence,
          message: ackFeedback.message,
        });

        onModeChange('ack-display');
      } else {
        // Handle unrecognized or legacy modes (e.g., 'targeted' which was removed)
        console.warn(`[FountainQRFeedbackScanner] Unrecognized feedback mode: '${data.mode}' (sequence: ${data.sequence}). Only 'part-complete' mode is supported.`);
        onError(`Unsupported feedback mode: '${data.mode}'. Please ensure sender and receiver are using compatible versions.`);
        setCurrentMode('idle');
      }
    } finally {
      setProcessingRef(false);
    }
  }, [sessionId, lastProcessedSequence, senderFeedbackSequence, encoder, onFeedbackProcessed, onModeChange, onError, generateSenderFeedbackQR, processingRef]);

  // Initialize scanner hook after handleFeedbackScan is defined
  const { videoRef, canvasRef } = useZXingQRScanner({
    onScan: (data) => {
      if (Array.isArray(data) && data.length > 0) {
        handleFeedbackScan(data[0]);
      }
    },
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
                Align the camera with the receiver&apos;s amber QR card to receive progress updates and continue the transfer.
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
