import { useState, useRef } from 'react'
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Upload as UploadIcon, Copy, Trash2 } from 'lucide-react'

interface DecodedQR {
  text: string
  format: string
  timestamp: Date
}

export default function QRDecode() {
  const [decodedQRs, setDecodedQRs] = useState<DecodedQR[]>([])
  const [error, setError] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
                results.forEach((result) => {
                  const newQR: DecodedQR = {
                    text: result.text,
                    format: result.format,
                    timestamp: new Date(),
                  }
                  setDecodedQRs((prev) => [newQR, ...prev])
                })
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
    setDecodedQRs([])
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
          Upload an image containing a QR code to decode it
        </p>
      </div>

      {/* Upload Area */}
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

      {/* Error Message */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Results */}
      {decodedQRs.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Decoded Results ({decodedQRs.length})</CardTitle>
            {decodedQRs.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={clearAll}
                className="flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Clear
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {decodedQRs.map((qr, index) => (
              <div
                key={index}
                className="border rounded-lg p-4 space-y-3 bg-muted/50"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Format: {qr.format}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {qr.timestamp.toLocaleTimeString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(qr.text)}
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
                    value={qr.text}
                    readOnly
                    className="min-h-24 font-mono text-sm"
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {decodedQRs.length === 0 && !error && (
        <Card className="border-dashed">
          <CardContent className="pt-8">
            <div className="text-center text-muted-foreground">
              <p>No QR codes decoded yet</p>
              <p className="text-sm">Upload an image to get started</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
