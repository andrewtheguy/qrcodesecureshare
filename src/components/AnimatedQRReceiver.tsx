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

  const handleScan = (data: string) => {
    try {
      // Debounce duplicate scans (within 500ms)
      const now = Date.now()
      if (data === lastScannedRef.current && now - lastScanTimeRef.current < 500) {
        return
      }
      lastScannedRef.current = data
      lastScanTimeRef.current = now

      const chunk: ChunkData = JSON.parse(data)

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
        }
        return updated
      })

      setError('')
    } catch (err) {
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

      // Sort chunks by index and concatenate data
      const sortedChunks = Array.from(receivedChunks.values()).sort((a, b) => a.index - b.index)
      const base64Data = sortedChunks.map(chunk => chunk.data).join('')

      // Convert base64 to binary
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
