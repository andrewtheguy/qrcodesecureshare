/**
 * This is the main SENDER component that orchestrates the entire fountain code
 * transfer process from the sender's perspective. It coordinates between data
 * display, feedback scanning, and acknowledgment generation to efficiently
 * transmit files via fountain-coded QR streams.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { FountainEncoder, DEFAULT_FOUNTAIN_ENCODER_OPTIONS, type PartBasedModeConfig } from '@/utils/fountainCodeWasm'
import { DEFAULT_BLOCK_SIZE, PART_SIZE_OPTIONS, type PartSizeOption } from '@/utils/fountainConfig'
import { getQRCapacity } from '@/utils/qrCapacity'
import { FountainQRDataDisplay } from './sender/FountainQRDataDisplay'
import { FountainQRFeedbackScanner } from './sender/FountainQRFeedbackScanner'
import { FountainQRManualFeedbackInput } from './sender/FountainQRManualFeedbackInput'

interface FountainQRSenderProps {
  file: File
  sessionId: number
  feedbackEnabled?: boolean
  checksum: string
  checksumAlg: string
  partSizeOption?: PartSizeOption
  qrOptions?: {
    errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'
    margin: number
  }
}


export function FountainQRSender({ file, sessionId, feedbackEnabled = true, checksum, checksumAlg, partSizeOption = 'MEDIUM', qrOptions = { errorCorrectionLevel: 'L', margin: 1 } }: FountainQRSenderProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [error, setError] = useState<string>('')
  const [receivedBlocks, setReceivedBlocks] = useState<Set<number>>(new Set())
  const [lastProcessedSequence, setLastProcessedSequence] = useState<number>(-1)
  const [lastFeedbackMode, setLastFeedbackMode] = useState<'part-complete' | 'targeted' | null>(null)
  const [senderMode, setSenderMode] = useState<'data-display' | 'feedback-scanning' | 'ack-display'>('data-display')
  const [activationToken, setActivationToken] = useState<number>(0)
  const [feedbackInputMode, setFeedbackInputMode] = useState<'camera' | 'manual'>('camera')
  const [ackPayload, setAckPayload] = useState<{ qrUrl: string; sequence: number; message?: string } | null>(null)
  const [autoPauseResetToken, setAutoPauseResetToken] = useState(0)
  const lastSenderModeRef = useRef(senderMode)
  const currentQROptions = useMemo(() => qrOptions, [qrOptions])

  // Calculate max QR data size once - used by both encoder and display component
  const maxQRDataSize = useMemo(() => {
    return getQRCapacity(currentQROptions.errorCorrectionLevel)
  }, [currentQROptions.errorCorrectionLevel])

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
          fileType: file.type,
          timestamp: Date.now(),
          checksum,
          checksumAlg
        }

        // Enable part-based mode for feedback-enabled transfers
        const partSize = feedbackEnabled ? PART_SIZE_OPTIONS[partSizeOption] : 0

        // Part-based mode configuration (session-level settings)
        const partConfig: PartBasedModeConfig = {
          enabled: feedbackEnabled,
          partSize
        }

        // Use default options with maxQrDataSize override for degree tuning
        const encoderOptions = {
          ...DEFAULT_FOUNTAIN_ENCODER_OPTIONS,
          maxQrDataSize: maxQRDataSize // Pass QR capacity to encoder for degree tuning (camelCase)
        }

        const fountainEncoder = await FountainEncoder.create(bytes, metadata, encoderOptions, partConfig)

         // Runtime sanity check: compare fountainEncoder.getMetadata().blockSize with DEFAULT_BLOCK_SIZE
         const encoderBlockSize = fountainEncoder.getMetadata().blockSize
         if (encoderBlockSize !== DEFAULT_BLOCK_SIZE) {
           setError(`Block size mismatch: encoder has ${encoderBlockSize} bytes, expected ${DEFAULT_BLOCK_SIZE} bytes`)
           console.warn(`Block size mismatch detected: encoder=${encoderBlockSize}, DEFAULT_BLOCK_SIZE=${DEFAULT_BLOCK_SIZE}`)
           return
         }

        // Compute part checksums if in part-based mode
        if (feedbackEnabled) {
          console.log('[FountainQRSender] Computing part checksums...')
          await fountainEncoder.computePartChecksums(bytes)
          const partInfo = fountainEncoder.getPartInfo()
          if (partInfo.partBasedMode) {
            console.log('[FountainQRSender] Part checksums computed:', partInfo.partChecksums)
          }
        }

        setEncoder(fountainEncoder)
        setError('')
      } catch (err) {
        // Check for WASM initialization failure
        const errorMessage = err instanceof Error ? err.message : String(err)
        if (errorMessage.includes('WASM_INIT_FAILED')) {
          setError('⚠️ Failed to load WASM module. The fountain code engine could not be initialized. Please refresh the page and try again. If the problem persists, the WASM bundle may not be properly loaded.')
          console.error('[FountainQRSender] WASM initialization failed:', err)
        } else {
          setError('Failed to process file')
          console.error('[FountainQRSender] File processing error:', err)
        }
      }
    }

    reader.onerror = () => {
      setError('Failed to read file')
    }

    reader.readAsArrayBuffer(file)
  }, [file, checksum, checksumAlg, feedbackEnabled, currentQROptions.errorCorrectionLevel, partSizeOption, maxQRDataSize])

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
    if (senderMode === 'data-display' && lastSenderModeRef.current === 'ack-display') {
      setAutoPauseResetToken((token) => token + 1)
    }
    lastSenderModeRef.current = senderMode
  }, [senderMode])

  useEffect(() => {
    setAckPayload(null)
    setSenderMode('data-display')
  }, [file, sessionId])

  const handleFeedbackProcessed = (feedbackData: {
    sequence: number;
    mode: 'part-complete' | 'targeted';
    receivedBlocks?: Set<number>;
    message: string;
  }) => {
    setLastProcessedSequence(feedbackData.sequence);
    setLastFeedbackMode(feedbackData.mode);
    if (feedbackData.mode === 'targeted') {
      setReceivedBlocks(feedbackData.receivedBlocks || new Set());
    } else {
      setReceivedBlocks(new Set());
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

  const handleChunkGenerated = () => {
    // Optional: Log chunk generation for debugging
    //console.log('Chunk generated')
  }


  const handleBufferUpdate = () => {
    // Optional: Monitor buffer status
    //console.log(`Buffer size: ${bufferSize}`)
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


      {/* Receiver Progress Alert */}
      {receivedBlocksCount > 0 && (
        <Alert>
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">📊 Receiver Progress {lastFeedbackMode === 'targeted' ? '(Targeted Mode Active)' : '(Part-Complete Mode)'}</p>
              <div className="text-sm">
                <p>Decoded {receivedBlocksCount} / {sourceBlocks} blocks ({decodingProgress.toFixed(1)}%)</p>
                {decodingProgress >= 100 ? (
                  <p className="text-green-600 dark:text-green-400 font-medium mt-1">
                    ✅ Transfer complete! You can stop sending.
                  </p>
                ) : (
                  <p className="text-blue-600 dark:text-blue-400 font-medium mt-1">
                    🎯 Targeted Mode Active - Focusing on {sourceBlocks - receivedBlocksCount} missing blocks
                  </p>
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
          receivedBlocks={receivedBlocks}
          isActive={senderMode === 'data-display'}
          activationToken={activationToken}
          autoPauseResetToken={autoPauseResetToken}
          onChunkGenerated={handleChunkGenerated}
          onBufferUpdate={handleBufferUpdate}
          onError={handleDataDisplayError}
          maxQRDataSize={maxQRDataSize}
        />
      )}

      {senderMode === 'ack-display' && ackPayload && (
        <Card className="border border-emerald-500/50 bg-emerald-950 text-emerald-100 shadow-2xl">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <Badge
                  variant="outline"
                  className="border-emerald-400/60 bg-emerald-500/10 text-emerald-100 uppercase tracking-wider"
                >
                  Ack Confirmation
                </Badge>
                <CardTitle className="text-xl font-semibold text-emerald-50">Show This QR to the Receiver</CardTitle>
                <p className="text-sm text-emerald-200/70">
                  Hold the code steady while the receiver scans. This confirms their feedback and allows the transfer to continue.
                </p>
              </div>
              <Button
                variant="secondary"
                className="bg-emerald-900 text-emerald-100 border border-emerald-400/60 hover:bg-emerald-800"
                onClick={() => handleFeedbackModeChange('data-display')}
              >
                Resume Data
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-emerald-500/40 bg-black/80 p-6 shadow-inner">
              <div className="absolute inset-3 rounded-2xl border border-emerald-400/50" />
              <img
                src={ackPayload.qrUrl}
                alt="ACK QR Code"
                className="relative z-10 w-full h-auto"
              />
            </div>
            <div className="space-y-3 text-sm">
              <p className="text-center font-medium text-emerald-100">
                Receiver must scan this before you resume broadcasting data.
              </p>
              {ackPayload.message && (
                <Alert className="border border-emerald-500/50 bg-emerald-500/10 text-emerald-100">
                  <AlertDescription>
                    <p className="text-sm font-medium">Message: {ackPayload.message}</p>
                  </AlertDescription>
                </Alert>
              )}
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-100/80 space-y-1">
                <p>• Confirm the receiver sees their scanner banner before proceeding.</p>
                <p>• Once they acknowledge the scan, tap <span className="font-semibold text-emerald-100">Resume Data</span> to restart the stream.</p>
              </div>
              <p className="text-center text-xs text-emerald-200/60">
                Sequence #{ackPayload.sequence} • Session {sessionId}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {senderMode === 'feedback-scanning' && (
        <Alert className="border border-amber-500/40 bg-amber-500/10 text-amber-900">
          <AlertDescription>
            <div className="space-y-1 text-sm">
              <p className="font-medium text-amber-900">Feedback scanning is active.</p>
              <p>Point your camera at the receiver&apos;s amber feedback card to sync progress.</p>
              <p>The data stream is paused until you finish scanning.</p>
            </div>
          </AlertDescription>
        </Alert>
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
            lastProcessedSequence={lastProcessedSequence}
            onFeedbackProcessed={handleFeedbackProcessed}
            onAckGenerated={handleAckGenerated}
            onModeChange={handleFeedbackModeChange}
            onError={handleFeedbackError}
            autoStartScanning={senderMode === 'feedback-scanning'}
          />
        ) : (
          <FountainQRManualFeedbackInput
            encoder={encoder}
            sessionId={sessionId}
            isActive={true}
            lastProcessedSequence={lastProcessedSequence}
            onFeedbackProcessed={handleFeedbackProcessed}
            onAckGenerated={handleAckGenerated}
            onModeChange={handleFeedbackModeChange}
            onError={handleFeedbackError}
          />
        )
      )}

      {feedbackEnabled && ackPayload && senderMode !== 'ack-display' && (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => handleFeedbackModeChange('ack-display')}
        >
          Show Last ACK QR
        </Button>
      )}

      {/* Status indicators for non-data-display modes */}
      {senderMode !== 'data-display' && (
        <div className="flex items-center justify-center gap-2 flex-wrap text-xs text-muted-foreground">
          {senderMode === 'feedback-scanning' && (
            <span className="px-2 py-0.5 rounded bg-amber-500 text-white font-semibold">MODE: Scanning Feedback</span>
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
                <li>More robust than ordered chunk transfer</li>
                <li>Use 'Scan Feedback QR' button to switch to feedback scanning mode</li>
                <li>After scanning feedback, sender will display ACK QR automatically</li>
                <li>Show ACK QR to receiver, then click 'Resume Data Display' to continue transfer</li>
                <li>If you resume data display accidentally, use 'Show Last ACK QR' button to return to ACK display</li>
                <li>Receiver must scan ACK before resuming data scanning</li>
                <li>If you don't have a camera, use 'Manual Input' mode to type feedback details from the receiver's display</li>
                  <li className="text-blue-600 dark:text-blue-400">For part-based transfers, feedback QR signals part completion with checksum validation</li>
                  <li className="text-blue-600 dark:text-blue-400">When only a few blocks remain (≤10), feedback includes block details for targeted encoding</li>
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
        </AlertDescription>
      </Alert>
    </div>
  )
}
