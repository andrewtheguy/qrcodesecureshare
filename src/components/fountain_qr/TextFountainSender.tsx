import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  TEXT_FOUNTAIN_AUTO_PAUSE_MIN_MS,
  TEXT_FOUNTAIN_FPS,
  TEXT_FOUNTAIN_VERSION,
} from '@/constants'
import { computeChecksum } from '@/utils/checksum'
import { generateFastQrModuleMatrix } from '@/utils/fastQrWasm'
import { DEFAULT_FOUNTAIN_ENCODER_OPTIONS, type FountainChunk, FountainEncoder } from '@/utils/fountainCodeWasm'
import { DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig'
import { renderQrModulesToCanvas } from '@/utils/qrCanvasRenderer'
import { serializeTextFountainFrame } from '@/utils/textFountainProtocol'

const DISPLAY_SIZE = 400
const AUTO_PAUSE_PADDING = 2
const DECODE_OVERHEAD_RATIO = 1.1

interface TextFountainSenderProps {
  text: string
  onReset: () => void
}

export function TextFountainSender({ text, onReset }: TextFountainSenderProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [sessionId, setSessionId] = useState<number>(0)
  const [finalCrc32, setFinalCrc32] = useState<string>('')
  const [hasFrame, setHasFrame] = useState<boolean>(false)
  const [isPreparing, setIsPreparing] = useState<boolean>(true)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [isAutoPaused, setIsAutoPaused] = useState<boolean>(false)
  const [frameCount, setFrameCount] = useState<number>(0)
  const [error, setError] = useState<string>('')

  const textBytesRef = useRef<Uint8Array>(new Uint8Array())
  const generationTimeoutRef = useRef<number | null>(null)
  const autoPauseTimeoutRef = useRef<number | null>(null)
  const isGeneratingRef = useRef<boolean>(false)
  const isPlayingRef = useRef<boolean>(isPlaying)
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const fpsLabel = useMemo(() => `${TEXT_FOUNTAIN_FPS} fps`, [])

  const estimatedAutoPauseMs = useMemo(() => {
    if (!encoder || TEXT_FOUNTAIN_FPS <= 0) {
      return TEXT_FOUNTAIN_AUTO_PAUSE_MIN_MS
    }

    const baseChunks = encoder.getMetadata().totalSourceBlocks
    if (!baseChunks || baseChunks <= 0) {
      return TEXT_FOUNTAIN_AUTO_PAUSE_MIN_MS
    }

    const estimatedChunksNeeded = Math.ceil(baseChunks * DECODE_OVERHEAD_RATIO)
    const paddedChunks = Math.ceil(estimatedChunksNeeded * AUTO_PAUSE_PADDING)
    const estimatedMs = Math.ceil((paddedChunks / TEXT_FOUNTAIN_FPS) * 1000)

    return Math.max(TEXT_FOUNTAIN_AUTO_PAUSE_MIN_MS, estimatedMs)
  }, [encoder])

  const clearGenerationTimer = useCallback(() => {
    if (generationTimeoutRef.current !== null) {
      clearTimeout(generationTimeoutRef.current)
      generationTimeoutRef.current = null
    }
  }, [])

  const clearAutoPauseTimer = useCallback(() => {
    if (autoPauseTimeoutRef.current !== null) {
      clearTimeout(autoPauseTimeoutRef.current)
      autoPauseTimeoutRef.current = null
    }
  }, [])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    let cancelled = false

    const initialize = async () => {
      try {
        setIsPreparing(true)
        setError('')
        setIsPlaying(false)
        setFrameCount(0)
        setHasFrame(false)
        clearGenerationTimer()
        clearAutoPauseTimer()

        const textBytes = new TextEncoder().encode(text)
        textBytesRef.current = textBytes

        const checksum = await computeChecksum(textBytes, 'crc32')
        const generatedSessionId = Math.floor(Math.random() * 0x10000)

        const fountainEncoder = await FountainEncoder.create(
          textBytes,
          {
            name: 'text-fountain.txt',
            fileType: 'text/plain',
            timestamp: Date.now(),
          },
          {
            ...DEFAULT_FOUNTAIN_ENCODER_OPTIONS,
            blockSize: DEFAULT_BLOCK_SIZE,
            maxQrDataSize: 900,
          },
          {
            enabled: false,
            partSize: 0,
          }
        )

        if (cancelled) return

        setEncoder(fountainEncoder)
        setFinalCrc32(checksum)
        setSessionId(generatedSessionId)
        setIsPlaying(true)
      } catch (err) {
        if (cancelled) return
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(`Failed to initialize text fountain stream: ${errorMessage}`)
      } finally {
        if (!cancelled) {
          setIsPreparing(false)
        }
      }
    }

    void initialize()

    return () => {
      cancelled = true
      clearGenerationTimer()
      clearAutoPauseTimer()
    }
  }, [clearAutoPauseTimer, clearGenerationTimer, text])

  const renderChunk = useCallback(async (chunk: FountainChunk) => {
    if (!encoder) return

    const metadata = encoder.getMetadata()

    const frameBytes = await serializeTextFountainFrame({
      version: TEXT_FOUNTAIN_VERSION,
      sessionId,
      textByteLength: metadata.size,
      blockSize: metadata.blockSize,
      totalSourceBlocks: metadata.totalSourceBlocks,
      finalCrc32,
      seed: chunk.seed,
      degree: chunk.degree,
      indices: chunk.indices,
      chunkData: chunk.data,
    })

    const matrix = await generateFastQrModuleMatrix(frameBytes, {
      margin: 1,
      errorCorrectionLevel: 'L',
      mode: 'byte',
    })

    const canvas = qrCanvasRef.current
    if (!canvas) {
      throw new Error('Text fountain canvas is unavailable')
    }

    renderQrModulesToCanvas(canvas, matrix.moduleCount, matrix.modules, {
      size: DISPLAY_SIZE,
      darkColor: '#000000',
      lightColor: '#FFFFFF',
    })
    setHasFrame(true)
  }, [encoder, finalCrc32, sessionId])

  const generateNextFrame = useCallback(async () => {
    if (!encoder || !isPlaying || isGeneratingRef.current) return
    isGeneratingRef.current = true

    try {
      const chunk = encoder.generateChunk()
      await renderChunk(chunk)
      setFrameCount((count) => count + 1)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(`Failed to generate stream frame: ${errorMessage}`)
      setIsPlaying(false)
    } finally {
      isGeneratingRef.current = false
    }
  }, [encoder, isPlaying, renderChunk])

  useEffect(() => {
    clearGenerationTimer()
    if (!isPlaying || !encoder) return

    const schedule = () => {
      generationTimeoutRef.current = window.setTimeout(async () => {
        await generateNextFrame()
        if (isPlayingRef.current) {
          schedule()
        }
      }, Math.floor(1000 / TEXT_FOUNTAIN_FPS))
    }

    void generateNextFrame()
    schedule()

    return clearGenerationTimer
  }, [clearGenerationTimer, encoder, generateNextFrame, isPlaying])

  useEffect(() => {
    clearAutoPauseTimer()
    if (!isPlaying) return

    autoPauseTimeoutRef.current = window.setTimeout(() => {
      setIsPlaying(false)
      setIsAutoPaused(true)
    }, estimatedAutoPauseMs)

    return clearAutoPauseTimer
  }, [clearAutoPauseTimer, estimatedAutoPauseMs, isPlaying])

  const handlePause = () => {
    setIsPlaying(false)
    setIsAutoPaused(false)
  }

  const handleResume = () => {
    setIsPlaying(true)
    setIsAutoPaused(false)
  }

  return (
    <Card className="border-sky-200">
      <CardHeader className="space-y-2">
        <CardTitle>🔁 Streamlined Fountain Mode</CardTitle>
        <CardDescription>
          Long text is being streamed as self-contained fountain QR frames.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <Badge variant={isPlaying ? 'default' : 'secondary'}>
            {isPlaying ? 'Streaming' : 'Paused'}
          </Badge>
          <Badge variant="outline">{fpsLabel}</Badge>
          <Badge variant="outline">Session {sessionId}</Badge>
          <Badge variant="outline">{textBytesRef.current.length} bytes</Badge>
        </div>

        {isAutoPaused && (
          <Alert>
            <AlertDescription>
              Stream auto-paused after {Math.ceil(estimatedAutoPauseMs / 1000)} seconds. Resume to continue broadcasting frames.
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="mx-auto w-fit max-w-full rounded-xl border border-sky-300/40 bg-slate-950/95 p-2">
          <div className="relative">
            <canvas
              ref={qrCanvasRef}
              width={DISPLAY_SIZE}
              height={DISPLAY_SIZE}
              aria-label="Text fountain frame"
              role="img"
              className={`mx-auto block w-auto max-w-full h-auto bg-white ${hasFrame ? 'opacity-100' : 'opacity-0'}`}
            />
            {!hasFrame && (
              <div
                className="absolute inset-0 rounded-lg border border-sky-500/30 bg-sky-500/10 flex items-center justify-center text-sm text-sky-100/80"
              >
                {isPreparing ? 'Preparing stream…' : 'Generating frames…'}
              </div>
            )}
          </div>
        </div>

        <div className="text-sm text-muted-foreground text-center">
          Frames sent: <span className="font-medium text-foreground">{frameCount}</span>
        </div>

        <div className="flex gap-2 justify-center flex-wrap">
          {isPlaying ? (
            <Button variant="outline" onClick={handlePause} disabled={isPreparing || !!error}>
              Pause
            </Button>
          ) : (
            <Button onClick={handleResume} disabled={isPreparing || !!error}>
              Resume
            </Button>
          )}
          <Button variant="destructive" onClick={onReset}>
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
