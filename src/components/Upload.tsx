import { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

export interface UploadRef {
  setTextFromScan: (text: string) => void
}

const MAX_QR_TEXT_LENGTH = 700

const Upload = forwardRef<UploadRef>((_props, ref) => {
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [isOverLimit, setIsOverLimit] = useState(false)
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

  const generateTextQR = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setTextQrGenerated(false)
      setIsOverLimit(false)
      setQrCodeUrl('')
      return
    }

    if (trimmed.length > MAX_QR_TEXT_LENGTH) {
      setIsOverLimit(true)
      setTextQrGenerated(false)
      setQrCodeUrl('')
      return
    }

    setIsOverLimit(false)
    generateQRCode(trimmed)
    setTextQrGenerated(true)
  }, [generateQRCode])

  useEffect(() => {
    generateTextQR(textInput)
  }, [textInput, generateTextQR])

  return (
    <div className="space-y-6">
      <Card>
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
              <AlertDescription className="space-y-2">
                <div className="font-medium flex items-center gap-2">
                  📏 Text is too long for a single QR code ({textInput.length} characters)
                </div>
                <p className="text-sm text-muted-foreground">
                  Shorten the text or use Online File Transfer at{' '}
                  <a
                    href="https://secure-send-web.andrewtheguy.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    secure-send-web.andrewtheguy.com
                  </a>
                  {' '}for larger payloads.
                </p>
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

export default Upload
