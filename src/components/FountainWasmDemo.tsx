import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'

interface WorkerResult {
  type: 'result'
  data?: {
    success?: boolean
    seed?: number
    degree?: number
    indices?: number[]
    data?: Uint8Array
    decoded?: boolean
    isComplete?: boolean
    progress?: number
    decodedBlockCount?: number
    receivedChunkCount?: number
    name?: string
    size?: number
    fileType?: string
    timestamp?: number
    totalSourceBlocks?: number
    blockSize?: number
  }
  error?: string
}

export function FountainWasmDemo() {
  const [status, setStatus] = useState<string>('Ready')
  const [error, setError] = useState<string>('')
  const [isEncoding, setIsEncoding] = useState(false)
  const [isDecoding, setIsDecoding] = useState(false)
  const [progress, setProgress] = useState(0)
  const [decodedBlocks, setDecodedBlocks] = useState(0)
  const [totalBlocks, setTotalBlocks] = useState(0)
  const [chunksReceived, setChunksReceived] = useState(0)
  const [decodedData, setDecodedData] = useState<Uint8Array | null>(null)

  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    // Initialize the worker
    const worker = new Worker(
      new URL('../workers/fountain.worker.ts', import.meta.url),
      { type: 'module' }
    )

    worker.onerror = (e) => {
      setError(`Worker error: ${e.message}`)
      setStatus('Error')
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
    }
  }, [])

  const runDemo = async () => {
    if (!workerRef.current) {
      setError('Worker not initialized')
      return
    }

    setError('')
    setStatus('Starting demo...')
    setIsEncoding(true)
    setIsDecoding(false)
    setProgress(0)
    setDecodedData(null)

    const worker = workerRef.current

    try {
      // Create test data
      const testData = new Uint8Array(2000)
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256
      }

      // Initialize encoder
      setStatus('Initializing encoder...')
      await new Promise<void>((resolve, reject) => {
        const handler = (e: MessageEvent<WorkerResult>) => {
          if (e.data.error) {
            reject(new Error(e.data.error))
          } else {
            worker.removeEventListener('message', handler)
            resolve()
          }
        }
        worker.addEventListener('message', handler)
        worker.postMessage({
          type: 'init_encoder',
          data: testData,
          name: 'test.bin',
          fileType: 'application/octet-stream',
          timestamp: Date.now(),
          blockSize: 400,
        })
      })

      // Get metadata
      setStatus('Getting metadata...')
      const metadata = await new Promise<WorkerResult['data']>((resolve, reject) => {
        const handler = (e: MessageEvent<WorkerResult>) => {
          if (e.data.error) {
            reject(new Error(e.data.error))
          } else {
            worker.removeEventListener('message', handler)
            resolve(e.data.data)
          }
        }
        worker.addEventListener('message', handler)
        worker.postMessage({ type: 'get_metadata' })
      })

      if (!metadata || !metadata.totalSourceBlocks) {
        throw new Error('Failed to get metadata')
      }

      setTotalBlocks(metadata.totalSourceBlocks)
      setStatus(`Total blocks: ${metadata.totalSourceBlocks}`)

      // Initialize decoder
      setStatus('Initializing decoder...')
      await new Promise<void>((resolve, reject) => {
        const handler = (e: MessageEvent<WorkerResult>) => {
          if (e.data.error) {
            reject(new Error(e.data.error))
          } else {
            worker.removeEventListener('message', handler)
            resolve()
          }
        }
        worker.addEventListener('message', handler)
        worker.postMessage({
          type: 'init_decoder',
          metadata,
        })
      })

      setIsEncoding(false)
      setIsDecoding(true)
      setStatus('Encoding and decoding...')

      // Generate and decode chunks until complete
      let chunkCount = 0
      const maxChunks = metadata.totalSourceBlocks * 2 // Safety limit

      while (chunkCount < maxChunks) {
        // Generate chunk
        const chunk = await new Promise<WorkerResult['data']>((resolve, reject) => {
          const handler = (e: MessageEvent<WorkerResult>) => {
            if (e.data.error) {
              reject(new Error(e.data.error))
            } else {
              worker.removeEventListener('message', handler)
              resolve(e.data.data)
            }
          }
          worker.addEventListener('message', handler)
          worker.postMessage({ type: 'generate_chunk' })
        })

        // Add chunk to decoder
        const result = await new Promise<WorkerResult['data']>((resolve, reject) => {
          const handler = (e: MessageEvent<WorkerResult>) => {
            if (e.data.error) {
              reject(new Error(e.data.error))
            } else {
              worker.removeEventListener('message', handler)
              resolve(e.data.data)
            }
          }
          worker.addEventListener('message', handler)
          worker.postMessage({ type: 'add_chunk', chunk })
        })

        chunkCount++
        setChunksReceived(chunkCount)

        if (result && result.progress !== undefined) {
          setProgress(Math.round(result.progress * 100))
          setDecodedBlocks(result.decodedBlockCount || 0)
        }

        if (result && result.isComplete) {
          setStatus('Decoding complete!')
          break
        }
      }

      // Get decoded data
      setStatus('Retrieving decoded data...')
      const decoded = await new Promise<Uint8Array | null>((resolve, reject) => {
        const handler = (e: MessageEvent<WorkerResult>) => {
          if (e.data.error) {
            reject(new Error(e.data.error))
          } else {
            worker.removeEventListener('message', handler)
            resolve(e.data.data as Uint8Array | null)
          }
        }
        worker.addEventListener('message', handler)
        worker.postMessage({ type: 'get_decoded_data' })
      })

      if (decoded) {
        setDecodedData(decoded)
        // Verify data
        const isCorrect = decoded.length === testData.length &&
          decoded.every((byte, i) => byte === testData[i])
        setStatus(isCorrect ? 'Success! Data verified.' : 'Error: Data mismatch!')
      } else {
        setStatus('Error: No decoded data')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setStatus('Failed')
    } finally {
      setIsEncoding(false)
      setIsDecoding(false)
    }
  }

  return (
    <div className="container mx-auto p-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Fountain Code WASM Demo</CardTitle>
          <CardDescription>
            Test Rust WASM fountain encoding and decoding
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Controls */}
          <div>
            <Button
              onClick={runDemo}
              disabled={isEncoding || isDecoding}
            >
              {isEncoding || isDecoding ? 'Running...' : 'Run Demo'}
            </Button>
          </div>

          {/* Status */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Status</h3>
            <div className="p-3 bg-muted rounded-md text-sm">
              {status}
            </div>
          </div>

          {/* Progress */}
          {(isEncoding || isDecoding) && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Progress</h3>
              <Progress value={progress} />
              <div className="text-xs text-muted-foreground">
                Decoded: {decodedBlocks} / {totalBlocks} blocks ({progress}%)
                <br />
                Chunks received: {chunksReceived}
              </div>
            </div>
          )}

          {/* Results */}
          {decodedData && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Results</h3>
              <div className="p-3 bg-muted rounded-md text-xs">
                <div>Decoded {decodedData.length} bytes</div>
                <div>Chunks needed: {chunksReceived}</div>
                <div>Overhead: {((chunksReceived / totalBlocks - 1) * 100).toFixed(1)}%</div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive rounded-md text-sm text-destructive">
              Error: {error}
            </div>
          )}

          {/* Info */}
          <div className="text-xs text-muted-foreground pt-4 border-t">
            <p>This demo encodes 2KB of test data and decodes it using fountain codes.</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Rust WASM implementation</li>
              <li>Belief propagation decoder</li>
              <li>Robust soliton distribution</li>
              <li>Web Worker for async processing</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
