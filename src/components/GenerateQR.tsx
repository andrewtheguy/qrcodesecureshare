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
  const [isOverLimit, setIsOverLimit] = useState(false)

  useImperativeHandle(ref, () => ({
    setTextFromScan: (text: string) => {
      setTextInput(text)
      generateTextQR(text)
    }
  }))

  const generateQRCode = useCallback(async (payload: string) => {
    try {
      const dataUrl = await generateQRTextDataURL(payload, { width: QR_CODE_WIDTH })
      setQrCodeUrl(dataUrl)
    } catch (error) {
      console.error('QR Code generation failed:', error)
    }
  }, [])

  const generatePlainQROverride = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    await generateQRCode(trimmed)
    setTextQrGenerated(true)
    setIsOverLimit(false)
  }

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
        </CardContent>
      </Card>

      {textQrGenerated && qrCodeUrl && (
        <Card>
          <CardContent className="text-center">
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
