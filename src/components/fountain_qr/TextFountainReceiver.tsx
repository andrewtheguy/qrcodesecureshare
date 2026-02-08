import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner'
import { isTextFountainFrame } from '@/utils/textFountainProtocol'
import TextFountainDecoderWorker from '@/workers/textFountainDecoder.worker?worker'

interface TextFountainReceiverProps {
  initialFrame?: Uint8Array | null
  onReset: () => void
}

type ReceiverStatus = 'waiting' | 'decoding' | 'complete' | 'error'

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
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(() =>
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'environment' : 'user'
  )

  const workerRef = useRef<Worker | null>(null)
  const initialFrameProcessedRef = useRef<boolean>(false)

  const sendFrameToWorker = useCallback((frame: Uint8Array) => {
    if (!workerRef.current) return
    const transferFrame = frame.slice()
    workerRef.current.postMessage({ type: 'processFrame', frame: transferFrame }, [transferFrame.buffer])
  }, [])

  useEffect(() => {
    const worker = new TextFountainDecoderWorker()
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | {
            type: 'initialized'
            textByteLength: number
            totalSourceBlocks: number
          }
        | {
            type: 'progress'
            decodedBlockCount: number
            totalSourceBlocks: number
            receivedChunkCount: number
            progress: number
          }
        | {
            type: 'complete'
            text: string
            checksum: string
            byteLength: number
          }
        | {
            type: 'error'
            error: string
          }

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

  const handleScan = useCallback((frames: Uint8Array[]) => {
    if (frames.length === 0) return
    const frame = frames[0]
    if (!isTextFountainFrame(frame)) return
    sendFrameToWorker(frame)
  }, [sendFrameToWorker])

  const { videoRef, canvasRef, availableCameras } = useZXingQRScanner({
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

  useEffect(() => {
    if (status === 'complete' || status === 'error') {
      setIsScanning(false)
    }
  }, [status])

  const handleReset = () => {
    workerRef.current?.postMessage({ type: 'reset' })
    onReset()
  }

  const handleCopyResult = async () => {
    try {
      await navigator.clipboard.writeText(textResult)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      const textArea = document.createElement('textarea')
      textArea.value = textResult
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
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
