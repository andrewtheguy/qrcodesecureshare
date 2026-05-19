/**
 * This component is responsible for the RECEIVER's side of the Fountain Code transfer.
 * It uses the device's camera to scan QR codes containing fountain-coded chunks sent
 * by the sender. The component processes these chunks in a web worker to decode the
 * original file, even if some chunks are missed or arrive out of order.
 *
 */

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { FountainMetadata } from '@/utils/fountainCodeWasm'
import { useRxingQRScanner } from '@/hooks/useRxingQRScanner'

// Grid layout constants
const GRID_COLUMNS = 20
const GRID_MAX_ROWS = 12
const GRID_MAX_RECTANGLES = GRID_COLUMNS * GRID_MAX_ROWS

interface FountainQRDataScannerProps {
  fountainMetadata: FountainMetadata
  workerRef: React.RefObject<Worker | null>
  messageIdCounterRef: React.RefObject<number>
  isScanning: boolean
  receiverMode: 'data-scanning' | 'feedback-display' | 'ack-scanning'
  isAwaitingFeedback: boolean
  success: boolean
  decodedBlocks: number
  invalidChecksumCount: number
  senderFeedbackMessage: string
  receivedFountainChunks: number
  currentPartChunkCount: number
  decodedBlockIndices?: number[]
  currentPartIndex?: number
  totalParts?: number
  currentPartDecodedBlocks?: number
  currentPartTotalBlocks?: number
  onChunkScanned: (seed: number) => void
  onScanError: (error: string) => void
  onScanStart: () => void
  onScanStop: () => void
  onToggleMetadataInfo: (show: boolean) => void
  onModeChange: (mode: 'data-scanning' | 'feedback-display' | 'ack-scanning') => void;
  onAckTransitionStatus: (successful: boolean) => void;
}

export function FountainQRDataScanner({
  fountainMetadata,
  workerRef,
  messageIdCounterRef,
  isScanning,
  receiverMode,
  isAwaitingFeedback,
  success,
  decodedBlocks,
  invalidChecksumCount,
  senderFeedbackMessage,
  receivedFountainChunks,
  currentPartChunkCount,
  decodedBlockIndices = [],
  currentPartIndex = 0,
  totalParts = 1,
  currentPartDecodedBlocks = 0,
  currentPartTotalBlocks = 0,
  onChunkScanned,
  onScanError,
  onScanStart,
  onScanStop,
  onToggleMetadataInfo,
  onModeChange,
  onAckTransitionStatus
}: FountainQRDataScannerProps) {
  const [showMetadataInfo, setShowMetadataInfo] = useState(false)
  const [error, setError] = useState<string>('')
  const [hasAutoStarted, setHasAutoStarted] = useState(false)

  const addDebugLog = useCallback((message: string) => {
    console.log(`[FountainQRDataScanner] ${message}`)
  }, [])

  useEffect(() => {
    console.log(
      `[FountainQRDataScanner] Initialized with metadata: ${fountainMetadata.name} (${fountainMetadata.totalSourceBlocks} blocks, ${fountainMetadata.blockSize} bytes/block)`
    )
  }, [fountainMetadata.name, fountainMetadata.totalSourceBlocks, fountainMetadata.blockSize])

  const handleBinaryFountainChunk = useCallback(async (bytes: Uint8Array) => {
    // Parse seed from bytes (big-endian from bytes[2] and bytes[3])
    const seed = (bytes[2] << 8) | bytes[3]

    // Send binary data to worker for processing
    workerRef.current?.postMessage({ type: 'processChunk', id: messageIdCounterRef.current++, binaryData: bytes }, [bytes.buffer])

    // Note: Counter is now incremented in parent's worker message handler
    // to ensure we only count non-duplicate chunks

    addDebugLog('📤 Sent chunk to worker for processing')

    // Invoke callback with parsed seed
    onChunkScanned(seed)
  }, [addDebugLog, onChunkScanned, workerRef, messageIdCounterRef])

  const handleScan = useCallback((qrCodes: Uint8Array[]) => {
    if (qrCodes.length === 0) return

    const bytes = qrCodes[0]
    try {
      addDebugLog(`Scanned chunk, length: ${bytes.length} bytes`)

      if (receiverMode === 'ack-scanning') {
        console.log('[DIAGNOSTIC] Early return: already in ack-scanning mode')
        return
      }

      // Try to check if it is JSON first by checking if it starts with ASCII '{' (0x7B)
      // (sender feedback QR codes are JSON)
      if (bytes[0] === 0x7B) { // '{' character
        try {
          // Convert bytes to string for JSON parsing
          const jsonString = new TextDecoder().decode(bytes)
          const json = JSON.parse(jsonString)
          if (json.type === 'FOUNTAIN_FEEDBACK') {
            addDebugLog('📥 Detected FOUNTAIN_FEEDBACK QR, switching to feedback-display mode')
            console.log('[DIAGNOSTIC] Switching to feedback-display mode')
            onModeChange('feedback-display')
            return
          } else if (json.type === 'SENDER_FEEDBACK') {
            addDebugLog('📥 Detected SENDER_FEEDBACK QR, skipping since we are not in feedback mode')
            return
          }
        } catch {
          // If JSON parsing fails, just ignore
          addDebugLog('⚠ Ignoring non-feedback JSON QR content')
        }
        return
      }

      // Expect only fountain data chunks now; metadata is JSON and handled by parent before this component mounts
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFD) {
        addDebugLog('🔁 Processing fountain chunk')
        handleBinaryFountainChunk(bytes)
      } else {
        addDebugLog('⚠ Ignoring non-fountain-chunk QR content')
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Error: ${errorMsg}`)
      console.error('Scan error:', err)
    }
  }, [addDebugLog, handleBinaryFountainChunk, receiverMode, onModeChange])

  const handleScanError = useCallback((errorMessage: string) => {
    setError(errorMessage)
    onScanError(errorMessage)
  }, [onScanError])

  // Continuous data scanning is the most battery-critical operation.
  // Use 30 fps (33ms interval) and low-res mode on mobile for better performance.
  const { videoRef, canvasRef } = useRxingQRScanner({
    onScan: handleScan,
    isScanning: receiverMode === 'data-scanning' && isScanning && !isAwaitingFeedback && !success,
    onError: handleScanError,
    onCameraReady: () => {
      addDebugLog('✅ Data scanner started')
      onAckTransitionStatus(true)
    },
    scanInterval: 33, // ~30 fps
    preferLowRes: true, // Use lower resolution on mobile for better performance and battery life
    readerOptions: { tryHarder: false, binarizer: 'global' },
  })

  // Stop scanning when receiverMode changes away from 'data-scanning' or when success becomes true
  useEffect(() => {
    if (receiverMode !== 'data-scanning' || success) {
      addDebugLog(`🛑 Stopping camera due to mode change (mode=${receiverMode}) or success (success=${success})`)
      setHasAutoStarted(false)
    }
  }, [receiverMode, success, addDebugLog])

  const handleStartScan = useCallback(() => {
    setError('')
    setHasAutoStarted(true)
    onScanStart()
  }, [onScanStart])

  const handleStopScan = () => {
    onScanStop()
  }


  useEffect(() => {
    if (receiverMode !== 'data-scanning' || success || isAwaitingFeedback) {
      if (receiverMode !== 'data-scanning' || success) {
        setHasAutoStarted(false)
      }
      return
    }

    if (!isScanning && !hasAutoStarted) {
      handleStartScan()
    }
  }, [receiverMode, success, isAwaitingFeedback, isScanning, hasAutoStarted, handleStartScan])

  // Determine if we're in multi-part mode
  const isMultiPartMode = fountainMetadata.partBasedMode && totalParts > 1

  // Use part-specific values when in multi-part mode, otherwise use total blocks
  const displayDecodedBlocks = isMultiPartMode ? currentPartDecodedBlocks : decodedBlocks
  const displayTotalBlocks = isMultiPartMode ? currentPartTotalBlocks : fountainMetadata.totalSourceBlocks
  const displayChunksScanned = isMultiPartMode ? currentPartChunkCount : receivedFountainChunks
  const progress = displayTotalBlocks > 0 ? (displayDecodedBlocks / displayTotalBlocks) * 100 : 0

  // More accurate estimate based on robust soliton parameters (c=0.2, delta=0.01) + degree doping
  // Formula: k * (1 + c * ln(k/delta) / sqrt(k)) * 1.05 (accounting for degree doping overhead)
  const k = displayTotalBlocks
  const c = 0.2
  const delta = 0.01
  const theoreticalOverhead = c * Math.log(k / delta) / Math.sqrt(k)
  const dopingOverhead = 1.05 // Account for forced low-degree chunks
  const estimatedChunksNeeded = Math.ceil(k * (1 + theoreticalOverhead) * dopingOverhead)

  // Calculate block range for the current part in multi-part mode
  let partStartBlock = 0
  let partEndBlock = fountainMetadata.totalSourceBlocks
  if (isMultiPartMode && fountainMetadata.partSize && fountainMetadata.blockSize) {
    const partStartByte = currentPartIndex * fountainMetadata.partSize
    const partEndByte = Math.min((currentPartIndex + 1) * fountainMetadata.partSize, fountainMetadata.size)
    partStartBlock = Math.floor(partStartByte / fountainMetadata.blockSize)
    partEndBlock = Math.ceil(partEndByte / fountainMetadata.blockSize)
  }

  // Calculate compressed rectangle grid layout
  // In multi-part mode, use the number of blocks in the current part
  const gridBlockCount = isMultiPartMode ? (partEndBlock - partStartBlock) : fountainMetadata.totalSourceBlocks
  const totalRectangles = Math.min(gridBlockCount, GRID_MAX_RECTANGLES)
  const blocksPerRect = Math.ceil(gridBlockCount / totalRectangles)

  // Get color for rectangle based on decoded blocks in range
  function getRectangleColor(decodedInRange: number, totalInRange: number) {
    if (decodedInRange === 0) return 'bg-gray-200 dark:bg-gray-700'
    if (decodedInRange === totalInRange) return 'bg-green-500'
    return 'bg-yellow-500'
  }

  return (
    <div className="space-y-4">
      {/* Video Preview */}
      {receiverMode === 'data-scanning' && (
        <div className="space-y-3">
          <div className="relative mx-auto w-full max-w-xl">
            <div className="pointer-events-none absolute inset-x-6 -top-10 h-40 rounded-full bg-sky-500/20 blur-[48px]" />
            <div className="relative overflow-hidden rounded-3xl border border-sky-500/40 bg-slate-950/90 shadow-[0_45px_80px_-35px_rgba(56,189,248,0.75)] p-4 sm:p-5">
              <div className="relative overflow-hidden rounded-xl bg-black">
                <video
                  ref={videoRef}
                  className="w-full h-auto"
                  style={{ maxHeight: '400px' }}
                  playsInline
                  muted
                />
                <canvas ref={canvasRef} style={{ display: 'none' }} />
                {isScanning && !isAwaitingFeedback && (
                  <div className="absolute top-3 left-3 rounded-full border border-sky-400/60 bg-sky-600/90 px-3 py-1 text-xs font-semibold text-white shadow-lg shadow-sky-500/30 z-20">
                    ● SCANNING
                  </div>
                )}
                {isAwaitingFeedback && (
                  <div className="absolute bottom-3 left-3 right-3 rounded-xl border border-sky-400/20 bg-slate-950/85 px-3 py-3 text-sm text-sky-100 shadow-lg z-20">
                    <p className="text-sm text-center">
                      Awaiting feedback processing. Scanning will resume automatically.
                    </p>
                  </div>
                )}
                {senderFeedbackMessage && senderFeedbackMessage.trim() !== '' && (
                  <div className="absolute top-16 right-3 max-w-xs rounded-xl border border-sky-400/40 bg-sky-600/80 px-3 py-2 text-white shadow-lg shadow-sky-500/40 z-20">
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-sky-100">Sender's Last Message</p>
                      <p className="text-sm font-medium">{senderFeedbackMessage}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {!success && (
            <div className="flex flex-wrap gap-2">
              {receiverMode === 'data-scanning' && !isScanning && !isAwaitingFeedback && (
                <Button onClick={handleStartScan} className="flex-1 sm:flex-none bg-sky-600 hover:bg-sky-500 text-white">
                  📷 Start Scanning
                </Button>
              )}
              {receiverMode === 'data-scanning' && !isScanning && !success && isAwaitingFeedback && (
                <Button disabled className="flex-1 sm:flex-none" variant="secondary">
                  ⏸️ Provide Feedback to Resume
                </Button>
              )}
              {receiverMode === 'data-scanning' && isScanning && !success && (
                <>
                  <Button onClick={handleStopScan} variant="destructive" className="flex-1 sm:flex-none">
                    ⏹ Stop Scanning
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Progress */}
      {!success && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>
              {isMultiPartMode ? (
                <>Part {currentPartIndex + 1}/{totalParts}: Decoded {displayDecodedBlocks} of {displayTotalBlocks} blocks</>
              ) : (
                <>Decoded {displayDecodedBlocks} of {displayTotalBlocks} blocks</>
              )}
            </span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
          <div className="text-xs text-muted-foreground">
            Chunks scanned: {displayChunksScanned} (est. {estimatedChunksNeeded} needed)
            {invalidChecksumCount > 0 && (
              <div className="text-red-600">
                Invalid checksums: {invalidChecksumCount} chunks skipped
              </div>
            )}
          </div>
        </div>
      )}

      {/* Block Progress Grid */}
      {!success && fountainMetadata.totalSourceBlocks > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              {isMultiPartMode ? `Block Progress (Part ${currentPartIndex + 1}/${totalParts})` : 'Block Progress'}
            </div>
            <div className="text-xs text-muted-foreground">
              {displayDecodedBlocks} / {displayTotalBlocks} blocks decoded
            </div>
          </div>
          <div className={`grid gap-0`} style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}>
            {Array.from({ length: totalRectangles }, (_, i) => {
              // Calculate block range relative to the part's starting block
              const relativeStartBlock = i * blocksPerRect
              const relativeEndBlock = Math.min(relativeStartBlock + blocksPerRect, gridBlockCount)

              // Convert to absolute block indices
              const absoluteStartBlock = partStartBlock + relativeStartBlock
              const absoluteEndBlock = partStartBlock + relativeEndBlock

              // Hide rectangles that don't contain any blocks
              if (relativeStartBlock >= gridBlockCount) {
                return (
                  <div
                    key={i}
                    className="aspect-square hidden"
                  />
                )
              }

              const rangeBlocks = Array.from({ length: absoluteEndBlock - absoluteStartBlock }, (_, j) => absoluteStartBlock + j)
              const decodedInRange = rangeBlocks.filter(block => decodedBlockIndices.includes(block)).length

              const colorClass = getRectangleColor(decodedInRange, rangeBlocks.length)

              return (
                <div
                  key={i}
                  className="aspect-square p-0.5 bg-transparent"
                  title={`Blocks ${absoluteStartBlock + 1}-${absoluteEndBlock}: ${decodedInRange}/${rangeBlocks.length} decoded`}
                >
                  <div className={`w-full h-full rounded-full ${colorClass}`} />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Metadata Info Alert */}
      {!success && showMetadataInfo && (
        <Alert>
          <AlertDescription>
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium">{fountainMetadata.name}</p>
                <p className="text-sm text-muted-foreground">
                  Expected size: {(fountainMetadata.size / 1024).toFixed(2)}KB |
                  Blocks: {fountainMetadata.totalSourceBlocks}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowMetadataInfo(false)
                  onToggleMetadataInfo(false)
                }}
                className="text-muted-foreground hover:text-foreground text-sm"
              >
                ✕
              </button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Instructions Alert */}
      {!isScanning && !success && (
        <Alert>
          <AlertDescription>
            <p className="font-medium mb-2">📱 Fountain Code Transfer Mode:</p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Scanning starts automatically; use "Start Scanning" if you pause it</li>
              <li>Scan the metadata QR code first</li>
              <li>Then scan fountain-coded chunks</li>
              <li>You only need ~110% of chunks (can miss some)</li>
              <li>Progress shows decoded blocks, not chunks scanned</li>
              <li>File will download when fully decoded</li>
              <li>When feedback is required, you'll be prompted to generate a feedback QR</li>
              <li>Show it to sender, then switch to ACK scanning mode to receive acknowledgment</li>
              <li>You can toggle between showing feedback QR and scanning for ACK at any time</li>
              <li>Data scanning is blocked until ACK is received from sender</li>
            </ol>
          </AlertDescription>
        </Alert>
      )}

      {/* Control Buttons */}
      <div className="flex justify-end">
        {!success && (
          <Button
            onClick={() => {
              const newShow = !showMetadataInfo
              setShowMetadataInfo(newShow)
              onToggleMetadataInfo(newShow)
            }}
            variant="ghost"
            size="sm"
          >
            {showMetadataInfo ? '▼' : '▶'} File Info
          </Button>
        )}
      </div>
    </div>
  )
}
