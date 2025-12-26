import { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { COMPRESSED_TEXT_MAGIC } from '@/constants'

export interface GenerateQRRef {
  setTextFromScan: (text: string) => void
}

const MAX_QR_TEXT_LENGTH = 700

const GenerateQR = forwardRef<GenerateQRRef>((_props, ref) => {
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isOverLimit, setIsOverLimit] = useState(false)
  const [isCompressedQr, setIsCompressedQr] = useState(false)
  const [compressionError, setCompressionError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useImperativeHandle(ref, () => ({
    setTextFromScan: (text: string) => {
      setTextInput(text)
      generateTextQR(text)
    }
  }))

  const generateQRCode = useCallback(async (payload: string) => {
    try {
      const canvas = canvasRef.current
      if (canvas) {
        await QRCode.toCanvas(canvas, payload, {
          width: 300,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
      }
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      })
      setQrCodeUrl(dataUrl)
    } catch (error) {
      console.error('QR Code generation failed:', error)
    }
  }, [])

  const generateQRCodeBytes = useCallback(async (payload: Uint8Array) => {
    try {
      const canvas = canvasRef.current
      if (canvas) {
        await QRCode.toCanvas(canvas, [{ data: payload, mode: 'byte' }], {
          width: 300,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
      }
      const dataUrl = await QRCode.toDataURL([{ data: payload, mode: 'byte' }], {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      })
      setQrCodeUrl(dataUrl)
    } catch (error) {
      console.error('QR Code generation failed:', error)
    }
  }, [])

  const compressText = async (text: string): Promise<Uint8Array> => {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('Compression is not supported in this browser.')
    }
    const encoded = new TextEncoder().encode(text)
    const stream = new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'))
    const buffer = await new Response(stream).arrayBuffer()
    return new Uint8Array(buffer)
  }

  const generateCompressedQR = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    try {
      setCompressionError(null)
      const compressed = await compressText(trimmed)
      const magicBytes = new TextEncoder().encode(COMPRESSED_TEXT_MAGIC)
      const payload = new Uint8Array(magicBytes.length + compressed.length)
      payload.set(magicBytes, 0)
      payload.set(compressed, magicBytes.length)
      await generateQRCodeBytes(payload)
      setTextQrGenerated(true)
      setIsCompressedQr(true)
      setIsOverLimit(false)
    } catch (error) {
      setCompressionError(error instanceof Error ? error.message : 'Failed to compress text.')
    }
  }

  const generatePlainQROverride = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    await generateQRCode(trimmed)
    setTextQrGenerated(true)
    setIsCompressedQr(false)
    setIsOverLimit(false)
    setCompressionError(null)
  }

  const generateTextQR = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setTextQrGenerated(false)
      setIsOverLimit(false)
      setIsCompressedQr(false)
      setCompressionError(null)
      setQrCodeUrl('')
      return
    }

    if (trimmed.length > MAX_QR_TEXT_LENGTH) {
      setIsOverLimit(true)
      setTextQrGenerated(false)
      setIsCompressedQr(false)
      setCompressionError(null)
      setQrCodeUrl('')
      return
    }

    setIsOverLimit(false)
    setIsCompressedQr(false)
    setCompressionError(null)
    generateQRCode(trimmed)
    setTextQrGenerated(true)
  }, [generateQRCode])

  useEffect(() => {
    generateTextQR(textInput)
  }, [textInput, generateTextQR])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Generate QR Code</CardTitle>
          <CardDescription>Turn text into a scannable QR code, with optional compression for large content.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-2">
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 flex-wrap">
                <span>Enter your text:</span>
                <Button
                  size="sm"
                  onClick={() => setTextInput('')}
                  className="h-6 px-2 text-xs"
                >
                  Clear
                </Button>
                <Button
                  size="sm"
                  onClick={() => setTextInput(window.location.href)}
                  className="h-6 px-2 text-xs"
                  variant="outline"
                >
                  QR for This Site
                </Button>
              </div>
              <span className={textInput.length > MAX_QR_TEXT_LENGTH ? 'text-orange-600 font-medium' : ''}>
                {textInput.length} characters
              </span>
            </div>
            <Textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type your text here..."
              className="min-h-[100px]"
            />
          </div>

          {isOverLimit && (
            <Alert>
              <AlertDescription className="space-y-3">
                <div className="font-medium flex items-center gap-2">
                  📏 Text is too long for a single QR code ({textInput.length} characters)
                </div>
                <p className="text-sm text-muted-foreground">
                  Switch to compressed QR mode (binary payload) to maximize what can fit in one code, or generate a large QR anyway.
                </p>
                <div className="flex gap-3 justify-center flex-wrap pt-2">
                  <Button
                    onClick={() => generatePlainQROverride(textInput)}
                    variant="outline"
                  >
                    Generate QR Anyway
                  </Button>
                  <Button
                    onClick={() => generateCompressedQR(textInput)}
                  >
                    Generate Compressed QR
                  </Button>
                </div>
                {compressionError && (
                  <p className="text-xs text-red-600">{compressionError}</p>
                )}
              </AlertDescription>
            </Alert>
          )}
          {isCompressedQr && !isOverLimit && (
            <Alert>
              <AlertDescription className="text-sm text-muted-foreground">
                ✅ Compressed QR mode active. Scan with this app to automatically decompress the text.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {textQrGenerated && qrCodeUrl && (
        <Card>
          <CardContent className="text-center">
            <canvas
              ref={canvasRef}
              style={{ display: 'none' }}
            />
            <img
              src={qrCodeUrl}
              alt="QR Code with text content"
              className="mx-auto rounded-lg shadow-sm mb-4"
            />
            <p className="text-sm text-muted-foreground">
              Scan QR code to read the text
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
})

export default GenerateQR
