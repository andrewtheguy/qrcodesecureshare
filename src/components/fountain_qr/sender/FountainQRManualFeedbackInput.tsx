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
import { FountainEncoder } from '@/utils/fountainCode';
import type { FountainFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import { generateFeedbackConfirmationCode, normalizeConfirmationCode } from '@/utils/checksum';

interface ProcessedFeedbackData {
  sequence: number;
  mode: 'part-complete' | 'targeted';
  receivedBlocks?: Set<number>;
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
  skipTargetedModeForSession: boolean;
}

export const FountainQRManualFeedbackInput: React.FC<FountainQRManualFeedbackInputProps> = ({
  encoder,
  sessionId,
  lastProcessedSequence,
  onFeedbackProcessed,
  onAckGenerated,
  onModeChange,
  onError,
  skipTargetedModeForSession,
}) => {
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0);

  // Form field states
  const [inputSessionId] = useState(sessionId.toString());
  const [inputSequence, setInputSequence] = useState((lastProcessedSequence + 1).toString());
  const [inputMode, setInputMode] = useState<'part-complete' | 'targeted'>('part-complete');
  const [inputCurrentPart, setInputCurrentPart] = useState('0');
  const [inputTotalParts, setInputTotalParts] = useState('1');
  const [inputPartChecksumMatch, setInputPartChecksumMatch] = useState<'true' | 'false'>('true');
  const [inputMissingBlocks, setInputMissingBlocks] = useState('');
  const [inputConfirmationCode, setInputConfirmationCode] = useState('');
  const [validationError, setValidationError] = useState('')
  const validationErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Reset sequence on session change
  useEffect(() => {
    setSenderFeedbackSequence(0);
    setInputSequence((lastProcessedSequence + 1).toString());
  }, [sessionId, lastProcessedSequence]);

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
    setInputMode('part-complete');
    setInputCurrentPart('0');
    setInputTotalParts('1');
    setInputPartChecksumMatch('true');
    setInputMissingBlocks('');
    setInputConfirmationCode('');
  }, [lastProcessedSequence]);

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

    let feedback: FountainFeedback;

    if (inputMode === 'part-complete') {
      // SYNC REQUIREMENT: These fields MUST match exactly with:
      // 1. FountainQRFeedbackDisplay.tsx - feedback generation for part-complete mode
      // 2. FountainQRFeedbackScanner.tsx - handleFeedbackScan() validation
      // 3. checksum.ts - generateFeedbackConfirmationCode()
      //
      // Required fields: type, mode, sessionId, sequence, currentPart, totalParts, partChecksumMatch
      // Do NOT include optional fields like computedChecksum

      // Parse and validate currentPart
      const parsedCurrentPart = parseInt(inputCurrentPart);
      if (isNaN(parsedCurrentPart) || parsedCurrentPart < 0) {
        return { valid: false, error: `Invalid current part: Must be a non-negative integer. Current value: ${inputCurrentPart}. Please verify this field from receiver's feedback display.`, feedback: null };
      }

      // Parse and validate totalParts
      const parsedTotalParts = parseInt(inputTotalParts);
      if (isNaN(parsedTotalParts) || parsedTotalParts < 1) {
        return { valid: false, error: `Invalid total parts: Must be at least 1. Current value: ${inputTotalParts}. Please verify this field from receiver's feedback display.`, feedback: null };
      }

      if (parsedCurrentPart >= parsedTotalParts) {
        return { valid: false, error: `Current part (${parsedCurrentPart}) must be less than total parts (${parsedTotalParts}). Please verify these fields.`, feedback: null };
      }

      feedback = {
        type: 'FOUNTAIN_FEEDBACK',
        mode: 'part-complete',
        sessionId: parsedSessionId,
        sequence: parsedSequence,
        currentPart: parsedCurrentPart,
        totalParts: parsedTotalParts,
        partChecksumMatch: inputPartChecksumMatch === 'true',
      };
    } else {
      // SYNC REQUIREMENT: These fields MUST match exactly with:
      // 1. FountainQRFeedbackDisplay.tsx - feedback generation for targeted mode
      // 2. FountainQRFeedbackScanner.tsx - handleFeedbackScan() validation for targeted mode
      // 3. checksum.ts - generateFeedbackConfirmationCode()
      //
      // Required fields: type, mode, sessionId, sequence, currentPart, totalParts, missingBlocks
      // Do NOT include optional fields

      const parsedCurrentPart = parseInt(inputCurrentPart);
      if (isNaN(parsedCurrentPart) || parsedCurrentPart < 0) {
        return { valid: false, error: `Invalid current part: Must be a non-negative integer. Current value: ${inputCurrentPart}. Please verify this field from receiver's feedback display.`, feedback: null };
      }

      const parsedTotalParts = parseInt(inputTotalParts);
      if (isNaN(parsedTotalParts) || parsedTotalParts < 1) {
        return { valid: false, error: `Invalid total parts: Must be at least 1. Current value: ${inputTotalParts}. Please verify this field from receiver's feedback display.`, feedback: null };
      }

      let missingBlocks: number[];
      try {
        missingBlocks = parseMissingBlocks(inputMissingBlocks);
      } catch (error) {
        return { valid: false, error: `Invalid missing blocks format: ${(error as Error).message}. Expected format: comma-separated numbers or ranges (e.g., "1-5, 8, 10-12"). Please verify and correct the input.`, feedback: null };
      }

      feedback = {
        type: 'FOUNTAIN_FEEDBACK',
        mode: 'targeted',
        sessionId: parsedSessionId,
        sequence: parsedSequence,
        currentPart: parsedCurrentPart,
        totalParts: parsedTotalParts,
        missingBlocks,
      };
    }

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
  }, [inputSessionId, inputSequence, inputMode, inputCurrentPart, inputTotalParts, inputPartChecksumMatch, inputMissingBlocks, inputConfirmationCode, sessionId, lastProcessedSequence]);

  const parseMissingBlocks = (input: string): number[] => {
    const trimmedInput = input.trim();
    if (trimmedInput === '') {
      return [];
    }

    const segments = trimmedInput.split(',').map(s => s.trim());
    const blocks: number[] = [];

    for (const segment of segments) {
      if (segment === '') continue; // Skip empty segments
      if (segment.includes('-')) {
        const [start, end] = segment.split('-').map(s => parseInt(s.trim()));
        if (isNaN(start) || isNaN(end) || start > end) {
          throw new Error(`Invalid range: ${segment}`);
        }
        for (let i = start; i <= end; i++) {
          blocks.push(i);
        }
      } else {
        const block = parseInt(segment);
        if (isNaN(block)) {
          throw new Error(`Invalid block number: ${segment}`);
        }
        blocks.push(block);
      }
    }

    const deduplicated = [...new Set(blocks)].sort((a, b) => a - b);
    if (deduplicated.length < blocks.length) {
      throw new Error('Duplicate block indices detected. Please remove duplicates from the input.');
    }
    return deduplicated;
  };

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
    } else if (feedback.mode === 'targeted') {
      const missingBlocks = feedback.missingBlocks || [];
      console.log(`[FountainQRManualFeedbackInput] Processing targeted feedback for part ${feedback.currentPart + 1}/${feedback.totalParts}`);
      console.log(`[FountainQRManualFeedbackInput] Missing blocks: ${missingBlocks.length}`);
      encoder?.setMissingBlocks(missingBlocks);

      // Generate ACK for targeted mode (final cleanup)
      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: feedback.sequence,
        message: `Targeted feedback received. ${missingBlocks.length} blocks still missing. Final cleanup mode.`,
      };

      await generateSenderFeedbackQR(ackFeedback);
      resetInputFields();

      onFeedbackProcessed({
        sequence: feedback.sequence,
        mode: 'targeted',
        receivedBlocks: new Set(),
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
        {skipTargetedModeForSession && (
          <Alert>
            <AlertDescription>
              <p className="font-medium">ℹ️ Targeted Mode Disabled</p>
              <p className="text-sm">Part-complete mode will be used for all feedback this session.</p>
            </AlertDescription>
          </Alert>
        )}
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
            Targeted mode: currentPart, totalParts, missingBlocks
            Do NOT include optional fields like computedChecksum */}

        <div>
          <Label className="text-xs">Feedback Mode</Label>
          <RadioGroup value={inputMode} onValueChange={(value: 'part-complete' | 'targeted') => setInputMode(value)}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="part-complete" id="part-complete" />
              <Label htmlFor="part-complete" className="text-sm">Part Complete</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="targeted" id="targeted" />
              <Label htmlFor="targeted" className="text-sm">Targeted</Label>
            </div>
          </RadioGroup>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="currentPart" className="text-xs">Current Part (0-indexed)</Label>
            <Input
              id="currentPart"
              type="number"
              min="0"
              value={inputCurrentPart}
              onChange={(e) => setInputCurrentPart(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="totalParts" className="text-xs">Total Parts</Label>
            <Input
              id="totalParts"
              type="number"
              min="1"
              value={inputTotalParts}
              onChange={(e) => setInputTotalParts(e.target.value)}
            />
          </div>
        </div>

        {inputMode === 'part-complete' && (
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
        )}

        {inputMode === 'targeted' && (
          <div>
            <Label htmlFor="missingBlocks" className="text-xs">Missing Blocks</Label>
            <Input
              id="missingBlocks"
              type="text"
              value={inputMissingBlocks}
              onChange={(e) => setInputMissingBlocks(e.target.value)}
              placeholder="e.g., 1-5, 8, 10-12 or 1,2,3,4,5"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Enter comma-separated block indices or ranges
            </p>
          </div>
        )}

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
            📋 Instructions: Copy the essential feedback details exactly as shown in the receiver's "Feedback Details" card below their QR code. Enter Current Part, Total Parts, and the Confirmation Code. For part-complete mode, also enter Checksum Match (Yes/No). For targeted mode, enter the Missing Blocks. The confirmation code acts as a checksum to verify all fields are entered correctly. If the code doesn't match, review all fields for typos. After processing, an ACK QR will be generated for the receiver to scan.
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
