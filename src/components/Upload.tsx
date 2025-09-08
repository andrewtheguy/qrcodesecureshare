import { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import QRCode from 'qrcode'
import { ENCRYPTED_FILE_MAGIC } from '../constants'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { deriveKey } from '@/lib/utils'

interface UploadResult {
  status: string
  data: {
    url: string
  }
}

interface UploadedFile {
  name: string
  originalUrl: string
  downloadUrl: string
  uploadTime: string
  passphrase: string
}

export interface UploadRef {
  setTextFromScan: (text: string) => void
}

const Upload = forwardRef<UploadRef>((props, ref) => {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [mode, setMode] = useState<'file' | 'text'>('text')
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const [showTextUploadOption, setShowTextUploadOption] = useState(false)
  const [uploadingText, setUploadingText] = useState(false)
  const [textUploadCompleted, setTextUploadCompleted] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useImperativeHandle(ref, () => ({
    setTextFromScan: (text: string) => {
      setMode('text')
      setTextInput(text)
      // Generate QR code immediately if text is not too long
      if (text.trim().length <= 700) {
        generateQRCode(text.trim())
        setTextQrGenerated(true)
        setShowTextUploadOption(false)
      } else {
        setShowTextUploadOption(true)
        setTextQrGenerated(false)
        setQrCodeUrl('')
      }
    }
  }))

  const convertUrl = (originalUrl: string): string => {
    return originalUrl.replace('http://tmpfiles.org/', 'https://tmpfiles.org/dl/')
  }

  const generatePassphrase = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*()_+-=[]{}|~'
    let passphrase = ''
    for (let i = 0; i < 32; i++) {
      passphrase += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return passphrase
  }


  const encryptFile = async (file: File, passphrase: string): Promise<File> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer
          
          // Generate random salt and IV (nonce for GCM)
          const salt = crypto.getRandomValues(new Uint8Array(16))
          const iv = crypto.getRandomValues(new Uint8Array(12)) // GCM uses 12-byte IV
          
          // Derive key from passphrase
          const key = await deriveKey(passphrase, salt)
          
          // Encrypt the file data using AES-GCM
          const encryptedData = await crypto.subtle.encrypt(
            {
              name: 'AES-GCM',
              iv: iv
            },
            key,
            arrayBuffer
          )
          
          // Combine salt + iv + encrypted data (includes auth tag)
          const encryptedBytes = new Uint8Array(salt.length + iv.length + encryptedData.byteLength)
          encryptedBytes.set(salt, 0)
          encryptedBytes.set(iv, salt.length)
          encryptedBytes.set(new Uint8Array(encryptedData), salt.length + iv.length)
          
          const blob = new Blob([encryptedBytes], { type: 'application/octet-stream' })
          const encryptedFile = new File([blob], 'file.enc', { type: 'application/octet-stream' })
          resolve(encryptedFile)
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = reject
      reader.readAsArrayBuffer(file)
    })
  }

  const uploadFile = async (file: File) => {
    const passphrase = generatePassphrase()
    const encryptedFile = await encryptFile(file, passphrase)
    
    const formData = new FormData()
    formData.append('file', encryptedFile)

    try {
      const response = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const result: UploadResult = await response.json()
      
      if (result.status === 'success') {
        const downloadUrl = convertUrl(result.data.url)
        const fileData = {
          name: file.name,
          originalUrl: result.data.url,
          downloadUrl,
          uploadTime: new Date().toISOString(),
          passphrase
        }
        setUploadedFile(fileData)
        return fileData
      } else {
        throw new Error('Upload failed')
      }
    } catch (error) {
      console.error('Upload error:', error)
      throw error
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    
    const file = files[0]
    setUploading(true)
    
    try {
      await uploadFile(file)
    } catch (error) {
      alert('File failed to upload. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }, [])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files)
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      const textArea = document.createElement('textarea')
      textArea.value = text
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
    }
  }

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

  const generateTextQR = (text: string) => {
    if (text.trim()) {
      if (text.trim().length > 700) {
        // Show upload option for long text
        setShowTextUploadOption(true)
        setTextQrGenerated(false)
        setQrCodeUrl('')
      } else {
        // Generate QR code for plain text (no magic header)
        generateQRCode(text.trim())
        setTextQrGenerated(true)
        setShowTextUploadOption(false)
      }
    } else {
      setTextQrGenerated(false)
      setShowTextUploadOption(false)
      setQrCodeUrl('')
    }
  }

  const resetTextMode = () => {
    setTextInput('')
    setTextQrGenerated(false)
    setShowTextUploadOption(false)
    setUploadingText(false)
    setTextUploadCompleted(false)
    setQrCodeUrl('')
  }

  const resetFileMode = () => {
    setUploadedFile(null)
    setQrCodeUrl('')
  }

  const uploadTextAsFile = async () => {
    if (!textInput.trim()) return
    
    try {
      setUploadingText(true)
      setUploading(true)
      
      // Create a text file from the input
      const textBlob = new Blob([textInput.trim()], { type: 'text/plain' })
      const textFile = new File([textBlob], 'text-content.txt', { type: 'text/plain' })
      
      // Use the existing uploadFile logic
      await uploadFile(textFile)
      
      // Don't clear text input - keep it visible and set upload completed state
      setShowTextUploadOption(false)
      setUploadingText(false)
      setTextUploadCompleted(true)
    } catch (error) {
      alert('Text failed to upload as encrypted file. Please try again.')
      setUploadingText(false)
    } finally {
      setUploading(false)
    }
  }

  const cancelTextUpload = () => {
    setUploadingText(false)
    setShowTextUploadOption(true)
  }

  const editTextAgain = () => {
    setTextUploadCompleted(false)
    setUploadedFile(null)
    setQrCodeUrl('')
    // Re-evaluate the text state to show upload option if needed
    if (textInput.trim().length > 700) {
      setShowTextUploadOption(true)
    } else if (textInput.trim().length > 0) {
      generateQRCode(textInput.trim())
      setTextQrGenerated(true)
    }
  }

  useEffect(() => {
    if (uploadedFile) {
      const qrData = {
        url: uploadedFile.downloadUrl,
        passphrase: uploadedFile.passphrase,
        filename: uploadedFile.name,
        //uploadedAt: uploadedFile.uploadTime
      }
      // Add magic header to indicate this is an encrypted file download QR
      const qrPayload = ENCRYPTED_FILE_MAGIC + JSON.stringify(qrData)
      generateQRCode(qrPayload)
    }
  }, [uploadedFile, generateQRCode])

  return (
    <div className="space-y-6">
      <Tabs value={mode} onValueChange={(value) => {
        if (value === 'file') {
          setMode('file')
          resetTextMode()
        } else if (value === 'text') {
          setMode('text')
          resetFileMode()
        }
      }}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="text" className="flex items-center gap-2">
            📝 Text QR Code
          </TabsTrigger>
          <TabsTrigger value="file" className="flex items-center gap-2">
            📁 Upload File
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="mt-2">
          <Card
            className={`border-2 border-dashed transition-all duration-300 cursor-pointer ${
              isDragging 
                ? 'border-primary bg-primary/10 scale-105' 
                : uploading 
                  ? 'border-muted cursor-not-allowed'
                  : 'border-border hover:border-muted-foreground'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <CardContent className="p-12 text-center">
              {uploading ? (
                <div className="flex flex-col items-center gap-4">
                  <Progress value={33} className="w-full max-w-xs" />
                  <p className="text-muted-foreground">Encrypting and uploading file...</p>
                </div>
              ) : (
                <>
                  <div className="text-6xl mb-6">📁</div>
                  <p className="mb-6 text-lg text-muted-foreground">Drag & drop a file here or</p>
                  <input
                    type="file"
                    onChange={handleFileSelect}
                    className="hidden"
                    id="file-input"
                  />
                  <Button 
                    size="lg"
                    onClick={() => document.getElementById('file-input')?.click()}
                    type="button"
                  >
                    Choose File
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="text" className="mt-2">
          <Card>
            <CardContent className="space-y-4 px-2">
              <div className="space-y-2">
                <div className="flex justify-between items-center text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span>Enter your text:</span>
                    <Button
                      size="sm"
                      onClick={() => {
                        setTextInput('')
                        generateTextQR('')
                      }}
                      className="h-6 px-2 text-xs"
                    >
                      Clear
                    </Button>
                  </div>
                  <span className={textInput.length > 700 ? "text-orange-600 font-medium" : ""}>
                    {textInput.length} characters
                  </span>
                </div>
                <Textarea
                  value={textInput}
                  onChange={(e) => {
                    setTextInput(e.target.value)
                    generateTextQR(e.target.value)
                  }}
                  placeholder="Type your text here..."
                  className="min-h-[100px]"
                  readOnly={uploadingText || textUploadCompleted}
                  disabled={uploadingText || textUploadCompleted}
                />
              </div>
              
              {showTextUploadOption && !uploadingText && (
                <Alert>
                  <AlertDescription className="space-y-3">
                    <div className="font-medium flex items-center gap-2">
                      📏 Text is too long for QR code ({textInput.length} characters)
                    </div>
                    <p className="text-sm">
                      QR codes work best with shorter text (under 700 characters). 
                      Would you like to upload this text as an encrypted file instead?
                    </p>
                    <div className="flex gap-3 justify-center flex-wrap pt-2">
                      <Button
                        onClick={uploadTextAsFile}
                        disabled={uploading}
                        className="flex items-center gap-2"
                      >
                        📁 Upload as Encrypted File
                      </Button>
                      <Button 
                        variant="outline"
                        onClick={() => {
                          setTextInput('')
                          setShowTextUploadOption(false)
                        }}
                        disabled={uploading}
                      >
                        Clear Text
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {uploadingText && (
                <Alert>
                  <AlertDescription className="space-y-3">
                    <div className="font-medium flex items-center gap-2">
                      📤 Uploading text as encrypted file...
                    </div>
                    <p className="text-sm">
                      Your text is being encrypted and uploaded. The text above is now read-only.
                    </p>
                    <div className="flex gap-3 justify-center flex-wrap pt-2">
                      <Button
                        disabled={true}
                        className="flex items-center gap-2"
                      >
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Uploading...
                      </Button>
                      <Button 
                        variant="outline"
                        onClick={cancelTextUpload}
                        disabled={uploading}
                      >
                        Cancel
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {textUploadCompleted && (
                <Alert>
                  <AlertDescription className="space-y-3">
                    <div className="font-medium flex items-center gap-2">
                      ✅ Text uploaded successfully
                    </div>
                    <p className="text-sm">
                      Your text has been uploaded as an encrypted file. The text above shows what was uploaded.
                    </p>
                    <div className="flex gap-3 justify-center flex-wrap pt-2">
                      <Button
                        onClick={editTextAgain}
                        variant="outline"
                        className="flex items-center gap-2"
                      >
                        ✏️ Edit Again
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {uploadedFile && (
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-green-600 flex items-center justify-center gap-2">
              ✅ File Uploaded Successfully
            </CardTitle>
            <div className="space-y-1">
              <p className="font-semibold text-lg">{uploadedFile.name}</p>
              <p className="text-sm text-muted-foreground">{uploadedFile.uploadTime}</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <Alert>
              <AlertDescription className="space-y-3">
                <div className="font-medium flex items-center gap-2">
                  🔐 Decryption Passphrase:
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <code className="bg-muted px-3 py-2 rounded font-mono text-sm break-all flex-1 min-w-0">
                    {uploadedFile.passphrase}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(uploadedFile.passphrase)}
                  >
                    📋 Copy
                  </Button>
                </div>
                <p className="text-sm text-destructive font-medium">
                  Save this passphrase - you'll need it to decrypt the file!
                </p>
              </AlertDescription>
            </Alert>

            <div className="text-center space-y-4">
              <Card>
                <CardContent className="p-6">
                  <canvas
                    ref={canvasRef}
                    style={{ display: 'none' }}
                  />
                  {qrCodeUrl && (
                    <img 
                      src={qrCodeUrl} 
                      alt="QR Code with file URL and passphrase"
                      className="mx-auto rounded-lg shadow-sm"
                    />
                  )}
                  <p className="text-sm text-muted-foreground mt-4 max-w-xs mx-auto">
                    Scan with your phone to get the download URL and passphrase
                  </p>
                </CardContent>
              </Card>
            </div>
            
            <div className="flex gap-3 justify-center flex-wrap">
              <Button asChild variant="default">
                <a
                  href={uploadedFile.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  📥 Download Encrypted File
                </a>
              </Button>
              <Button 
                variant="outline"
                onClick={() => setUploadedFile(null)}
              >
                Upload Another File
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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
              Scan with your phone to read the text
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
})

export default Upload