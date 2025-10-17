import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { FountainEncoder } from '@/utils/fountainCode';
import type { FountainFeedback, SenderFeedbackAcknowledge } from '@/types/fountainFeedback';
import { generateNonDataQR } from '@/utils/qrUtils';
import { generateFeedbackConfirmationCode, normalizeConfirmationCode } from '@/utils/checksum';

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
  lastStats?: { totalDecoded: number; totalBlocks: number; windowStart?: number; windowEnd?: number; progress?: number };
  windowExpanded: boolean;
  message: string;
}

interface FountainQRManualFeedbackInputProps {
  encoder: FountainEncoder | null;
  sessionId: number;
  isActive?: boolean;
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
  skipTargetedModeForSession: boolean;
}

export const FountainQRManualFeedbackInput: React.FC<FountainQRManualFeedbackInputProps> = ({
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
  skipTargetedModeForSession,
}) => {
  const [currentMode, setCurrentMode] = useState<'idle' | 'ack-display'>('idle');
  const [ackQRUrl, setAckQRUrl] = useState('');
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0);

  // Form field states
  const [inputSessionId] = useState(sessionId.toString());
  const [inputSequence, setInputSequence] = useState((lastProcessedSequence + 1).toString());
  const [inputMode, setInputMode] = useState<'statistics' | 'targeted'>('statistics');
  const [inputFirstMissingBlock, setInputFirstMissingBlock] = useState('0');
  const [inputProgress, setInputProgress] = useState('');
  const [inputRequestExpansion, setInputRequestExpansion] = useState(false);
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
    setInputMode('statistics');
    setInputFirstMissingBlock('0');
    setInputProgress('');
    setInputRequestExpansion(false);
    setInputMissingBlocks('');
    setInputConfirmationCode('');
  }, [lastProcessedSequence]);

  const validateInputs = useCallback((): { valid: boolean; error: string; feedback: FountainFeedback | null } => {
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

    // Parse and validate firstMissingBlock
    const parsedFirstMissingBlock = parseInt(inputFirstMissingBlock);
    if (isNaN(parsedFirstMissingBlock) || parsedFirstMissingBlock < 0) {
      return { valid: false, error: `Invalid first missing block: Must be a non-negative integer. Current value: ${inputFirstMissingBlock}. Please verify this field from receiver's feedback display.`, feedback: null };
    }

    // Parse and validate progress
    const parsedProgress = parseInt(inputProgress);
    if (isNaN(parsedProgress) || parsedProgress < 0 || parsedProgress > 100) {
      return { valid: false, error: `Invalid progress: Must be an integer between 0 and 100. Current value: ${inputProgress}. Please verify this field from receiver's feedback display.`, feedback: null };
    }

    // Validate confirmation code
    if (!inputConfirmationCode.trim()) {
      return { valid: false, error: 'Confirmation code required: Please enter the confirmation code shown in receiver\'s Feedback Details card to verify input accuracy.', feedback: null };
    }

    let feedback: FountainFeedback;

    if (inputMode === 'statistics') {
      feedback = {
        type: 'FOUNTAIN_FEEDBACK',
        mode: 'statistics',
        sessionId: parsedSessionId,
        sequence: parsedSequence,
        firstMissingBlock: parsedFirstMissingBlock,
        progress: parsedProgress,
        requestWindowExpansion: inputRequestExpansion,
      };
    } else {
      // Targeted mode
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
        firstMissingBlock: parsedFirstMissingBlock,
        progress: parsedProgress,
        missingBlocks,
      };
    }

    // Validate confirmation code against expected value
    const expectedCode = generateFeedbackConfirmationCode(feedback);
    const normalizedInput = normalizeConfirmationCode(inputConfirmationCode);
    const normalizedExpected = normalizeConfirmationCode(expectedCode);

    if (normalizedInput !== normalizedExpected) {
      return {
        valid: false,
        error: `Confirmation code mismatch: The code you entered doesn't match the expected value for this feedback. This indicates a typo in one or more fields. Please double-check all fields (Session ID, Sequence, First Missing Block, Mode, and mode-specific fields) and try again. Expected: ${expectedCode}, Got: ${inputConfirmationCode}`,
        feedback: null
      };
    }

    return { valid: true, error: '', feedback };
  }, [inputSessionId, inputSequence, inputMode, inputFirstMissingBlock, inputProgress, inputRequestExpansion, inputMissingBlocks, inputConfirmationCode, sessionId, lastProcessedSequence]);

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

  const handleProcessFeedback = useCallback(async () => {
    const { valid, error, feedback } = validateInputs();
    if (!valid || !feedback) {
      showValidationError(error);
      return;
    }

    // Clear any existing validation error
    setValidationError('');
    const firstMissingBlock = feedback.firstMissingBlock || 0;

    if (feedback.mode === 'statistics') {
      encoder?.setReceivedBlocks([]);
      encoder?.setSkipBlocksBelow(firstMissingBlock);

      const updatedWindowInfo = encoder?.getWindowInfo();
      if (updatedWindowInfo) {
        onUpdateWindowInfo(updatedWindowInfo);
      }

      const lastStats = {
        totalDecoded: feedback.totalDecoded ?? 0,
        totalBlocks: feedback.totalBlocks ?? updatedWindowInfo?.totalBlocks ?? 0,
        windowStart: updatedWindowInfo?.windowStart,
        windowEnd: updatedWindowInfo?.windowEnd,
        progress: feedback.progress,
      };

      let windowExpanded = false;
      if (feedback.requestWindowExpansion && windowInfo && !windowInfo.isWindowComplete) {
        const now = Date.now();
        if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
          encoder?.expandWindow();
          windowExpanded = true;
          const newWindowInfo = encoder?.getWindowInfo();
          if (newWindowInfo) {
            onUpdateWindowInfo(newWindowInfo);
          }
          onUpdateLastWindowExpansion(now);
        }
      }

      const ackFeedback: SenderFeedbackAcknowledge = {
        type: 'SENDER_FEEDBACK',
        sessionId,
        sequence: senderFeedbackSequence,
        command: 'acknowledge',
        acknowledgedSequence: feedback.sequence,
        message: `Statistics received. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`,
        windowExpanded,
      };

      await generateSenderFeedbackQR(ackFeedback);
      resetInputFields(); // Add this line
      setCurrentMode('ack-display');

      onFeedbackProcessed({
        sequence: feedback.sequence,
        mode: 'statistics',
        lastStats,
        windowExpanded,
        message: ackFeedback.message,
      });

      onModeChange('ack-display');
    } else if (feedback.mode === 'targeted') {
      const missingBlocks = feedback.missingBlocks || [];
      encoder?.setMissingBlocks(missingBlocks);
      encoder?.setSkipBlocksBelow(firstMissingBlock);

      const updatedWindowInfo = encoder?.getWindowInfo();
      if (updatedWindowInfo) {
        onUpdateWindowInfo(updatedWindowInfo);
      }

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
        acknowledgedSequence: feedback.sequence,
        message: `Targeted feedback received. ${missingBlocks.length} blocks still missing. Window ${windowExpanded ? 'expanded' : 'unchanged'}.`,
        windowExpanded,
      };

      await generateSenderFeedbackQR(ackFeedback);
      resetInputFields(); // Add this line
      setCurrentMode('ack-display');

      onFeedbackProcessed({
        sequence: feedback.sequence,
        mode: 'targeted',
        receivedBlocks: new Set(),
        windowExpanded,
        message: ackFeedback.message,
      });

      onModeChange('ack-display');
    }
  }, [validateInputs, encoder, sessionId, senderFeedbackSequence, windowInfo, lastDecodedInWindow, lastWindowExpansion, onFeedbackProcessed, onAckGenerated, onModeChange, onUpdateWindowInfo, onUpdateLastDecodedInWindow, onUpdateLastWindowExpansion, resetInputFields]);

  const generateSenderFeedbackQR = useCallback(async (feedback: SenderFeedbackAcknowledge) => {
    try {
      const dataUrl = await generateNonDataQR(feedback);
      setAckQRUrl(dataUrl);
      setSenderFeedbackSequence(prev => prev + 1);
      onAckGenerated(dataUrl, feedback.sequence);
    } catch (error) {
      console.error('Failed to generate ACK QR:', error);
      onError('Failed to generate acknowledgment QR code');
    }
  }, [onAckGenerated, onError]);

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

  const handleResumeDataDisplay = useCallback(() => {
    setCurrentMode('idle');
    onModeChange('data-display');
  }, [onModeChange]);

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
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <CardTitle>Manual Feedback Input</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {skipTargetedModeForSession && (
          <Alert>
            <AlertDescription>
              <p className="font-medium">ℹ️ Targeted Mode Disabled</p>
              <p className="text-sm">Statistics mode will be used for all feedback this session.</p>
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

        <div>
          <Label className="text-xs">Feedback Mode</Label>
          <RadioGroup value={inputMode} onValueChange={(value: 'statistics' | 'targeted') => setInputMode(value)}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="statistics" id="statistics" />
              <Label htmlFor="statistics" className="text-sm">Statistics</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="targeted" id="targeted" />
              <Label htmlFor="targeted" className="text-sm">Targeted</Label>
            </div>
          </RadioGroup>
        </div>

        <div>
          <Label htmlFor="firstMissingBlock" className="text-xs">First Missing Block</Label>
          <Input
            id="firstMissingBlock"
            type="number"
            value={inputFirstMissingBlock}
            onChange={(e) => setInputFirstMissingBlock(e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="progress" className="text-xs">Progress (%)</Label>
          <Input
            id="progress"
            type="number"
            min="0"
            max="100"
            value={inputProgress}
            onChange={(e) => setInputProgress(e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Overall file decode progress (0-100)
          </p>
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

         {inputMode === 'statistics' && (
           <div className="flex items-center space-x-2">
             <Checkbox
               id="requestExpansion"
               checked={inputRequestExpansion}
               onCheckedChange={(checked) => setInputRequestExpansion(checked as boolean)}
             />
             <Label htmlFor="requestExpansion" className="text-sm">Request Window Expansion</Label>
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
            📋 Instructions: Copy the essential feedback details exactly as shown in the receiver's "Feedback Details" card below their QR code. All required fields (Session ID, Sequence, First Missing Block, Progress, and mode-specific fields) must be entered. Double-check each field before processing. The confirmation code acts as a checksum to verify all fields are entered correctly. If the code doesn't match, review all fields for typos. After processing, an ACK QR will be generated for the receiver to scan.
          </AlertDescription>
        </Alert>

        <Button
          onClick={handleProcessFeedback}
          disabled={!encoder}
          className="w-full"
        >
          Process Feedback & Generate ACK
        </Button>

        {ackQRUrl && (
          <Button
            onClick={() => {
              setCurrentMode('ack-display');
              onModeChange('ack-display');
            }}
            variant="outline"
            className="w-full"
          >
            Show Last ACK QR
          </Button>
        )}
      </CardContent>
    </Card>
  );
};