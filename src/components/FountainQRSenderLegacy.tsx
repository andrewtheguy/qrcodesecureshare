import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Slider } from '@/components/ui/slider'
import { Progress } from '@/components/ui/progress'
import { FountainEncoder, type FountainChunk } from '@/utils/fountainCode.legacy'

interface FountainQRSenderLegacyProps {
  file: File
  sessionId: number
}

const MAX_QR_DATA_SIZE = 1800 // bytes

export function FountainQRSenderLegacy({ file, sessionId }: FountainQRSenderLegacyProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(20)
  const [error, setError] = useState<string>('')
  const [chunkCount, setChunkCount] = useState(0)
  const [skippedChunks, setSkippedChunks] = useState(0)
  const [estimatedChunksNeeded, setEstimatedChunksNeeded] = useState(0)

  const currentChunkRef = useRef<FountainChunk | null>(null)
  const lastSuccessfulQrRef = useRef<string>('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  // Initialize encoder when file changes
  useEffect(() => {
    const initializeEncoder = async () => {
      try {
        setError('')
        const arrayBuffer = await file.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)

        const metadata = {
          name: file.name,
          size: bytes.length,
          type: file.type || 'application/octet-stream',
          timestamp: Date.now()
        }

        const encoderInstance = new FountainEncoder(bytes, metadata, {
          blockSize: 600,
          c: 0.2,
          delta: 0.01,
          degree1Rate: 0.08,
          lowDegreeRate: 0.15
        })

        const totalSourceBlocks = Math.ceil(bytes.length / 600)
        const estimatedNeeded = Math.ceil(totalSourceBlocks * 1.1)

        setEncoder(encoderInstance)
        setEstimatedChunksNeeded(estimatedNeeded)
        setChunkCount(0)
        setSkippedChunks(0)

        // Auto-start playback
        setIsPlaying(true)
      } catch (e) {
        setError('Failed to initialize encoder')
        console.error('Encoder initialization error:', e)
      }
    }

    initializeEncoder()
  }, [file])

  // Generate and show next chunk
  const generateAndShowNextChunk = async () => {
    if (!encoder) return

    try {
      let chunk: FountainChunk
      let attempts = 0
      const maxAttempts = 20
      let payloadLength: number

      do {
        chunk = encoder.generateChunk()
        attempts++
        const numIndices = chunk.indices.length
        payloadLength = 6 + (2 * numIndices) + chunk.data.length
      } while (payloadLength > MAX_QR_DATA_SIZE && attempts < maxAttempts)

      if (payloadLength > MAX_QR_DATA_SIZE) {
        setSkippedChunks(prev => prev + 1)
        return // Skip this chunk, try again next time
      }

      // Encode chunk in binary format
      const numIndices = chunk.indices.length
      const totalPayloadLength = 6 + (2 * numIndices) + chunk.data.length
      const binaryData = new Uint8Array(totalPayloadLength)
      binaryData[0] = 0xFF // Magic byte 1
      binaryData[1] = 0xFD // Magic byte 2
      binaryData[2] = chunk.seed >> 8 // Seed high byte
      binaryData[3] = chunk.seed & 0xFF // Seed low byte
      binaryData[4] = chunk.degree // Degree
      binaryData[5] = chunk.indices.length // Num indices

      // Add indices (2 bytes each)
      let offset = 6
      for (const index of chunk.indices) {
        binaryData[offset++] = index >> 8
        binaryData[offset++] = index & 0xFF
      }

      // Add chunk data
      binaryData.set(chunk.data, offset)

      // Convert to binary string
      let binaryString = ''
      for (let i = 0; i < binaryData.length; i++) {
        binaryString += String.fromCharCode(binaryData[i])
      }

      // Generate QR code
      const qrUrl = await QRCode.toDataURL(binaryString, {
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#FFFFFF' }
      })

      setQrCodeUrl(qrUrl)
      setChunkCount(prev => prev + 1)
      currentChunkRef.current = chunk
      lastSuccessfulQrRef.current = qrUrl

    } catch (e) {
      console.error('Chunk generation error:', e)
      setError('Failed to generate chunk')
    }
  }

  // Animation loop
  useEffect(() => {
    if (isPlaying && encoder) {
      generateAndShowNextChunk() // Generate first chunk immediately

      intervalRef.current = setInterval(() => {
        generateAndShowNextChunk()
      }, 1000 / fps)
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [isPlaying, fps, encoder])

  const handlePlayPause = () => {
    if (!isPlaying) {
      // Reset counters when starting fresh
      setChunkCount(0)
      setSkippedChunks(0)
    }
    setIsPlaying(!isPlaying)
  }

  const handleSpeedChange = (value: number[]) => {
    setFps(value[0])
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (!encoder) {
    return (
      <div className="flex justify-center items-center py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2"></div>
          <p className="text-sm text-muted-foreground">Initializing fountain encoder...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* QR Code Display */}
      <div className="flex justify-center bg-white p-4 rounded-lg">
        <div className="relative">
          {qrCodeUrl ? (
            <img
              src={qrCodeUrl}
              alt="Fountain chunk QR"
              className="max-w-full h-auto block"
            />
          ) : (
            <div className="w-[400px] h-[400px] bg-gray-100 rounded flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Generating fountain-coded QR stream...</p>
            </div>
          )}
        </div>
      </div>

      {/* Status caption */}
      <div className="text-center text-xs text-muted-foreground min-h-[1.25rem] flex items-center justify-center">
        {chunkCount > 0 && (
          <>
            <span className="font-mono">{chunkCount.toLocaleString()}</span> chunks sent
            {isPlaying && <span className="ml-2 text-green-600 font-bold">● LIVE</span>}
            {skippedChunks > 0 && (
              <span className="ml-2 text-orange-600">({skippedChunks} skipped)</span>
            )}
          </>
        )}
      </div>

      {/* Chunk details */}
      {currentChunkRef.current && (
        <div className="text-xs text-muted-foreground space-y-1">
          <div className="font-semibold">Current Chunk:</div>
          <div>Degree: {currentChunkRef.current.degree}</div>
          <div>Block indices: {currentChunkRef.current.indices.slice(0, 10).join(', ')}{currentChunkRef.current.indices.length > 10 ? '...' : ''}</div>
          <div>Avg degree: {encoder.getStats().avgDegree.toFixed(2)}</div>
          <div>Coverage: {(encoder.getStats().uniqueBlockCoverage * 100).toFixed(1)}%</div>
        </div>
      )}

      {/* Progress section */}
      <div className="space-y-2">
        <div className="text-sm font-medium">
          Progress: Sent <span className="font-mono">{chunkCount.toLocaleString()}</span> chunks
          (~{estimatedChunksNeeded.toLocaleString()} typically needed)
        </div>
        <Progress value={Math.min((chunkCount / estimatedChunksNeeded) * 100, 100)} />
        {chunkCount < estimatedChunksNeeded && (
          <div className="text-xs text-muted-foreground">
            {Math.max(0, estimatedChunksNeeded - chunkCount).toLocaleString()} more recommended for high success chance
          </div>
        )}
        {skippedChunks > 0 && (
          <Alert>
            <AlertDescription className="text-xs">
              {skippedChunks} chunks were skipped because they exceeded QR capacity ({MAX_QR_DATA_SIZE} bytes).
              This is normal and doesn't affect decoding.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Controls */}
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button
            onClick={handlePlayPause}
            variant={isPlaying ? "secondary" : "default"}
            size="sm"
            className="flex-1"
          >
            {isPlaying ? '⏸️ Pause' : '▶️ Play'}
          </Button>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Speed: {fps} fps</span>
          </div>
          <Slider
            value={[fps]}
            onValueChange={handleSpeedChange}
            min={1}
            max={60}
            step={1}
            className="w-full"
          />
        </div>
      </div>

      {/* Instructions */}
      <Alert>
        <AlertDescription className="text-xs space-y-1">
          <p className="font-medium mb-1">Fountain Code Transfer (Simple Mode):</p>
          <p>• Generates random coded chunks that combine multiple data blocks</p>
          <p>• Receiver needs ~110% of source blocks to decode successfully</p>
          <p>• Can skip/miss chunks and still decode - very robust</p>
          <p>• This simple mode does not require camera access for feedback scanning</p>
          <p>• Receiver will automatically decode when enough chunks are received</p>
        </AlertDescription>
      </Alert>
    </div>
  )
}