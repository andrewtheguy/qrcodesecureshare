import { useState, useCallback, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { ENCRYPTED_FILE_MAGIC } from '../constants'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'

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

const Upload = () => {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [mode, setMode] = useState<'file' | 'text'>('file')
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

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

  const deriveKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
    const encoder = new TextEncoder()
    const passphraseKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    )

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passphraseKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
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
      // Generate QR code for plain text (no magic header)
      generateQRCode(text.trim())
      setTextQrGenerated(true)
    } else {
      setTextQrGenerated(false)
      setQrCodeUrl('')
    }
  }

  const resetTextMode = () => {
    setTextInput('')
    setTextQrGenerated(false)
    setQrCodeUrl('')
  }

  const resetFileMode = () => {
    setUploadedFile(null)
    setQrCodeUrl('')
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
          <TabsTrigger value="file" className="flex items-center gap-2">
            📁 Upload File
          </TabsTrigger>
          <TabsTrigger value="text" className="flex items-center gap-2">
            📝 Text QR Code
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="mt-6">
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
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    <Button size="lg">
                      Choose File
                    </Button>
                  </label>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="text" className="mt-6">
          <Card>
            <CardHeader className="text-center">
              <div className="text-6xl mb-4">📝</div>
              <CardTitle>Text QR Code Generator</CardTitle>
              <CardDescription>
                Enter text to generate a QR code instantly
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={textInput}
                onChange={(e) => {
                  setTextInput(e.target.value)
                  generateTextQR(e.target.value)
                }}
                placeholder="Type your text here..."
                className="min-h-[100px]"
              />
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
          <CardContent className="p-6 text-center">
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
}

export default Upload