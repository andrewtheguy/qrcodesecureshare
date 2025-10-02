import { useState, useRef, useEffect } from 'react'
import QrScanner from 'qr-scanner'
import { ENCRYPTED_FILE_MAGIC } from '../constants'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { deriveKey } from '@/lib/utils'

interface EncryptedFileData {
  url: string
  passphrase?: string
  privateKey?: string
  filename: string
  uploadedAt?: string
  encryptionType?: 'symmetric' | 'asymmetric'
}

interface ScanState {
  showingDetails: boolean
  confirmDownload: boolean
}

interface ScanProps {
  onGenerateQR?: (text: string) => void
}

const Scan = ({ onGenerateQR }: ScanProps) => {
  const [scannedData, setScannedData] = useState<EncryptedFileData | null>(null)
  const [scannedText, setScannedText] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [decrypting, setDecrypting] = useState(false)
  const [scanState, setScanState] = useState<ScanState>({ showingDetails: false, confirmDownload: false })
  const [uploadMode, setUploadMode] = useState<'camera' | 'file'>('camera')
  const [privateKeyInput, setPrivateKeyInput] = useState('')
  const [showPrivateKeyInput, setShowPrivateKeyInput] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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


  const decryptFileSymmetric = async (encryptedData: ArrayBuffer, passphrase: string): Promise<{ data: ArrayBuffer, filename: string }> => {
    try {
      const encryptedBytes = new Uint8Array(encryptedData)

      // Extract salt, IV, and encrypted data
      const salt = encryptedBytes.slice(0, 16)
      const iv = encryptedBytes.slice(16, 28) // 12 bytes for GCM
      const encrypted = encryptedBytes.slice(28)

      // Derive key from passphrase
      const key = await deriveKey(passphrase, salt)

      // Decrypt the data using AES-GCM
      const decryptedData = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv
        },
        key,
        encrypted
      )

      return {
        data: decryptedData,
        filename: scannedData?.filename || 'decrypted-file'
      }
    } catch (error) {
      console.error('Decryption failed:', error)
      throw new Error('Failed to decrypt file. Please check the passphrase.')
    }
  }

  const decryptFileAsymmetric = async (encryptedData: ArrayBuffer, privateKeyJwk: string): Promise<{ data: ArrayBuffer, filename: string }> => {
    try {
      const encryptedBytes = new Uint8Array(encryptedData)

      // Extract encrypted AES key length (4 bytes)
      const aesKeyLengthBytes = encryptedBytes.slice(0, 4)
      const aesKeyLength = new Uint32Array(aesKeyLengthBytes.buffer)[0]

      // Extract encrypted AES key, IV, and encrypted data
      const encryptedAesKey = encryptedBytes.slice(4, 4 + aesKeyLength)
      const iv = encryptedBytes.slice(4 + aesKeyLength, 4 + aesKeyLength + 12)
      const encrypted = encryptedBytes.slice(4 + aesKeyLength + 12)

      // Import private key from JWK
      const privateKeyData = JSON.parse(privateKeyJwk)
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        privateKeyData,
        {
          name: 'RSA-OAEP',
          hash: 'SHA-256'
        },
        false,
        ['decrypt']
      )

      // Decrypt the AES key using RSA private key
      const decryptedAesKeyBytes = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        privateKey,
        encryptedAesKey
      )

      // Import the AES key
      const aesKey = await crypto.subtle.importKey(
        'raw',
        decryptedAesKeyBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
      )

      // Decrypt the file data with AES-GCM
      const decryptedData = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        aesKey,
        encrypted
      )

      return {
        data: decryptedData,
        filename: scannedData?.filename || 'decrypted-file'
      }
    } catch (error) {
      console.error('Decryption failed:', error)
      throw new Error('Failed to decrypt file. Please check the private key.')
    }
  }

  const downloadDecryptedFile = async () => {
    if (!scannedData) return

    // For asymmetric encryption, require private key input
    if (scannedData.encryptionType === 'asymmetric') {
      if (!privateKeyInput) {
        alert('Please enter the private key to decrypt this file')
        return
      }
    }

    try {
      setDecrypting(true)

      // Use CORS proxy to fetch the encrypted file
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(scannedData.url)}`
      const response = await fetch(proxyUrl)

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`)
      }

      const encryptedData = await response.arrayBuffer()

      // Decrypt the file based on encryption type
      let result: { data: ArrayBuffer, filename: string }

      if (scannedData.encryptionType === 'asymmetric') {
        result = await decryptFileAsymmetric(encryptedData, privateKeyInput)
      } else if (scannedData.passphrase) {
        result = await decryptFileSymmetric(encryptedData, scannedData.passphrase)
      } else {
        throw new Error('Missing decryption credentials')
      }

      const { data, filename } = result

      // Create blob and download decrypted file
      const blob = new Blob([data])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

    } catch (error) {
      console.error('Download and decrypt failed:', error)
      alert(error instanceof Error ? error.message : 'Failed to decrypt and download file')
    } finally {
      setDecrypting(false)
    }
  }

  const startScanning = async () => {
    try {
      setScanning(true)
      console.log('Starting QR scanner...')
      
      // Set worker path - file is copied by Vite plugin during build
      QrScanner.WORKER_PATH = '/qr-scanner-worker.min.js'
      
      // Wait for the next render cycle to ensure video element exists
      await new Promise(resolve => setTimeout(resolve, 100))
      
      if (!videoRef.current) {
        throw new Error('Video element not available')
      }
      
      const scanner = new QrScanner(
        videoRef.current,
        (result) => {
          console.log('QR code detected:', result)
          
          // Check if QR code contains encrypted file data
          if (result.data.startsWith(ENCRYPTED_FILE_MAGIC)) {
            try {
              const jsonData = result.data.substring(ENCRYPTED_FILE_MAGIC.length)
              const data = JSON.parse(jsonData) as EncryptedFileData
              console.log('Parsed encrypted file data:', data)
              setScannedData(data)
              setScannedText(null)
              setScanState({ showingDetails: true, confirmDownload: true })
              stopScanning()
            } catch (error) {
              console.error('Invalid encrypted file data in QR code:', error)
              alert('QR code contains invalid encrypted file data')
            }
          } else {
            // Regular text QR code
            console.log('Regular text QR code:', result.data)
            setScannedText(result.data)
            setScannedData(null)
            stopScanning()
          }
        },
        {
          returnDetailedScanResult: true,
          highlightScanRegion: true,
          highlightCodeOutline: true,
        }
      )
      scannerRef.current = scanner
      await scanner.start()
      console.log('QR scanner started successfully')
    } catch (error) {
      console.error('Failed to start QR scanner:', error)
      alert(`Failed to access camera: ${(error as Error).message}. Please ensure camera permissions are granted.`)
      setScanning(false)
    }
  }

  const stopScanning = () => {
    if (scannerRef.current) {
      scannerRef.current.stop()
      scannerRef.current.destroy()
      scannerRef.current = null
    }
    setScanning(false)
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      console.log('Processing uploaded image for QR code...')
      
      // Set worker path
      QrScanner.WORKER_PATH = '/qr-scanner-worker.min.js'
      
      const result = await QrScanner.scanImage(file, {
        returnDetailedScanResult: true,
      })
      
      console.log('QR code detected from uploaded image:', result)
      
      // Check if QR code contains encrypted file data
      if (result.data.startsWith(ENCRYPTED_FILE_MAGIC)) {
        try {
          const jsonData = result.data.substring(ENCRYPTED_FILE_MAGIC.length)
          const data = JSON.parse(jsonData) as EncryptedFileData
          console.log('Parsed encrypted file data:', data)
          setScannedData(data)
          setScannedText(null)
          setScanState({ showingDetails: true, confirmDownload: true })
        } catch (error) {
          console.error('Invalid encrypted file data in QR code:', error)
          alert('QR code contains invalid encrypted file data')
        }
      } else {
        // Regular text QR code
        console.log('Regular text QR code:', result.data)
        setScannedText(result.data)
        setScannedData(null)
      }
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
      {!scanning && !scannedData && !scannedText && (
        <Card>
          <CardContent className="p-8 text-center">
            <div className="space-y-6">
              <div className="text-6xl">📷</div>
              <div className="space-y-2">
                <h2 className="text-2xl font-bold">Scan QR Code</h2>
                <p className="text-muted-foreground max-w-md mx-auto">
                  Scan a QR code from a previously uploaded file to retrieve the download URL and passphrase
                </p>
              </div>
              
              {/* Mode selection */}
              <div className="flex justify-center gap-2 mb-4">
                <Button
                  variant={uploadMode === 'camera' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setUploadMode('camera')}
                >
                  📷 Camera
                </Button>
                <Button
                  variant={uploadMode === 'file' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setUploadMode('file')}
                >
                  📁 Upload Image
                </Button>
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
              />
              <Button variant="outline" onClick={stopScanning}>
                Stop Scanning
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
        
      {scannedData && scanState.confirmDownload && (
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-green-600 flex items-center justify-center gap-2">
              🔐 This QR Code is an Encrypted File
            </CardTitle>
            <CardDescription className="text-lg font-semibold">
              File Details
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="grid gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">📄 Filename:</span>
                  <code className="bg-muted px-2 py-1 rounded font-mono text-sm">
                    {scannedData.filename}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">🔗 URL:</span>
                  <code className="bg-muted px-2 py-1 rounded font-mono text-xs break-all">
                    {scannedData.url}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(scannedData.url)}
                  >
                    📋
                  </Button>
                </div>
                {scannedData.uploadedAt && (
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-muted-foreground">📅 Uploaded:</span>
                    <span className="text-sm">
                      {new Date(scannedData.uploadedAt).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {scannedData.encryptionType === 'asymmetric' ? (
              <Alert>
                <AlertDescription className="space-y-3">
                  <div className="font-medium flex items-center gap-2">
                    🔑 Enter Private Key to Decrypt:
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="privateKeyDec" className="text-sm">Private Key (JWK):</Label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowPrivateKeyInput(!showPrivateKeyInput)}
                        className="h-6 px-2 text-xs"
                      >
                        {showPrivateKeyInput ? 'Hide' : 'Show'}
                      </Button>
                    </div>
                    {showPrivateKeyInput && (
                      <Textarea
                        id="privateKeyDec"
                        value={privateKeyInput}
                        onChange={(e) => setPrivateKeyInput(e.target.value)}
                        placeholder='{"kty":"RSA","d":"...","n":"...","e":"AQAB",...}'
                        className="font-mono text-xs h-32"
                      />
                    )}
                    {privateKeyInput && (
                      <p className="text-xs text-green-600">✓ Private key entered</p>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    This file uses asymmetric encryption (RSA-OAEP). Enter your private key above to decrypt.
                  </p>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <AlertDescription className="space-y-3">
                  <div className="font-medium flex items-center gap-2">
                    🔐 Decryption Passphrase:
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <code className="bg-muted px-3 py-2 rounded font-mono text-sm break-all flex-1 min-w-0">
                      {scannedData.passphrase}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(scannedData.passphrase!)}
                    >
                      📋 Copy
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    This file uses symmetric encryption (AES-GCM)
                  </p>
                </AlertDescription>
              </Alert>
            )}
            
            <div className="flex gap-3 justify-center flex-wrap">
              <Button
                onClick={downloadDecryptedFile}
                disabled={decrypting || (scannedData.encryptionType === 'asymmetric' && !privateKeyInput)}
                className="flex items-center gap-2"
              >
                {decrypting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    Decrypting...
                  </>
                ) : (
                  '📥 Download Original File'
                )}
              </Button>
              <Button 
                variant="outline"
                onClick={() => {
                  setScannedData(null)
                  setScannedText(null)
                  setScanState({ showingDetails: false, confirmDownload: false })
                  setUploadMode('camera')
                }}
                disabled={decrypting}
              >
                Scan Another QR
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
            <div className="space-y-3">
              <div className="bg-muted p-4 rounded-md font-mono text-sm whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto text-left">
                {renderTextWithLinks(scannedText)}
              </div>
              <div className="flex justify-center gap-3">
                <Button 
                  variant="outline"
                  onClick={() => copyToClipboard(scannedText)}
                >
                  📋 Copy Text
                </Button>
                {onGenerateQR && (
                  <Button 
                    onClick={() => onGenerateQR(scannedText)}
                  >
                    🔄 Generate QR Code
                  </Button>
                )}
              </div>
            </div>
            
            <div className="text-center">
              <Button 
                onClick={() => {
                  setScannedData(null)
                  setScannedText(null)
                  setUploadMode('camera')
                }}
              >
                Scan Another QR
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default Scan