import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainEncoder, type FountainChunk } from '@/utils/fountainCode'

interface FountainQRSenderProps {
  file: File
}

// Maximum bytes per QR code chunk (raw data before encoding)
// Reduced to 600 bytes to ensure QR codes fit within size limits
// QR Code capacity at error level M: ~2953 bytes
// Binary overhead: ~6 bytes fixed + (2 * degree) for indices
// Target: keep total under 2000 bytes for safety
const CHUNK_SIZE = 600

// Maximum QR code size in bytes (with some safety margin)
const MAX_QR_DATA_SIZE = 1800 // Conservative limit to ensure QR generation succeeds

export function FountainQRSender({ file }: FountainQRSenderProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(2)
  const [error, setError] = useState<string>('')
  const [chunkCount, setChunkCount] = useState(0)
  const [skippedChunks, setSkippedChunks] = useState(0)
  const [estimatedChunksNeeded, setEstimatedChunksNeeded] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const currentChunkRef = useRef<FountainChunk | null>(null)
  const lastSuccessfulQrRef = useRef<string>('')

  // Initialize fountain encoder when file is loaded
  useEffect(() => {
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer
        const bytes = new Uint8Array(arrayBuffer)

        const metadata = {
          name: file.name,
          size: file.size,
          type: file.type,
          timestamp: Date.now()
        }

        const fountainEncoder = new FountainEncoder(bytes, CHUNK_SIZE, metadata)
        setEncoder(fountainEncoder)
        setError('')
        setChunkCount(0)

        // Estimate chunks needed: typically 105-110% of source blocks
        const meta = fountainEncoder.getMetadata()
        setEstimatedChunksNeeded(Math.ceil(meta.totalSourceBlocks * 1.1))
      } catch (err) {
        setError('Failed to process file')
        console.error(err)
      }
    }

    reader.onerror = () => {
      setError('Failed to read file')
    }

    reader.readAsArrayBuffer(file)
  }, [file])

  // Generate metadata-only QR code (Chunk #0) in binary format
  const generateMetadataQR = async () => {
    if (!encoder) return

    try {
      const metadata = encoder.getMetadata()

      // Binary format for metadata:
      // [0xFF][0xFE] - magic bytes for fountain metadata
      // [nameLen(1)][name bytes...]
      // [typeLen(1)][type bytes...]
      // [size(4 bytes)]
      // [timestamp(4 bytes, seconds)]
      // [blocks(2 bytes)]
      // [blockSize(2 bytes)]

      const nameBytes = new TextEncoder().encode(metadata.name)
      const typeBytes = new TextEncoder().encode(metadata.type)

      const binaryData = new Uint8Array(
        2 + // magic bytes
        1 + nameBytes.length +
        1 + typeBytes.length +
        4 + // size
        4 + // timestamp (seconds)
        2 + // blocks
        2   // blockSize
      )

      let offset = 0
      binaryData[offset++] = 0xFF // Magic byte 1
      binaryData[offset++] = 0xFE // Magic byte 2

      // Name
      binaryData[offset++] = nameBytes.length
      binaryData.set(nameBytes, offset)
      offset += nameBytes.length

      // Type
      binaryData[offset++] = typeBytes.length
      binaryData.set(typeBytes, offset)
      offset += typeBytes.length

      // Size (4 bytes)
      binaryData[offset++] = (metadata.size >> 24) & 0xFF
      binaryData[offset++] = (metadata.size >> 16) & 0xFF
      binaryData[offset++] = (metadata.size >> 8) & 0xFF
      binaryData[offset++] = metadata.size & 0xFF

      // Timestamp (4 bytes, as seconds)
      const timestampSec = Math.floor(metadata.timestamp / 1000)
      binaryData[offset++] = (timestampSec >> 24) & 0xFF
      binaryData[offset++] = (timestampSec >> 16) & 0xFF
      binaryData[offset++] = (timestampSec >> 8) & 0xFF
      binaryData[offset++] = timestampSec & 0xFF

      // Blocks (2 bytes)
      binaryData[offset++] = (metadata.totalSourceBlocks >> 8) & 0xFF
      binaryData[offset++] = metadata.totalSourceBlocks & 0xFF

      // Block size (2 bytes)
      binaryData[offset++] = (metadata.blockSize >> 8) & 0xFF
      binaryData[offset++] = metadata.blockSize & 0xFF

      // Convert to string for QR encoding (ISO-8859-1/Latin1)
      const binaryString = String.fromCharCode(...binaryData)

      const dataUrl = await QRCode.toDataURL(binaryString, {
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      })
      setQrCodeUrl(dataUrl)
      currentChunkRef.current = null // No chunk data for metadata-only
    } catch (err) {
      console.error('QR generation error:', err)
      setError('Failed to generate QR code')
    }
  }

  // Generate and display fountain-coded chunk in binary format
  const generateAndShowNextChunk = async () => {
    if (!encoder) return

    const maxRetries = 20 // Maximum attempts to find a chunk that fits
    let attempt = 0

    while (attempt < maxRetries) {
      try {
        // Generate next fountain-coded chunk
        // Limit degree to 50 to keep overhead small (50 indices * 2 bytes = 100 bytes overhead max)
        const chunk = encoder.generateChunk(50)

        // Binary format for fountain chunk:
        // [0xFF][0xFD] - magic bytes for fountain chunk
        // [seed(2 bytes)]
        // [degree(1 byte)]
        // [numIndices(1 byte)]
        // [indices... (2 bytes each)]
        // [chunk data...]

        const numIndices = chunk.indices.length
        const expectedSize =
          2 + // magic bytes
          2 + // seed
          1 + // degree
          1 + // numIndices
          (numIndices * 2) + // indices (2 bytes each)
          chunk.data.length // chunk data

        // Pre-check: Skip chunks that are too large before attempting QR generation
        if (expectedSize > MAX_QR_DATA_SIZE) {
          console.warn(`Pre-check: Chunk size ${expectedSize} bytes exceeds limit, skipping (attempt ${attempt + 1}/${maxRetries})`)
          setSkippedChunks(prev => prev + 1)
          attempt++
          continue
        }

        const binaryData = new Uint8Array(expectedSize)

        let offset = 0
        binaryData[offset++] = 0xFF // Magic byte 1
        binaryData[offset++] = 0xFD // Magic byte 2 (different from metadata)

        // Seed (2 bytes)
        binaryData[offset++] = (chunk.seed >> 8) & 0xFF
        binaryData[offset++] = chunk.seed & 0xFF

        // Degree (1 byte)
        binaryData[offset++] = chunk.degree & 0xFF

        // Number of indices (1 byte)
        binaryData[offset++] = numIndices & 0xFF

        // Indices (2 bytes each)
        for (const idx of chunk.indices) {
          binaryData[offset++] = (idx >> 8) & 0xFF
          binaryData[offset++] = idx & 0xFF
        }

        // Chunk data
        binaryData.set(chunk.data, offset)

        // Convert to string for QR encoding (ISO-8859-1/Latin1)
        const binaryString = String.fromCharCode(...binaryData)

        const dataUrl = await QRCode.toDataURL(binaryString, {
          width: 400,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })

        // Success! Update state and display
        currentChunkRef.current = chunk
        setChunkCount(prev => prev + 1)
        setQrCodeUrl(dataUrl)
        lastSuccessfulQrRef.current = dataUrl
        return // Exit successfully

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)

        // Check if error is about data being too big
        if (errorMsg.includes('too big') || errorMsg.includes('too large') || errorMsg.includes('too much')) {
          console.warn(`Chunk too large for QR code (attempt ${attempt + 1}/${maxRetries}), generating new chunk...`)
          setSkippedChunks(prev => prev + 1)
          attempt++
          // Try again with a new chunk
          continue
        } else {
          // Other error, stop and report
          console.error('QR generation error:', err)
          setError('Failed to generate QR code: ' + errorMsg)
          return
        }
      }
    }

    // If we exhausted all retries, show warning but keep last successful QR
    console.error(`Failed to generate QR after ${maxRetries} attempts - data chunks too large`)
    setError(`Warning: Some chunks are too large for QR codes (${skippedChunks} skipped)`)
  }

  // Show metadata QR when encoder is ready but not playing
  useEffect(() => {
    if (encoder && !isPlaying && chunkCount === 0) {
      generateMetadataQR()
    }
  }, [encoder, isPlaying, chunkCount])

  // Animation loop
  useEffect(() => {
    if (!isPlaying || !encoder) return

    // Generate first chunk immediately
    generateAndShowNextChunk()

    const interval = setInterval(() => {
      generateAndShowNextChunk()
    }, 1000 / fps)

    return () => clearInterval(interval)
  }, [isPlaying, encoder, fps])

  const handlePlayPause = () => {
    if (!isPlaying && encoder) {
      setChunkCount(0) // Reset counter when starting
      setSkippedChunks(0) // Reset skipped counter
    }
    setIsPlaying(!isPlaying)
  }

  const handleSpeedChange = (newFps: number) => {
    setFps(newFps)
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const progress = estimatedChunksNeeded > 0 ? Math.min((chunkCount / estimatedChunksNeeded) * 100, 100) : 0
  const sourceBlocks = encoder?.getMetadata().totalSourceBlocks || 0

  return (
    <div className="space-y-4">
      {/* QR Code Display */}
      <div className="relative">
        <div className="flex justify-center bg-white p-4 rounded-lg">
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          {qrCodeUrl ? (
            <img
              src={qrCodeUrl}
              alt={`Fountain coded chunk`}
              className="max-w-full h-auto"
            />
          ) : (
            <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
              <p className="text-muted-foreground">
                {encoder ? 'Click Play to start' : 'Processing file...'}
              </p>
            </div>
          )}
        </div>

        {/* Chunk Counter Overlay */}
        <div className="absolute top-2 left-2 right-2 flex justify-between items-start">
          <div className="bg-black/80 text-white px-3 py-2 rounded-lg font-bold text-lg">
            {chunkCount === 0 ? 'Metadata Only' : `Chunk #${chunkCount}`}
          </div>
          {isPlaying && (
            <div className="bg-red-500 text-white px-2 py-1 rounded text-xs font-medium flex items-center gap-1">
              <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
              LIVE
            </div>
          )}
        </div>
      </div>

      {/* Chunk details */}
      {chunkCount === 0 && qrCodeUrl ? (
        <div className="text-xs text-center text-blue-600 dark:text-blue-400 font-medium">
          📦 Scan this first to receive file information
        </div>
      ) : currentChunkRef.current && (
        <div className="text-xs text-center text-muted-foreground">
          <span className="font-medium">Degree: {currentChunkRef.current.degree}</span>
          <span className="mx-2">|</span>
          <span>Blocks: {currentChunkRef.current.indices.slice(0, 10).join(', ')}{currentChunkRef.current.indices.length > 10 ? '...' : ''}</span>
        </div>
      )}

      {/* Progress */}
      {chunkCount > 0 && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Sent {chunkCount} chunks (est. {estimatedChunksNeeded} needed)</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
          <div className="flex items-center justify-between text-xs">
            <p className="text-muted-foreground">
              {chunkCount >= estimatedChunksNeeded
                ? '✅ Receiver should have enough chunks to decode'
                : `${estimatedChunksNeeded - chunkCount} more chunks recommended`}
            </p>
            {skippedChunks > 0 && (
              <p className="text-amber-600 dark:text-amber-400 font-medium">
                ⚠️ Skipped: {skippedChunks}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="space-y-3">
        <div className="flex gap-2 justify-center">
          <Button
            size="sm"
            onClick={handlePlayPause}
            disabled={!encoder}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </Button>
        </div>

        {/* Speed Control */}
        <div className="flex items-center gap-2 justify-center flex-wrap">
          <span className="text-sm text-muted-foreground">Speed:</span>
          {[1, 2, 3, 4, 5].map((speed) => (
            <Button
              key={speed}
              variant={fps === speed ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleSpeedChange(speed)}
              className="w-12"
            >
              {speed}fps
            </Button>
          ))}
        </div>
      </div>

      {/* Instructions */}
      <Alert>
        <AlertDescription>
          <p className="font-medium mb-2">📱 Fountain Code Transfer Mode:</p>
          <ol className="list-decimal list-inside space-y-1 text-sm">
            <li>Each chunk combines multiple source blocks via XOR</li>
            <li>Receiver doesn't need ALL chunks - just enough (~110%)</li>
            <li>Can skip/miss chunks and still decode successfully</li>
            <li>Keep playing until receiver shows 100% decoded</li>
            <li>More robust than sequential chunk transfer</li>
          </ol>
          {skippedChunks > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 pt-3 border-t">
              <span className="font-medium">⚠️ Note:</span> {skippedChunks} chunk{skippedChunks > 1 ? 's were' : ' was'} too large for QR encoding and {skippedChunks > 1 ? 'were' : 'was'} automatically skipped.
              This is normal - fountain coding generates new chunks on the fly.
            </p>
          )}
        </AlertDescription>
      </Alert>
    </div>
  )
}
