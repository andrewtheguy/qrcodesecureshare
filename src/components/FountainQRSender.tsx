import { useState, useEffect, useRef, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainEncoder, type FountainChunk } from '@/utils/fountainCode'
import type { FountainFeedback, FountainFeedbackTargeted, SenderFeedback } from '@/types/fountainFeedback'
import { DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig'
import { generateNonDataQR } from '@/utils/qrUtils'
import { FountainQRDataDisplay } from './FountainQRDataDisplay'
import { FountainQRFeedbackScanner } from './FountainQRFeedbackScanner'

interface FountainQRSenderProps {
  file: File
  sessionId: number
  qrOptions?: {
    errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'
    margin: number
  }
}


export function FountainQRSender({ file, sessionId, qrOptions = { errorCorrectionLevel: 'L', margin: 1 } }: FountainQRSenderProps) {
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
  } | null>(null)
  const [lastProcessedSequence, setLastProcessedSequence] = useState<number>(-1)
  const [senderFeedbackSequence, setSenderFeedbackSequence] = useState(0)
  const [lastFeedbackMode, setLastFeedbackMode] = useState<'statistics' | 'targeted' | null>(null)
  const [senderMode, setSenderMode] = useState<'data-display' | 'feedback-scanning' | 'ack-display'>('data-display')
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
          timestamp: Date.now()
        }

        const fountainEncoder = new FountainEncoder(bytes, metadata, {
           blockSize: DEFAULT_BLOCK_SIZE,
           c: 0.2,
               delta: 0.01,
            // Optional: override doping rates here if experimenting
            degree1Rate: 0.08
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





  const handleFeedbackProcessed = (feedbackData: {
    sequence: number;
    mode: 'statistics' | 'targeted';
    receivedBlocks?: Set<number>;
    lastStats?: { totalDecoded: number; totalBlocks: number; windowStart?: number; windowEnd?: number };
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

  const handleAckGenerated = (ackUrl: string, sequence: number) => {
    setSenderFeedbackSequence(sequence + 1);
  };

  const handleFeedbackModeChange = (mode: 'data-display' | 'feedback-scanning' | 'ack-display') => {
    setSenderMode(mode);
    console.log('Mode changed to:', mode);
  };

  const handleFeedbackError = (error: string) => {
    setError(error);
  };

  const handleUpdateWindowInfo = (windowInfo: {
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
    setWindowInfo(windowInfo);
  };

  const handleUpdateLastDecodedInWindow = (count: number) => {
    setLastDecodedInWindow(count);
  };

  const handleUpdateLastWindowExpansion = (timestamp: number) => {
    setLastWindowExpansion(timestamp);
  };

  const handleChunkGenerated = (chunkNum: number, chunk: FountainChunk) => {
    // Optional: Log chunk generation for debugging
    console.log(`Chunk ${chunkNum} generated`)
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
                <p>Window: blocks {windowInfo.windowStart}-{windowInfo.windowEnd} of {windowInfo.totalBlocks} ({((windowInfo.windowSize / windowInfo.totalBlocks) * 100).toFixed(1)}% of file)</p>
                <p>Segment: {windowInfo.currentSegment} / {windowInfo.totalSegments}</p>
                <p>Segment progress: {windowInfo.segmentProgress.toFixed(1)}%</p>
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
                          {windowInfo?.windowEnabled && lastStats.windowStart != null && lastStats.windowEnd != null && (
                            <p>Current window: blocks {lastStats.windowStart}-{lastStats.windowEnd}</p>
                          )}
                          {windowInfo && windowInfo.skipBlocksBelow > 0 && (
                            <p>Skipping blocks 0-{windowInfo.skipBlocksBelow - 1} (contiguous prefix decoded)</p>
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
                          blockIdx >= windowInfo.windowStart && blockIdx < windowInfo.windowEnd
                        ).length} / {windowInfo.windowSize} blocks</p>
                        {windowInfo && windowInfo.skipBlocksBelow > 0 && (
                          <p>Skipping blocks 0-{windowInfo.skipBlocksBelow - 1} (contiguous prefix decoded)</p>
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


      {/* QR Code Display (clean container without overlays) */}
      {senderMode === 'data-display' ? (
        <FountainQRDataDisplay
          encoder={encoder}
          sessionId={sessionId}
          qrOptions={currentQROptions}
          windowInfo={windowInfo}
          receivedBlocks={receivedBlocks}
          lastStats={lastStats}
          isActive={senderMode === 'data-display'}
          onChunkGenerated={handleChunkGenerated}
          onSkippedChunk={handleSkippedChunk}
          onBufferUpdate={handleBufferUpdate}
          onError={handleDataDisplayError}
        />
      ) : (
        <div className="flex justify-center bg-white p-4 rounded-lg">
          <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
            <p className="text-muted-foreground">
              {encoder ? 'Generating fountain-coded QR stream…' : 'Processing file...'}
            </p>
          </div>
        </div>
      )}

      {/* Feedback Scanner Component */}
      <FountainQRFeedbackScanner
        encoder={encoder}
        sessionId={sessionId}
        isActive={senderMode === 'feedback-scanning'}
        lastProcessedSequence={lastProcessedSequence}
        senderFeedbackSequence={senderFeedbackSequence}
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
            {windowInfo && windowInfo.windowEnabled && (
              <li className="text-blue-600 dark:text-blue-400">For large files ({'>'}200KB), transfer uses a sliding window that expands as blocks are decoded</li>
              )}
              <li className="text-blue-600 dark:text-blue-400">For most of the transfer, feedback QR contains only statistics (compact)</li>
              <li className="text-blue-600 dark:text-blue-400">When only a few blocks remain (≤10), feedback includes block details for targeted encoding</li>
              <li className="text-blue-600 dark:text-blue-400">Feedback QR includes contiguous progress to skip already-decoded blocks</li>
          </ol>
          {windowInfo && windowInfo.windowEnabled && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-3 pt-3 border-t">
              <span className="font-medium">🪟 Tip:</span> Scan feedback QR periodically to enable automatic window expansion for large files.
            </p>
          )}
        </AlertDescription>
      </Alert>
    </div>
  )
}
