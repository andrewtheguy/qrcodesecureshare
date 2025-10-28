import { useState, useRef, useEffect, useCallback } from 'react'
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Upload as UploadIcon, Copy, Trash2, Camera, CameraOff, Repeat } from 'lucide-react'
import { isMobileDevice } from '@/lib/utils'

interface DecodedQR {
  text: string
  format: string
  timestamp: Date
  source: 'file' | 'camera'
  filename?: string
}

export default function QRDecode() {
  // Existing state
  const [decodedQR, setDecodedQR] = useState<DecodedQR | null>(null)
  const [error, setError] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Camera state
  const [scanMode, setScanMode] = useState<'file' | 'camera'>('file')
  const [scanning, setScanning] = useState(false)
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment')
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([])
  const [cameraError, setCameraError] = useState<string | null>(null)

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scanLoopRef = useRef<number | null>(null)
  const isScanningRef = useRef<boolean>(false)

  // Camera functions
  const enumerateCameras = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter((device) => device.kind === 'videoinput')
      setAvailableCameras(videoDevices)
    } catch (err) {
      console.error('Failed to enumerate cameras:', err)
    }
  }

  const startCameraScanning = async () => {
    try {
      setCameraError(null)
      setError('')

      // Set scanning first so video element renders
      setScanning(true)

      // Wait for video element to be rendered in DOM
      await new Promise((resolve) => setTimeout(resolve, 100))

      if (!videoRef.current) {
        throw new Error('Video element not available')
      }

      const isMobile = isMobileDevice()
      const constraints: MediaStreamConstraints = {
        video: isMobile
          ? {
              facingMode: facingMode,
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : {
              facingMode: facingMode,
            },
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      setCameraStream(stream)
      videoRef.current.srcObject = stream

      // Wait for video to load and play
      await videoRef.current.play()

      await enumerateCameras()
      startScanLoop()
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to access camera'
      setCameraError(
        `Camera access denied or unavailable. Please check your permissions. ${errorMessage}`
      )
      setScanning(false)
      isScanningRef.current = false
    }
  }

  const stopCameraScanning = useCallback(() => {
    setScanning(false)
    isScanningRef.current = false

    // Stop camera stream
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop())
      setCameraStream(null)
    }

    // Stop video element
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    // Cancel animation frame
    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current)
      scanLoopRef.current = null
    }
  }, [cameraStream])

  const startScanLoop = () => {
    const isMobile = isMobileDevice()
    const scanInterval = isMobile ? 125 : 67 // ms between scans (8fps mobile, 15fps desktop)
    let lastScanTime = 0

    const scanFrame = async () => {
      if (!isScanningRef.current) {
        return
      }

      const now = Date.now()
      if (now - lastScanTime >= scanInterval) {
        await scanVideoFrame()
        lastScanTime = now
      }

      if (isScanningRef.current) {
        scanLoopRef.current = requestAnimationFrame(scanFrame)
      }
    }

    isScanningRef.current = true
    scanFrame()
  }

  const scanVideoFrame = async () => {
    if (!videoRef.current || !canvasRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current

    // Check if video is ready
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      return
    }

    try {
      // Set canvas size to match video
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      if (canvas.width === 0 || canvas.height === 0) {
        return
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      // Draw current video frame to canvas
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

      // Get ImageData from canvas
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

      // Decode with zxing-wasm
      const readerOptions: ReaderOptions = {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: true,
      }

      const results = await readBarcodes(imageData, readerOptions)

      if (results.length > 0) {
        // QR code found!
        const newQR: DecodedQR = {
          text: results[0].text,
          format: results[0].format,
          timestamp: new Date(),
          source: 'camera',
        }
        setDecodedQR(newQR)

        // Stop scanning after successful decode
        stopCameraScanning()
      }
    } catch (err) {
      // Silent fail - continue scanning
      console.error('Error scanning frame:', err)
    }
  }

  const switchCamera = async () => {
    stopCameraScanning()
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
    // The new facing mode will be used when starting camera again
    await new Promise((resolve) => setTimeout(resolve, 100))
    startCameraScanning()
  }

  // Cleanup on unmount or mode change
  useEffect(() => {
    return () => {
      isScanningRef.current = false
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop())
      }
      if (scanLoopRef.current !== null) {
        cancelAnimationFrame(scanLoopRef.current)
      }
    }
  }, [cameraStream])

  // Stop camera when switching modes
  useEffect(() => {
    if (scanMode === 'file') {
      stopCameraScanning()
    }
  }, [scanMode, stopCameraScanning])

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsLoading(true)
    setError('')

    try {
      // Create an image element to get canvas data
      const reader = new FileReader()
      reader.onload = async (e) => {
        try {
          const imageUrl = e.target?.result as string

          // Create an image element
          const img = new Image()
          img.src = imageUrl

          img.onload = async () => {
            try {
              // Create a canvas and draw the image
              const canvas = document.createElement('canvas')
              canvas.width = img.width
              canvas.height = img.height
              const ctx = canvas.getContext('2d')
              if (!ctx) {
                setError('Failed to get canvas context')
                setIsLoading(false)
                return
              }

              ctx.drawImage(img, 0, 0)
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

              // Decode the QR code using zxing-wasm
              const readerOptions: ReaderOptions = {
                formats: ['QRCode'],
                tryHarder: true,
                tryRotate: true,
              }

              const results = await readBarcodes(imageData, readerOptions)

              if (results.length === 0) {
                setError('No QR code found in the image')
              } else {
                const newQR: DecodedQR = {
                  text: results[0].text,
                  format: results[0].format,
                  timestamp: new Date(),
                  source: 'file',
                  filename: file.name,
                }
                setDecodedQR(newQR)
                setError('')
              }
            } catch (err) {
              setError(`Failed to decode QR code: ${err instanceof Error ? err.message : 'Unknown error'}`)
            } finally {
              setIsLoading(false)
            }
          }

          img.onerror = () => {
            setError('Failed to load image')
            setIsLoading(false)
          }
        } catch (err) {
          setError(`Error processing file: ${err instanceof Error ? err.message : 'Unknown error'}`)
          setIsLoading(false)
        }
      }

      reader.onerror = () => {
        setError('Failed to read file')
        setIsLoading(false)
      }

      reader.readAsDataURL(file)
    } catch (err) {
      setError(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
      setIsLoading(false)
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      setError('Failed to copy to clipboard')
    }
  }

  const clearAll = () => {
    setDecodedQR(null)
    setError('')
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div className="w-full space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">QR Code Decoder</h1>
        <p className="text-muted-foreground">
          Upload an image or use your camera to decode QR codes
        </p>
      </div>

      {/* Mode Toggle */}
      <div className="flex gap-2 justify-center">
        <Button
          variant={scanMode === 'file' ? 'default' : 'outline'}
          onClick={() => setScanMode('file')}
          className="flex items-center gap-2"
        >
          <UploadIcon className="w-4 h-4" />
          Upload Image
        </Button>
        <Button
          variant={scanMode === 'camera' ? 'default' : 'outline'}
          onClick={() => setScanMode('camera')}
          className="flex items-center gap-2"
        >
          <Camera className="w-4 h-4" />
          Camera Scan
        </Button>
      </div>

      {/* File Upload Mode */}
      {scanMode === 'file' && (
        <Card>
          <CardHeader>
            <CardTitle>Upload Image</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center hover:border-muted-foreground/50 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              <h3 className="font-semibold mb-2">Click to upload or drag and drop</h3>
              <p className="text-sm text-muted-foreground mb-4">
                PNG, JPG, GIF or WebP (max. 10MB)
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
                disabled={isLoading}
              />
              <Button disabled={isLoading} variant="outline">
                {isLoading ? 'Processing...' : 'Select Image'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Camera Scan Mode */}
      {scanMode === 'camera' && (
        <Card>
          <CardHeader>
            <CardTitle>Camera Scanner</CardTitle>
          </CardHeader>
          <CardContent>
            {!scanning ? (
              <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
                <Camera className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="font-semibold mb-2">Start Camera Scanning</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Point your camera at a QR code to decode it
                </p>
                <Button onClick={startCameraScanning} className="flex items-center gap-2">
                  <Camera className="w-4 h-4" />
                  Start Camera
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="relative">
                  <video
                    ref={videoRef}
                    className="w-full max-w-md min-h-[300px] rounded-lg bg-black mx-auto"
                    playsInline
                    muted
                    autoPlay
                  />
                  <canvas ref={canvasRef} className="hidden" />
                </div>
                <div className="flex gap-2 justify-center">
                  <Button
                    onClick={stopCameraScanning}
                    variant="outline"
                    className="flex items-center gap-2"
                  >
                    <CameraOff className="w-4 h-4" />
                    Stop Camera
                  </Button>
                  {availableCameras.length > 1 && (
                    <Button
                      onClick={switchCamera}
                      variant="outline"
                      className="flex items-center gap-2"
                    >
                      <Repeat className="w-4 h-4" />
                      Flip Camera
                    </Button>
                  )}
                </div>
                <p className="text-sm text-center text-muted-foreground">
                  {facingMode === 'environment' ? 'Using rear camera' : 'Using front camera'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Camera Error */}
      {cameraError && (
        <Alert variant="destructive">
          <AlertDescription>{cameraError}</AlertDescription>
        </Alert>
      )}

      {/* Error Message */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Results */}
      {decodedQR && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Decoded QR Code</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={clearAll}
              className="flex items-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Clear
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border rounded-lg p-4 space-y-3 bg-muted/50">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Format: {decodedQR.format}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Source: {decodedQR.source === 'camera' ? '📷 Camera' : '📤 File'}
                  </p>
                  {decodedQR.filename && (
                    <p className="text-sm text-muted-foreground">
                      File: {decodedQR.filename}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {decodedQR.timestamp.toLocaleTimeString()}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(decodedQR.text)}
                  className="flex items-center gap-2"
                >
                  <Copy className="w-4 h-4" />
                  Copy
                </Button>
              </div>
              <div>
                <Label className="text-sm font-medium mb-2 block">
                  Decoded Content
                </Label>
                <Textarea
                  value={decodedQR.text}
                  readOnly
                  className="min-h-24 font-mono text-sm"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!decodedQR && !error && (
        <Card className="border-dashed">
          <CardContent className="pt-8">
            <div className="text-center text-muted-foreground">
              <p>No QR code decoded yet</p>
              <p className="text-sm">Upload an image or use your camera to get started</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
