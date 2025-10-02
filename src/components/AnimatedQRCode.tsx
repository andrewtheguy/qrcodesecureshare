import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainEncoder, type FountainChunk } from '@/utils/fountainCode'

interface AnimatedQRCodeProps {
  file: File | null
  onReset?: () => void
}

// Maximum bytes per QR code chunk (raw data before encoding)
const CHUNK_SIZE = 1200
export const MAX_FILE_SIZE = 512 * 1024 // 512KB

interface QRChunkData {
  f: 1 // fountain code marker
  s: number // seed
  d: number // degree
  i: number[] // indices
  data: string // base64 encoded chunk data
  m: { // metadata
    name: string
    size: number
    type: string
    timestamp: number
    blocks: number // totalSourceBlocks
    bs: number // blockSize
  }
}

export function AnimatedQRCode({ file, onReset }: AnimatedQRCodeProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(2)
  const [error, setError] = useState<string>('')
  const [chunkCount, setChunkCount] = useState(0)
  const [estimatedChunksNeeded, setEstimatedChunksNeeded] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const currentChunkRef = useRef<FountainChunk | null>(null)

  // Initialize fountain encoder when file is loaded
  useEffect(() => {
    if (!file) {
      setEncoder(null)
      setError('')
      setChunkCount(0)
      return
    }

    if (file.size > MAX_FILE_SIZE) {
      setError(`File size (${(file.size / 1024).toFixed(2)}KB) exceeds maximum of ${(MAX_FILE_SIZE / 1024).toFixed(2)}KB`)
      setEncoder(null)
      return
    }

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

  // Generate and display QR code
  const generateAndShowNextChunk = async () => {
    if (!encoder) return

    try {
      // Generate next fountain-coded chunk
      const chunk = encoder.generateChunk()
      currentChunkRef.current = chunk
      setChunkCount(prev => prev + 1)

      // Package chunk for QR code
      const metadata = encoder.getMetadata()
      const qrData: QRChunkData = {
        f: 1,
        s: chunk.seed,
        d: chunk.degree,
        i: chunk.indices,
        data: btoa(String.fromCharCode(...chunk.data)),
        m: {
          name: metadata.name,
          size: metadata.size,
          type: metadata.type,
          timestamp: metadata.timestamp,
          blocks: metadata.totalSourceBlocks,
          bs: metadata.blockSize
        }
      }

      const dataUrl = await QRCode.toDataURL(JSON.stringify(qrData), {
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      })
      setQrCodeUrl(dataUrl)
    } catch (err) {
      console.error('QR generation error:', err)
      setError('Failed to generate QR code')
    }
  }

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
    }
    setIsPlaying(!isPlaying)
  }

  const handleSpeedChange = (newFps: number) => {
    setFps(newFps)
  }

  if (!file) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-muted-foreground">No file selected</p>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          {onReset && (
            <Button onClick={onReset} className="mt-4 w-full">
              Try Another File
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  const progress = estimatedChunksNeeded > 0 ? Math.min((chunkCount / estimatedChunksNeeded) * 100, 100) : 0
  const sourceBlocks = encoder?.getMetadata().totalSourceBlocks || 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">🔁 Fountain Code Transfer</CardTitle>
        <div className="text-sm text-muted-foreground text-center space-y-1">
          <p className="font-medium">{file.name}</p>
          <p>Size: {(file.size / 1024).toFixed(2)}KB | Source Blocks: {sourceBlocks}</p>
          <p className="text-xs">✨ No need to scan all chunks - fountain coding allows recovery from ~110% of source blocks</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
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
              Chunk #{chunkCount}
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
        {currentChunkRef.current && (
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
            <p className="text-xs text-muted-foreground text-center">
              {chunkCount >= estimatedChunksNeeded
                ? '✅ Receiver should have enough chunks to decode'
                : `${estimatedChunksNeeded - chunkCount} more chunks recommended`}
            </p>
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
            <p className="font-medium mb-2">📱 How Fountain Codes Work:</p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Each chunk combines multiple source blocks via XOR</li>
              <li>Receiver doesn't need ALL chunks - just enough (~110%)</li>
              <li>Can skip/miss chunks and still decode successfully</li>
              <li>Keep playing until receiver shows 100% decoded</li>
              <li>More robust than sequential chunk transfer</li>
            </ol>
          </AlertDescription>
        </Alert>

        {onReset && (
          <Button onClick={onReset} variant="outline" className="w-full">
            Select Different File
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
