import { useState, useEffect, useRef } from 'react'
import QrScanner from 'qr-scanner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SequentialQRReceiver } from './SequentialQRReceiver'
import { FountainQRReceiver } from './FountainQRReceiver'

type TransferMode = 'sequential' | 'fountain' | null

interface DetectedMetadata {
  mode: 'sequential' | 'fountain'
  name: string
  size: number
  type: string
  totalChunks?: number // for sequential
  totalSourceBlocks?: number // for fountain
  blockSize?: number // for fountain
  checksum?: string
  checksumAlg?: string
}

export function AnimatedQRReceiver() {
  const [transferMode, setTransferMode] = useState<TransferMode>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [detectedMetadata, setDetectedMetadata] = useState<DetectedMetadata | null>(null)
  const [error, setError] = useState<string>('')
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [showDebugLog, setShowDebugLog] = useState(false)
  // Used to force remount receiver component when a new file is chosen/confirmed
  const [receiverKey, setReceiverKey] = useState(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)

  // Initialize scanner for metadata detection
  useEffect(() => {
    if (!isScanning || !videoRef.current) {
      return
    }

    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        handleMetadataScan(result.data)
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      }
    )

    scannerRef.current = scanner
    scanner.start().catch((err) => {
      console.error('Scanner start error:', err)
      setError('Failed to start camera. Please ensure camera permissions are granted.')
      setIsScanning(false)
    })

    return () => {
      scanner.stop()
      scanner.destroy()
    }
  }, [isScanning])

  const addDebugLog = (message: string) => {
    setDebugLog(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${message}`])
  }

  const handleMetadataScan = (data: string) => {
    try {
      // Debounce duplicate scans (within 500ms)
      const now = Date.now()
      if (data === lastScannedRef.current && now - lastScanTimeRef.current < 500) {
        return
      }
      lastScannedRef.current = data
      lastScanTimeRef.current = now

      addDebugLog(`Scanned metadata text, length: ${data.length} chars`)

      // Try to parse JSON (new format)
      const parsed = JSON.parse(data)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Not a JSON object')
      }
      if (parsed.type !== 'METADATA') {
        throw new Error('Missing METADATA type field')
      }
      if (parsed.mode !== 'sequential' && parsed.mode !== 'fountain') {
        throw new Error('Unknown transfer mode')
      }

      if (parsed.mode === 'sequential') {
        setDetectedMetadata({
          mode: 'sequential',
          name: parsed.fileName,
          size: parsed.fileSize,
          type: parsed.fileType,
          totalChunks: parsed.totalChunks,
          checksum: parsed.checksum,
          checksumAlg: parsed.checksumAlg
        })
        addDebugLog(`✓ Sequential metadata: ${parsed.fileName} (${parsed.totalChunks} chunks)`)
      } else {
        setDetectedMetadata({
          mode: 'fountain',
          name: parsed.fileName,
          size: parsed.fileSize,
          type: parsed.fileType,
          totalSourceBlocks: parsed.totalSourceBlocks,
          blockSize: parsed.blockSize,
          checksum: parsed.checksum,
          checksumAlg: parsed.checksumAlg
        })
        addDebugLog(`✓ Fountain metadata: ${parsed.fileName} (${parsed.totalSourceBlocks} blocks)`)
      }

      setIsScanning(false)
      if (scannerRef.current) {
        scannerRef.current.stop()
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Metadata parse error: ${errorMsg}`)
      console.error('Metadata scan error:', err)
      setError('Failed to parse metadata QR code (expecting JSON).')
    }
  }

  const handleStartScan = () => {
    setIsScanning(true)
    setError('')
    setDetectedMetadata(null)
    setDebugLog([])
  }

  const handleReset = () => {
    setIsScanning(false)
    setDetectedMetadata(null)
    setTransferMode(null)
    setError('')
    setDebugLog([])
    if (scannerRef.current) {
      scannerRef.current.stop()
    }
  }

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
              />
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

          {/* Debug Log */}
          {debugLog.length > 0 && (
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
                  {debugLog.map((log, i) => (
                    <div key={i} className="py-0.5">
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </div>
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
    )
  }

  // Metadata detected - show confirmation screen
  if (detectedMetadata && !transferMode) {
    const estimatedChunks = detectedMetadata.mode === 'fountain' && detectedMetadata.totalSourceBlocks
      ? Math.ceil(detectedMetadata.totalSourceBlocks * 1.1)
      : detectedMetadata.totalChunks || 0

    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-center">
            {detectedMetadata.mode === 'fountain' ? '🔁 Fountain Code Transfer' : '📋 Sequential Transfer'}
          </CardTitle>
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
                  {detectedMetadata.mode === 'fountain' ? (
                    <>
                      <p>🔢 Source Blocks: {detectedMetadata.totalSourceBlocks}</p>
                      <p>📊 Est. Chunks Needed: ~{estimatedChunks}</p>
                    </>
                  ) : (
                    <p>🔢 Total Chunks: {detectedMetadata.totalChunks}</p>
                  )}
                </div>
              </div>
            </AlertDescription>
          </Alert>

          {/* Mode Info */}
          <Alert>
            <AlertDescription>
              <p className="font-medium mb-2">
                {detectedMetadata.mode === 'fountain' ? '🔁 Fountain Code Mode' : '📋 Sequential Mode'}
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                {detectedMetadata.mode === 'fountain' ? (
                  <>
                    <li>Receives random coded chunks</li>
                    <li>Only needs ~110% of chunks to decode</li>
                    <li>Can skip/miss chunks and still succeed</li>
                  </>
                ) : (
                  <>
                    <li>Receives chunks in sequential order</li>
                    <li>Needs ALL chunks to complete</li>
                    <li>Can request missing chunks via feedback QR</li>
                  </>
                )}
              </ul>
            </AlertDescription>
          </Alert>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <Button onClick={handleConfirmMode} className="flex-1">
                📥 Start Receiving Data
            </Button>
            <Button onClick={handleReset} variant="outline">
              ↺ Reset
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Show selected receiver component
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">
          {transferMode === 'sequential' ? '📋 Sequential Receiver' : '🔁 Fountain Code Receiver'}
        </CardTitle>
        {detectedMetadata && (
          <p className="text-sm text-muted-foreground text-center">
            {detectedMetadata.name} • {(detectedMetadata.size / 1024).toFixed(2)}KB
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Reset Button */}
        <Button
          onClick={handleReset}
          variant="outline"
          size="sm"
          className="w-full"
        >
          ↺ Reset & Scan New File
        </Button>

        {/* Render appropriate receiver component */}
        {transferMode === 'sequential' && detectedMetadata ? (
          <SequentialQRReceiver
            key={receiverKey}
            initialMetadata={{
              name: detectedMetadata.name,
              size: detectedMetadata.size,
              type: detectedMetadata.type,
              totalChunks: detectedMetadata.totalChunks || 0,
              checksum: detectedMetadata.checksum,
              checksumAlg: detectedMetadata.checksumAlg
            }}
          />
        ) : transferMode === 'fountain' && detectedMetadata ? (
          <FountainQRReceiver
            key={receiverKey}
            initialMetadata={{
              name: detectedMetadata.name,
              size: detectedMetadata.size,
              type: detectedMetadata.type,
              totalSourceBlocks: detectedMetadata.totalSourceBlocks || 0,
              blockSize: detectedMetadata.blockSize,
              checksum: detectedMetadata.checksum,
              checksumAlg: detectedMetadata.checksumAlg
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}
