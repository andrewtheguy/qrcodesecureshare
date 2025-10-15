import { useState, useEffect, useRef, useMemo } from 'react'
import QrScanner from 'qr-scanner'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainEncoder, type FountainChunk } from '@/utils/fountainCode'
import type { FountainFeedback, FountainFeedbackTargeted, SenderFeedback } from '@/types/fountainFeedback'
import { DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig'
import { generateNonDataQR } from '@/utils/qrUtils'
import { FountainQRDataDisplay } from './FountainQRDataDisplay'

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
  const [scanningFeedback, setScanningFeedback] = useState(false)
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
  const currentQROptions = useMemo(() => qrOptions, [qrOptions])
  const [senderMode, setSenderMode] = useState<'data-display' | 'feedback-scanning' | 'ack-display'>('data-display')
  const [lastAckQRUrl, setLastAckQRUrl] = useState<string>('')
  const feedbackVideoRef = useRef<HTMLVideoElement>(null)
  const feedbackScannerRef = useRef<QrScanner | null>(null)
  const processingRef = useRef(false)

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
        setLastAckQRUrl('')
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

  // Feedback scanner initialization
  useEffect(() => {
    if (!scanningFeedback || !feedbackVideoRef.current) {
      return
    }

    const scanner = new QrScanner(
      feedbackVideoRef.current,
      (result) => {
        handleFeedbackScan(result.data)
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      }
    )

    feedbackScannerRef.current = scanner
    scanner.start().catch((err) => {
      console.error('Feedback scanner start error:', err)
      setError('Failed to start camera for feedback scanning')
      setScanningFeedback(false)
    })

    return () => {
      scanner.stop()
      scanner.destroy()
    }
  }, [scanningFeedback])


  const generateSenderFeedbackQR = async (feedback: SenderFeedback): Promise<void> => {
    try {
      const dataUrl = await generateNonDataQR(feedback)
      setSenderFeedbackSequence(prev => prev + 1)
      setLastAckQRUrl(dataUrl)
    } catch (err) {
      console.error('ACK QR generation failed:', err)
      setError('Failed to generate ACK QR. Please try scanning feedback again.')
    }
  }

  const handleFeedbackScan = async (data: string) => {
    // Guard against multiple rapid callbacks
    if (processingRef.current) {
      console.warn('Already processing feedback, ignoring duplicate callback')
      return
    }
    processingRef.current = true

    let valid = true
    try {
      const feedback: FountainFeedback = JSON.parse(data)

      // Early validation guard
      if (feedback.type !== 'FOUNTAIN_FEEDBACK' || typeof feedback.sessionId !== 'number' || feedback.sessionId !== sessionId) {
        console.warn(`Invalid feedback: expected type='FOUNTAIN_FEEDBACK' and sessionId=${sessionId}, got type='${feedback.type}' and sessionId=${feedback.sessionId}`)
        valid = false
      }

      const feedbackSequence = feedback.sequence

      // Validate sequence is a number
      if (typeof feedbackSequence !== 'number') {
        console.warn('Invalid feedback: missing or invalid sequence number')
        valid = false
      }

      // Reject duplicate or out-of-order feedback
      if (feedbackSequence <= lastProcessedSequence) {
        console.warn(`Ignoring duplicate/stale feedback: sequence ${feedbackSequence} (last processed: ${lastProcessedSequence})`)
        valid = false
      }

      if (!valid) {
        // cleanup
        feedbackScannerRef.current?.stop()
        setScanningFeedback(false)
        processingRef.current = false
        return
      }

       if (feedback.type === 'FOUNTAIN_FEEDBACK') {
        // Extract firstMissingBlock from feedback (default to 0 if not present)
        const firstMissingBlock = feedback.firstMissingBlock ?? 0

        console.log('Processing feedback sequence:', feedbackSequence, '(last:', lastProcessedSequence, ')')

        // Handle both statistics and targeted feedback modes
        if (feedback.mode === 'statistics') {
          // Statistics-only feedback - no targeted encoding
          console.log('Received statistics feedback:', feedback.totalDecoded, '/', feedback.totalBlocks, 'blocks')
  
  
  
  
          // Clear targeted mode so encoder doesn't use stale missing-blocks information
          if (encoder) {
            encoder.setReceivedBlocks([])
          }
  
          // Apply skip threshold
          if (encoder) {
            encoder.setSkipBlocksBelow(firstMissingBlock)
            setWindowInfo(encoder.getWindowInfo())
            console.log('Skip blocks below:', firstMissingBlock, '(contiguous prefix)')
          }
  
          // Update UI state for progress display
          setReceivedBlocks(new Set()) // Clear targeted mode
          setLastStats({
            totalDecoded: feedback.totalDecoded,
            totalBlocks: feedback.totalBlocks,
            windowStart: feedback.windowStart,
            windowEnd: feedback.windowEnd,
          })
  
          // Check if window expansion is requested
          let windowExpanded = false
          if (encoder && feedback.requestWindowExpansion) {
            const currentWindow = encoder.getWindowInfo()
            if (!currentWindow.isWindowComplete) {
              const now = Date.now()
              if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
                windowExpanded = encoder.expandWindow()
                if (windowExpanded) {
                  setWindowInfo(encoder.getWindowInfo())
                  setLastWindowExpansion(now)
                  console.log('Window expanded based on statistics feedback:', encoder.getWindowInfo())
                }
              }
            }
          }

          // Update estimated chunks based on statistics
          const totalBlocks = encoder?.getMetadata().totalSourceBlocks || 0
          const missingBlocks = totalBlocks - feedback.totalDecoded
          // Note: chunkCount is now managed by subcomponent, so we can't update estimatedChunksNeeded here
          // The subcomponent will handle its own estimates based on the encoder

          // Generate ACK QR
          const ackFeedback: SenderFeedback = {
            type: 'SENDER_FEEDBACK',
            sessionId: sessionId,
            sequence: senderFeedbackSequence,
            command: 'acknowledge',
            acknowledgedSequence: feedbackSequence,
            message: windowExpanded ? `Feedback processed successfully. Window expanded, ${feedback.totalDecoded}/${feedback.totalBlocks} blocks decoded.` : `Feedback processed successfully. ${feedback.totalDecoded}/${feedback.totalBlocks} blocks decoded.`,
            windowExpanded: windowExpanded
          }
          await generateSenderFeedbackQR(ackFeedback)
          setSenderMode('ack-display')
  
          // Update last processed sequence after successful processing
          setLastProcessedSequence(feedbackSequence)
          console.log('Feedback processed - ACK QR generated')
        } else if (feedback.mode === 'targeted') {
            // Targeted feedback with missing block indices
            const missingBlocks = (feedback as FountainFeedbackTargeted).missingBlocks
            console.log('Received targeted feedback:', missingBlocks.length, 'missing blocks')

            let windowExpanded = false

            // Enable targeted encoding with missing blocks
            setReceivedBlocks(new Set()) // Clear received blocks since we're now using missing blocks
            setLastStats(null) // Clear statistics mode
            if (encoder) {
              encoder.setMissingBlocks(missingBlocks)
              encoder.setSkipBlocksBelow(firstMissingBlock)
              setWindowInfo(encoder.getWindowInfo())
              console.log('Skip blocks below:', firstMissingBlock, '/', missingBlocks.length, 'missing')

              // Check for window expansion
              const currentWindow = encoder.getWindowInfo()
              if (!currentWindow.windowEnabled || currentWindow.isWindowComplete) {
                // Skip expansion logic if windowing not enabled or already complete
              } else {
                // Calculate decoded blocks in current window (total - missing in window)
                const missingInWindow = missingBlocks.filter((blockIdx: number) =>
                  blockIdx >= currentWindow.windowStart && blockIdx < currentWindow.windowEnd
                ).length
                const decodedInWindow = currentWindow.windowSize - missingInWindow

                if (decodedInWindow > lastDecodedInWindow) {
                  // Update last decoded count
                  setLastDecodedInWindow(decodedInWindow)

                  // Calculate window decode percentage
                  const windowDecodePercent = decodedInWindow / currentWindow.windowSize

                  // Check expansion trigger (50% threshold)
                  if (windowDecodePercent >= 0.5) {
                    // Check if we haven't expanded too recently (minimum 2 seconds between expansions)
                    const now = Date.now()
                    if (!lastWindowExpansion || now - lastWindowExpansion > 2000) {
                      windowExpanded = encoder.expandWindow()
                      if (windowExpanded) {
                        setWindowInfo(encoder.getWindowInfo())
                        setLastWindowExpansion(now)
                        console.log('Window expanded:', encoder.getWindowInfo())
                      }
                    }
                  }
                }
              }
            }

            // Update estimated chunks needed based on feedback
            const blocksMissing = missingBlocks.length

            // Note: chunkCount and estimatedChunksNeeded are now managed by subcomponent
            // The subcomponent will handle its own estimates based on the encoder and feedback

            // Generate ACK QR
            const ackFeedback: SenderFeedback = {
              type: 'SENDER_FEEDBACK',
              sessionId: sessionId,
              sequence: senderFeedbackSequence,
              command: 'acknowledge',
              acknowledgedSequence: feedbackSequence,
              message: windowExpanded ? `Targeted mode activated. Window expanded, focusing on ${blocksMissing} missing blocks.` : `Targeted mode activated. Focusing on ${blocksMissing} missing blocks.`,
              windowExpanded: windowExpanded
            }
           await generateSenderFeedbackQR(ackFeedback)
           setSenderMode('ack-display')

           // Update last processed sequence after successful processing
           setLastProcessedSequence(feedbackSequence)
           console.log('Feedback processed - ACK QR generated')
        }

        setScanningFeedback(false)

        // Stop the scanner immediately after validation to avoid multiple rapid callbacks
        if (feedbackScannerRef.current) {
          feedbackScannerRef.current.stop()
        }
      }
    } catch (err) {
      console.error('Failed to parse feedback QR:', err)
      valid = false
    } finally {
      if (!valid) {
        // cleanup
        feedbackScannerRef.current?.stop()
        setScanningFeedback(false)
      }
      processingRef.current = false
    }
  }

  const wasPlayingRef = useRef(false)
  const handleStartFeedbackScan = () => {
    wasPlayingRef.current = false // Data display is now handled by subcomponent
    setScanningFeedback(true)
    setSenderMode('feedback-scanning')
    setError('')
  }

  const handleStopFeedbackScan = () => {
    setScanningFeedback(false)
    feedbackScannerRef.current?.stop()
    setSenderMode('data-display')
    // Data display will resume automatically when subcomponent becomes active
  }

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
      {/* Feedback Scanner Mode */}
      {senderMode === 'feedback-scanning' && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium">📷 Scanning for Feedback QR</p>
              <div className="relative bg-black rounded-lg overflow-hidden">
                <video
                  ref={feedbackVideoRef}
                  className="w-full h-auto"
                  style={{ maxHeight: '300px' }}
                />
                <div className="absolute top-2 right-2 bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium">
                  ● SCANNING
                </div>
              </div>
              <p className="text-sm">
                Point camera at the receiver's feedback QR code to see decoding progress.
              </p>
              <Button onClick={handleStopFeedbackScan} variant="outline" className="w-full">
                Cancel Scan
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

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
              <p className="font-medium">📊 Receiver Progress {receivedBlocksCount === 0 ? '(Statistics Mode)' : '(Targeted Mode Active)'}</p>
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
      ) : senderMode === 'feedback-scanning' ? (
        <div className="flex justify-center bg-white p-4 rounded-lg">
          <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
            <p className="text-muted-foreground">Feedback scanning mode active<br/>Scan receiver's feedback QR below</p>
          </div>
        </div>
      ) : senderMode === 'ack-display' && lastAckQRUrl ? (
        <div className="flex justify-center bg-white p-4 rounded-lg">
          <div className="space-y-3">
            <img src={lastAckQRUrl} alt="ACK QR Code" className="max-w-full h-auto" />
            <p className="text-sm text-center font-medium">ACK QR Code - Show to receiver</p>
            <p className="text-xs text-center text-muted-foreground">Receiver must scan this before resuming data scanning</p>
          </div>
        </div>
      ) : (
        <div className="flex justify-center bg-white p-4 rounded-lg">
          <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
            <p className="text-muted-foreground">
              {encoder ? 'Generating fountain-coded QR stream…' : 'Processing file...'}
            </p>
          </div>
        </div>
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

      {/* Controls */}
      <div className="space-y-3">
        <div className="flex gap-2 justify-center">
          <Button
            size="sm"
            onClick={handleStartFeedbackScan}
            disabled={!encoder || senderMode === 'feedback-scanning' || senderMode === 'ack-display'}
            variant={senderMode === 'feedback-scanning' ? 'default' : 'outline'}
          >
            📷 Scan Feedback QR
          </Button>
          {senderMode === 'ack-display' && (
            <Button
              size="sm"
              onClick={() => setSenderMode('data-display')}
              variant="default"
            >
              ▶ Resume Data Display
            </Button>
          )}
          {senderMode === 'data-display' && lastAckQRUrl && (
            <Button
              size="sm"
              onClick={() => setSenderMode('ack-display')}
              variant="outline"
            >
              📊 Show Last ACK QR
            </Button>
          )}
        </div>
      </div>

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
