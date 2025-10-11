import { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import QRCode from 'qrcode'
import { ENCRYPTED_FILE_MAGIC } from '../constants'
import { PUBLIC_KEY_JWK } from '../config/publicKey'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { deriveKey } from '@/lib/utils'
import { getJwkSshFingerprint } from '@/utils/fingerprint'
import { WebRTCSender } from './WebRTCSender'

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
  passphrase?: string
  encryptionType: 'symmetric' | 'asymmetric'
  publicKeyFingerprint?: string
}

export interface UploadRef {
  setTextFromScan: (text: string) => void
}

interface UploadProps {
  mode?: 'file' | 'text'
}

const Upload = forwardRef<UploadRef, UploadProps>(({ mode: initialMode = 'text' }, ref) => {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const mode = initialMode
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const [showTextUploadOption, setShowTextUploadOption] = useState(false)
  const [uploadingText, setUploadingText] = useState(false)
  const [textUploadCompleted, setTextUploadCompleted] = useState(false)
  const [encryptionType, setEncryptionType] = useState<'symmetric' | 'asymmetric'>('symmetric')
  const [transferMethod, setTransferMethod] = useState<'server' | 'webrtc'>('server')
  const [webrtcFile, setWebrtcFile] = useState<File | null>(null)
  const [webrtcKey, setWebrtcKey] = useState<string>('')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useImperativeHandle(ref, () => ({
    setTextFromScan: (text: string) => {
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


  const encryptFileSymmetric = async (file: File, passphrase: string): Promise<File> => {
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

  const encryptFileAsymmetric = async (file: File, publicKey: CryptoKey): Promise<File> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer

          // For large files, use hybrid encryption: AES-GCM for file, RSA for AES key
          const aesKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
          )

          const iv = crypto.getRandomValues(new Uint8Array(12))

          // Encrypt file with AES-GCM
          const encryptedData = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            aesKey,
            arrayBuffer
          )

          // Export AES key and encrypt it with RSA public key
          const rawAesKey = await crypto.subtle.exportKey('raw', aesKey)
          const encryptedAesKey = await crypto.subtle.encrypt(
            { name: 'RSA-OAEP' },
            publicKey,
            rawAesKey
          )

          // Combine: encryptedAesKey length (4 bytes) + encrypted AES key + IV + encrypted data
          const aesKeyLength = new Uint32Array([encryptedAesKey.byteLength])
          const encryptedBytes = new Uint8Array(
            4 + encryptedAesKey.byteLength + iv.length + encryptedData.byteLength
          )

          encryptedBytes.set(new Uint8Array(aesKeyLength.buffer), 0)
          encryptedBytes.set(new Uint8Array(encryptedAesKey), 4)
          encryptedBytes.set(iv, 4 + encryptedAesKey.byteLength)
          encryptedBytes.set(new Uint8Array(encryptedData), 4 + encryptedAesKey.byteLength + iv.length)

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
    let encryptedFile: File
    let fileData: UploadedFile

    if (encryptionType === 'symmetric') {
      const passphrase = generatePassphrase()
      encryptedFile = await encryptFileSymmetric(file, passphrase)

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
          fileData = {
            name: file.name,
            originalUrl: result.data.url,
            downloadUrl,
            uploadTime: new Date().toISOString(),
            passphrase,
            encryptionType: 'symmetric'
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
    } else {
      // Asymmetric encryption - use hardcoded public key
      const publicKey = await crypto.subtle.importKey(
        'jwk',
        PUBLIC_KEY_JWK,
        {
          name: 'RSA-OAEP',
          hash: 'SHA-256'
        },
        true,
        ['encrypt']
      )

      encryptedFile = await encryptFileAsymmetric(file, publicKey)

      // Compute a stable fingerprint for the hardcoded public key
  const publicKeyFingerprint = await getJwkSshFingerprint(JSON.stringify(PUBLIC_KEY_JWK))

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

          fileData = {
            name: file.name,
            originalUrl: result.data.url,
            downloadUrl,
            uploadTime: new Date().toISOString(),
            encryptionType: 'asymmetric',
            publicKeyFingerprint
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
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const file = files[0]

    if (transferMethod === 'webrtc') {
      // For WebRTC, just encrypt the file and prepare for transfer
      try {
        setUploading(true)
        const passphrase = generatePassphrase()
        const encryptedFile = await encryptFileSymmetric(file, passphrase)
        setWebrtcFile(encryptedFile)
        setWebrtcKey(passphrase)
      } catch (error) {
        alert('File encryption failed. Please try again.')
      } finally {
        setUploading(false)
      }
    } else {
      // Server upload
      setUploading(true)
      try {
        await uploadFile(file)
      } catch (error) {
        alert('File failed to upload. Please try again.')
      } finally {
        setUploading(false)
      }
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
    setWebrtcFile(null)
    setWebrtcKey('')
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
      const qrData = uploadedFile.encryptionType === 'symmetric'
        ? {
            url: uploadedFile.downloadUrl,
            passphrase: uploadedFile.passphrase,
            filename: uploadedFile.name,
            encryptionType: 'symmetric'
          }
        : {
            url: uploadedFile.downloadUrl,
            filename: uploadedFile.name,
            encryptionType: 'asymmetric',
            publicKeyFingerprint: uploadedFile.publicKeyFingerprint
          }

      // Add magic header to indicate this is an encrypted file download QR
      const qrPayload = ENCRYPTED_FILE_MAGIC + JSON.stringify(qrData)
      generateQRCode(qrPayload)
    }
  }, [uploadedFile, generateQRCode])

  // Pre-compute and show the hardcoded public key fingerprint(s) for user verification.
  const [publicKeySshFp, setPublicKeySshFp] = useState<string | null>(null)
  const [publicKeyFpError, setPublicKeyFpError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const sshFp = await getJwkSshFingerprint(JSON.stringify(PUBLIC_KEY_JWK))
        setPublicKeySshFp(sshFp)
      } catch (e) {
        setPublicKeyFpError((e as Error).message)
      }
    })()
  }, [])

  return (
    <div className="space-y-6">
      {mode === 'file' && (
        <>
          <Card className="mb-4">
            <CardContent className="pt-6">
              <div className="space-y-6">
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Encryption Type</Label>
                  <RadioGroup
                    value={encryptionType}
                    onValueChange={(value: 'symmetric' | 'asymmetric') => setEncryptionType(value)}
                    disabled={uploading}
                  >
                    <div className="flex items-start space-x-3 space-y-0">
                      <RadioGroupItem value="symmetric" id="symmetric" />
                      <div className="space-y-1 leading-none">
                        <Label htmlFor="symmetric" className="cursor-pointer">
                          Symmetric (Passphrase-based)
                        </Label>
                        <p className="text-sm text-muted-foreground text-left">
                          Uses AES-GCM encryption with a random passphrase. Both sender and receiver use the same passphrase.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start space-x-3 space-y-0">
                      <RadioGroupItem value="asymmetric" id="asymmetric" />
                      <div className="space-y-1 leading-none flex-1">
                        <Label htmlFor="asymmetric" className="cursor-pointer">
                          Asymmetric (Public/Private Key)
                        </Label>
                        <p className="text-sm text-muted-foreground text-left">
                          Uses RSA-OAEP encryption with hardcoded public key. Only the private key holder can decrypt.
                        </p>
                        {encryptionType === 'asymmetric' && (
                          <div className="mt-2 space-y-1">
                            <p className="text-sm text-green-600 text-left">✓ Public key configured (hardcoded in app)</p>
                            {publicKeyFpError && (
                              <p className="text-[10px] text-red-500">Fingerprint error: {publicKeyFpError}</p>
                            )}
                            {!publicKeyFpError && (
                              <>
                                {publicKeySshFp && (
                                  <div className="flex items-center gap-1 flex-wrap text-sm">
                                    <span className="text-muted-foreground">Fingerprint:</span>
                                    <code className="font-mono px-2 py-1 rounded bg-muted/70 dark:bg-zinc-800 text-muted-foreground break-all">
                                      {publicKeySshFp}
                                    </code>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </RadioGroup>
                </div>

                {encryptionType === 'symmetric' && (
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">Transfer Method</Label>
                    <RadioGroup
                      value={transferMethod}
                      onValueChange={(value: 'server' | 'webrtc') => setTransferMethod(value)}
                      disabled={uploading}
                    >
                      <div className="flex items-start space-x-3 space-y-0">
                        <RadioGroupItem value="server" id="server" />
                        <div className="space-y-1 leading-none">
                          <Label htmlFor="server" className="cursor-pointer">
                            Server Upload + QR Code
                          </Label>
                          <p className="text-sm text-muted-foreground text-left">
                            Upload encrypted file to server and generate QR code with download link and passphrase.
                          </p>
                        </div>
                      </div>
                      <div className="flex items-start space-x-3 space-y-0">
                        <RadioGroupItem value="webrtc" id="webrtc" />
                        <div className="space-y-1 leading-none flex-1">
                          <Label htmlFor="webrtc" className="cursor-pointer">
                            WebRTC Peer-to-Peer Transfer
                          </Label>
                          <p className="text-sm text-muted-foreground text-left">
                            Direct peer-to-peer transfer using WebRTC. Generate QR code with connection info and encryption key.
                          </p>
                        </div>
                      </div>
                    </RadioGroup>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

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
        </>
      )}

      {mode === 'text' && (
        <>
          <Card>
            <CardContent className="space-y-4 px-2">
              <div className="space-y-2">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2 flex-wrap">
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
                    <Button
                      size="sm"
                      onClick={() => {
                        const currentUrl = window.location.href
                        setTextInput(currentUrl)
                        generateTextQR(currentUrl)
                      }}
                      className="h-6 px-2 text-xs"
                      variant="outline"
                    >
                      QR for This Site
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
                          generateQRCode(textInput.trim())
                          setTextQrGenerated(true)
                          setShowTextUploadOption(false)
                        }}
                        disabled={uploading}
                      >
                        Generate QR Anyway
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
        </>
      )}

      {/* WebRTC Transfer */}
      {webrtcFile && webrtcKey && transferMethod === 'webrtc' && (
        <WebRTCSender
          encryptedFile={webrtcFile}
          encryptionKey={webrtcKey}
          onReset={() => {
            setWebrtcFile(null)
            setWebrtcKey('')
          }}
        />
      )}

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
            {uploadedFile.encryptionType === 'symmetric' ? (
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
                      onClick={() => copyToClipboard(uploadedFile.passphrase!)}
                    >
                      📋 Copy
                    </Button>
                  </div>
                  <p className="text-sm text-destructive font-medium">
                    Save this passphrase - you'll need it to decrypt the file!
                  </p>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <AlertDescription className="space-y-3">
                  <div className="font-medium flex items-center gap-2">
                    🔑 Asymmetric Encryption Used
                  </div>
                  <p className="text-sm text-muted-foreground text-left">
                    This file was encrypted with a public key. You'll need to provide the corresponding private key when scanning the QR code to decrypt it.
                  </p>
                </AlertDescription>
              </Alert>
            )}

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
                    Scan QR code to get the download URL and passphrase
                  </p>
                  {uploadedFile.encryptionType === 'asymmetric' && qrCodeUrl && (
                    <div className="mt-6 space-y-2 text-left">
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-xs text-muted-foreground font-medium m-0">QR Code Payload (no secrets):</p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          onClick={() => copyToClipboard(ENCRYPTED_FILE_MAGIC + JSON.stringify({
                            url: uploadedFile.downloadUrl,
                            filename: uploadedFile.name,
                            encryptionType: 'asymmetric',
                            publicKeyFingerprint: uploadedFile.publicKeyFingerprint
                          }))}
                        >
                          Copy
                        </Button>
                      </div>
                      <pre className="bg-muted p-3 rounded text-[10px] leading-snug overflow-x-auto whitespace-pre-wrap break-all max-h-40 border border-border">
{ENCRYPTED_FILE_MAGIC + JSON.stringify({
  url: uploadedFile.downloadUrl,
  filename: uploadedFile.name,
  encryptionType: 'asymmetric',
  publicKeyFingerprint: uploadedFile.publicKeyFingerprint
})}
                      </pre>
                    </div>
                  )}
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
              Scan QR code to read the text
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
})

export default Upload