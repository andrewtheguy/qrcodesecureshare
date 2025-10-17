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
import { useQRScanner } from '@/hooks/useQRScanner'

// Optional: Extract ignored block list to a top-level constant or env for easier test control.
const TARGETED_TEST_IGNORE_BLOCKS: number[] = [190, 197]

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
  onChunkScanned: (seed: number) => void
  onScanError: (error: string) => void
  onScanStart: () => void
  onScanStop: () => void
  onReset: () => void
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
  onChunkScanned,
  onScanError,
  onScanStart,
  onScanStop,
  onReset,
  onToggleMetadataInfo,
  onModeChange,
  onAckTransitionStatus
}: FountainQRDataScannerProps) {
  const [debugLog, setDebugLog] = useState<string[]>([`[${new Date().toLocaleTimeString()}] 📦 Initialized with metadata: ${fountainMetadata.name} (${fountainMetadata.totalSourceBlocks} blocks, ${fountainMetadata.blockSize} bytes/block)`])
  const [showDebugLog, setShowDebugLog] = useState(false)
  const [showMetadataInfo, setShowMetadataInfo] = useState(false)
  const [error, setError] = useState<string>('')
  const [receivedFountainChunks, setReceivedFountainChunks] = useState(0)

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

  const handleScan = useCallback((data: string) => {
    try {
      addDebugLog(`Scanned chunk, length: ${data.length} bytes`)

      // DIAGNOSTIC: Log current mode and data type
      console.log(`[DIAGNOSTIC] receiverMode=${receiverMode}, dataType=${data.startsWith('{') ? 'JSON' : 'BINARY'}, dataPreview=${data.substring(0, 20)}`)

      if (receiverMode === 'ack-scanning') {
        console.log('[DIAGNOSTIC] Early return: already in ack-scanning mode')
        return
      }

      // Try to check if it is JSON first by checking
      // if it begins with { (sender feedback)
      if (data.startsWith('{')) {
        try {
          const json = JSON.parse(data)
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

      // Convert string to bytes
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xFF
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

  const { videoRef, stopScanner, restartScanner } = useQRScanner({
    onScan: handleScan,
    isScanning: receiverMode === 'data-scanning' && isScanning && !isAwaitingFeedback,
    onError: handleScanError,
    onStart: () => {
        addDebugLog('✅ Data scanner started');
        onAckTransitionStatus(true);
    },
    onStop: () => addDebugLog('🛑 Data scanner stopped')
  })

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
    }
  }, [receiverMode, success])

  const handleStartScan = () => {
    setReceivedFountainChunks(0)
    setError('')
    onScanStart()
  }

  const handleStopScan = () => {
    stopScannerRef.current?.()
    onScanStop()
  }

  const handleReset = () => {
    setReceivedFountainChunks(0)
    setError('')
    setShowMetadataInfo(false)
    setDebugLog([`[${new Date().toLocaleTimeString()}] 📦 Reset - Initialized with metadata: ${fountainMetadata.name} (${fountainMetadata.totalSourceBlocks} blocks, ${fountainMetadata.blockSize} bytes/block)`])
    onReset()
  }

  const progress = (decodedBlocks / fountainMetadata.totalSourceBlocks) * 100
  // More accurate estimate based on robust soliton parameters (c=0.2, delta=0.01) + degree doping
  // Formula: k * (1 + c * ln(k/delta) / sqrt(k)) * 1.05 (accounting for degree doping overhead)
  const k = fountainMetadata.totalSourceBlocks
  const c = 0.2
  const delta = 0.01
  const theoreticalOverhead = c * Math.log(k / delta) / Math.sqrt(k)
  const dopingOverhead = 1.05 // Account for forced low-degree chunks
  const estimatedChunksNeeded = Math.ceil(k * (1 + theoreticalOverhead) * dopingOverhead)

  return (
    <div className="space-y-4">
      {/* Video Preview */}
      {receiverMode === 'data-scanning' && (
        <div className="relative bg-black rounded-lg overflow-hidden">
          <video
            ref={videoRef}
            className="w-full h-auto"
            style={{ maxHeight: '400px' }}
          />
          {isScanning && !isAwaitingFeedback && (
            <div className="absolute top-2 left-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium z-20">
              ● SCANNING
            </div>
          )}
          {isAwaitingFeedback && (
            <div className="absolute bottom-2 left-2 right-2 bg-black/70 text-white px-3 py-2 rounded-lg shadow-lg z-20">
              <p className="text-sm text-center">
                Awaiting feedback processing. Scanning will resume automatically.
              </p>
            </div>
          )}
          {senderFeedbackMessage && senderFeedbackMessage.trim() !== '' && (
            <div className="absolute top-12 right-2 bg-blue-500/90 text-white px-3 py-2 rounded-lg shadow-lg max-w-xs z-20">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-blue-100">Sender's Last Message</p>
                <p className="text-sm font-medium">{senderFeedbackMessage}</p>
              </div>
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
              <li>Click "Start Scanning" to activate camera</li>
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
      <div className="flex gap-2">
        {receiverMode === 'data-scanning' && !isScanning && !success && !isAwaitingFeedback && (
          <Button onClick={handleStartScan} className="flex-1">
            📷 Start Scanning
          </Button>
        )}
        {receiverMode === 'data-scanning' && !isScanning && !success && isAwaitingFeedback && (
          <Button disabled className="flex-1" variant="secondary">
            ⏸️ Provide Feedback to Resume
          </Button>
        )}
        {receiverMode === 'data-scanning' && isScanning && !success && (
          <>
            <Button onClick={handleStopScan} variant="destructive" className="flex-1">
              ⏹ Stop Scanning
            </Button>
            <Button onClick={handleReset} variant="outline">
              Reset
            </Button>
          </>
        )}
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
