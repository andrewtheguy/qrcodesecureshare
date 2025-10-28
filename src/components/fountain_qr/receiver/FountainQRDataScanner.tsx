/**
 * This component is responsible for the RECEIVER's side of the Fountain Code transfer.
 * It uses the device's camera to scan QR codes containing fountain-coded chunks sent
 * by the sender. The component processes these chunks in a web worker to decode the
 * original file, even if some chunks are missed or arrive out of order.
 *
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { FountainMetadata } from '@/utils/fountainCode'
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner'

// Optional: Extract ignored block list to a top-level constant or env for easier test control.
const TARGETED_TEST_IGNORE_BLOCKS: number[] = [190, 197]

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
  isTargetedModeActive: boolean
  senderFeedbackMessage: string
  decodedBlockIndices?: number[]
  isWindowEnabled: boolean
  currentWindowStart: number
  currentWindowEnd: number
  firstMissingBlock: number
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
  isTargetedModeActive,
  senderFeedbackMessage,
  decodedBlockIndices = [],
  isWindowEnabled,
  currentWindowStart,
  currentWindowEnd,
  firstMissingBlock,
  onChunkScanned,
  onScanError,
  onScanStart,
  onScanStop,
  onToggleMetadataInfo,
  onModeChange,
  onAckTransitionStatus
}: FountainQRDataScannerProps) {
  const [debugLog, setDebugLog] = useState<string[]>([`[${new Date().toLocaleTimeString()}] 📦 Initialized with metadata: ${fountainMetadata.name} (${fountainMetadata.totalSourceBlocks} blocks, ${fountainMetadata.blockSize} bytes/block)`])
  const [showDebugLog, setShowDebugLog] = useState(false)
  const [showMetadataInfo, setShowMetadataInfo] = useState(false)
  const [error, setError] = useState<string>('')
  const [receivedFountainChunks, setReceivedFountainChunks] = useState(0)
  const [hasAutoStarted, setHasAutoStarted] = useState(false)

  const stopScannerRef = useRef<(() => void) | null>(null)
  const restartScannerRef = useRef<(() => Promise<void>) | null>(null)

  const addDebugLog = useCallback((message: string) => {
    console.log(`[FountainQRDataScanner] ${message}`)
    setDebugLog(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${message}`])
  }, [])

  const handleBinaryFountainChunk = useCallback(async (bytes: Uint8Array) => {
    // ════════════════════════════════════════════════════════════════════════════
    // TARGETED MODE TEST LOGIC: IGNORE BLOCKS TO SIMULATE TARGETED MODE
    // To enable: set ENABLE_TARGETED_MODE_TEST to true above
    // Suggested test file size: 60KB (100 blocks) for meaningful targeted mode testing
    // ════════════════════════════════════════════════════════════════════════════
    // ════════════════════════════════════════════════════════════════════════════

    const ENABLE_TARGETED_MODE_TEST = false

    const isTargetedModeTestActive = ENABLE_TARGETED_MODE_TEST && !isTargetedModeActive

    if (isTargetedModeTestActive) {
      // Parse just enough to check indices
      let offset = 2 // Skip magic bytes
      const seed = (bytes[offset++] << 8) | bytes[offset++]
      offset++ // Skip degree
      const numIndices = bytes[offset++]
      const indices: number[] = []
      for (let i = 0; i < numIndices; i++) {
        const idx = (bytes[offset++] << 8) | bytes[offset++]
        indices.push(idx)
      }

      if (TARGETED_TEST_IGNORE_BLOCKS.length > 0) {
        const containsIgnoredBlock = indices.some(i => TARGETED_TEST_IGNORE_BLOCKS.includes(i))
        if (containsIgnoredBlock) {
          addDebugLog(`🎯 [TARGETED MODE TEST] Ignoring chunk #${seed} because it contains a blocked index.`)
          return
        }
      }
    } else if (process.env.NODE_ENV === 'development' && isTargetedModeActive) {
      addDebugLog(`🎯 [TARGETED MODE TEST] Test disabled due to targeted mode activation.`)
    }

    // Parse seed from bytes (big-endian from bytes[2] and bytes[3])
    const seed = (bytes[2] << 8) | bytes[3]

    // Send binary data to worker for processing
    workerRef.current?.postMessage({ type: 'processChunk', id: messageIdCounterRef.current++, binaryData: bytes }, [bytes.buffer])
    setReceivedFountainChunks(prev => prev + 1)
    addDebugLog('📤 Sent chunk to worker for processing')

    // Invoke callback with parsed seed
    onChunkScanned(seed)
  }, [addDebugLog, onChunkScanned, isTargetedModeActive, workerRef, messageIdCounterRef])

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

  // Continuous data scanning is the most battery-critical operation
  // Use 30 fps (33ms interval) for faster QR code decoding with zxing-wasm binary mode
  const { videoRef, canvasRef } = useZXingQRScanner({
    onScan: handleScan,
    isScanning: receiverMode === 'data-scanning' && isScanning && !isAwaitingFeedback,
    onError: handleScanError,
    onCameraReady: () => {
      addDebugLog('✅ Data scanner started')
      onAckTransitionStatus(true)
    },
    scanInterval: 33, // ~30 fps
    binary: true // Return Uint8Array for fountain binary data
  })

  // Create wrapper functions for compatibility with existing stop/restart logic
  const stopScanner = useCallback(() => {
    // Handled by isScanning state change in useZXingQRScanner
  }, [])

  const restartScanner = useCallback(async () => {
    // Handled by isScanning state change in useZXingQRScanner
  }, [])

  // Sync scanner refs
  useEffect(() => {
    stopScannerRef.current = stopScanner
  }, [stopScanner])

  useEffect(() => {
    restartScannerRef.current = restartScanner
  }, [restartScanner])

  // Stop camera when receiverMode changes away from 'data-scanning' or when success becomes true
  useEffect(() => {
    if (receiverMode !== 'data-scanning' || success) {
      addDebugLog(`🛑 Stopping camera due to mode change (mode=${receiverMode}) or success (success=${success})`)
      stopScannerRef.current?.()
      setHasAutoStarted(false)
    }
  }, [receiverMode, success, addDebugLog])

  const handleStartScan = useCallback(() => {
    setReceivedFountainChunks(0)
    setError('')
    setHasAutoStarted(true)
    onScanStart()
  }, [onScanStart])

  const handleStopScan = () => {
    stopScannerRef.current?.()
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

  const progress = (decodedBlocks / fountainMetadata.totalSourceBlocks) * 100
  // More accurate estimate based on robust soliton parameters (c=0.2, delta=0.01) + degree doping
  // Formula: k * (1 + c * ln(k/delta) / sqrt(k)) * 1.05 (accounting for degree doping overhead)
  const k = fountainMetadata.totalSourceBlocks
  const c = 0.2
  const delta = 0.01
  const theoreticalOverhead = c * Math.log(k / delta) / Math.sqrt(k)
  const dopingOverhead = 1.05 // Account for forced low-degree chunks
  const estimatedChunksNeeded = Math.ceil(k * (1 + theoreticalOverhead) * dopingOverhead)

  // Calculate compressed rectangle grid layout
  const totalRectangles = Math.min(fountainMetadata.totalSourceBlocks, GRID_MAX_RECTANGLES)
  const blocksPerRect = Math.ceil(fountainMetadata.totalSourceBlocks / totalRectangles)

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
          <div className="relative mx-auto w-full max-w-md">
            <div className="pointer-events-none absolute inset-x-10 -top-6 h-32 rounded-full bg-sky-500/15 blur-3xl" />
            <div className="relative overflow-hidden rounded-2xl border border-sky-500/35 bg-slate-950/90 shadow-[0_35px_65px_-35px_rgba(56,189,248,0.7)] p-3">
              <div className="relative overflow-hidden rounded-xl bg-black">
                <video
                  ref={videoRef}
                  className="w-full h-auto"
                  style={{ maxHeight: '400px' }}
                  playsInline
                  muted
                />
                <canvas ref={canvasRef} style={{ display: 'none' }} />
                {/* Simple corner guides for scan region */}
                <div className="pointer-events-none absolute inset-0 z-10">
                  {/* Corner guides - top-left */}
                  <div className="absolute top-4 left-4 w-4 h-4">
                    <div className="absolute top-0 left-0 w-full h-0.5 bg-white" />
                    <div className="absolute top-0 left-0 w-0.5 h-full bg-white" />
                  </div>
                  {/* Corner guides - top-right */}
                  <div className="absolute top-4 right-4 w-4 h-4">
                    <div className="absolute top-0 right-0 w-full h-0.5 bg-white" />
                    <div className="absolute top-0 right-0 w-0.5 h-full bg-white" />
                  </div>
                  {/* Corner guides - bottom-left */}
                  <div className="absolute bottom-4 left-4 w-4 h-4">
                    <div className="absolute bottom-0 left-0 w-full h-0.5 bg-white" />
                    <div className="absolute bottom-0 left-0 w-0.5 h-full bg-white" />
                  </div>
                  {/* Corner guides - bottom-right */}
                  <div className="absolute bottom-4 right-4 w-4 h-4">
                    <div className="absolute bottom-0 right-0 w-full h-0.5 bg-white" />
                    <div className="absolute bottom-0 right-0 w-0.5 h-full bg-white" />
                  </div>
                </div>
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
            <span>Decoded {decodedBlocks} of {fountainMetadata.totalSourceBlocks} blocks</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
          <div className="text-xs text-muted-foreground">
            Chunks scanned: {receivedFountainChunks} (est. {estimatedChunksNeeded} needed)
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
            <div className="text-sm font-medium">Block Progress</div>
            {isWindowEnabled ? (
              <div className="text-xs text-muted-foreground">
                {(() => {
                  const windowSize = currentWindowEnd - firstMissingBlock
                  const decodedInWindow = decodedBlockIndices.filter(idx => idx >= firstMissingBlock && idx < currentWindowEnd).length
                  const windowPercent = windowSize > 0 ? Math.round((decodedInWindow / windowSize) * 100) : 0
                  return `Window Mode: Active (${windowPercent}% full, blocks ${firstMissingBlock}-${currentWindowEnd} of ${fountainMetadata.totalSourceBlocks})`
                })()}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                Window Mode: Disabled
              </div>
            )}
          </div>
          <div className={`grid gap-0`} style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}>
            {Array.from({ length: totalRectangles }, (_, i) => {
              const startBlock = i * blocksPerRect
              const endBlock = Math.min(startBlock + blocksPerRect, fountainMetadata.totalSourceBlocks)

              // Hide rectangles that don't contain any blocks
              if (startBlock >= fountainMetadata.totalSourceBlocks) {
                return (
                  <div
                    key={i}
                    className="aspect-square hidden"
                  />
                )
              }

              const rangeBlocks = Array.from({ length: endBlock - startBlock }, (_, j) => startBlock + j)
              const decodedInRange = rangeBlocks.filter(block => decodedBlockIndices.includes(block)).length

              // Check if this rectangle is within the current window
              // A rectangle is considered "in window" if any of its blocks fall within [currentWindowStart, currentWindowEnd)
              const isInWindow = rangeBlocks.some(block => block >= currentWindowStart && block < currentWindowEnd)
              const colorClass = getRectangleColor(decodedInRange, rangeBlocks.length)

              // Apply a different background color for blocks within window range when window mode is enabled
              const windowBackground = isWindowEnabled && isInWindow ? 'bg-purple-100 dark:bg-purple-900' : 'bg-transparent'

              return (
                <div
                  key={i}
                  className={`aspect-square p-0.5 ${windowBackground}`}
                  title={`Blocks ${startBlock + 1}-${endBlock}: ${decodedInRange}/${rangeBlocks.length} decoded${isWindowEnabled ? (isInWindow ? ' (in window)' : ' (outside window)') : ''}`}
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

      {/* Debug Log Section */}
      <div className="border-t pt-3">
        <Button
          onClick={() => setShowDebugLog(!showDebugLog)}
          variant="ghost"
          size="sm"
          className="w-full text-xs"
        >
          {showDebugLog ? '▼' : '▶'} Debug Log ({debugLog.length})
        </Button>
        {showDebugLog && (
          <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono max-h-48 overflow-y-auto">
            {debugLog.length === 0 ? (
              <p className="text-muted-foreground">No logs yet...</p>
            ) : (
              debugLog.map((log, i) => (
                <div key={i} className="py-0.5">
                  {log}
                </div>
              ))
            )}
          </div>
        )}
      </div>

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
