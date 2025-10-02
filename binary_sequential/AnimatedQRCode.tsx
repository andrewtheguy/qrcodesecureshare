import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface AnimatedQRCodeProps {
  file: File | null
  onReset?: () => void
}

// Maximum bytes per QR code chunk - using binary mode instead of base64
// QR max ~2953 bytes (byte mode, error correction M)
// Binary mode is more efficient (no base64 overhead)
const CHUNK_SIZE = 1200 // bytes of raw binary data
export const MAX_FILE_SIZE = 512 * 1024 // 512KB

export function AnimatedQRCode({ file, onReset }: AnimatedQRCodeProps) {
  const [metadataChunk, setMetadataChunk] = useState<string>('') // Separate metadata chunk
  const [dataChunks, setDataChunks] = useState<string[]>([]) // Data chunks only (0-based)
  const [currentChunk, setCurrentChunk] = useState(0)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [fps, setFps] = useState(2) // frames per second
  const [error, setError] = useState<string>('')
  const [repeatMode, setRepeatMode] = useState(true) // Auto-repeat animation
  const [loopCount, setLoopCount] = useState(0)
  const [scanningFeedback, setScanningFeedback] = useState(false)
  const [missingChunksQueue, setMissingChunksQueue] = useState<number[]>([])
  const [playingMissingOnly, setPlayingMissingOnly] = useState(false)
  const [showMetadata, setShowMetadata] = useState(true) // Show metadata QR initially
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const feedbackVideoRef = useRef<HTMLVideoElement>(null)
  const feedbackScannerRef = useRef<QrScanner | null>(null)

  // Process file into chunks
  useEffect(() => {
    if (!file) {
      setMetadataChunk('')
      setDataChunks([])
      setError('')
      return
    }

    if (file.size > MAX_FILE_SIZE) {
      setError(`File size (${(file.size / 1024).toFixed(2)}KB) exceeds maximum of ${(MAX_FILE_SIZE / 1024).toFixed(2)}KB`)
      setMetadataChunk('')
      setDataChunks([])
      return
    }

    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer
        const bytes = new Uint8Array(arrayBuffer)

        // Calculate number of data chunks needed
        const totalDataChunks = Math.ceil(bytes.length / CHUNK_SIZE)

        // Encode text fields using TextEncoder
        const nameBytes = new TextEncoder().encode(file.name)
        const typeBytes = new TextEncoder().encode(file.type || 'application/octet-stream')

        // Create metadata chunk (binary format)
        // Format: [type=0 (1 byte)][total data chunks (2 bytes)][name length (1 byte)][name][type length (1 byte)][type][file size (4 bytes)]
        const metadataSize = 1 + 2 + 1 + nameBytes.length + 1 + typeBytes.length + 4
        const metadataBytes = new Uint8Array(metadataSize)
        let offset = 0

        // Chunk type: 0 = metadata
        metadataBytes[offset++] = 0

        // Total data chunks (2 bytes, big-endian)
        metadataBytes[offset++] = (totalDataChunks >> 8) & 0xFF
        metadataBytes[offset++] = totalDataChunks & 0xFF

        // Name
        metadataBytes[offset++] = nameBytes.length
        metadataBytes.set(nameBytes, offset)
        offset += nameBytes.length

        // Type
        metadataBytes[offset++] = typeBytes.length
        metadataBytes.set(typeBytes, offset)
        offset += typeBytes.length

        // File size (4 bytes, big-endian)
        metadataBytes[offset++] = (bytes.length >> 24) & 0xFF
        metadataBytes[offset++] = (bytes.length >> 16) & 0xFF
        metadataBytes[offset++] = (bytes.length >> 8) & 0xFF
        metadataBytes[offset++] = bytes.length & 0xFF

        // Convert metadata to string for QR encoding (using Latin-1 encoding)
        setMetadataChunk(String.fromCharCode(...metadataBytes))

        // Create data chunks (0-based indexing)
        // Format: [type=1 (1 byte)][chunk index (2 bytes)][data (up to CHUNK_SIZE bytes)]
        const newDataChunks: string[] = []
        for (let i = 0; i < totalDataChunks; i++) {
          const start = i * CHUNK_SIZE
          const end = Math.min(start + CHUNK_SIZE, bytes.length)
          const dataBytes = bytes.slice(start, end)

          // Create chunk with type and index header
          const chunkWithHeader = new Uint8Array(1 + 2 + dataBytes.length)
          let chunkOffset = 0

          // Chunk type: 1 = data
          chunkWithHeader[chunkOffset++] = 1

          // Chunk index (2 bytes, big-endian)
          chunkWithHeader[chunkOffset++] = (i >> 8) & 0xFF
          chunkWithHeader[chunkOffset++] = i & 0xFF

          // Data payload
          chunkWithHeader.set(dataBytes, chunkOffset)

          // Convert to string using Latin-1 encoding (preserves all byte values)
          newDataChunks.push(String.fromCharCode(...chunkWithHeader))
        }

        setDataChunks(newDataChunks)
        setCurrentChunk(0)
        setShowMetadata(true) // Reset to show metadata when new file is loaded
        setError('')
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

  // Generate QR code for current chunk
  useEffect(() => {
    if (!metadataChunk && dataChunks.length === 0) {
      setQrCodeUrl('')
      return
    }

    const generateQR = async () => {
      try {
        // Select the appropriate chunk (metadata or data)
        const chunkString = showMetadata ? metadataChunk : dataChunks[currentChunk]
        if (!chunkString) return

        // Convert string back to byte array for binary QR generation
        const bytes = new Uint8Array(chunkString.length)
        for (let i = 0; i < chunkString.length; i++) {
          bytes[i] = chunkString.charCodeAt(i) & 0xFF
        }

        const dataUrl = await QRCode.toDataURL([{ data: bytes, mode: 'byte' }], {
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

    generateQR()
  }, [metadataChunk, dataChunks, currentChunk, showMetadata])

  // Animation loop
  useEffect(() => {
    if (!isPlaying || dataChunks.length === 0) return

    const interval = setInterval(() => {
      setCurrentChunk((prev) => {
        // If playing only missing chunks, use the queue
        if (playingMissingOnly && missingChunksQueue.length > 0) {
          const currentIndexInQueue = missingChunksQueue.indexOf(prev)
          const nextIndexInQueue = currentIndexInQueue + 1

          if (nextIndexInQueue >= missingChunksQueue.length) {
            setLoopCount((count) => count + 1)
            return repeatMode ? missingChunksQueue[0] : prev
          }
          return missingChunksQueue[nextIndexInQueue]
        }

        // Normal playback - 0-based data chunks
        const next = prev + 1
        if (next >= dataChunks.length) {
          setLoopCount((count) => count + 1)
          return repeatMode ? 0 : prev // Loop back to first data chunk (index 0)
        }
        return next
      })
    }, 1000 / fps)

    return () => clearInterval(interval)
  }, [isPlaying, dataChunks.length, fps, repeatMode, playingMissingOnly, missingChunksQueue])

  const handlePlayPause = () => {
    if (!isPlaying && showMetadata) {
      // When starting play from metadata, move to first data chunk
      setShowMetadata(false)
      setCurrentChunk(0)
    }
    setIsPlaying(!isPlaying)
  }

  const handleNext = () => {
    if (showMetadata) {
      setShowMetadata(false)
      setCurrentChunk(0)
    } else {
      // Navigate through data chunks (0-based)
      setCurrentChunk((prev) => {
        const next = prev + 1
        if (next >= dataChunks.length) return 0 // Loop to first data chunk
        return next
      })
    }
  }

  const handlePrevious = () => {
    if (showMetadata) return // Can't go back from metadata
    setCurrentChunk((prev) => {
      const prevChunk = prev - 1
      if (prevChunk < 0) return dataChunks.length - 1 // Loop to last data chunk
      return prevChunk
    })
  }

  const handleSpeedChange = (newFps: number) => {
    setFps(newFps)
  }

  // Feedback scanner initialization
  useEffect(() => {
    if (!scanningFeedback || !feedbackVideoRef.current) {
      return
    }

    const scanner = new QrScanner(
      feedbackVideoRef.current,
      (result) => {
        handleFeedbackScan(result.data)
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      }
    )

    feedbackScannerRef.current = scanner
    scanner.start().catch((err) => {
      console.error('Feedback scanner start error:', err)
      setError('Failed to start camera for feedback scanning')
      setScanningFeedback(false)
    })

    return () => {
      scanner.stop()
      scanner.destroy()
    }
  }, [scanningFeedback])

  const handleFeedbackScan = (data: string) => {
    try {
      const feedback = JSON.parse(data)

      if (feedback.type === 'MISSING_CHUNKS_FEEDBACK' && Array.isArray(feedback.missingChunks)) {
        // Receiver already uses 0-based data chunk indices, so use them directly
        setMissingChunksQueue(feedback.missingChunks)
        setPlayingMissingOnly(true)
        setCurrentChunk(feedback.missingChunks[0] || 0)
        setShowMetadata(false)
        setScanningFeedback(false)
        setIsPlaying(false)
        setLoopCount(0)

        // Stop the scanner
        if (feedbackScannerRef.current) {
          feedbackScannerRef.current.stop()
        }
      }
    } catch (err) {
      console.error('Failed to parse feedback QR:', err)
    }
  }

  const handleStartFeedbackScan = () => {
    setScanningFeedback(true)
    setError('')
  }

  const handleStopFeedbackScan = () => {
    setScanningFeedback(false)
    if (feedbackScannerRef.current) {
      feedbackScannerRef.current.stop()
    }
  }

  const handleResetToAllChunks = () => {
    setPlayingMissingOnly(false)
    setMissingChunksQueue([])
    setShowMetadata(true)
    setCurrentChunk(0)
    setIsPlaying(false)
    setLoopCount(0)
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">Animated QR Code Transfer</CardTitle>
        <div className="text-sm text-muted-foreground text-center space-y-1">
          <p className="font-medium">{file.name}</p>
          <p>Size: {(file.size / 1024).toFixed(2)}KB | Data Chunks: {dataChunks.length}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Feedback Scanner Mode */}
        {scanningFeedback && (
          <Alert>
            <AlertDescription>
              <div className="space-y-3">
                <p className="font-medium">📷 Scanning for Feedback QR</p>
                <div className="relative bg-black rounded-lg overflow-hidden">
                  <video
                    ref={feedbackVideoRef}
                    className="w-full h-auto"
                    style={{ maxHeight: '300px' }}
                  />
                  <div className="absolute top-2 right-2 bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium">
                    ● SCANNING
                  </div>
                </div>
                <p className="text-sm">
                  Point camera at the receiver's feedback QR code to see which chunks are missing.
                </p>
                <Button onClick={handleStopFeedbackScan} variant="outline" className="w-full">
                  Cancel Scan
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Missing Chunks Mode Alert */}
        {playingMissingOnly && missingChunksQueue.length > 0 && (
          <Alert>
            <AlertDescription>
              <div className="space-y-2">
                <p className="font-medium">🎯 Playing Missing Chunks Only</p>
                <p className="text-sm">
                  Showing only {missingChunksQueue.length} missing chunk(s) out of {chunks.length} total.
                </p>
                <Button onClick={handleResetToAllChunks} variant="outline" size="sm" className="w-full">
                  ← Back to All Chunks
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* QR Code Display */}
        <div className="relative">
          <div className="flex justify-center bg-white p-4 rounded-lg">
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {qrCodeUrl ? (
              <img
                src={qrCodeUrl}
                alt={showMetadata ? 'Metadata QR Code - Scan to Start' : `Data QR Code chunk ${currentChunk + 1}/${dataChunks.length}`}
                className="max-w-full h-auto"
              />
            ) : (
              <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100">
                <p className="text-muted-foreground">Generating QR code...</p>
              </div>
            )}
          </div>

          {/* Chunk ID Overlay */}
          {showMetadata ? (
            <div className="absolute top-2 left-2 right-2 flex justify-center items-start">
              <div className="bg-blue-600/90 text-white px-4 py-2 rounded-lg font-bold text-base">
                📋 Metadata QR - Scan First
              </div>
            </div>
          ) : (
            <div className="absolute top-2 left-2 right-2 flex justify-between items-start">
              <div className="bg-black/80 text-white px-3 py-2 rounded-lg font-bold text-lg">
                Data QR {currentChunk + 1} / {dataChunks.length}
              </div>
              {isPlaying && (
                <div className="bg-red-500 text-white px-2 py-1 rounded text-xs font-medium flex items-center gap-1">
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                  PLAYING
                </div>
              )}
            </div>
          )}

          {loopCount > 0 && !showMetadata && (
            <div className="absolute bottom-2 right-2 bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium">
              Loop #{loopCount + 1}
            </div>
          )}
        </div>

        {/* Chunk Progress */}
        {!showMetadata && dataChunks.length > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Data chunk {currentChunk + 1} of {dataChunks.length}</span>
              <span>{Math.round(((currentChunk + 1) / dataChunks.length) * 100)}%</span>
            </div>
            <Progress value={((currentChunk + 1) / dataChunks.length) * 100} />
          </div>
        )}

        {showMetadata && (
          <Alert>
            <AlertDescription>
              <div className="text-center space-y-2">
                <p className="font-medium">📋 Metadata QR Code Ready</p>
                <p className="text-sm">
                  Have the receiver scan this QR code first to get file information.
                  Then click "Play" to start transmitting data chunks.
                </p>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Controls */}
        <div className="space-y-3">
          <div className="flex gap-2 justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrevious}
              disabled={dataChunks.length === 0 || showMetadata}
            >
              ← Previous
            </Button>
            <Button
              size="sm"
              onClick={handlePlayPause}
              disabled={dataChunks.length === 0}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNext}
              disabled={dataChunks.length === 0}
            >
              Next →
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

          {/* Repeat Mode Toggle */}
          <div className="flex items-center justify-center gap-2">
            <Button
              variant={repeatMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => setRepeatMode(!repeatMode)}
              className="flex items-center gap-2"
            >
              {repeatMode ? '🔁 Repeat ON' : '🔁 Repeat OFF'}
            </Button>
            {loopCount > 0 && (
              <span className="text-sm text-muted-foreground">
                Completed {loopCount} loop{loopCount > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Feedback QR Scanner Button */}
          <div className="pt-2 border-t">
            <Button
              onClick={handleStartFeedbackScan}
              variant="secondary"
              size="sm"
              className="w-full"
              disabled={scanningFeedback}
            >
              📷 Scan Receiver's Feedback QR
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-1">
              Get missing chunks from receiver
            </p>
          </div>
        </div>

        {/* Instructions */}
        <Alert>
          <AlertDescription>
            <p className="font-medium mb-2">📱 How to transfer this file:</p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Receiver scans the metadata QR code first (shown now)</li>
              <li>Click "Play" to cycle through data QR codes automatically</li>
              <li>Enable "Repeat ON" to loop through all data chunks</li>
              <li>Receiver tracks which chunks are scanned (deduplication)</li>
              <li>Keep playing until receiver shows 100% complete</li>
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
