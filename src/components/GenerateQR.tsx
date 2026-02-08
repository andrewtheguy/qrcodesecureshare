import { useState, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react'
import { generateQRTextDataURL } from '@/utils/qrUtils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  TEXT_FOUNTAIN_MAX_TEXT_BYTES,
  TEXT_FOUNTAIN_TRIGGER_CHAR_COUNT,
} from '@/constants'
import { TextFountainSender } from '@/components/fountain_qr/TextFountainSender'

export interface GenerateQRRef {
  setTextFromScan: (text: string) => void
}

const STREAM_PREVIEW_MAX_CHARS = 280

const GenerateQR = forwardRef<GenerateQRRef>((_props, ref) => {
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [qrError, setQrError] = useState<string | null>(null)
  const [isOverLimit, setIsOverLimit] = useState(false)
  const [isFountainModeActive, setIsFountainModeActive] = useState(false)

  useImperativeHandle(ref, () => ({
    setTextFromScan: (text: string) => {
      setIsFountainModeActive(false)
      setTextInput(text)
      void generateTextQR(text)
    }
  }))

  const getUtf8Bytes = useCallback((value: string) => new TextEncoder().encode(value.trim()), [])

  const generateQRCode = useCallback(async (payload: string) => {
    setQrError(null)
    try {
      const dataUrl = await generateQRTextDataURL(payload)
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

    setIsFountainModeActive(false)
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

    if (trimmed.length > TEXT_FOUNTAIN_TRIGGER_CHAR_COUNT) {
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

  const activateFountainMode = () => {
    const trimmed = textInput.trim()
    if (!trimmed) return

    const textBytes = getUtf8Bytes(trimmed)
    if (textBytes.length > TEXT_FOUNTAIN_MAX_TEXT_BYTES) {
      setQrError(
        `Text is too large for streamlined fountain mode (${textBytes.length} bytes). Max is ${TEXT_FOUNTAIN_MAX_TEXT_BYTES} bytes.`
      )
      return
    }

    setQrError(null)
    setTextQrGenerated(false)
    setQrCodeUrl('')
    setIsFountainModeActive(true)
  }

  const resetFountainMode = () => {
    setIsFountainModeActive(false)
    setQrError(null)
    setTextQrGenerated(false)
    setQrCodeUrl('')
  }

  useEffect(() => {
    if (isFountainModeActive) return
    void generateTextQR(textInput)
  }, [textInput, generateTextQR, isFountainModeActive])

  const trimmedTextInput = useMemo(() => textInput.trim(), [textInput])
  const textByteLength = useMemo(() => getUtf8Bytes(textInput).length, [textInput, getUtf8Bytes])
  const canUseFountainMode = useMemo(
    () => textByteLength > 0 && textByteLength <= TEXT_FOUNTAIN_MAX_TEXT_BYTES,
    [textByteLength]
  )
  const streamPreviewText = useMemo(
    () => (
      trimmedTextInput.length > STREAM_PREVIEW_MAX_CHARS
        ? `${trimmedTextInput.slice(0, STREAM_PREVIEW_MAX_CHARS)}...`
        : trimmedTextInput
    ),
    [trimmedTextInput]
  )

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
                  disabled={isFountainModeActive}
                >
                  Clear
                </Button>
                <Button
                  size="sm"
                  onClick={() => setTextInput(window.location.origin)}
                  className="h-6 px-2 text-xs"
                  variant="outline"
                  disabled={isFountainModeActive}
                >
                  QR for This Site
                </Button>
              </div>
              <span className={textInput.length > TEXT_FOUNTAIN_TRIGGER_CHAR_COUNT ? 'text-orange-600 font-medium' : ''}>
                {textInput.length} characters ({textByteLength} bytes)
              </span>
            </div>
            {!isFountainModeActive && (
              <Textarea
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Type your text here..."
                className="min-h-[100px]"
              />
            )}
            {isFountainModeActive && (
              <div className="space-y-2">
                <div className="rounded-md border bg-muted p-3">
                  <p className="text-xs text-muted-foreground mb-1">Text preview (truncated)</p>
                  <p className="text-sm whitespace-pre-wrap break-words">
                    {streamPreviewText}
                  </p>
                </div>
                <p className="text-xs text-amber-600">
                  Streamlined fountain mode is active. Reset the session to edit text.
                </p>
              </div>
            )}
          </div>

          {isOverLimit && !isFountainModeActive && (
            <Alert>
              <AlertDescription className="space-y-3">
                <div className="font-medium flex items-center gap-2">
                  📏 Text is too long for a single QR code ({textInput.length} characters)
                </div>
                <p className="text-sm text-muted-foreground">
                  You can still try generating one QR code, or switch to streamlined fountain stream mode.
                </p>
                {!canUseFountainMode && (
                  <p className="text-xs text-red-600">
                    Streamlined fountain mode supports up to {TEXT_FOUNTAIN_MAX_TEXT_BYTES} bytes.
                  </p>
                )}
                <div className="flex gap-3 justify-center flex-wrap pt-2">
                  <Button
                    onClick={() => generatePlainQROverride(textInput)}
                    variant="outline"
                  >
                    Generate QR Anyway
                  </Button>
                  <Button
                    onClick={activateFountainMode}
                    disabled={!canUseFountainMode}
                  >
                    Convert to Fountain Stream
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

      {isFountainModeActive && (
        <TextFountainSender text={textInput} onReset={resetFountainMode} />
      )}

      {!isFountainModeActive && textQrGenerated && qrCodeUrl && (
        <Card>
          <CardContent className="text-center">
            <div className="w-[300px] max-w-full mx-auto">
              <img
                src={qrCodeUrl}
                alt="QR Code with text content"
                className="block w-full h-auto rounded-lg shadow-sm mb-4"
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
