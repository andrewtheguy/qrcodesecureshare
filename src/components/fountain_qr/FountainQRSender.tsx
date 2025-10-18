/**
 * This is the main SENDER component that orchestrates the entire fountain code
 * transfer process from the sender's perspective. It coordinates between data
 * display, feedback scanning, and acknowledgment generation to efficiently
 * transmit files via fountain-coded QR streams.
 */

import { useState, useEffect, useMemo } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { FountainEncoder } from '@/utils/fountainCode'
import { DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig'
import { FountainQRDataDisplay } from './sender/FountainQRDataDisplay'
import { FountainQRFeedbackScanner } from './sender/FountainQRFeedbackScanner'
import { FountainQRManualFeedbackInput } from './sender/FountainQRManualFeedbackInput'

const DEFAULT_FOUNTAIN_FPS = 20

interface FountainQRSenderProps {
  file: File
  sessionId: number
  feedbackEnabled?: boolean
  checksum: string
  checksumAlg: string
  qrOptions?: {
    errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'
    margin: number
  }
}


export function FountainQRSender({ file, sessionId, feedbackEnabled = true, checksum, checksumAlg, qrOptions = { errorCorrectionLevel: 'L', margin: 1 } }: FountainQRSenderProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [error, setError] = useState<string>('')
  const [receivedBlocks, setReceivedBlocks] = useState<Set<number>>(new Set())
  const [windowInfo, setWindowInfo] = useState<{
    windowEnabled: boolean
    windowStart: number
    windowEnd: number
    windowSize: number
    totalBlocks: number
    isWindowComplete: boolean
    skipBlocksBelow: number
    currentSegment: number
    totalSegments: number
    segmentProgress: number
    segmentSizeBlocks: number
  } | null>(null)
  const [lastWindowExpansion, setLastWindowExpansion] = useState<number | null>(null)
  const [lastDecodedInWindow, setLastDecodedInWindow] = useState<number>(0)
  const [lastStats, setLastStats] = useState<{
    totalDecoded: number
    totalBlocks: number
    windowStart?: number
    windowEnd?: number
    progress?: number
  } | null>(null)
  const [lastProcessedSequence, setLastProcessedSequence] = useState<number>(-1)
  const [lastFeedbackMode, setLastFeedbackMode] = useState<'statistics' | 'targeted' | null>(null)
  const [senderMode, setSenderMode] = useState<'data-display' | 'feedback-scanning' | 'ack-display'>('data-display')
  const [activationToken, setActivationToken] = useState<number>(0)
  const [feedbackInputMode, setFeedbackInputMode] = useState<'camera' | 'manual'>('camera')
  const [senderFps, setSenderFps] = useState<number>(DEFAULT_FOUNTAIN_FPS)
  const [ackPayload, setAckPayload] = useState<{ qrUrl: string; sequence: number; message?: string } | null>(null)
  const currentQROptions = useMemo(() => qrOptions, [qrOptions])

  // Initialize fountain encoder when file is loaded
  useEffect(() => {
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer
        const bytes = new Uint8Array(arrayBuffer)

        const metadata = {
          name: file.name,
          size: file.size,
          type: file.type,
          timestamp: Date.now(),
          checksum,
          checksumAlg
        }

        const fountainEncoder = new FountainEncoder(bytes, metadata, {
           blockSize: DEFAULT_BLOCK_SIZE,
           c: 0.2,
           delta: 0.01,
           // Optional: override doping rates here if experimenting
           degree1Rate: 0.08,
           windowEnabled: feedbackEnabled ? undefined : false
          })

         // Runtime sanity check: compare fountainEncoder.getMetadata().blockSize with DEFAULT_BLOCK_SIZE
         const encoderBlockSize = fountainEncoder.getMetadata().blockSize
         if (encoderBlockSize !== DEFAULT_BLOCK_SIZE) {
           setError(`Block size mismatch: encoder has ${encoderBlockSize} bytes, expected ${DEFAULT_BLOCK_SIZE} bytes`)
           console.warn(`Block size mismatch detected: encoder=${encoderBlockSize}, DEFAULT_BLOCK_SIZE=${DEFAULT_BLOCK_SIZE}`)
           return
         }

        setEncoder(fountainEncoder)
        setWindowInfo(fountainEncoder.getWindowInfo())
        setError('')
      } catch (err) {
        setError('Failed to process file')
        console.error(err)
      }
    }

    reader.onerror = () => {
      setError('Failed to read file')
    }

    reader.readAsArrayBuffer(file)
  }, [file])

  // Reset lastProcessedSequence on new session or file to avoid stale UI/state carryover
  useEffect(() => {
      setLastProcessedSequence(-1)
   }, [sessionId, file])





  useEffect(() => {
    if (encoder && senderMode === 'data-display' && activationToken === 0) {
      setActivationToken(1);
    }
  }, [encoder, senderMode, activationToken]);

  useEffect(() => {
    setAckPayload(null)
    setSenderMode('data-display')
  }, [file, sessionId])

  const handleFeedbackProcessed = (feedbackData: {
    sequence: number;
    mode: 'statistics' | 'targeted';
    receivedBlocks?: Set<number>;
    lastStats?: { totalDecoded: number; totalBlocks: number; windowStart?: number; windowEnd?: number; progress?: number };
    windowExpanded: boolean;
    message: string;
  }) => {
    setLastProcessedSequence(feedbackData.sequence);
    setLastFeedbackMode(feedbackData.mode);
    if (feedbackData.mode === 'statistics') {
      setLastStats(feedbackData.lastStats || null);
      setReceivedBlocks(new Set());
    } else if (feedbackData.mode === 'targeted') {
      setReceivedBlocks(feedbackData.receivedBlocks || new Set());
      setLastStats(null);
    }
    console.log('Feedback processed:', feedbackData);
  };

  const handleAckGenerated = (ackUrl: string, sequence: number, message?: string) => {
    setAckPayload({ qrUrl: ackUrl, sequence, message })
    console.log('ACK generated', { sequence, message });
  };

  const handleFeedbackModeChange = (mode: 'data-display' | 'feedback-scanning' | 'ack-display') => {
    // Increment activation token when switching TO data-display mode
    // This ensures the child component only auto-starts on explicit activation
    if (mode === 'data-display') {
      setActivationToken(prev => prev + 1);
    }
    setSenderMode(mode);
    console.log('Mode changed to:', mode);
  };

  const handleFeedbackError = (error: string) => {
    setError(error);
  };

  const handleUpdateWindowInfo = (updatedWindowInfo: {
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
  }) => {
    setWindowInfo(updatedWindowInfo);
  };

  const handleUpdateLastDecodedInWindow = (count: number) => {
    setLastDecodedInWindow(count);
  };

  const handleUpdateLastWindowExpansion = (timestamp: number) => {
    setLastWindowExpansion(timestamp);
  };

  const handleChunkGenerated = () => {
    // Optional: Log chunk generation for debugging
    console.log('Chunk generated')
  }

  const handleSkippedChunk = () => {
    // Optional: Track skipped chunks if needed for parent-level logic
    console.log('Chunk skipped due to size')
  }

  const handleBufferUpdate = (bufferSize: number) => {
    // Optional: Monitor buffer status
    console.log(`Buffer size: ${bufferSize}`)
  }

  const handleDataDisplayError = (error: string) => {
    setError(error)
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const sourceBlocks = encoder?.getMetadata().totalSourceBlocks || 0
  const receivedBlocksCount = receivedBlocks.size
  const decodingProgress = sourceBlocks > 0 ? (receivedBlocksCount / sourceBlocks) * 100 : 0

  return (
    <div className="space-y-4">

      {/* Window Progress Alert */}
      {windowInfo && windowInfo.windowEnabled && (
        <Alert>
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">🪟 Window Progress</p>
              <div className="text-sm">
                <p>Window Range: {windowInfo.skipBlocksBelow}-{windowInfo.windowEnd} of {windowInfo.totalBlocks} blocks</p>
                <p>Window % of file: {((windowInfo.windowEnd / windowInfo.totalBlocks) * 100).toFixed(1)}%</p>
                <p>Segment: {windowInfo.currentSegment} / {windowInfo.totalSegments}</p>
                <p>Segment progress: {windowInfo.segmentProgress.toFixed(1)}%</p>
                {windowInfo.skipBlocksBelow > 0 && (
                  <p className="text-xs text-muted-foreground">Skipping blocks 0-{windowInfo.skipBlocksBelow - 1} (contiguous prefix decoded)</p>
                )}
                <p className="text-xs text-muted-foreground">Session ID: {sessionId}</p>
                {windowInfo.isWindowComplete ? (
                  <p className="text-green-600 dark:text-green-400 font-medium mt-1">
                    ✅ Full file now in transfer window
                  </p>
                ) : (
                  <p className="text-blue-600 dark:text-blue-400 font-medium mt-1">
                    📈 Window will expand automatically as blocks are decoded
                  </p>
                )}
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}


      {/* Receiver Progress Alert */}
      {(lastStats || receivedBlocksCount > 0) && (
        <Alert>
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">📊 Receiver Progress {lastFeedbackMode === 'targeted' ? '(Targeted Mode Active)' : '(Statistics Mode)'}</p>
              <div className="text-sm">
                {receivedBlocksCount === 0 && lastStats ? (
                  <>
                    <p>Overall: {lastStats.totalDecoded} / {lastStats.totalBlocks} blocks ({((lastStats.totalDecoded / lastStats.totalBlocks) * 100).toFixed(1)}%)</p>
                    <p>Receiver reports: {lastStats.progress ?? 'N/A'}% complete</p>
                          {windowInfo?.windowEnabled && lastStats.windowStart != null && lastStats.windowEnd != null && (
                            <p>Current window: blocks {windowInfo.skipBlocksBelow}-{lastStats.windowEnd}</p>
                          )}
                          {windowInfo && windowInfo.skipBlocksBelow > 0 && (
                            <p className="text-xs text-muted-foreground">Skipping blocks 0-{windowInfo.skipBlocksBelow - 1} (contiguous prefix decoded)</p>
                          )}
                          {lastProcessedSequence >= 0 && (
                            <p>Last feedback: sequence {lastProcessedSequence}</p>
                          )}
                          <p className="text-blue-600 dark:text-blue-400 font-medium mt-1">📈 Sending random chunks - targeted encoding will activate when only a few blocks remain</p>
                  </>
                ) : (
                  <>
                    {windowInfo && windowInfo.windowEnabled ? (
                      <>
                        <p>Overall: {receivedBlocksCount} / {sourceBlocks} blocks ({decodingProgress.toFixed(1)}%)</p>
                        <p>Current window: {Array.from(receivedBlocks).filter((blockIdx: number) =>
                          blockIdx >= windowInfo.skipBlocksBelow && blockIdx < windowInfo.windowEnd
                        ).length} / {windowInfo.windowEnd - windowInfo.skipBlocksBelow} blocks</p>
                        {windowInfo && windowInfo.skipBlocksBelow > 0 && (
                          <p className="text-xs text-muted-foreground">Skipping blocks 0-{windowInfo.skipBlocksBelow - 1} (contiguous prefix decoded)</p>
                        )}
                      </>
                    ) : (
                      <p>Decoded {receivedBlocksCount} / {sourceBlocks} blocks ({decodingProgress.toFixed(1)}%)</p>
                    )}
                    {decodingProgress >= 100 ? (
                      <p className="text-green-600 dark:text-green-400 font-medium mt-1">
                        ✅ Transfer complete! You can stop sending.
                      </p>
                    ) : (
                      <p className="text-blue-600 dark:text-blue-400 font-medium mt-1">
                        🎯 Targeted Mode Active - Focusing on {sourceBlocks - receivedBlocksCount} missing blocks
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* No-feedback mode alert */}
      {!feedbackEnabled && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">📱 No-feedback mode: Receiver will not generate feedback QR codes</p>
            <p className="text-sm">Transfer will complete using random chunk generation only. The receiver should continue scanning until 100% complete.</p>
          </AlertDescription>
        </Alert>
      )}

      {/* Active Sender View */}
      {senderMode === 'data-display' && (
        <FountainQRDataDisplay
          encoder={encoder}
          sessionId={sessionId}
          qrOptions={currentQROptions}
          windowInfo={windowInfo}
          receivedBlocks={receivedBlocks}
          lastStats={lastStats}
          isActive={senderMode === 'data-display'}
          activationToken={activationToken}
          onChunkGenerated={handleChunkGenerated}
          onSkippedChunk={handleSkippedChunk}
          onBufferUpdate={handleBufferUpdate}
          onError={handleDataDisplayError}
          fps={senderFps}
          onFpsChange={setSenderFps}
        />
      )}

      {senderMode === 'ack-display' && ackPayload && (
        <div className="flex flex-col items-center space-y-4 p-6 bg-white rounded-lg border border-muted">
          <img src={ackPayload.qrUrl} alt="ACK QR Code" className="max-w-xs" />
          <div className="text-center space-y-1">
            <p className="font-medium">ACK QR Code - Show to receiver</p>
            <p className="text-sm text-muted-foreground">
              Receiver must scan this before resuming data scanning
            </p>
            {ackPayload.message && (
              <p className="text-xs text-muted-foreground">{ackPayload.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2 w-full sm:flex-row">
            <Button onClick={() => handleFeedbackModeChange('data-display')} className="flex-1">
              Resume Data Display
            </Button>
          </div>
        </div>
      )}

      {senderMode === 'feedback-scanning' && (
        <div className="flex justify-center bg-white p-4 rounded-lg border border-dashed">
          <div className="w-[320px] flex flex-col items-center text-center space-y-2 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Feedback scanning active</p>
            <p>Use the controls below to scan the receiver feedback QR code.</p>
            <p>The data QR stream pauses until scanning completes.</p>
          </div>
        </div>
      )}

      {/* Feedback Mode Toggle */}
      {feedbackEnabled && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-lg">Feedback Input Method</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup value={feedbackInputMode} onValueChange={(value: 'camera' | 'manual') => setFeedbackInputMode(value)} className="space-y-4">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="camera" id="camera-mode" />
                <Label htmlFor="camera-mode" className="text-sm font-medium">Camera Scanning</Label>
                <p className="text-xs text-muted-foreground">Scan receiver's feedback QR with camera</p>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="manual" id="manual-mode" />
                <Label htmlFor="manual-mode" className="text-sm font-medium">Manual Input (No Camera)</Label>
                <p className="text-xs text-muted-foreground">Type feedback details manually</p>
              </div>
            </RadioGroup>
          </CardContent>
        </Card>
      )}

      {/* Manual Mode Alert */}
      {feedbackEnabled && feedbackInputMode === 'manual' && (
        <Alert className="mb-4">
          <AlertDescription>
            Manual mode is designed for senders without cameras. Copy the feedback details from the receiver's feedback QR display. All fields must match exactly for successful processing. An ACK QR will be generated after processing.
          </AlertDescription>
        </Alert>
      )}

      {/* Feedback Input Component */}
      {feedbackEnabled && (
        feedbackInputMode === 'camera' ? (
          <FountainQRFeedbackScanner
            encoder={encoder}
            sessionId={sessionId}
            isActive={senderMode === 'feedback-scanning'}
            lastProcessedSequence={lastProcessedSequence}
            windowInfo={windowInfo}
            lastDecodedInWindow={lastDecodedInWindow}
            lastWindowExpansion={lastWindowExpansion}
            onFeedbackProcessed={handleFeedbackProcessed}
            onAckGenerated={handleAckGenerated}
            onModeChange={handleFeedbackModeChange}
            onError={handleFeedbackError}
            onUpdateWindowInfo={handleUpdateWindowInfo}
            onUpdateLastDecodedInWindow={handleUpdateLastDecodedInWindow}
            onUpdateLastWindowExpansion={handleUpdateLastWindowExpansion}
          />
        ) : (
          <FountainQRManualFeedbackInput
            encoder={encoder}
            sessionId={sessionId}
            isActive={true}
            lastProcessedSequence={lastProcessedSequence}
            windowInfo={windowInfo}
            lastDecodedInWindow={lastDecodedInWindow}
            lastWindowExpansion={lastWindowExpansion}
            onFeedbackProcessed={handleFeedbackProcessed}
            onAckGenerated={handleAckGenerated}
            onModeChange={handleFeedbackModeChange}
            onError={handleFeedbackError}
            onUpdateWindowInfo={handleUpdateWindowInfo}
            onUpdateLastDecodedInWindow={handleUpdateLastDecodedInWindow}
            onUpdateLastWindowExpansion={handleUpdateLastWindowExpansion}
            skipTargetedModeForSession={false}
          />
        )
      )}

      {feedbackEnabled && ackPayload && senderMode !== 'ack-display' && (
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => handleFeedbackModeChange('ack-display')}
        >
          Show Last ACK QR
        </Button>
      )}

      {/* Status indicators for non-data-display modes */}
      {senderMode !== 'data-display' && (
        <div className="flex items-center justify-center gap-2 flex-wrap text-xs text-muted-foreground">
          {senderMode === 'feedback-scanning' && (
            <span className="px-2 py-0.5 rounded bg-blue-500 text-white font-semibold">MODE: Scanning Feedback</span>
          )}
          {senderMode === 'ack-display' && (
            <span className="px-2 py-0.5 rounded bg-green-500 text-white font-semibold">MODE: ACK Display - Show to receiver</span>
          )}
        </div>
      )}


      {/* Instructions */}
      <Alert>
        <AlertDescription>
          <p className="font-medium mb-2">📱 Fountain Code Transfer Mode:</p>
          <ol className="list-decimal list-inside space-y-1 text-sm">
            {feedbackEnabled ? (
              <>
                <li>Each chunk combines multiple source blocks via XOR</li>
                <li>Receiver doesn't need ALL chunks - just enough (~110%)</li>
                <li>Can skip/miss chunks and still decode successfully</li>
                <li>Keep playing until receiver shows 100% decoded</li>
                <li>More robust than sequential chunk transfer</li>
                <li>Use 'Scan Feedback QR' button to switch to feedback scanning mode</li>
                <li>After scanning feedback, sender will display ACK QR automatically</li>
                <li>Show ACK QR to receiver, then click 'Resume Data Display' to continue transfer</li>
                <li>If you resume data display accidentally, use 'Show Last ACK QR' button to return to ACK display</li>
                <li>Receiver must scan ACK before resuming data scanning</li>
                <li>If you don't have a camera, use 'Manual Input' mode to type feedback details from the receiver's display</li>
                {windowInfo && windowInfo.windowEnabled && (
                  <li className="text-blue-600 dark:text-blue-400">For large files ({'>'}200KB), transfer uses a sliding window that expands as blocks are decoded</li>
                  )}
                  <li className="text-blue-600 dark:text-blue-400">For most of the transfer, feedback QR contains only statistics (compact)</li>
                  <li className="text-blue-600 dark:text-blue-400">When only a few blocks remain (≤10), feedback includes block details for targeted encoding</li>
                  <li className="text-blue-600 dark:text-blue-400">Feedback QR includes contiguous progress to skip already-decoded blocks</li>
              </>
            ) : (
              <>
                <li>Each chunk combines multiple source blocks via XOR</li>
                <li>Receiver doesn't need ALL chunks - just enough (~110%)</li>
                <li>Can skip/miss chunks and still decode successfully</li>
                <li>Keep scanning until receiver shows 100% decoded</li>
                <li>No feedback scanning needed</li>
              </>
            )}
          </ol>
          {windowInfo && windowInfo.windowEnabled && feedbackEnabled && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-3 pt-3 border-t">
              <span className="font-medium">🪟 Tip:</span> Scan feedback QR periodically to enable automatic window expansion for large files.
            </p>
          )}
        </AlertDescription>
      </Alert>
    </div>
  )
}
