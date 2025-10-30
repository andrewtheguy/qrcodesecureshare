import { useState, useEffect, useCallback, useRef } from 'react'
import { computeChecksum } from '@/utils/checksum'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner'

interface ChunkData {
  meta: {
    name: string
    size: number
    fileType: string
    timestamp: number
  }
  index: number
  total: number
  data: Uint8Array // binary data
}

interface SequentialQRReceiverProps {
   // initialMetadata is required; metadata QR should be handled by parent
   initialMetadata: {
     name: string
     size: number
     type: string
     totalChunks: number
     checksum: string
     checksumAlg: string
     sessionId: number
   }
 }

export function SequentialQRReceiver({ initialMetadata }: SequentialQRReceiverProps) {
  // Metadata always provided by parent
  const initialMeta: ChunkData['meta'] = {
    name: initialMetadata.name,
    size: initialMetadata.size,
    fileType: initialMetadata.type,
    timestamp: Date.now()
  }

  const [isScanning, setIsScanning] = useState(false)
  const [receivedChunks, setReceivedChunks] = useState<Map<number, ChunkData>>(new Map())
  // Metadata + totalChunks are immutable for lifecycle of this mounted receiver (parent remounts on file change)
  const metadata = initialMeta
  const totalChunks = initialMetadata.totalChunks
  const [success, setSuccess] = useState(false)
  const [integrityOk, setIntegrityOk] = useState<boolean | null>(null)
  const [actualChecksum, setActualChecksum] = useState<string>('')
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [debugLog, setDebugLog] = useState<string[]>([
    `[${new Date().toLocaleTimeString()}] 📦 Initialized with metadata: ${initialMeta.name} (${initialMetadata.totalChunks} chunks)`
  ])
  const [showDebugLog, setShowDebugLog] = useState(false)
  const [error, setError] = useState<string>('')

  const addDebugLog = useCallback((message: string) => {
    console.log(`[SequentialQRReceiver] ${message}`)
    setDebugLog(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${message}`])
  }, [])

  const handleScan = useCallback((qrCodes: Uint8Array[]) => {
    if (qrCodes.length === 0) return

    const bytes = qrCodes[0]
    try {
      addDebugLog(`Scanned chunk, length: ${bytes.length} bytes, first byte: ${bytes[0]}`)

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

        const chunk: ChunkData = {
          meta: metadata,
          index: chunkIndex,
          total: totalChunks,
          data: chunkData
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

  const { videoRef, canvasRef } = useZXingQRScanner({
    onScan: handleScan,
    isScanning,
    onError: handleScanError,
    binary: true
  })

  // Auto-start scanning on mount
  useEffect(() => {
    setIsScanning(true)
  }, [])

  // Use ref to track if we've already initiated reconstruction (prevents duplicate calls)
  const reconstructionInitiatedRef = useRef(false)

  // Check if all chunks received and reconstruct file
  useEffect(() => {
    if (totalChunks === 0 || receivedChunks.size === 0) return
    if (success || reconstructionInitiatedRef.current) return // Guard: Don't reconstruct again if already successful or in progress

    // totalChunks is the number of data chunks (metadata chunk is separate)
    if (receivedChunks.size === totalChunks) {
      reconstructionInitiatedRef.current = true // Mark that we're starting reconstruction

      // Execute reconstruction inline to avoid dependency array issues
      ;(async () => {
        try {
          // Sort chunks by index
          const sortedChunks = Array.from(receivedChunks.values()).sort((a, b) => a.index - b.index)

          // Concatenate binary data chunks
          const totalLength = sortedChunks.reduce((sum, chunk) => sum + chunk.data.length, 0)
          const bytes = new Uint8Array(totalLength)
          let offset = 0
          for (const chunk of sortedChunks) {
            bytes.set(chunk.data, offset)
            offset += chunk.data.length
          }

          addDebugLog(`✓ Reconstructed file: ${bytes.length} bytes`)

          // Integrity verification using initialMetadata checksum (if present)
          const calc = await computeChecksum(bytes, 'crc32')
          const checksumMatch = calc === initialMetadata.checksum
          addDebugLog(checksumMatch
            ? `🔐 Integrity OK (crc32 ${calc})`
            : `❌ Integrity FAILED (expected ${initialMetadata.checksum}, got ${calc})`)
          setIntegrityOk(checksumMatch)
          setActualChecksum(calc)

          // Create blob and download URL
          const blob = new Blob([bytes], { type: metadata.fileType || 'application/octet-stream' })
          const url = URL.createObjectURL(blob)

          setDownloadUrl(url)
          setSuccess(true)
          setIsScanning(false)
        } catch (err) {
          console.error('Reconstruction error:', err)
          setError('Failed to reconstruct file from chunks')
          reconstructionInitiatedRef.current = false // Reset on error so it can retry
        }
      })()
    }
  }, [receivedChunks.size, totalChunks, success, addDebugLog, initialMetadata.checksum, metadata.fileType])


  const handleStartScan = () => {
    setIsScanning(true)
    setReceivedChunks(new Map())
    setError('')
    setSuccess(false)
    setDownloadUrl('')
  }

  const handleStopScan = () => {
    setIsScanning(false)
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

  const progress = totalChunks > 0 ? (receivedChunks.size / totalChunks) * 100 : 0

  return (
    <div className="space-y-4">
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
          <div className="pointer-events-none absolute inset-0 z-10 rounded-lg border border-white/25 shadow-[0_0_30px_rgba(0,0,0,0.35)]" />
          <div className="absolute top-2 right-2 bg-red-500 text-white px-2 py-1 rounded text-xs font-medium z-20">
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
                  {integrityOk ? `🔐 Integrity verified (checksum matches ${initialMetadata.checksum})` : `❌ Integrity check failed, expected ${initialMetadata.checksum}, but got ${actualChecksum}`}
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
