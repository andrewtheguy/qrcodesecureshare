import { useState, useEffect, useRef } from 'react'
import QrScanner from 'qr-scanner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainDecoder, type FountainChunk, type FountainMetadata } from '@/utils/fountainCode'

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

interface QRChunkData {
  f?: 1 // fountain code marker
  s?: number // seed
  d?: number // degree
  i?: number[] // indices
  data?: string // base64 encoded chunk data
  m?: { // metadata
    name: string
    size: number
    type: string
    timestamp: number
    blocks: number // totalSourceBlocks
    bs: number // blockSize
  }
}

export function AnimatedQRReceiver() {
  const [isScanning, setIsScanning] = useState(false)

  // Legacy mode state
  const [receivedChunks, setReceivedChunks] = useState<Map<number, ChunkData>>(new Map())
  const [metadata, setMetadata] = useState<ChunkData['meta'] | null>(null)
  const [totalChunks, setTotalChunks] = useState(0)

  // Fountain code mode state
  const [fountainMetadata, setFountainMetadata] = useState<FountainMetadata | null>(null)
  const [receivedFountainChunks, setReceivedFountainChunks] = useState(0)
  const [decodedBlocks, setDecodedBlocks] = useState(0)
  const [isFountainMode, setIsFountainMode] = useState(false)

  const [error, setError] = useState<string>('')
  const [success, setSuccess] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string>('')
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [showDebugLog, setShowDebugLog] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)
  const receivedChunkSeedsRef = useRef<Set<number>>(new Set())
  const fountainDecoderRef = useRef<FountainDecoder | null>(null)

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

      // Check if data starts with '{' - if so, it's JSON
      if (data.trim().startsWith('{')) {
        const parsed: QRChunkData = JSON.parse(data)

        // Check if this is a fountain code chunk
        if (parsed.f === 1 && parsed.s !== undefined && parsed.d !== undefined && parsed.i && parsed.data && parsed.m) {
          addDebugLog('🔁 Detected fountain code chunk')
          handleFountainChunk(parsed)
          return
        }

        // Legacy chunk handling
        addDebugLog('Detected legacy JSON format')
        handleLegacyChunk(data)
      } else {
        addDebugLog('Detected binary format')
        handleLegacyChunk(data)
      }

      setError('')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      addDebugLog(`✗ Error: ${errorMsg}`)
      console.error('Scan error:', err)
      // Don't show error for every failed scan, as non-chunk QR codes may be scanned
    }
  }

  const handleFountainChunk = (parsed: QRChunkData) => {
    if (!parsed.m || !parsed.data || parsed.s === undefined || parsed.d === undefined || !parsed.i) {
      throw new Error('Invalid fountain chunk data')
    }

    // Check for duplicate chunk (same seed)
    if (receivedChunkSeedsRef.current.has(parsed.s)) {
      addDebugLog(`⊗ Duplicate fountain chunk seed ${parsed.s}`)
      return
    }
    receivedChunkSeedsRef.current.add(parsed.s)

    // Initialize decoder if this is the first chunk
    let meta: FountainMetadata
    if (!fountainDecoderRef.current) {
      meta = {
        name: parsed.m.name,
        size: parsed.m.size,
        type: parsed.m.type,
        timestamp: parsed.m.timestamp,
        totalSourceBlocks: parsed.m.blocks,
        blockSize: parsed.m.bs
      }
      const decoder = new FountainDecoder(meta)
      fountainDecoderRef.current = decoder
      setFountainMetadata(meta)
      setIsFountainMode(true)
      addDebugLog(`📦 Initialized fountain decoder: ${meta.name} (${meta.totalSourceBlocks} blocks)`)
    } else {
      // Get metadata from existing decoder
      meta = fountainDecoderRef.current.getMetadata()
    }

    // Decode base64 chunk data
    const binaryString = atob(parsed.data)
    const chunkData = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      chunkData[i] = binaryString.charCodeAt(i)
    }

    const fountainChunk: FountainChunk = {
      seed: parsed.s,
      degree: parsed.d,
      indices: parsed.i,
      data: chunkData
    }

    const decoder = fountainDecoderRef.current
    const decoded = decoder.addChunk(fountainChunk)

    setReceivedFountainChunks(decoder.getReceivedChunkCount())
    setDecodedBlocks(decoder.getDecodedBlockCount())

    addDebugLog(`✓ Fountain chunk #${parsed.s} (degree: ${parsed.d}) - decoded ${decoder.getDecodedBlockCount()}/${meta.totalSourceBlocks} blocks`)

    if (decoded) {
      addDebugLog(`🎉 Decoding complete!`)
      reconstructFountainFile(decoder)
    }
  }

  const handleLegacyChunk = (data: string) => {
    let chunk: ChunkData

    if (data.trim().startsWith('{')) {
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
      // Binary format - convert string to bytes
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xFF
      }

      let offset = 0
      const index = (bytes[offset++] << 8) | bytes[offset++]
      const total = (bytes[offset++] << 8) | bytes[offset++]
      const nameLen = bytes[offset++]
      if (nameLen > 255 || offset + nameLen > bytes.length) {
        throw new Error('Invalid binary format: nameLen out of bounds')
      }
      const name = new TextDecoder().decode(bytes.slice(offset, offset + nameLen))
      offset += nameLen
      const typeLen = bytes[offset++]
      if (typeLen > 255 || offset + typeLen > bytes.length) {
        throw new Error('Invalid binary format: typeLen out of bounds')
      }
      const type = new TextDecoder().decode(bytes.slice(offset, offset + typeLen))
      offset += typeLen
      const size = (bytes[offset++] << 24) | (bytes[offset++] << 16) | (bytes[offset++] << 8) | bytes[offset++]
      const chunkData = bytes.slice(offset)

      addDebugLog(`Binary chunk ${index + 1}/${total} - ${name} (${chunkData.length} bytes)`)

      chunk = {
        meta: { name, type, size, timestamp: Date.now() },
        index,
        total,
        encoding: 'binary',
        data: btoa(String.fromCharCode(...chunkData))
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
  }

  const reconstructFountainFile = (decoder: FountainDecoder) => {
    try {
      const meta = decoder.getMetadata()
      const decodedData = decoder.getDecodedData()

      if (!decodedData) {
        const decodedCount = decoder.getDecodedBlockCount()
        addDebugLog(`❌ Decode failed: only ${decodedCount}/${meta.totalSourceBlocks} blocks decoded`)
        throw new Error(`Failed to decode data: only ${decodedCount}/${meta.totalSourceBlocks} blocks decoded`)
      }

      // Create a proper ArrayBuffer from the decoded data
      const bytes = new Uint8Array(decodedData)

      // Create blob and download URL
      const blob = new Blob([bytes], { type: meta.type || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)

      setDownloadUrl(url)
      setSuccess(true)
      setIsScanning(false)

      // Stop scanner
      if (scannerRef.current) {
        scannerRef.current.stop()
      }

      addDebugLog(`✅ File reconstructed: ${meta.name} (${bytes.length} bytes)`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      console.error('Fountain reconstruction error:', err)
      addDebugLog(`✗ Reconstruction error: ${errMsg}`)
      setError('Failed to reconstruct file from fountain chunks')
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
    fountainDecoderRef.current = null
    setFountainMetadata(null)
    setReceivedFountainChunks(0)
    setDecodedBlocks(0)
    setIsFountainMode(false)
    receivedChunkSeedsRef.current.clear()
    setError('')
    setSuccess(false)
    setDownloadUrl('')
    setIsScanning(false)
  }

  const handleDownload = () => {
    const fileName = isFountainMode ? fountainMetadata?.name : metadata?.name
    if (!downloadUrl || !fileName) return

    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Calculate progress based on mode
  const progress = isFountainMode
    ? fountainMetadata
      ? (decodedBlocks / fountainMetadata.totalSourceBlocks) * 100
      : 0
    : totalChunks > 0
      ? (receivedChunks.size / totalChunks) * 100
      : 0

  const hasMissingChunks = !isFountainMode && totalChunks > 0 && receivedChunks.size < totalChunks && receivedChunks.size > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">
          {isFountainMode ? '🔁 Fountain Code Receiver' : 'QR Code Receiver'}
        </CardTitle>
        {(metadata || fountainMetadata) && (
          <div className="text-sm text-muted-foreground text-center space-y-1">
            <p className="font-medium">{isFountainMode ? fountainMetadata?.name : metadata?.name}</p>
            <p>Expected size: {(((isFountainMode ? fountainMetadata?.size : metadata?.size) || 0) / 1024).toFixed(2)}KB</p>
            {isFountainMode && fountainMetadata && (
              <p className="text-xs">Mode: Fountain Coding (no need to scan all chunks)</p>
            )}
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
        {(totalChunks > 0 || isFountainMode) && !success && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              {isFountainMode ? (
                <span>Decoded {decodedBlocks} of {fountainMetadata?.totalSourceBlocks || 0} blocks</span>
              ) : (
                <span>Received {receivedChunks.size} of {totalChunks} chunks</span>
              )}
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} />
          </div>
        )}

        {/* Chunk Grid - Legacy mode only */}
        {!isFountainMode && totalChunks > 0 && !success && (
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

        {/* Fountain Code Progress Display */}
        {isFountainMode && fountainMetadata && !success && (
          <Alert>
            <AlertDescription>
              <div className="space-y-2">
                <p className="font-medium">🔁 Fountain Code Decoding</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Received chunks:</span>
                    <span className="ml-2 font-medium">{receivedFountainChunks}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Decoded blocks:</span>
                    <span className="ml-2 font-medium">{decodedBlocks}/{fountainMetadata.totalSourceBlocks}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Efficiency:</span>
                    <span className="ml-2 font-medium">
                      {decodedBlocks > 0 ? ((receivedFountainChunks / decodedBlocks) * 100).toFixed(0) : 0}%
                    </span>
                  </div>
                </div>
                {decodedBlocks < fountainMetadata.totalSourceBlocks && (
                  <p className="text-xs text-muted-foreground">
                    Need ~{Math.ceil(fountainMetadata.totalSourceBlocks * 1.1) - receivedFountainChunks} more chunks to decode
                  </p>
                )}
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
                <p className="font-medium text-green-600">
                  ✅ File received successfully!
                  {isFountainMode && (
                    <span className="block text-sm font-normal text-muted-foreground mt-1">
                      Decoded using fountain codes ({receivedFountainChunks} chunks received)
                    </span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button onClick={handleDownload} className="flex-1">
                    📥 Download {isFountainMode ? fountainMetadata?.name : metadata?.name}
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
