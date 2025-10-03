import { useState, useEffect, useRef } from 'react'
import QrScanner from 'qr-scanner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainDecoder, type FountainMetadata } from '@/utils/fountainCode'

interface FountainQRReceiverProps {
  initialMetadata: {
    name: string
    size: number
    type: string
    totalSourceBlocks: number
    blockSize?: number
  }
}

export function FountainQRReceiver({ initialMetadata }: FountainQRReceiverProps) {
  // Initialize metadata and decoder immediately (always provided by parent)
  const initialMeta: FountainMetadata = {
    name: initialMetadata.name,
    size: initialMetadata.size,
    type: initialMetadata.type,
    timestamp: Date.now(),
    totalSourceBlocks: initialMetadata.totalSourceBlocks,
    blockSize: initialMetadata.blockSize || 600
  }

  const [isScanning, setIsScanning] = useState(false)
  const [fountainMetadata] = useState<FountainMetadata>(initialMeta)
  const [receivedFountainChunks, setReceivedFountainChunks] = useState(0)
  const [decodedBlocks, setDecodedBlocks] = useState(0)
  const [error, setError] = useState<string>('')
  const [success, setSuccess] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [debugLog, setDebugLog] = useState<string[]>([`[${new Date().toLocaleTimeString()}] 📦 Initialized with metadata: ${initialMeta.name} (${initialMeta.totalSourceBlocks} blocks, ${initialMeta.blockSize} bytes/block)`])
  const [showDebugLog, setShowDebugLog] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)
  const receivedChunkSeedsRef = useRef<Set<number>>(new Set())
  const fountainDecoderRef = useRef<FountainDecoder>(new FountainDecoder(initialMeta))

  // Auto-start scanning on mount
  useEffect(() => {
    setIsScanning(true)
  }, [])

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

      addDebugLog(`Scanned chunk, length: ${data.length} bytes`)

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
  }

  const handleBinaryFountainChunk = (bytes: Uint8Array) => {
    // Binary format: [0xFF][0xFD][seed(2)][degree(1)][numIndices(1)][indices...(2 each)][data...]
    let offset = 2 // Skip magic bytes

    // Read seed (2 bytes)
    const seed = (bytes[offset++] << 8) | bytes[offset++]

    // Check for duplicate seed
    if (receivedChunkSeedsRef.current.has(seed)) {
      addDebugLog(`⊗ Duplicate chunk seed ${seed}, ignoring`)
      return
    }
    receivedChunkSeedsRef.current.add(seed)

    // Read degree (1 byte)
    const degree = bytes[offset++]

    // Read numIndices (1 byte)
    const numIndices = bytes[offset++]

    // Read indices (2 bytes each)
    const indices: number[] = []
    for (let i = 0; i < numIndices; i++) {
      const idx = (bytes[offset++] << 8) | bytes[offset++]
      indices.push(idx)
    }

    // Read chunk data (rest of bytes)
    const data = bytes.slice(offset)

    // Metadata is always available (provided by parent)
    const chunk = { seed, degree, indices, data }

    const decoded = fountainDecoderRef.current.addChunk(chunk)
    setReceivedFountainChunks(prev => prev + 1)
    setDecodedBlocks(fountainDecoderRef.current.getDecodedBlockCount())

    addDebugLog(`✓ Fountain chunk #${seed} (degree: ${degree}) - decoded ${fountainDecoderRef.current.getDecodedBlockCount()}/${fountainMetadata.totalSourceBlocks} blocks`)

    if (decoded) {
      addDebugLog(`🎉 Decoding complete!`)
      reconstructFountainFile(fountainDecoderRef.current)
    }
  }

  const reconstructFountainFile = (decoder: FountainDecoder) => {
    try {
      const reconstructedData = decoder.getDecodedData()
      if (!reconstructedData) {
        throw new Error('Failed to get decoded data')
      }

      // Ensure we pass an ArrayBuffer or valid BlobPart; slice to detach if needed
      const uint8Copy = new Uint8Array(reconstructedData) // Ensures standard Uint8Array
      const blob = new Blob([uint8Copy], { type: fountainMetadata.type || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)

      setDownloadUrl(url)
      setSuccess(true)
      setIsScanning(false)

      // Stop scanner
      if (scannerRef.current) {
        scannerRef.current.stop()
      }

      addDebugLog(`✓ File reconstructed successfully: ${reconstructedData.length} bytes`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error('Reconstruction error:', err)
      addDebugLog(`✗ Reconstruction error: ${errMsg}`)
      setError('Failed to reconstruct file from fountain chunks')
    }
  }

  const handleStartScan = () => {
    setIsScanning(true)
    setReceivedFountainChunks(0)
    setDecodedBlocks(0)
    receivedChunkSeedsRef.current = new Set()
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
    setReceivedFountainChunks(0)
    setDecodedBlocks(0)
    receivedChunkSeedsRef.current.clear()
    setError('')
    setSuccess(false)
    setDownloadUrl('')
    setIsScanning(false)
  }

  const handleDownload = () => {
    if (!downloadUrl || !fountainMetadata) return

    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = fountainMetadata.name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const progress = fountainMetadata
    ? (decodedBlocks / fountainMetadata.totalSourceBlocks) * 100
    : 0

  const estimatedChunksNeeded = fountainMetadata
    ? Math.ceil(fountainMetadata.totalSourceBlocks * 1.1)
    : 0

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
      {fountainMetadata && !success && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Decoded {decodedBlocks} of {fountainMetadata.totalSourceBlocks} blocks</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
          <div className="text-xs text-muted-foreground">
            Received {receivedFountainChunks} chunks (est. {estimatedChunksNeeded} needed)
          </div>
        </div>
      )}

      {/* Metadata Info */}
      {fountainMetadata && !success && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">{fountainMetadata.name}</p>
            <p className="text-sm text-muted-foreground">
              Expected size: {(fountainMetadata.size / 1024).toFixed(2)}KB |
              Blocks: {fountainMetadata.totalSourceBlocks}
            </p>
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
              <p className="font-medium text-green-600">
                ✅ File decoded successfully!
                <span className="block text-sm font-normal text-muted-foreground mt-1">
                  Decoded using fountain codes ({receivedFountainChunks} chunks received)
                </span>
              </p>
              <div className="flex gap-2">
                <Button onClick={handleDownload} className="flex-1">
                  📥 Download {fountainMetadata?.name}
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
            <p className="font-medium mb-2">📱 Fountain Code Transfer Mode:</p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Click "Start Scanning" to activate camera</li>
              <li>Scan the metadata QR code first</li>
              <li>Then scan fountain-coded chunks</li>
              <li>You only need ~110% of chunks (can miss some)</li>
              <li>Progress shows decoded blocks, not chunks scanned</li>
              <li>File will download when fully decoded</li>
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
