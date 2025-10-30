/**
 *
 * This component provides an alternative manual input method for SENDER devices
 * that cannot use camera-based QR scanning. Instead of scanning feedback QR codes
 * from the receiver, the sender can manually enter the feedback details from the
 * receiver's display. This enables fountain code transfers on devices without cameras
 * or when camera scanning is not feasible.
 *
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { FountainEncoder } from '@/utils/fountainCodeWasm';
import type { FountainFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import { generateFeedbackConfirmationCode, normalizeConfirmationCode } from '@/utils/checksum';

interface ProcessedFeedbackData {
  sequence: number;
  mode: 'part-complete';
  message: string;
}

interface FountainQRManualFeedbackInputProps {
  encoder: FountainEncoder | null;
  sessionId: number;
  isActive?: boolean;
  lastProcessedSequence: number;
  onFeedbackProcessed: (feedbackData: ProcessedFeedbackData) => void;
  onAckGenerated: (ackUrl: string, sequence: number, message?: string) => void;
  onModeChange: (mode: 'data-display' | 'feedback-scanning' | 'ack-display') => void;
  onError: (error: string) => void;
}

export const FountainQRManualFeedbackInput: React.FC<FountainQRManualFeedbackInputProps> = ({
  encoder,
  sessionId,
  lastProcessedSequence,
  onFeedbackProcessed,
  onAckGenerated,
  onModeChange,
  onError,
}) => {
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0);

  // Form field states
  const [inputSessionId] = useState(sessionId.toString());
  const [inputSequence, setInputSequence] = useState((lastProcessedSequence + 1).toString());
  // Note: User enters 1-indexed values (what they see on display), but we store as strings for UI
  // Conversion to 0-indexed happens in validateInputs before checksum generation
  const [inputCurrentPart, setInputCurrentPart] = useState('1');
  const [inputTotalParts, setInputTotalParts] = useState('1');
  const [inputPartChecksumMatch, setInputPartChecksumMatch] = useState<'true' | 'false'>('true');
  const [inputConfirmationCode, setInputConfirmationCode] = useState('');
  const [validationError, setValidationError] = useState('')
  const validationErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Reset sequence on session change
  useEffect(() => {
    setSenderFeedbackSequence(0);
    setInputSequence((lastProcessedSequence + 1).toString());
  }, [sessionId, lastProcessedSequence]);

  // Set total parts and current part from encoder
  useEffect(() => {
    if (encoder) {
      const partInfo = encoder.getPartInfo();
      if (partInfo) {
        setInputTotalParts(partInfo.totalParts.toString());
        // Set current part to the part the receiver is expected to report on (1-indexed)
        setInputCurrentPart((partInfo.currentPartIndex + 1).toString());
      }
    }
  }, [encoder]);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (validationErrorTimeoutRef.current) {
        clearTimeout(validationErrorTimeoutRef.current);
      }
    };
  }, []);


  const showValidationError = (message: string) => {
    // Clear any existing timeout
    if (validationErrorTimeoutRef.current) {
      clearTimeout(validationErrorTimeoutRef.current);
    }

    setValidationError(message);

    // Auto-clear after 5 seconds
    validationErrorTimeoutRef.current = setTimeout(() => {
      setValidationError('');
      validationErrorTimeoutRef.current = null;
    }, 5000);
  };

  const resetInputFields = useCallback(() => {
    setInputSequence((lastProcessedSequence + 1).toString());
    // Set current part to the next expected part from encoder (1-indexed)
    if (encoder) {
      const partInfo = encoder.getPartInfo();
      if (partInfo) {
        setInputCurrentPart((partInfo.currentPartIndex + 1).toString());
      }
    }
    // Note: inputTotalParts is not reset here as it's auto-populated from encoder
    setInputPartChecksumMatch('true');
    setInputConfirmationCode('');
  }, [lastProcessedSequence, encoder]);

  const validateInputs = useCallback(async (): Promise<{ valid: boolean; error: string; feedback: FountainFeedback | null }> => {
    // Parse and validate sessionId
    const parsedSessionId = parseInt(inputSessionId);
    if (isNaN(parsedSessionId) || parsedSessionId !== sessionId) {
      return { valid: false, error: `Session ID mismatch: Expected ${sessionId}, but got ${parsedSessionId}. Please verify you copied the correct Session ID from the receiver's feedback display.`, feedback: null };
    }

    // Parse and validate sequence
    const parsedSequence = parseInt(inputSequence);
    if (isNaN(parsedSequence) || parsedSequence <= lastProcessedSequence) {
      return { valid: false, error: `Invalid sequence: Must be greater than ${lastProcessedSequence} (last processed). Current value: ${parsedSequence}. Please check the Sequence field from receiver's feedback display.`, feedback: null };
    }

    // Validate confirmation code
    if (!inputConfirmationCode.trim()) {
      return { valid: false, error: 'Confirmation code required: Please enter the confirmation code shown in receiver\'s Feedback Details card to verify input accuracy.', feedback: null };
    }

    // SYNC REQUIREMENT: These fields MUST match exactly with:
    // 1. FountainQRFeedbackDisplay.tsx - feedback generation for part-complete mode
    // 2. FountainQRFeedbackScanner.tsx - handleFeedbackScan() validation
    // 3. checksum.ts - generateFeedbackConfirmationCode()
    //
    // Required fields: type, mode, sessionId, sequence, currentPart, totalParts, partChecksumMatch
    // Do NOT include optional fields like computedChecksum

    // Parse and validate currentPart (user enters 1-indexed, convert to 0-indexed)
    const parsedCurrentPartDisplay = parseInt(inputCurrentPart);
    if (isNaN(parsedCurrentPartDisplay) || parsedCurrentPartDisplay < 1) {
      return { valid: false, error: `Invalid current part: Must be at least 1. Current value: ${inputCurrentPart}. Please verify this field from receiver's feedback display.`, feedback: null };
    }

    // Parse and validate totalParts
    const parsedTotalParts = parseInt(inputTotalParts);
    if (isNaN(parsedTotalParts) || parsedTotalParts < 1) {
      return { valid: false, error: `Invalid total parts: Must be at least 1. Current value: ${inputTotalParts}. Please verify this field from receiver's feedback display.`, feedback: null };
    }

    if (parsedCurrentPartDisplay > parsedTotalParts) {
      return { valid: false, error: `Current part (${parsedCurrentPartDisplay}) cannot be greater than total parts (${parsedTotalParts}). Please verify these fields.`, feedback: null };
    }

    // Convert currentPart from 1-indexed (display) to 0-indexed (internal)
    const parsedCurrentPart = parsedCurrentPartDisplay - 1;

    const feedback: FountainFeedback = {
      type: 'FOUNTAIN_FEEDBACK',
      mode: 'part-complete',
      sessionId: parsedSessionId,
      sequence: parsedSequence,
      currentPart: parsedCurrentPart,
      totalParts: parsedTotalParts,
      partChecksumMatch: inputPartChecksumMatch === 'true',
    };

    // Validate confirmation code against expected value
    const expectedCode = await generateFeedbackConfirmationCode(feedback);
    const normalizedInput = normalizeConfirmationCode(inputConfirmationCode);
    const normalizedExpected = normalizeConfirmationCode(expectedCode);

    if (normalizedInput !== normalizedExpected) {
      return {
        valid: false,
        error: `Confirmation code mismatch: The code you entered doesn't match the expected value for this feedback. This indicates a typo in one or more fields. Please double-check all fields (Session ID, Sequence, Current Part, Total Parts, and mode-specific fields) and try again. Expected: ${expectedCode}, Got: ${inputConfirmationCode}`,
        feedback: null
      };
    }

    return { valid: true, error: '', feedback };
  }, [inputSessionId, inputSequence, inputCurrentPart, inputTotalParts, inputPartChecksumMatch, inputConfirmationCode, sessionId, lastProcessedSequence]);

  const generateSenderFeedbackQR = useCallback(async (feedback: SenderFeedbackAcknowledge) => {
    try {
      const dataUrl = await generateNonDataQR(feedback);
      setSenderFeedbackSequence(prev => prev + 1);
      onAckGenerated(dataUrl, feedback.sequence, feedback.message);
    } catch (error) {
      console.error('Failed to generate ACK QR:', error);
      onError('Failed to generate acknowledgment QR code');
    }
  }, [onAckGenerated, onError]);

  const handleProcessFeedback = useCallback(async () => {
    const { valid, error, feedback } = await validateInputs();
    if (!valid || !feedback) {
      showValidationError(error);
      return;
    }

    // Validate encoder exists before processing
    if (!encoder) {
      console.error('[FountainQRManualFeedbackInput] CRITICAL: Encoder is null when processing feedback');
      showValidationError('Encoder not available. Cannot process feedback.');
      return;
    }

    // Clear any existing validation error
    setValidationError('');

    if (feedback.mode === 'part-complete') {
      console.log(`[FountainQRManualFeedbackInput] Processing part-complete feedback for part ${feedback.currentPart + 1}/${feedback.totalParts}`);
      console.log(`[FountainQRManualFeedbackInput] Checksum match: ${feedback.partChecksumMatch}`);

      // Check for part completion
      let partTransition = false;
      let newPartIndex: number | undefined;

      if (feedback.partChecksumMatch) {
        console.log(`[FountainQRManualFeedbackInput] Part ${feedback.currentPart + 1}/${feedback.totalParts} completed successfully`);

        // Move encoder to next part
        const moved = encoder?.moveToNextPart();
        if (moved) {
          partTransition = true;
          const partInfo = encoder?.getPartInfo();
          newPartIndex = partInfo?.currentPartIndex;
          console.log(`[FountainQRManualFeedbackInput] Moved to part ${(newPartIndex ?? 0) + 1}`);
        } else {
          console.log('[FountainQRManualFeedbackInput] Part complete, but this was the last part');
        }
      } else {
        // Part checksum mismatch - fail the transfer
        showValidationError(`Part ${feedback.currentPart + 1} checksum validation failed on receiver`);
        return;
      }

      // Determine message based on part transition
      let ackMessage = `Part completion acknowledged.`;
      if (partTransition && newPartIndex !== undefined) {
        ackMessage = `Part ${feedback.currentPart + 1} complete. Moving to part ${newPartIndex + 1}.`;
      }

      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: feedback.sequence,
        message: ackMessage,
        ...(partTransition && { partTransition, newPartIndex })
      };

      await generateSenderFeedbackQR(ackFeedback);
      resetInputFields();

      onFeedbackProcessed({
        sequence: feedback.sequence,
        mode: 'part-complete',
        message: ackFeedback.message,
      });

      onModeChange('ack-display');
    }
  }, [validateInputs, encoder, sessionId, senderFeedbackSequence, onFeedbackProcessed, onModeChange, resetInputFields, generateSenderFeedbackQR]);

  const handleConfirmationCodeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;

    // 1. Get raw input value
    // 2. Remove all non-hex characters and dashes using regex
    let cleaned = rawValue.replace(/[^0-9A-Fa-f-]/g, '');

    // 3. Remove existing dashes
    cleaned = cleaned.replace(/-/g, '');

    // 4. Convert to uppercase
    cleaned = cleaned.toUpperCase();

    // 5. Limit to 8 characters
    cleaned = cleaned.slice(0, 8);

    // 6. Auto-insert dash after 4th character if length > 4
    let formatted = cleaned;
    if (cleaned.length > 4) {
      formatted = cleaned.slice(0, 4) + '-' + cleaned.slice(4);
    }

    // 7. Set the formatted value to state
    setInputConfirmationCode(formatted);
  }, []);

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <CardTitle>Manual Feedback Input</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="sessionId" className="text-xs">Session ID (Auto)</Label>
            <Input
              id="sessionId"
              type="number"
              value={inputSessionId}
              readOnly
              className="bg-gray-100"
            />
          </div>
          <div>
            <Label htmlFor="sequence" className="text-xs">Feedback Sequence (Auto)</Label>
            <Input
              id="sequence"
              type="number"
              value={inputSequence}
              readOnly
              className="bg-gray-100"
            />
          </div>
        </div>

        {/* SYNC REQUIREMENT: UI fields MUST match exactly with:
            1. FountainQRFeedbackDisplay.tsx - feedback generation and display
            2. FountainQRFeedbackScanner.tsx - handleFeedbackScan() validation
            3. checksum.ts - generateFeedbackConfirmationCode()

            Part-complete mode: currentPart, totalParts, partChecksumMatch
            Do NOT include optional fields like computedChecksum */}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="currentPart" className="text-xs">Current Part (Expected)</Label>
            <Input
              id="currentPart"
              type="number"
              min="1"
              value={inputCurrentPart}
              onChange={(e) => setInputCurrentPart(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Defaults to expected part. Verify with receiver's display.
            </p>
          </div>
          <div>
            <Label htmlFor="totalParts" className="text-xs">Total Parts (Auto)</Label>
            <Input
              id="totalParts"
              type="number"
              value={inputTotalParts}
              readOnly
              className="bg-gray-100"
            />
          </div>
        </div>

        <div>
          <Label className="text-xs">Part Checksum Match</Label>
          <RadioGroup value={inputPartChecksumMatch} onValueChange={(value: 'true' | 'false') => setInputPartChecksumMatch(value)}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="true" id="checksum-yes" />
              <Label htmlFor="checksum-yes" className="text-sm">Yes</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="false" id="checksum-no" />
              <Label htmlFor="checksum-no" className="text-sm">No</Label>
            </div>
          </RadioGroup>
        </div>

        <div>
          <Label htmlFor="confirmationCode" className="text-xs">Confirmation Code *</Label>
          <Input
            id="confirmationCode"
            type="text"
            value={inputConfirmationCode}
            onChange={handleConfirmationCodeChange}
            placeholder="e.g., ABCD-1234"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Copy this code from the receiver's Feedback Details card
          </p>
        </div>

        {validationError && (
          <Alert variant="destructive">
            <AlertDescription>
              <div className="flex items-start gap-2">
                <span className="font-semibold">⚠️ {validationError}</span>
                <button
                  onClick={() => {
                    setValidationError('');
                    if (validationErrorTimeoutRef.current) {
                      clearTimeout(validationErrorTimeoutRef.current);
                      validationErrorTimeoutRef.current = null;
                    }
                  }}
                  className="text-red-600 hover:text-red-800 text-sm font-bold ml-auto"
                >
                  ✕
                </button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        <Alert>
          <AlertDescription>
            📋 Instructions: Copy the essential feedback details exactly as shown in the receiver's "Feedback Details" card below their QR code. Enter the Current Part number exactly as displayed (e.g., if it shows "Part 1", enter 1), Total Parts, Checksum Match (Yes/No), and the Confirmation Code. The confirmation code acts as a checksum to verify all fields are entered correctly. If the code doesn't match, review all fields for typos. After processing, an ACK QR will be generated for the receiver to scan.
          </AlertDescription>
        </Alert>

        <Button
          onClick={handleProcessFeedback}
          disabled={!encoder}
          className="w-full"
        >
          Process Feedback & Generate ACK
        </Button>
      </CardContent>
    </Card>
  );
};
