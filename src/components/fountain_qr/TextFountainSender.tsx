import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  TEXT_FOUNTAIN_AUTO_PAUSE_MS,
  TEXT_FOUNTAIN_FPS,
  TEXT_FOUNTAIN_VERSION,
} from '@/constants'
import { computeChecksum } from '@/utils/checksum'
import { DEFAULT_BLOCK_SIZE } from '@/utils/fountainConfig'
import { DEFAULT_FOUNTAIN_ENCODER_OPTIONS, FountainEncoder, type FountainChunk } from '@/utils/fountainCodeWasm'
import { generateFastQrPngBytes } from '@/utils/fastQrWasm'
import { serializeTextFountainFrame } from '@/utils/textFountainProtocol'

const DISPLAY_SIZE = 400

interface TextFountainSenderProps {
  text: string
  onReset: () => void
}

export function TextFountainSender({ text, onReset }: TextFountainSenderProps) {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null)
  const [sessionId, setSessionId] = useState<number>(0)
  const [finalCrc32, setFinalCrc32] = useState<string>('')
  const [qrUrl, setQrUrl] = useState<string>('')
  const [isPreparing, setIsPreparing] = useState<boolean>(true)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [isAutoPaused, setIsAutoPaused] = useState<boolean>(false)
  const [frameCount, setFrameCount] = useState<number>(0)
  const [error, setError] = useState<string>('')

  const textBytesRef = useRef<Uint8Array>(new Uint8Array())
  const generationTimeoutRef = useRef<number | null>(null)
  const autoPauseTimeoutRef = useRef<number | null>(null)
  const isGeneratingRef = useRef<boolean>(false)
  const lastQrUrlRef = useRef<string>('')

  const releaseQrUrl = useCallback((url: string | null) => {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url)
    }
  }, [])

  const fpsLabel = useMemo(() => `${TEXT_FOUNTAIN_FPS} fps`, [])

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

  const updateQrUrl = useCallback((nextUrl: string) => {
    if (lastQrUrlRef.current && lastQrUrlRef.current !== nextUrl) {
      releaseQrUrl(lastQrUrlRef.current)
    }
    lastQrUrlRef.current = nextUrl
    setQrUrl(nextUrl)
  }, [releaseQrUrl])

  useEffect(() => {
    let cancelled = false

    const initialize = async () => {
      try {
        setIsPreparing(true)
        setError('')
        setIsPlaying(false)
        setFrameCount(0)
        clearGenerationTimer()
        clearAutoPauseTimer()
        releaseQrUrl(lastQrUrlRef.current)
        lastQrUrlRef.current = ''
        setQrUrl('')

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
      releaseQrUrl(lastQrUrlRef.current)
      lastQrUrlRef.current = ''
    }
  }, [clearAutoPauseTimer, clearGenerationTimer, releaseQrUrl, text])

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

    const pngBytes = await generateFastQrPngBytes(frameBytes, {
      width: DISPLAY_SIZE,
      margin: 1,
      errorCorrectionLevel: 'L',
      forceByteMode: true,
    })

    const blob = new Blob([pngBytes], { type: 'image/png' })
    const nextUrl = URL.createObjectURL(blob)
    updateQrUrl(nextUrl)
  }, [encoder, finalCrc32, sessionId, updateQrUrl])

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
        if (isPlaying) {
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
    }, TEXT_FOUNTAIN_AUTO_PAUSE_MS)

    return clearAutoPauseTimer
  }, [clearAutoPauseTimer, isPlaying])

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
              Stream auto-paused after 60 seconds. Resume to continue broadcasting frames.
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="mx-auto max-w-[420px] rounded-xl border border-sky-300/40 bg-slate-950/95 p-4">
          {qrUrl ? (
            <img
              src={qrUrl}
              alt="Text fountain frame"
              className="w-full h-auto rounded-lg"
            />
          ) : (
            <div className="aspect-square w-full rounded-lg border border-sky-500/30 bg-sky-500/10 flex items-center justify-center text-sm text-sky-100/80">
              {isPreparing ? 'Preparing stream…' : 'Generating frames…'}
            </div>
          )}
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
