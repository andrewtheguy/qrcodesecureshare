import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
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
  const [fps, setFps] = useState(4)
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

        const fountainEncoder = new FountainEncoder(bytes, metadata, {
          blockSize: CHUNK_SIZE,
          c: 0.2,
            delta: 0.01,
          // Optional: override doping rates here if experimenting
          degree1Rate: 0.08,
          lowDegreeRate: 0.15
        })
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

  // Auto-start playback once encoder is ready (no need to wait for receiver now)
  useEffect(() => {
    if (encoder && !isPlaying) {
      // Reset counters for fresh session
      setChunkCount(0)
      setSkippedChunks(0)
      setIsPlaying(true)
    }
    // We intentionally exclude isPlaying setters from deps to avoid restarting mid-session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoder])

  // Generate and display fountain-coded chunk in binary format
  const generateAndShowNextChunk = async () => {
    if (!encoder) return

    const maxRetries = 20 // Maximum attempts to find a chunk that fits
    let attempt = 0

    while (attempt < maxRetries) {
      try {
  // Generate next fountain-coded chunk (internally tuned distribution + doping)
  const chunk = encoder.generateChunk()

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

  // Metadata generation removed – handled by parent component

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
      setChunkCount(0)
      setSkippedChunks(0)
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

  const sourceBlocks = encoder?.getMetadata().totalSourceBlocks || 0

  return (
    <div className="space-y-4">
      {/* QR Code Display (clean container without overlays) */}
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
              {encoder ? 'Generating fountain-coded QR stream…' : 'Processing file...'}
            </p>
          </div>
        )}
      </div>

      {/* Caption / Status outside the QR container */}
      <div className="flex items-center justify-center gap-2 flex-wrap text-xs text-muted-foreground">
        <span className="font-medium">{chunkCount === 0 ? 'Ready' : `Chunk #${chunkCount}`}</span>
        {isPlaying && (
          <span className="px-2 py-0.5 rounded bg-red-500 text-white flex items-center gap-1 font-semibold">
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" /> LIVE
          </span>
        )}
        {skippedChunks > 0 && (
          <span className="px-2 py-0.5 rounded bg-amber-500 text-white font-semibold">Skipped {skippedChunks}</span>
        )}
        {chunkCount >= estimatedChunksNeeded && chunkCount > 0 && (
          <span className="px-2 py-0.5 rounded bg-green-600 text-white font-semibold">Enough Collected</span>
        )}
      </div>

      {/* Chunk details */}
      {(currentChunkRef.current && encoder) && (() => {
        const stats = encoder.getStats()
        return (
          <div className="text-xs text-center text-muted-foreground space-y-1">
            <div>
              <span className="font-medium">Degree: {currentChunkRef.current.degree}</span>
              <span className="mx-2">|</span>
              <span>Blocks: {currentChunkRef.current.indices.slice(0, 10).join(', ')}{currentChunkRef.current.indices.length > 10 ? '...' : ''}</span>
            </div>
            <div className="opacity-80">
              avg degree {stats.avgDegree.toFixed(2)} • coverage {(stats.uniqueBlockCoverage * 100).toFixed(1)}%
            </div>
          </div>
        )
      })()}

      {/* Progress */}
      {chunkCount > 0 && (
        <div className="space-y-1 text-sm">
          <div className="flex flex-wrap justify-center gap-2 text-center">
            <span className="font-medium">Sent {chunkCount} chunk{chunkCount === 1 ? '' : 's'}</span>
            <span className="opacity-70">(~{estimatedChunksNeeded} typically needed)</span>
          </div>
          <div className="flex items-center justify-center gap-3 text-xs flex-wrap">
            <p className="text-muted-foreground">
              {chunkCount >= estimatedChunksNeeded
                ? '✅ Receiver should now be able to decode'
                : `${estimatedChunksNeeded - chunkCount} more recommended for high success chance`}
            </p>
            {skippedChunks > 0 && (
              <p className="text-amber-600 dark:text-amber-400 font-medium">
                ⚠️ Skipped {skippedChunks}
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
