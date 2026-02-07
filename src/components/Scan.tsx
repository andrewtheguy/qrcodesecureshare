import { useState, useRef, useEffect, useCallback } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { OFFLINE_METADATA_MAGIC } from '../constants'
import { decodeQRFromImage } from '@/utils/zxingWorkerUtils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner'
import { OfflineMetadataDetails } from './OfflineMetadataDetails'

interface FountainMetadata {
  type: 'METADATA'
  mode: 'fountain'
  version: 1
  sessionId: number
  fileName: string
  fileType: string
  fileSize: number
  timestamp: number
  totalSourceBlocks: number
  blockSize: number
  chunkSize: number
  checksumAlg: 'crc32'
  checksum: string
  feedbackEnabled: boolean
  partBasedMode?: boolean
  partSize?: number
}

type OfflineMetadata = FountainMetadata

interface ScanProps {
  onGenerateQR?: (text: string) => void
  defaultMode?: 'camera' | 'file'
}

type QRCodeType = 'offline-metadata' | 'text'

interface ParsedQRData {
  type: QRCodeType
  offlineMetadata?: OfflineMetadata
}

const Scan = ({ onGenerateQR, defaultMode = 'camera' }: ScanProps) => {
  const location = useLocation()
  const navigate = useNavigate()
  const [scannedText, setScannedText] = useState<string | null>(null)
  const [parsedQRData, setParsedQRData] = useState<ParsedQRData | null>(null)
  const [scanning, setScanning] = useState(false)
  const [uploadMode, setUploadMode] = useState<'camera' | 'file'>(defaultMode)
  const [copiedFeedback, setCopiedFeedback] = useState<string | null>(null)
  // Simplified camera handling: only track facing mode categories (environment/back vs user/front)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(() => (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'environment' : 'user'))
  const [cameraError, setCameraError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Sync uploadMode with route changes
  useEffect(() => {
    if (location.pathname === '/scan/camera') {
      setUploadMode('camera')
    } else if (location.pathname === '/scan/upload') {
      setUploadMode('file')
    }
  }, [location.pathname])

  // Handle QR scan results (multiple QR codes from a single scan)
  const handleQRScan = useCallback((qrCodes: string[]) => {
    if (!qrCodes || qrCodes.length === 0) {
      return
    }

    // Process the first QR code for now (can be extended to handle multiple in the future)
    const data = qrCodes[0]
    console.log('QR code detected:', data)

    // Always set the scanned text
    setScanning(false)

    setScannedText(data)

    if (data.startsWith(OFFLINE_METADATA_MAGIC)) {
      try {
        const jsonData = data.substring(OFFLINE_METADATA_MAGIC.length)
        const parsedData = JSON.parse(jsonData) as OfflineMetadata
        console.log('Parsed offline metadata:', parsedData)
        // Validate that it's actually metadata
        if (parsedData.type === 'METADATA' && parsedData.mode === 'fountain') {
          setParsedQRData({
            type: 'offline-metadata',
            offlineMetadata: parsedData
          })
        } else {
          console.error('Invalid offline metadata structure')
          setParsedQRData({ type: 'text' })
        }
      } catch (error) {
        console.error('Invalid offline metadata in QR code:', error)
        setParsedQRData({ type: 'text' })
      }
    } else {
      // Regular text QR code
      console.log('Regular text QR code:', data)
      setParsedQRData({ type: 'text' })
    }
  }, [])

  // Handle camera errors
  const handleCameraError = useCallback((error: string) => {
    setCameraError(error)
    setScanning(false)
  }, [])

  // Use the new zxing-wasm scanner hook with maximized detection for general QR code scanning
  const { videoRef, canvasRef, availableCameras } = useZXingQRScanner({
    onScan: handleQRScan,
    onError: handleCameraError,
    isScanning: scanning,
    facingMode: facingMode,
    binary: false,
    // Maximize detection for challenging QR codes (worn, angled, poor lighting, color variations)
    readerOptions: {
      formats: ['QRCode'],
      tryHarder: true, // Spend more time finding barcodes
      tryRotate: true, // Check rotated versions
      tryInvert: true, // Check inverted versions (important for color/contrast variations)
      tryDownscale: true, // Try downscaled versions for distant QR codes
      tryDenoise: true, // Experimental: try denoising for noisy images
      binarizer: 'LocalAverage', // Use adaptive thresholding for color variations
      maxNumberOfSymbols: 1, // Only return first QR code found
    },
  })

  const copyToClipboard = async (text: string, label?: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedFeedback(label || 'Copied!')
      setTimeout(() => setCopiedFeedback(null), 2000)
    } catch {
      const textArea = document.createElement('textarea')
      textArea.value = text
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopiedFeedback(label || 'Copied!')
      setTimeout(() => setCopiedFeedback(null), 2000)
    }
  }

  const renderTextWithLinks = (text: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g
    const parts = text.split(urlRegex)

    return parts.map((part, index) => {
      if (part.match(urlRegex)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline break-all"
          >
            {part}
          </a>
        )
      }
      return part
    })
  }

  const handleProceedToOfflineReceive = () => {
    if (parsedQRData?.type === 'offline-metadata' && parsedQRData.offlineMetadata) {
      // Navigate to /offline/receive with metadata in location state
      navigate('/offline/receive', { state: { metadata: parsedQRData.offlineMetadata } })
    }
  }

  const startScanning = () => {
    setCameraError(null)
    setScanning(true)
  }

  const stopScanning = () => {
    setScanning(false)
  }

  const toggleFacingMode = () => {
    const nextMode: 'environment' | 'user' = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(nextMode)
    // The hook will automatically restart the camera with the new facingMode
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      console.log('Processing uploaded image for QR code...')

      // Decode the QR codes using zxing-wasm worker
      const results = await decodeQRFromImage(file, undefined, false)

      if (!results || results.length === 0) {
        alert('No QR code found in the uploaded image. Please try a different image.')
        return
      }

      console.log('QR codes detected from uploaded image:', results)

      // Use the same handler as camera scan, passing all detected QR codes
      handleQRScan(results as string[])
    } catch (error) {
      console.error('Failed to scan QR code from image:', error)
      alert('No QR code found in the uploaded image. Please try a different image.')
    }

    // Clear the file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    return () => {
      stopScanning()
    }
  }, [])

  return (
    <div className="space-y-6">
      {copiedFeedback && (
        <div className="fixed top-4 left-2/3 -translate-x-1/2 bg-green-600 text-white px-4 py-2 rounded-md shadow-lg z-50 animate-in fade-in slide-in-from-top-2">
          ✓ {copiedFeedback}
        </div>
      )}
      {!scanning && !scannedText && (
        <Card>
          <CardContent className="p-8 text-center">
            <div className="space-y-6">
              <div className="text-6xl">📷</div>
              <div className="space-y-2">
                <h2 className="text-2xl font-bold">Scan QR Code</h2>
                <p className="text-muted-foreground max-w-md mx-auto">
                  Scan any QR code to view its content. Supports offline file transfer metadata and plain text.
                </p>
              </div>

              {/* Mode selection */}
              <div className="flex justify-center gap-2 mb-4">
                <NavLink to="/scan/camera">
                  {({ isActive }) => (
                    <Button
                      variant={isActive ? 'default' : 'outline'}
                      size="sm"
                    >
                      📷 Camera
                    </Button>
                  )}
                </NavLink>
                <NavLink to="/scan/upload">
                  {({ isActive }) => (
                    <Button
                      variant={isActive ? 'default' : 'outline'}
                      size="sm"
                    >
                      📁 Upload Image
                    </Button>
                  )}
                </NavLink>
              </div>

              {uploadMode === 'camera' ? (
                <div className="space-y-4">
                  <div
                    onClick={startScanning}
                    className="cursor-pointer border-2 border-dashed border-gray-300 rounded-lg p-8 hover:border-gray-400 transition-colors"
                  >
                    <div className="space-y-2">
                      <div className="text-4xl">📷</div>
                      <div className="text-sm text-gray-600">
                        Click to start camera scanning
                      </div>
                      <div className="text-xs text-gray-500">
                        Point camera at QR code to scan
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <label htmlFor="qr-image-upload" className="cursor-pointer">
                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 hover:border-gray-400 transition-colors">
                      <div className="space-y-2">
                        <div className="text-4xl">🖼️</div>
                        <div className="text-sm text-gray-600">
                          Click to upload an image containing a QR code
                        </div>
                        <div className="text-xs text-gray-500">
                          Supports JPG, PNG, GIF, WebP
                        </div>
                      </div>
                    </div>
                  </label>
                  <input
                    id="qr-image-upload"
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {scanning && (
        <Card>
          <CardContent className="p-8 text-center">
            <div className="space-y-4">
              <video
                ref={videoRef}
                className="w-full max-w-md rounded-lg bg-black mx-auto"
                playsInline
                muted
                autoPlay
              />
              <canvas ref={canvasRef} className="hidden" />
              <div className="flex flex-col gap-2 items-center">
                {availableCameras.length > 1 && (
                  <div className="flex items-center gap-3 flex-wrap justify-center">
                    <span className="text-xs font-medium text-muted-foreground">Mode:</span>
                    <code className="text-xs bg-muted px-2 py-1 rounded">{facingMode}</code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      onClick={toggleFacingMode}
                    >
                      🔄 Flip
                    </Button>
                  </div>
                )}
                {cameraError && <p className="text-xs text-red-600">{cameraError}</p>}
              </div>
              <Button variant="outline" onClick={stopScanning}>
                Stop Scanning
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {scannedText && (
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-green-600 flex items-center justify-center gap-2">
              ✅ QR Code Scanned
            </CardTitle>
            <CardDescription className="flex items-center gap-2 justify-center">
              <span className="text-2xl">📄</span>
              <span className="text-lg font-semibold">Text Content</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {parsedQRData?.type === 'offline-metadata' && (() => {
              const metadata = parsedQRData.offlineMetadata
              return (
                <>
                  <Alert className="bg-amber-50 border-amber-200">
                    <AlertDescription className="space-y-2">
                      <div className="font-medium flex items-center gap-2">
                        📡 Offline File Transfer Detected
                      </div>
                      <p className="text-sm text-muted-foreground">
                        This QR code contains metadata for an offline file transfer. Click below to proceed to receive the file data.
                      </p>
                    </AlertDescription>
                  </Alert>
                  <div className="flex justify-center">
                    <Button
                      onClick={handleProceedToOfflineReceive}
                      className="flex items-center gap-2"
                    >
                      📡 Proceed to Receive Data
                    </Button>
                  </div>
                  {metadata && (
                    <OfflineMetadataDetails
                      metadata={{
                        fileName: metadata.fileName,
                        fileSize: metadata.fileSize,
                        totalSourceBlocks: metadata.totalSourceBlocks
                      }}
                    />
                  )}
                </>
              )
            })()}
            <div className="space-y-3">
              <div className="bg-muted p-4 rounded-md font-mono text-sm whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto text-left">
                {renderTextWithLinks(scannedText)}
              </div>

              <div className="flex justify-center gap-3 flex-wrap">
                <Button
                  variant="outline"
                  onClick={() => copyToClipboard(scannedText)}
                >
                  📋 Copy Text
                </Button>
                <Button
                  onClick={() => {
                    setScannedText(null)
                    setParsedQRData(null)
                    setUploadMode('camera')
                  }}
                >
                  📷 Scan Another QR
                </Button>
              </div>
              {onGenerateQR && parsedQRData?.type === 'text' && (
                <div className="flex justify-center">
                  <Button
                    onClick={() => onGenerateQR(scannedText)}
                  >
                    🔄 Generate QR Code from Result
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default Scan
