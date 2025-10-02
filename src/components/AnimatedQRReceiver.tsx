import { useState, useEffect, useRef } from 'react'
import QrScanner from 'qr-scanner'
import QRCode from 'qrcode'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface ChunkData {
  meta: {
    name: string
    size: number
    type: string
    timestamp: number
  }
  index: number
  total: number
  encoding?: 'base64' | 'binary' // support base64 (legacy) and binary formats
  data: string
}

export function AnimatedQRReceiver() {
  const [isScanning, setIsScanning] = useState(false)
  const [receivedChunks, setReceivedChunks] = useState<Map<number, ChunkData>>(new Map())
  const [metadata, setMetadata] = useState<ChunkData['meta'] | null>(null)
  const [totalChunks, setTotalChunks] = useState(0)
  const [error, setError] = useState<string>('')
  const [success, setSuccess] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [feedbackQrUrl, setFeedbackQrUrl] = useState<string>('')
  const [showFeedbackQr, setShowFeedbackQr] = useState(false)
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [showDebugLog, setShowDebugLog] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)

  // Initialize scanner
  useEffect(() => {
    if (!isScanning || !videoRef.current) {
      return
    }

    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        handleScan(result.data)
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

  const handleScan = (data: string) => {
    try {
      // Debounce duplicate scans (within 500ms)
      const now = Date.now()
      if (data === lastScannedRef.current && now - lastScanTimeRef.current < 500) {
        return
      }
      lastScannedRef.current = data
      lastScanTimeRef.current = now

      addDebugLog(`Scanned data length: ${data.length} bytes`)

      let chunk: ChunkData

      // Check if data starts with '{' - if so, it's JSON
      if (data.trim().startsWith('{')) {
        addDebugLog('Detected JSON format')
        // JSON format (legacy or compact)
        const parsed = JSON.parse(data)

        // Handle both compact format (m,i,t,d) and legacy format (meta,index,total,data)
        const encoding = parsed.e || (parsed.encoding === 'binary' ? 'binary' : 'base64')

        // Decode Latin1 if needed
        let decodedData = parsed.d || parsed.data
        if (parsed.e === 'l1') {
          // Latin1: convert string back to bytes then to base64
          const bytes = new Uint8Array(decodedData.length)
          for (let i = 0; i < decodedData.length; i++) {
            bytes[i] = decodedData.charCodeAt(i) & 0xFF
          }
          decodedData = btoa(String.fromCharCode(...bytes))
        }

        chunk = {
          meta: parsed.m || parsed.meta,
          index: parsed.i !== undefined ? parsed.i : parsed.index,
          total: parsed.t || parsed.total,
          encoding: encoding,
          data: decodedData
        }
        addDebugLog(`JSON chunk ${chunk.index + 1}/${chunk.total} - ${chunk.meta.name} (${encoding})`)
      } else {
        addDebugLog('Detected binary format')
        // Binary format - convert string to bytes
        const bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) {
          bytes[i] = data.charCodeAt(i) & 0xFF // Ensure byte values 0-255
        }

        let offset = 0
        // Read index (2 bytes)
        const index = (bytes[offset++] << 8) | bytes[offset++]
        // Read total (2 bytes)
        const total = (bytes[offset++] << 8) | bytes[offset++]
        // Read name
        const nameLen = bytes[offset++]
        if (nameLen > 255 || offset + nameLen > bytes.length) {
          throw new Error('Invalid binary format: nameLen out of bounds')
        }
        const name = new TextDecoder().decode(bytes.slice(offset, offset + nameLen))
        offset += nameLen
        // Read type
        const typeLen = bytes[offset++]
        if (typeLen > 255 || offset + typeLen > bytes.length) {
          throw new Error('Invalid binary format: typeLen out of bounds')
        }
        const type = new TextDecoder().decode(bytes.slice(offset, offset + typeLen))
        offset += typeLen
        // Read size (4 bytes)
        const size = (bytes[offset++] << 24) | (bytes[offset++] << 16) | (bytes[offset++] << 8) | bytes[offset++]
        // Extract chunk data
        const chunkData = bytes.slice(offset)

        addDebugLog(`Binary chunk ${index + 1}/${total} - ${name} (${chunkData.length} bytes)`)

        chunk = {
          meta: { name, type, size, timestamp: Date.now() },
          index,
          total,
          encoding: 'binary',
          data: btoa(String.fromCharCode(...chunkData)) // store as base64
        }
      }

      // Validate chunk structure
      if (!chunk.meta || chunk.index === undefined || !chunk.total || !chunk.data) {
        throw new Error('Invalid chunk format')
      }

      // Set metadata from first chunk
      if (!metadata) {
        setMetadata(chunk.meta)
        setTotalChunks(chunk.total)
      }

      // Add chunk to received set
      setReceivedChunks((prev) => {
        const updated = new Map(prev)
        if (!updated.has(chunk.index)) {
          updated.set(chunk.index, chunk)
          addDebugLog(`✓ Received chunk ${chunk.index + 1}/${chunk.total}`)
        } else {
          addDebugLog(`⊗ Duplicate chunk ${chunk.index + 1}/${chunk.total}`)
        }
        return updated
      })

      setError('')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Error: ${errorMsg}`)
      console.error('Scan error:', err)
      // Don't show error for every failed scan, as non-chunk QR codes may be scanned
    }
  }

  // Check if all chunks received and reconstruct file
  useEffect(() => {
    if (totalChunks === 0 || receivedChunks.size === 0) return

    if (receivedChunks.size === totalChunks) {
      reconstructFile()
    }
  }, [receivedChunks, totalChunks])

  const reconstructFile = () => {
    try {
      if (!metadata) {
        throw new Error('Missing metadata')
      }

      // Sort chunks by index
      const sortedChunks = Array.from(receivedChunks.values()).sort((a, b) => a.index - b.index)

      // Base64 or binary decoding (both use base64 storage internally)
      const base64Data = sortedChunks.map(chunk => chunk.data).join('')
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      // Create blob and download URL
      const blob = new Blob([bytes], { type: metadata.type || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)

      setDownloadUrl(url)
      setSuccess(true)
      setIsScanning(false)

      // Stop scanner
      if (scannerRef.current) {
        scannerRef.current.stop()
      }
    } catch (err) {
      console.error('Reconstruction error:', err)
      setError('Failed to reconstruct file from chunks')
    }
  }

  const handleStartScan = () => {
    setIsScanning(true)
    setReceivedChunks(new Map())
    setMetadata(null)
    setTotalChunks(0)
    setError('')
    setSuccess(false)
    setDownloadUrl('')
  }

  const handleStopScan = () => {
    setIsScanning(false)
    if (scannerRef.current) {
      scannerRef.current.stop()
    }
  }

  const handleReset = () => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
    }
    setReceivedChunks(new Map())
    setMetadata(null)
    setTotalChunks(0)
    setError('')
    setSuccess(false)
    setDownloadUrl('')
    setIsScanning(false)
  }

  const handleDownload = () => {
    if (!downloadUrl || !metadata) return

    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = metadata.name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const generateFeedbackQr = async () => {
    if (totalChunks === 0) return

    // Get missing chunk indices
    const missingChunks: number[] = []
    for (let i = 0; i < totalChunks; i++) {
      if (!receivedChunks.has(i)) {
        missingChunks.push(i)
      }
    }

    // Create feedback payload
    const feedback = {
      type: 'MISSING_CHUNKS_FEEDBACK',
      timestamp: metadata?.timestamp || Date.now(),
      fileName: metadata?.name || 'unknown',
      totalChunks,
      receivedCount: receivedChunks.size,
      missingChunks
    }

    try {
      const qrUrl = await QRCode.toDataURL(JSON.stringify(feedback), {
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      })
      setFeedbackQrUrl(qrUrl)
      setShowFeedbackQr(true)
    } catch (err) {
      console.error('Failed to generate feedback QR:', err)
      setError('Failed to generate feedback QR code')
    }
  }

  const progress = totalChunks > 0 ? (receivedChunks.size / totalChunks) * 100 : 0
  const hasMissingChunks = totalChunks > 0 && receivedChunks.size < totalChunks && receivedChunks.size > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">QR Code Receiver</CardTitle>
        {metadata && (
          <div className="text-sm text-muted-foreground text-center space-y-1">
            <p className="font-medium">{metadata.name}</p>
            <p>Expected size: {(metadata.size / 1024).toFixed(2)}KB</p>
          </div>
        )}
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
            <div className="absolute top-2 right-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium">
              ● SCANNING
            </div>
          </div>
        )}

        {/* Progress */}
        {totalChunks > 0 && !success && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Received {receivedChunks.size} of {totalChunks} chunks</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} />
          </div>
        )}

        {/* Chunk Grid */}
        {totalChunks > 0 && !success && (
          <div className="grid grid-cols-10 gap-1">
            {Array.from({ length: totalChunks }, (_, i) => (
              <div
                key={i}
                className={`aspect-square rounded ${
                  receivedChunks.has(i)
                    ? 'bg-green-500'
                    : 'bg-gray-200 dark:bg-gray-700'
                }`}
                title={`Chunk ${i + 1}`}
              />
            ))}
          </div>
        )}

        {/* Feedback QR Code Button */}
        {hasMissingChunks && !showFeedbackQr && (
          <Alert>
            <AlertDescription>
              <div className="space-y-3">
                <p className="font-medium">📊 Missing {totalChunks - receivedChunks.size} chunk(s)</p>
                <p className="text-sm">
                  Generate a feedback QR code to show the sender which chunks are missing,
                  so they can repeat only those specific ones.
                </p>
                <Button onClick={generateFeedbackQr} className="w-full">
                  📋 Generate Feedback QR Code
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Feedback QR Code Display */}
        {showFeedbackQr && feedbackQrUrl && (
          <Alert>
            <AlertDescription>
              <div className="space-y-3">
                <p className="font-medium">📋 Feedback QR Code</p>
                <p className="text-sm">
                  Show this to the sender. They can scan it to repeat only the missing chunks.
                </p>
                <div className="flex justify-center bg-white p-4 rounded-lg">
                  <img src={feedbackQrUrl} alt="Feedback QR Code" className="max-w-[300px]" />
                </div>
                <div className="text-xs text-muted-foreground">
                  Missing chunks: {totalChunks - receivedChunks.size} of {totalChunks}
                  {totalChunks - receivedChunks.size <= 10 && (
                    <span className="ml-2">
                      (#{Array.from({ length: totalChunks }, (_, i) => i)
                        .filter(i => !receivedChunks.has(i))
                        .map(i => i + 1)
                        .join(', ')})
                    </span>
                  )}
                </div>
                <Button
                  onClick={() => setShowFeedbackQr(false)}
                  variant="outline"
                  className="w-full"
                >
                  Hide Feedback QR
                </Button>
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

        {/* Success Alert */}
        {success && (
          <Alert>
            <AlertDescription>
              <div className="space-y-3">
                <p className="font-medium text-green-600">✅ File received successfully!</p>
                <div className="flex gap-2">
                  <Button onClick={handleDownload} className="flex-1">
                    📥 Download {metadata?.name}
                  </Button>
                  <Button onClick={handleReset} variant="outline">
                    Reset
                  </Button>
                </div>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Instructions */}
        {!isScanning && !success && (
          <Alert>
            <AlertDescription>
              <p className="font-medium mb-2">📱 How to receive a file:</p>
              <ol className="list-decimal list-inside space-y-1 text-sm">
                <li>Click "Start Scanning" to activate camera</li>
                <li>Point camera at the animated QR codes</li>
                <li>Keep scanning until all chunks are received</li>
                <li>File will download automatically when complete</li>
              </ol>
            </AlertDescription>
          </Alert>
        )}

        {/* Debug Log */}
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
          {!isScanning && !success && (
            <Button onClick={handleStartScan} className="flex-1">
              📷 Start Scanning
            </Button>
          )}
          {isScanning && !success && (
            <>
              <Button onClick={handleStopScan} variant="destructive" className="flex-1">
                ⏹ Stop Scanning
              </Button>
              <Button onClick={handleReset} variant="outline">
                Reset
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
