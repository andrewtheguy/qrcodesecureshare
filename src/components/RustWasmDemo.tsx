import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type WorkerResult = {
  type: 'result'
  message?: string
  error?: string
}

export function RustWasmDemo() {
  const [helloMessage, setHelloMessage] = useState<string>('')
  const [greetMessage, setGreetMessage] = useState<string>('')
  const [name, setName] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    // Initialize the worker
    const worker = new Worker(
      new URL('../workers/rust-hello.worker.ts', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (e: MessageEvent<WorkerResult>) => {
      setIsLoading(false)
      if (e.data.type === 'result') {
        if (e.data.error) {
          setError(e.data.error)
        } else if (e.data.message) {
          // Clear error on success
          setError('')
        }
      }
    }

    worker.onerror = (e) => {
      setIsLoading(false)
      setError(`Worker error: ${e.message}`)
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
    }
  }, [])

  const handleHelloClick = () => {
    if (!workerRef.current) {
      setError('Worker not initialized')
      return
    }

    setIsLoading(true)
    setError('')
    setHelloMessage('')

    const worker = workerRef.current
    const messageHandler = (e: MessageEvent<WorkerResult>) => {
      if (e.data.type === 'result') {
        if (e.data.message) {
          setHelloMessage(e.data.message)
        }
      }
      worker.removeEventListener('message', messageHandler)
    }

    worker.addEventListener('message', messageHandler)
    worker.postMessage({ type: 'hello' })
  }

  const handleGreetClick = () => {
    if (!workerRef.current) {
      setError('Worker not initialized')
      return
    }

    if (!name.trim()) {
      setError('Please enter a name')
      return
    }

    setIsLoading(true)
    setError('')
    setGreetMessage('')

    const worker = workerRef.current
    const messageHandler = (e: MessageEvent<WorkerResult>) => {
      if (e.data.type === 'result') {
        if (e.data.message) {
          setGreetMessage(e.data.message)
        }
      }
      worker.removeEventListener('message', messageHandler)
    }

    worker.addEventListener('message', messageHandler)
    worker.postMessage({ type: 'greet', name: name.trim() })
  }

  return (
    <div className="container mx-auto p-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Rust WASM Demo</CardTitle>
          <CardDescription>
            Test Rust WebAssembly functions through a Web Worker
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Hello World Section */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Hello World Function</h3>
            <div className="flex gap-2">
              <Button
                onClick={handleHelloClick}
                disabled={isLoading}
              >
                {isLoading ? 'Loading...' : 'Get Hello Message'}
              </Button>
            </div>
            {helloMessage && (
              <div className="p-3 bg-muted rounded-md text-sm">
                {helloMessage}
              </div>
            )}
          </div>

          {/* Greet Section */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Greet Function</h3>
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleGreetClick()
                  }
                }}
              />
              <Button
                onClick={handleGreetClick}
                disabled={isLoading || !name.trim()}
              >
                Greet
              </Button>
            </div>
            {greetMessage && (
              <div className="p-3 bg-muted rounded-md text-sm">
                {greetMessage}
              </div>
            )}
          </div>

          {/* Error Display */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive rounded-md text-sm text-destructive">
              Error: {error}
            </div>
          )}

          {/* Info */}
          <div className="text-xs text-muted-foreground pt-4 border-t">
            <p>This demo shows Rust WASM functions called through a Web Worker.</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>WASM module compiled with wasm-pack</li>
              <li>Web Worker pattern for async communication</li>
              <li>TypeScript integration with type safety</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
