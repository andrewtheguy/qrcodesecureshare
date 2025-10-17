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
}) => {
  const [currentMode, setCurrentMode] = useState<'idle' | 'ack-display'>('idle');
  const [ackQRUrl, setAckQRUrl] = useState('');
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0);

  // Form field states
  const [inputSessionId, setInputSessionId] = useState(sessionId.toString());
  const [inputSequence, setInputSequence] = useState('');
  const [inputMode, setInputMode] = useState<'statistics' | 'targeted'>('statistics');
  const [inputFirstMissingBlock, setInputFirstMissingBlock] = useState('0');
  const [inputWindowStart, setInputWindowStart] = useState('');
  const [inputWindowEnd, setInputWindowEnd] = useState('');
  const [inputTotalDecoded, setInputTotalDecoded] = useState('');
  const [inputTotalBlocks, setInputTotalBlocks] = useState('');
  const [inputProgress, setInputProgress] = useState('');
  const [inputDecodedInWindow, setInputDecodedInWindow] = useState('');
  const [inputRequestExpansion, setInputRequestExpansion] = useState(false);
  const [inputMissingBlocks, setInputMissingBlocks] = useState('');
  const [validationError, setValidationError] = useState('')
  const validationErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Reset sequence on session change
  useEffect(() => {
    setSenderFeedbackSequence(0);
  }, [sessionId]);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (validationErrorTimeoutRef.current) {
        clearTimeout(validationErrorTimeoutRef.current);
      }
    };
  }, []);

  // Pre-fill form fields when windowInfo changes
  useEffect(() => {
    if (windowInfo) {
      setInputWindowStart(windowInfo.windowStart.toString());
      setInputWindowEnd(windowInfo.windowEnd.toString());
      setInputTotalBlocks(windowInfo.totalBlocks.toString());
    }
  }, [windowInfo]);

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

    // Parse and validate totals first (needed for bounds checking)
    const parsedTotalDecoded = parseInt(inputTotalDecoded);
    const parsedTotalBlocks = parseInt(inputTotalBlocks);
    if (isNaN(parsedTotalDecoded) || isNaN(parsedTotalBlocks) || parsedTotalDecoded < 0 || parsedTotalBlocks <= 0) {
      return { valid: false, error: `Invalid totals: Total decoded (${parsedTotalDecoded}) and total blocks (${parsedTotalBlocks}) must be positive integers. Please verify these values from receiver's feedback display.`, feedback: null };
    }

    // Validate firstMissingBlock bounds
    if (parsedFirstMissingBlock > parsedTotalBlocks) {
      return { valid: false, error: `Invalid first missing block: Must be within range [0, ${parsedTotalBlocks}]. Current value: ${parsedFirstMissingBlock}. Please verify this field from receiver's feedback display.`, feedback: null };
    }

    // Validate that totalDecoded does not exceed totalBlocks
    if (parsedTotalDecoded > parsedTotalBlocks) {
      return { valid: false, error: `Total decoded (${parsedTotalDecoded}) cannot exceed total blocks (${parsedTotalBlocks}). Please verify these values from receiver's feedback display.`, feedback: null };
    }

    // Parse and validate window bounds
    const parsedWindowStart = parseInt(inputWindowStart);
    const parsedWindowEnd = parseInt(inputWindowEnd);
    if (isNaN(parsedWindowStart) || isNaN(parsedWindowEnd) || parsedWindowStart >= parsedWindowEnd) {
      return { valid: false, error: `Invalid window range: Window start (${parsedWindowStart}) must be less than window end (${parsedWindowEnd}). Please verify these values from receiver's feedback display and try again.`, feedback: null };
    }

    // Add bounds checking
    if (parsedWindowStart < 0 || parsedWindowEnd > parsedTotalBlocks) {
      return { valid: false, error: `Window bounds invalid: Window start must be >= 0 and window end must be <= total blocks (${parsedTotalBlocks}). Current range: ${parsedWindowStart} to ${parsedWindowEnd}. Please verify these values.`, feedback: null };
    }

    // Parse and validate progress
    const parsedProgress = parseFloat(inputProgress);
    if (isNaN(parsedProgress) || parsedProgress < 0 || parsedProgress > 100) {
      return { valid: false, error: `Invalid progress: Must be between 0 and 100. Current value: ${parsedProgress}. Please verify this field from receiver's feedback display.`, feedback: null };
    }

    let feedback: FountainFeedback;

    if (inputMode === 'statistics') {
      const parsedDecodedInWindow = parseInt(inputDecodedInWindow);
      if (isNaN(parsedDecodedInWindow) || parsedDecodedInWindow < 0) {
        return { valid: false, error: `Invalid decoded in window: Must be a non-negative integer. Current value: ${inputDecodedInWindow}. Please verify this field from receiver's feedback display.`, feedback: null };
      }

      feedback = {
        type: 'FOUNTAIN_FEEDBACK',
        mode: 'statistics',
        sessionId: parsedSessionId,
        sequence: parsedSequence,
        totalBlocks: parsedTotalBlocks,
        windowStart: parsedWindowStart,
        windowEnd: parsedWindowEnd,
        progress: parsedProgress,
        firstMissingBlock: parsedFirstMissingBlock,
        decodedInWindow: parsedDecodedInWindow,
        totalDecoded: parsedTotalDecoded,
        requestWindowExpansion: inputRequestExpansion,
      };
    } else {
      // Targeted mode
      if (inputMissingBlocks.trim() === '') {
        return { valid: false, error: 'Missing blocks required: In targeted mode, you must enter the missing blocks from receiver\'s feedback display. Please copy the missing blocks value and try again.', feedback: null };
      }
      let missingBlocks: number[];
      try {
        missingBlocks = parseMissingBlocks(inputMissingBlocks);
      } catch (error) {
        return { valid: false, error: `Invalid missing blocks format: ${(error as Error).message}. Expected format: comma-separated numbers or ranges (e.g., "1-5, 8, 10-12"). Please verify and correct the input.`, feedback: null };
      }
      if (missingBlocks.some(block => block < 0 || block >= parsedTotalBlocks)) {
        return { valid: false, error: `Invalid missing blocks: All block indices must be between 0 and ${parsedTotalBlocks - 1}. Found invalid blocks: ${missingBlocks.filter(b => b < 0 || b >= parsedTotalBlocks).join(', ')}. Please verify the missing blocks from receiver's feedback display.`, feedback: null };
      }

      // Add consistency check
      const expectedTotalDecoded = parsedTotalBlocks - missingBlocks.length;
      if (expectedTotalDecoded !== parsedTotalDecoded) {
        return { valid: false, error: `Warning: Total decoded (${parsedTotalDecoded}) doesn't match calculated value (${expectedTotalDecoded}) based on missing blocks. This may indicate a data entry error. Please verify all fields.`, feedback: null };
      }

      feedback = {
        type: 'FOUNTAIN_FEEDBACK',
        mode: 'targeted',
        sessionId: parsedSessionId,
        sequence: parsedSequence,
        totalBlocks: parsedTotalBlocks,
        windowStart: parsedWindowStart,
        windowEnd: parsedWindowEnd,
        progress: parsedProgress,
        firstMissingBlock: parsedFirstMissingBlock,
        missingBlocks,
      };
    }

    return { valid: true, error: '', feedback };
  }, [inputSessionId, inputSequence, inputMode, inputFirstMissingBlock, inputWindowStart, inputWindowEnd, inputTotalDecoded, inputTotalBlocks, inputProgress, inputDecodedInWindow, inputRequestExpansion, inputMissingBlocks, sessionId, lastProcessedSequence]);

  const parseMissingBlocks = (input: string): number[] => {
    const segments = input.split(',').map(s => s.trim());
    const blocks: number[] = [];

    for (const segment of segments) {
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
        totalDecoded: feedback.totalDecoded,
        totalBlocks: feedback.totalBlocks,
        windowStart: updatedWindowInfo?.windowStart,
        windowEnd: updatedWindowInfo?.windowEnd,
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
  }, [validateInputs, encoder, sessionId, senderFeedbackSequence, windowInfo, lastDecodedInWindow, lastWindowExpansion, onFeedbackProcessed, onAckGenerated, onModeChange, onUpdateWindowInfo, onUpdateLastDecodedInWindow, onUpdateLastWindowExpansion]);

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
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="sessionId" className="text-xs">Session ID</Label>
            <Input
              id="sessionId"
              type="number"
              value={inputSessionId}
              onChange={(e) => setInputSessionId(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="sequence" className="text-xs">Feedback Sequence</Label>
            <Input
              id="sequence"
              type="number"
              value={inputSequence}
              onChange={(e) => setInputSequence(e.target.value)}
              placeholder="Must be > last processed"
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

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="windowStart" className="text-xs">Window Start</Label>
            <Input
              id="windowStart"
              type="number"
              value={inputWindowStart}
              onChange={(e) => setInputWindowStart(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="windowEnd" className="text-xs">Window End</Label>
            <Input
              id="windowEnd"
              type="number"
              value={inputWindowEnd}
              onChange={(e) => setInputWindowEnd(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="totalDecoded" className="text-xs">Total Decoded Blocks</Label>
            <Input
              id="totalDecoded"
              type="number"
              value={inputTotalDecoded}
              onChange={(e) => setInputTotalDecoded(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="totalBlocks" className="text-xs">Total Blocks</Label>
            <Input
              id="totalBlocks"
              type="number"
              value={inputTotalBlocks}
              onChange={(e) => setInputTotalBlocks(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="progress" className="text-xs">Progress (%)</Label>
          <Input
            id="progress"
            type="number"
            step="0.1"
            value={inputProgress}
            onChange={(e) => setInputProgress(e.target.value)}
          />
        </div>

        {inputMode === 'statistics' && (
          <>
            <div>
              <Label htmlFor="decodedInWindow" className="text-xs">Decoded in Window</Label>
              <Input
                id="decodedInWindow"
                type="number"
                value={inputDecodedInWindow}
                onChange={(e) => setInputDecodedInWindow(e.target.value)}
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="requestExpansion"
                checked={inputRequestExpansion}
                onCheckedChange={(checked) => setInputRequestExpansion(checked as boolean)}
              />
              <Label htmlFor="requestExpansion" className="text-sm">Request Window Expansion</Label>
            </div>
          </>
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
            📋 Instructions: Copy all feedback details exactly as shown in the receiver's "Feedback Details" card below their QR code. Double-check each field before processing. After processing, an ACK QR will be generated for the receiver to scan.
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