import { useState, useEffect, useCallback } from 'react'
import { computeChecksum } from '@/utils/checksum'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useQRScanner } from '@/hooks/useQRScanner'

interface ChunkData {
  meta: {
    name: string
    size: number
    type: string
    timestamp: number
  }
  index: number
  total: number
  data: string // base64 encoded
}

interface SequentialQRReceiverProps {
   // initialMetadata is required; metadata QR should be handled by parent
   initialMetadata: {
     name: string
     size: number
     type: string
     totalChunks: number
     checksum?: string
     checksumAlg?: string
     sessionId: number
   }
 }

export function SequentialQRReceiver({ initialMetadata }: SequentialQRReceiverProps) {
  // Metadata always provided by parent
  const initialMeta: ChunkData['meta'] = {
    name: initialMetadata.name,
    size: initialMetadata.size,
    type: initialMetadata.type,
    timestamp: Date.now()
  }

  const [isScanning, setIsScanning] = useState(false)
  const [receivedChunks, setReceivedChunks] = useState<Map<number, ChunkData>>(new Map())
  // Metadata + totalChunks are immutable for lifecycle of this mounted receiver (parent remounts on file change)
  const metadata = initialMeta
  const totalChunks = initialMetadata.totalChunks
  const [success, setSuccess] = useState(false)
  const [integrityOk, setIntegrityOk] = useState<boolean | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [feedbackQrUrl, setFeedbackQrUrl] = useState<string>('')
  const [showFeedbackQr, setShowFeedbackQr] = useState(false)
  const [debugLog, setDebugLog] = useState<string[]>([
    `[${new Date().toLocaleTimeString()}] 📦 Initialized with metadata: ${initialMeta.name} (${initialMetadata.totalChunks} chunks)`
  ])
  const [showDebugLog, setShowDebugLog] = useState(false)
  const [error, setError] = useState<string>('')

  const addDebugLog = useCallback((message: string) => {
    console.log(`[SequentialQRReceiver] ${message}`)
    setDebugLog(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${message}`])
  }, [])

  const handleScan = useCallback((data: string) => {
    try {
      addDebugLog(`Scanned chunk, length: ${data.length} chars, first char code: ${data.length > 0 ? data.charCodeAt(0) : 'N/A'}`)

      //  No metadata parsing here; parent guarantees metadata already acquired

      // Convert string to bytes (QR scanner returns string from binary data or JSON)
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xFF
      }

      addDebugLog(`Bytes length: ${bytes.length}, first byte: ${bytes[0]}, bytes[0]===1: ${bytes[0] === 1}`)

      // Expect sequential data chunks (type=1)
      if (bytes.length >= 1 && bytes[0] === 1) {
        addDebugLog('📋 Processing data chunk')

        if (bytes.length < 4) {
          throw new Error('Invalid data chunk: too short')
        }

        let offset = 1 // Skip type byte
        const chunkIndex = (bytes[offset++] << 8) | bytes[offset++]
        const chunkData = bytes.slice(offset)

  addDebugLog(`Data chunk ${chunkIndex + 1}/${totalChunks} (${chunkData.length} bytes)`)

        // Convert chunk data to base64 for storage
        const base64Data = btoa(String.fromCharCode(...chunkData))

        const chunk: ChunkData = {
          meta: metadata,
          index: chunkIndex,
          total: totalChunks,
          data: base64Data
        }

        // Add chunk to received set
        setReceivedChunks((prev) => {
          const updated = new Map(prev)
          if (!updated.has(chunk.index)) {
            updated.set(chunk.index, chunk)
            addDebugLog(`✓ Received data chunk ${chunk.index + 1}/${totalChunks}`)
          } else {
            addDebugLog(`⊗ Duplicate chunk ${chunk.index + 1}/${totalChunks}`)
          }
          return updated
        })
      } else {
        addDebugLog('⚠ Ignoring non-data QR code')
      }

      setError('')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Error: ${errorMsg}`)
      console.error('Scan error:', err)
    }
  }, [addDebugLog, metadata, totalChunks])

  const handleScanError = useCallback((errorMessage: string) => {
    setError(errorMessage)
  }, [])

  const { videoRef, stopScanner } = useQRScanner({
    onScan: handleScan,
    isScanning,
    onError: handleScanError
  })

  // Auto-start scanning on mount
  useEffect(() => {
    setIsScanning(true)
  }, [])

  const reconstructFile = useCallback(async (chunks: Map<number, ChunkData>, stopScan: () => void) => {
    try {
      // Sort chunks by index
      const sortedChunks = Array.from(chunks.values()).sort((a, b) => a.index - b.index)

      // Decode base64 data
      const base64Data = sortedChunks.map(chunk => chunk.data).join('')
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      addDebugLog(`✓ Reconstructed file: ${bytes.length} bytes`)

      // Integrity verification using initialMetadata checksum (if present)
      let checksumMatch: boolean | null = null
      if (initialMetadata.checksum && initialMetadata.checksumAlg === 'crc32') {
        const calc = await computeChecksum(bytes, 'crc32')
        checksumMatch = calc === initialMetadata.checksum
        addDebugLog(checksumMatch
          ? `🔐 Integrity OK (crc32 ${calc})`
          : `❌ Integrity FAILED (expected ${initialMetadata.checksum}, got ${calc})`)
        setIntegrityOk(checksumMatch)
      } else {
        setIntegrityOk(null)
      }

      // Create blob and download URL
  const blob = new Blob([bytes], { type: metadata.type || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)

      setDownloadUrl(url)
      setSuccess(true)
      setIsScanning(false)
      stopScan()
    } catch (err) {
      console.error('Reconstruction error:', err)
      setError('Failed to reconstruct file from chunks')
    }
  }, [addDebugLog, initialMetadata.checksum, initialMetadata.checksumAlg, metadata.type, metadata.name])

  // Check if all chunks received and reconstruct file
  useEffect(() => {
  if (totalChunks === 0 || receivedChunks.size === 0) return

    // totalChunks is the number of data chunks (metadata chunk is separate)
    if (receivedChunks.size === totalChunks) {
      reconstructFile(receivedChunks, stopScanner)
    }
  }, [receivedChunks, totalChunks, reconstructFile, stopScanner])


  const handleStartScan = () => {
    setIsScanning(true)
    setReceivedChunks(new Map())
    setError('')
    setSuccess(false)
    setDownloadUrl('')
  }

  const handleStopScan = () => {
    setIsScanning(false)
    stopScanner()
  }

  const handleReset = () => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl)
    }
    setReceivedChunks(new Map())
    setError('')
    setSuccess(false)
    setDownloadUrl('')
    setIsScanning(false)
    setShowFeedbackQr(false)
    setFeedbackQrUrl('')
  }

  const handleDownload = () => {
  if (!downloadUrl) return

    const link = document.createElement('a')
    link.href = downloadUrl
  link.download = metadata.name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const generateFeedbackQr = async () => {
    if (totalChunks === 0) return

    // Get missing data chunk indices
    const missingChunks: number[] = []
    for (let i = 0; i < totalChunks; i++) {
      if (!receivedChunks.has(i)) {
        missingChunks.push(i)
      }
    }

    // Create feedback payload
     const feedback = {
       type: 'MISSING_CHUNKS_FEEDBACK',
       sessionId: initialMetadata.sessionId,
   timestamp: metadata.timestamp || Date.now(),
   fileName: metadata.name || 'unknown',
       totalChunks: totalChunks,
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
    <div className="space-y-4">
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
            <span>Received {receivedChunks.size} of {totalChunks} data chunks</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
        </div>
      )}

      {/* Metadata Info */}
  {metadata && !success && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">{metadata.name}</p>
            <p className="text-sm text-muted-foreground">
              Expected size: {(metadata.size / 1024).toFixed(2)}KB
            </p>
          </AlertDescription>
        </Alert>
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
              title={`Data chunk ${i + 1}`}
            />
          ))}
        </div>
      )}

      {/* Feedback QR Code Button */}
      {hasMissingChunks && !showFeedbackQr && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-medium">📊 Missing {totalChunks - receivedChunks.size} data chunk(s)</p>
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
              {integrityOk !== null && (
                <p className={`text-sm font-medium ${integrityOk ? 'text-green-600' : 'text-red-600'}`}>
                  {integrityOk ? '🔐 Integrity verified (checksum match)' : '❌ Integrity check failed'}
                </p>
              )}
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
            <p className="font-medium mb-2">📱 Sequential Transfer Mode:</p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Click "Start Scanning" to activate camera</li>
              <li>Point camera at the metadata QR code first</li>
              <li>Then scan the data QR codes in sequence</li>
              <li>All chunks must be received to complete transfer</li>
              <li>Use feedback QR if chunks are missing</li>
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
    </div>
  )
}
