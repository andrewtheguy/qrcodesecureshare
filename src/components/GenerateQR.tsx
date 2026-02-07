import { useState, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react'
import { generateQRTextDataURL } from '@/utils/qrUtils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

export interface GenerateQRRef {
  setTextFromScan: (text: string) => void
}

const MAX_QR_TEXT_LENGTH = 700
const QR_CODE_WIDTH = 300

const GenerateQR = forwardRef<GenerateQRRef>((_props, ref) => {
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [qrError, setQrError] = useState<string | null>(null)
  const [isOverLimit, setIsOverLimit] = useState(false)

  useImperativeHandle(ref, () => ({
    setTextFromScan: (text: string) => {
      setTextInput(text)
      void generateTextQR(text)
    }
  }))

  const generateQRCode = useCallback(async (payload: string) => {
    setQrError(null)
    try {
      const dataUrl = await generateQRTextDataURL(payload, { width: QR_CODE_WIDTH })
      setQrCodeUrl(dataUrl)
      return true
    } catch (error) {
      setQrCodeUrl('')
      setQrError('Failed to generate QR code. Please try again.')
      console.error('QR Code generation failed:', error)
      return false
    }
  }, [])

  const generatePlainQROverride = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const success = await generateQRCode(trimmed)
    setTextQrGenerated(success)
    setIsOverLimit(false)
  }

  const generateTextQR = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setTextQrGenerated(false)
      setIsOverLimit(false)
      setQrCodeUrl('')
      setQrError(null)
      return
    }

    if (trimmed.length > MAX_QR_TEXT_LENGTH) {
      setIsOverLimit(true)
      setTextQrGenerated(false)
      setQrCodeUrl('')
      setQrError(null)
      return
    }

    setIsOverLimit(false)
    const success = await generateQRCode(trimmed)
    setTextQrGenerated(success)
  }, [generateQRCode])

  useEffect(() => {
    void generateTextQR(textInput)
  }, [textInput, generateTextQR])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Generate QR Code</CardTitle>
          <CardDescription>Turn text into a scannable QR code.</CardDescription>
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
                  onClick={() => setTextInput(window.location.origin)}
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
                  You can still try generating it as a single QR code.
                </p>
                <div className="flex gap-3 justify-center flex-wrap pt-2">
                  <Button
                    onClick={() => generatePlainQROverride(textInput)}
                    variant="outline"
                  >
                    Generate QR Anyway
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {qrError && (
            <Alert>
              <AlertDescription className="text-sm text-red-600">
                {qrError}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {textQrGenerated && qrCodeUrl && (
        <Card>
          <CardContent className="text-center">
            <div className="max-w-[300px] mx-auto">
              <img
                src={qrCodeUrl}
                alt="QR Code with text content"
                className="w-full h-auto rounded-lg shadow-sm mb-4"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Scan QR code to read the text
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
})

GenerateQR.displayName = 'GenerateQR'

export default GenerateQR
