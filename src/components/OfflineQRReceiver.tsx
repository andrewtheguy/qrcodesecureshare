import { useState, useCallback, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainQRReceiver } from './fountain_qr/FountainQRReceiver'
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type TransferMode = 'fountain' | null

interface DetectedMetadata {
  mode: 'fountain'
  name: string
  size: number
  type: string
  sessionId: number
  checksum: string
  checksumAlg: string
}

interface FountainDetectedMetadata extends DetectedMetadata {
  mode: 'fountain'
  totalSourceBlocks: number
  blockSize: number
  feedbackEnabled: boolean
  partBasedMode?: boolean
  partSize?: number
}

export function OfflineQRReceiver() {
  const location = useLocation()
  const [transferMode, setTransferMode] = useState<TransferMode>(null)
  const [detectedMetadata, setDetectedMetadata] = useState<FountainDetectedMetadata | null>(null)
  // Used to force remount receiver component when a new file is chosen/confirmed
  const [receiverKey, setReceiverKey] = useState(0)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [error, setError] = useState<string>('')
  const [metadataDetected, setMetadataDetected] = useState(false)

  const addDebugLog = (message: string) => {
    console.log(`[AnimatedQRReceiver] ${message}`)
  }

  // Load metadata from location state on mount
  useEffect(() => {
    interface LocationState {
      metadata?: {
        mode: 'fountain'
        fileName: string
        fileSize: number
        fileType: string
        sessionId: number
        checksum: string
        checksumAlg: string
        totalSourceBlocks?: number
        blockSize?: number
        feedbackEnabled?: boolean
        partBasedMode?: boolean
        partSize?: number
      }
    }
    const state = location.state as LocationState | null
    if (state?.metadata) {
      const parsed = state.metadata
      addDebugLog('Loading metadata from navigation state')

      if (parsed.mode === 'fountain' && parsed.totalSourceBlocks !== undefined && parsed.blockSize !== undefined && parsed.feedbackEnabled !== undefined) {
        setDetectedMetadata({
          mode: 'fountain',
          name: parsed.fileName,
          size: parsed.fileSize,
          type: parsed.fileType,
          sessionId: parsed.sessionId,
          totalSourceBlocks: parsed.totalSourceBlocks,
          blockSize: parsed.blockSize,
          checksum: parsed.checksum,
          checksumAlg: parsed.checksumAlg,
          feedbackEnabled: parsed.feedbackEnabled,
          partBasedMode: parsed.partBasedMode,
          partSize: parsed.partSize
        })
        addDebugLog(`✓ Fountain metadata: ${parsed.fileName} (${parsed.totalSourceBlocks} blocks)`)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleMetadataScan = useCallback((data: string | Uint8Array) => {
    // Prevent duplicate detection if metadata already detected
    if (metadataDetected) {
      return
    }

    try {
      // Convert Uint8Array to string if needed
      const qrCode = data instanceof Uint8Array ? new TextDecoder().decode(data) : data
      addDebugLog(`Scanned metadata text, length: ${qrCode.length} chars`)

      // Try to parse JSON (new format)
      const parsed = JSON.parse(qrCode)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Not a JSON object')
      }
      if (parsed.type !== 'METADATA') {
        throw new Error('Missing METADATA type field')
      }
      if (parsed.mode !== 'fountain') {
        throw new Error('Unknown transfer mode')
      }

      // Strict validation for sessionId
      if (typeof parsed.sessionId !== 'number' || parsed.sessionId < 0 || parsed.sessionId > 65535) {
        throw new Error('Invalid sessionId: must be a number between 0 and 65535')
      }

      if (parsed.mode === 'fountain') {
        setDetectedMetadata({
          mode: 'fountain',
          name: parsed.fileName,
          size: parsed.fileSize,
          type: parsed.fileType,
          sessionId: parsed.sessionId,
          totalSourceBlocks: parsed.totalSourceBlocks,
          blockSize: parsed.blockSize,
          checksum: parsed.checksum,
          checksumAlg: parsed.checksumAlg,
          feedbackEnabled: parsed.feedbackEnabled,
          partBasedMode: parsed.partBasedMode,
          partSize: parsed.partSize
        })
        addDebugLog(`✓ Fountain metadata: ${parsed.fileName} (${parsed.totalSourceBlocks} blocks)`)
      }

      // Mark metadata as detected and stop scanning immediately
      setMetadataDetected(true)
      setIsScanning(false)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Metadata parse error: ${errorMsg}`)
      console.error('Metadata scan error:', err)
      setError('Failed to parse metadata QR code (expecting JSON).')
    }
  }, [metadataDetected])

  const handleScanError = useCallback((errorMessage: string) => {
    setError(errorMessage)
  }, [])

  // Metadata scanning is brief and one-time, so we use a slightly higher scan rate (10 fps = 100ms interval)
  // Add debounce to prevent duplicate metadata detections within 500ms
  const { videoRef, canvasRef } = useZXingQRScanner({
    onScan: (data) => handleMetadataScan(data[0]),
    isScanning,
    onError: handleScanError,
    scanInterval: 100,
    debounceMs: 500
  })

  const handleStartScan = () => {
    setIsScanning(true)
    setError('')
    setDetectedMetadata(null)
    setMetadataDetected(false)
  }

  const handleReset = () => {
    setIsScanning(false)
    setDetectedMetadata(null)
    setTransferMode(null)
    setError('')
    setMetadataDetected(false)
  }

  const requestReset = () => {
    setResetDialogOpen(true)
  }

  const handleConfirmReset = () => {
    setResetDialogOpen(false)
    handleReset()
  }

  const handleCancelReset = () => {
    setResetDialogOpen(false)
  }

  const resetConfirmationDialog = (
    <Dialog
      open={resetDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleCancelReset()
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Reset Receiver?</DialogTitle>
          <DialogDescription>
            This will stop the current scan and clear all received data. You will need to rescan the metadata QR code to start over.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancelReset}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirmReset}>
            Yes, Reset Receiver
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  const handleConfirmMode = () => {
    if (detectedMetadata) {
      setTransferMode(detectedMetadata.mode)
      // Increment key so receiver remounts fresh for each new file confirmation
      setReceiverKey(k => k + 1)
    }
  }

  // Metadata scanning screen
  if (!detectedMetadata && !transferMode) {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="text-center">QR Code Receiver</CardTitle>
            <p className="text-sm text-muted-foreground text-center">
              Scan the metadata QR code to begin
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Video Preview */}
            {isScanning && (
              <div className="relative bg-black rounded-lg overflow-hidden">
                <video
                  ref={videoRef}
                  className="w-full h-auto"
                  style={{ maxHeight: '400px' }}
                  playsInline
                  muted
                />
                <canvas ref={canvasRef} style={{ display: 'none' }} />
                <div className="absolute top-2 right-2 bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium">
                  ● SCANNING FOR METADATA
                </div>
              </div>
            )}

            {/* Error Alert */}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Instructions */}
            {!isScanning && (
              <Alert>
                <AlertDescription>
                  <p className="font-medium mb-2">📱 How to receive a file:</p>
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Click "Start Scanning" below</li>
                    <li>Point camera at the sender's metadata QR code</li>
                    <li>Transfer mode will be detected automatically</li>
                    <li>Continue scanning data QR codes until complete</li>
                  </ol>
                </AlertDescription>
              </Alert>
            )}

            {/* Control Buttons */}
            <div className="flex gap-2">
              {!isScanning && (
                <Button onClick={handleStartScan} className="flex-1">
                  📷 Start Scanning
                </Button>
              )}
              {isScanning && (
                <Button onClick={() => setIsScanning(false)} variant="destructive" className="flex-1">
                  ⏹ Stop Scanning
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
        {resetConfirmationDialog}
      </>
    )
  }

  // Metadata detected - show confirmation screen
  if (detectedMetadata && !transferMode) {
    const estimatedChunks = detectedMetadata.totalSourceBlocks
      ? Math.ceil(detectedMetadata.totalSourceBlocks * 1.1)
      : null

    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="text-center">🔁 Fountain Code Transfer</CardTitle>
            <p className="text-sm text-muted-foreground text-center">
              Transfer mode detected automatically
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* File Info */}
            <Alert>
              <AlertDescription>
                <div className="space-y-2">
                  <p className="font-medium text-lg">{detectedMetadata.name}</p>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <p>📦 Size: {(detectedMetadata.size / 1024).toFixed(2)}KB</p>
                    <p>🔢 Source Blocks: {detectedMetadata.totalSourceBlocks}</p>
                    <p>📊 Est. Chunks Needed: ~{estimatedChunks || "unavailable"}</p>
                  </div>
                </div>
              </AlertDescription>
            </Alert>

            {/* Mode Info */}
            <Alert>
              <AlertDescription>
                <p className="font-medium mb-2">🔁 Fountain Code Mode</p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li>Receives random coded chunks</li>
                  <li>Only needs ~110% of chunks to decode</li>
                  <li>Can skip/miss chunks and still succeed</li>
                </ul>
              </AlertDescription>
            </Alert>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <Button onClick={handleConfirmMode} className="flex-1">
                📥 Start Receiving Data
              </Button>
              <Button onClick={requestReset} variant="outline">
                ↺ Reset
              </Button>
            </div>
          </CardContent>
        </Card>
        {resetConfirmationDialog}
      </>
    )
  }

  // Show selected receiver component
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-center">🔁 Fountain Code Receiver</CardTitle>
          {detectedMetadata && (
            <p className="text-sm text-muted-foreground text-center">
              {detectedMetadata.name} • {(detectedMetadata.size / 1024).toFixed(2)}KB
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Reset Button */}
          <Button
            onClick={requestReset}
            variant="outline"
            size="sm"
            className="w-full"
          >
            ↺ Reset & Scan New File
          </Button>

          {/* Render appropriate receiver component */}
          {detectedMetadata && transferMode === 'fountain' ? (
            (() => {
              const fountainMeta = detectedMetadata as FountainDetectedMetadata
              return (
                <FountainQRReceiver
                  key={receiverKey}
                  initialMetadata={{
                    name: fountainMeta.name,
                    size: fountainMeta.size,
                    type: fountainMeta.type,
                    sessionId: fountainMeta.sessionId,
                    totalSourceBlocks: fountainMeta.totalSourceBlocks,
                    blockSize: fountainMeta.blockSize,
                    checksum: fountainMeta.checksum,
                    checksumAlg: fountainMeta.checksumAlg,
                    feedbackEnabled: fountainMeta.feedbackEnabled,
                    partBasedMode: fountainMeta.partBasedMode,
                    partSize: fountainMeta.partSize
                }}
              />
            )
            })()
          ) : null}
        </CardContent>
      </Card>
      {resetConfirmationDialog}
    </>
  )
}
