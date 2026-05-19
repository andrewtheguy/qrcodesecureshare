import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useRxingQRScanner } from '@/hooks/useRxingQRScanner'
import { isTextFountainFrame } from '@/utils/textFountainProtocol'
import TextFountainDecoderWorker from '@/workers/textFountainDecoder.worker?worker'

interface TextFountainReceiverProps {
  initialFrame?: Uint8Array | null
  onReset: () => void
}

type ReceiverStatus = 'waiting' | 'decoding' | 'complete' | 'error'

type WorkerInitializedMessage = {
  type: 'initialized'
  textByteLength: number
  totalSourceBlocks: number
}

type WorkerProgressMessage = {
  type: 'progress'
  decodedBlockCount: number
  totalSourceBlocks: number
  receivedChunkCount: number
  progress: number
}

type WorkerCompleteMessage = {
  type: 'complete'
  text: string
  checksum: string
  byteLength: number
}

type WorkerErrorMessage = {
  type: 'error'
  error: string
}

type TextFountainWorkerMessage =
  | WorkerInitializedMessage
  | WorkerProgressMessage
  | WorkerCompleteMessage
  | WorkerErrorMessage

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function isValidWorkerMessage(value: unknown): value is TextFountainWorkerMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false
  }

  switch (value.type) {
    case 'initialized':
      return isFiniteNumber(value.textByteLength) && isFiniteNumber(value.totalSourceBlocks)
    case 'progress':
      return (
        isFiniteNumber(value.decodedBlockCount) &&
        isFiniteNumber(value.totalSourceBlocks) &&
        isFiniteNumber(value.receivedChunkCount) &&
        isFiniteNumber(value.progress)
      )
    case 'complete':
      return (
        typeof value.text === 'string' &&
        typeof value.checksum === 'string' &&
        isFiniteNumber(value.byteLength)
      )
    case 'error':
      return typeof value.error === 'string'
    default:
      return false
  }
}

export function TextFountainReceiver({ initialFrame, onReset }: TextFountainReceiverProps) {
  const [status, setStatus] = useState<ReceiverStatus>('waiting')
  const [isScanning, setIsScanning] = useState<boolean>(true)
  const [decodedBlocks, setDecodedBlocks] = useState<number>(0)
  const [totalSourceBlocks, setTotalSourceBlocks] = useState<number>(0)
  const [receivedChunkCount, setReceivedChunkCount] = useState<number>(0)
  const [progress, setProgress] = useState<number>(0)
  const [textResult, setTextResult] = useState<string>('')
  const [checksum, setChecksum] = useState<string>('')
  const [byteLength, setByteLength] = useState<number>(0)
  const [error, setError] = useState<string>('')
  const [cameraError, setCameraError] = useState<string>('')
  const [copied, setCopied] = useState<boolean>(false)
  // NOTE: This reads navigator.userAgent at initialization time and is not SSR-safe.
  // This app is currently client-only (no SSR/hydration deployment target), so this is acceptable.
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(() =>
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'environment' : 'user'
  )

  const workerRef = useRef<Worker | null>(null)
  const initialFrameProcessedRef = useRef<boolean>(false)
  const copiedTimeoutRef = useRef<number | null>(null)

  const sendFrameToWorker = useCallback((frame: Uint8Array) => {
    if (!workerRef.current) return
    const transferFrame = frame.slice()
    workerRef.current.postMessage({ type: 'processFrame', frame: transferFrame }, [transferFrame.buffer])
  }, [])

  useEffect(() => {
    const worker = new TextFountainDecoderWorker()
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent) => {
      const rawMessage: unknown = event.data
      const rawType = isRecord(rawMessage) && typeof rawMessage.type === 'string'
        ? rawMessage.type
        : 'unknown'

      if (!isValidWorkerMessage(rawMessage)) {
        console.error(`[TextFountainReceiver] Ignoring malformed worker message (type=${rawType})`, rawMessage)
        return
      }

      const message = rawMessage

      switch (message.type) {
        case 'initialized': {
          setStatus('decoding')
          setByteLength(message.textByteLength)
          setTotalSourceBlocks(message.totalSourceBlocks)
          break
        }
        case 'progress': {
          setStatus('decoding')
          setDecodedBlocks(message.decodedBlockCount)
          setTotalSourceBlocks(message.totalSourceBlocks)
          setReceivedChunkCount(message.receivedChunkCount)
          setProgress(Math.max(0, Math.min(100, message.progress * 100)))
          break
        }
        case 'complete': {
          setStatus('complete')
          setTextResult(message.text)
          setChecksum(message.checksum)
          setByteLength(message.byteLength)
          setProgress(100)
          setIsScanning(false)
          break
        }
        case 'error': {
          setStatus('error')
          setError(message.error)
          setIsScanning(false)
          break
        }
      }
    }

    worker.onerror = (event) => {
      setStatus('error')
      setError(event.message || 'Worker error while decoding text fountain stream')
      setIsScanning(false)
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (initialFrameProcessedRef.current || !initialFrame || !isTextFountainFrame(initialFrame)) return
    sendFrameToWorker(initialFrame)
    initialFrameProcessedRef.current = true
  }, [initialFrame, sendFrameToWorker])

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        clearTimeout(copiedTimeoutRef.current)
        copiedTimeoutRef.current = null
      }
    }
  }, [])

  const handleScan = useCallback((frames: Uint8Array[]) => {
    if (frames.length === 0) return
    const frame = frames[0]
    if (!isTextFountainFrame(frame)) return
    sendFrameToWorker(frame)
  }, [sendFrameToWorker])

  const { videoRef, canvasRef, availableCameras } = useRxingQRScanner({
    onScan: handleScan,
    onError: (message) => {
      setCameraError(message)
      if (status === 'waiting' || status === 'decoding') {
        setStatus('error')
        setError(message)
      }
    },
    isScanning: isScanning && status !== 'complete' && status !== 'error',
    binary: true,
    scanInterval: 100,
    preferLowRes: true,
    facingMode,
  })

  const handleReset = () => {
    workerRef.current?.postMessage({ type: 'reset' })
    setStatus('waiting')
    setIsScanning(true)
    setDecodedBlocks(0)
    setTotalSourceBlocks(0)
    setReceivedChunkCount(0)
    setProgress(0)
    setTextResult('')
    setChecksum('')
    setByteLength(0)
    setError('')
    setCameraError('')
    setCopied(false)
    initialFrameProcessedRef.current = false
    onReset()
  }

  const handleCopyResult = async () => {
    const scheduleCopiedReset = () => {
      if (copiedTimeoutRef.current !== null) {
        clearTimeout(copiedTimeoutRef.current)
      }
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        copiedTimeoutRef.current = null
      }, 1500)
    }

    try {
      await navigator.clipboard.writeText(textResult)
      setCopied(true)
      scheduleCopiedReset()
    } catch {
      const textArea = document.createElement('textarea')
      textArea.value = textResult
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopied(true)
      scheduleCopiedReset()
    }
  }

  const handleToggleFacingMode = () => {
    setFacingMode((current) => (current === 'environment' ? 'user' : 'environment'))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>📡 Streamlined Text Receiver</CardTitle>
        <CardDescription>
          Scan fountain stream frames continuously until decoding completes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {copied && (
          <Alert>
            <AlertDescription>Copied decoded text to clipboard.</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {cameraError && status !== 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{cameraError}</AlertDescription>
          </Alert>
        )}

        {status !== 'complete' && (
          <div className="space-y-3">
            <video
              ref={videoRef}
              className="w-full max-w-md rounded-lg bg-black mx-auto"
              playsInline
              muted
              autoPlay
            />
            <canvas ref={canvasRef} className="hidden" />

            {availableCameras.length > 1 && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={handleToggleFacingMode}>
                  🔄 Flip Camera ({facingMode})
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Progress value={progress} />
          <div className="text-xs text-muted-foreground flex flex-wrap justify-between gap-2">
            <span>Status: {status}</span>
            <span>
              Blocks: {decodedBlocks}/{totalSourceBlocks || '?'}
            </span>
            <span>Accepted chunks: {receivedChunkCount}</span>
          </div>
        </div>

        {status === 'complete' && (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted p-3">
              <p className="text-xs text-muted-foreground mb-1">Decoded text</p>
              <pre className="text-sm whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto">
                {textResult}
              </pre>
            </div>
            <div className="text-xs text-muted-foreground">
              <p>Bytes: {byteLength}</p>
              <p>Checksum: {checksum}</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button onClick={handleCopyResult}>📋 Copy Text</Button>
              <Button variant="outline" onClick={handleReset}>
                Reset
              </Button>
            </div>
          </div>
        )}

        {status !== 'complete' && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={handleReset}>
              Reset
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
