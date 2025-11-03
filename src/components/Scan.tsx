import { useState, useRef, useEffect, useCallback } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ENCRYPTED_FILE_MAGIC, WEBRTC_TRANSFER_MAGIC } from '../constants'
import { decodeQRFromImage } from '@/utils/zxingWorkerUtils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { deriveKey } from '@/lib/utils'
import { importAndSetPrivateKey, getPrivateKey as vaultGetPrivateKey, clearPrivateKey as vaultClearPrivateKey } from '@/utils/privateKeyVault'
import { getJwkSshFingerprint } from '@/utils/fingerprint'
import { WebRTCReceiver } from './WebRTCReceiver'
import { useZXingQRScanner } from '@/hooks/useZXingQRScanner'

interface EncryptedFileData {
  url: string
  passphrase?: string
  privateKey?: string
  filename: string
  uploadedAt?: string
  encryptionType?: 'symmetric' | 'asymmetric'
  publicKeyFingerprint?: string
}

interface ScanState {
  showingDetails: boolean
  confirmDownload: boolean
}

interface WebRTCScanData {
  type: 'webrtc-transfer'
  peerId: string
  encryptionKey: string
  filename: string
  fileSize: number
}

interface ScanProps {
  onGenerateQR?: (text: string) => void
  defaultMode?: 'camera' | 'file'
}

interface WebRTCReceiveState {
  isReceiving: boolean
  data: WebRTCScanData | null
}

const Scan = ({ onGenerateQR, defaultMode = 'camera' }: ScanProps) => {
  const location = useLocation()
  const [scannedData, setScannedData] = useState<EncryptedFileData | null>(null)
  const [scannedText, setScannedText] = useState<string | null>(null)
  const [webrtcReceive, setWebrtcReceive] = useState<WebRTCReceiveState>({ isReceiving: false, data: null })
  const [scanning, setScanning] = useState(false)
  const [decrypting, setDecrypting] = useState(false)
  const [scanState, setScanState] = useState<ScanState>({ showingDetails: false, confirmDownload: false })
  const [uploadMode, setUploadMode] = useState<'camera' | 'file'>(defaultMode)

  // Sync uploadMode with route changes
  useEffect(() => {
    if (location.pathname === '/scan/camera') {
      setUploadMode('camera')
    } else if (location.pathname === '/scan/upload') {
      setUploadMode('file')
    }
  }, [location.pathname])
  const [privateKeyInput, setPrivateKeyInput] = useState('') // raw input field (cleared after load)
  const [privateKeyStatus, setPrivateKeyStatus] = useState<'empty' | 'importing' | 'loaded' | 'error'>('empty')
  const [privateKeyFingerprint, setPrivateKeyFingerprint] = useState<string | null>(null)
  const [privateKeyError, setPrivateKeyError] = useState<string | null>(null)
  const [copiedFeedback, setCopiedFeedback] = useState<string | null>(null)
  // Simplified camera handling: only track facing mode categories (environment/back vs user/front)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(() => (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'environment' : 'user'))
  const [cameraError, setCameraError] = useState<string | null>(null)
  const privateKeyImportDebounceRef = useRef<number | null>(null)
  const pageHiddenAtRef = useRef<number | null>(null)
  const VISIBILITY_CLEAR_THRESHOLD_MS = 60_000 // Clear if tab hidden > 60s
  // Timer ref to auto-clear private key after inactivity
  const privateKeyClearTimeoutRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Handle QR scan results (multiple QR codes from a single scan)
  const handleQRScan = useCallback((qrCodes: (string | Uint8Array)[]) => {
    if (!qrCodes || qrCodes.length === 0) {
      return
    }

    // Process the first QR code for now (can be extended to handle multiple in the future)
    const qrData = qrCodes[0]
    // Convert Uint8Array to string if needed
    const data = qrData instanceof Uint8Array ? new TextDecoder().decode(qrData) : qrData
    console.log('QR code detected:', data)

    // Check if QR code contains encrypted file data
    if (data.startsWith(ENCRYPTED_FILE_MAGIC)) {
      try {
        const jsonData = data.substring(ENCRYPTED_FILE_MAGIC.length)
        const parsedData = JSON.parse(jsonData) as EncryptedFileData
        console.log('Parsed encrypted file data:', parsedData)
        setScannedData(parsedData)
        setScannedText(null)
        setScanState({ showingDetails: true, confirmDownload: true })
        setScanning(false)
      } catch (error) {
        console.error('Invalid encrypted file data in QR code:', error)
        alert('QR code contains invalid encrypted file data')
      }
    } else if (data.startsWith(WEBRTC_TRANSFER_MAGIC)) {
      // Check if it's a WebRTC transfer QR code
      try {
        const jsonData = data.substring(WEBRTC_TRANSFER_MAGIC.length)
        const parsedData = JSON.parse(jsonData) as WebRTCScanData
        console.log('Parsed WebRTC transfer data:', parsedData)
        // Show WebRTC receiver directly in this tab
        setWebrtcReceive({ isReceiving: true, data: parsedData })
        setScannedData(null)
        setScannedText(null)
        setScanning(false)
      } catch (error) {
        console.error('Invalid WebRTC transfer data in QR code:', error)
        alert('QR code contains invalid WebRTC transfer data')
      }
    } else {
      // Regular text QR code
      console.log('Regular text QR code:', data)
      setScannedText(data)
      setScannedData(null)
      setScanning(false)
    }
  }, [])

  // Handle camera errors
  const handleCameraError = useCallback((error: string) => {
    setCameraError(error)
    setScanning(false)
  }, [])

  // Use the new zxing-wasm scanner hook with maximized detection for general QR code scanning
  const { videoRef, canvasRef, availableCameras } = useZXingQRScanner({
    onScan: handleQRScan,
    onError: handleCameraError,
    isScanning: scanning,
    facingMode: facingMode,
    // Maximize detection for challenging QR codes (worn, angled, poor lighting, color variations)
    readerOptions: {
      formats: ['QRCode'],
      tryHarder: true, // Spend more time finding barcodes
      tryRotate: true, // Check rotated versions
      tryInvert: true, // Check inverted versions (important for color/contrast variations)
      tryDownscale: true, // Try downscaled versions for distant QR codes
      tryDenoise: true, // Experimental: try denoising for noisy images
      binarizer: 'LocalAverage', // Use adaptive thresholding for color variations
      maxNumberOfSymbols: 1, // Only return first QR code found
    },
  })

  const copyToClipboard = async (text: string, label?: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedFeedback(label || 'Copied!')
      setTimeout(() => setCopiedFeedback(null), 2000)
    } catch {
      const textArea = document.createElement('textarea')
      textArea.value = text
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopiedFeedback(label || 'Copied!')
      setTimeout(() => setCopiedFeedback(null), 2000)
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

  const decryptFileAsymmetric = async (encryptedData: ArrayBuffer): Promise<{ data: ArrayBuffer, filename: string }> => {
    try {
      const encryptedBytes = new Uint8Array(encryptedData)

      // Extract encrypted AES key length (4 bytes)
      const aesKeyLengthBytes = encryptedBytes.slice(0, 4)
      const aesKeyLength = new Uint32Array(aesKeyLengthBytes.buffer)[0]

      // Extract encrypted AES key, IV, and encrypted data
      const encryptedAesKey = encryptedBytes.slice(4, 4 + aesKeyLength)
      const iv = encryptedBytes.slice(4 + aesKeyLength, 4 + aesKeyLength + 12)
      const encrypted = encryptedBytes.slice(4 + aesKeyLength + 12)

      // Retrieve already-imported private CryptoKey
      const privateKey = vaultGetPrivateKey()
      if (!privateKey) {
        throw new Error('Private key not loaded')
      }

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
        if (!vaultGetPrivateKey()) {
          alert('Please load/import the private key to decrypt this file')
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
        result = await decryptFileAsymmetric(encryptedData)
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

      // Clear private key immediately after successful asymmetric decryption & download
      if (scannedData.encryptionType === 'asymmetric') {
        setPrivateKeyInput('')
        vaultClearPrivateKey()
        setPrivateKeyStatus('empty')
        setPrivateKeyFingerprint(null)
        if (privateKeyClearTimeoutRef.current) {
          clearTimeout(privateKeyClearTimeoutRef.current)
          privateKeyClearTimeoutRef.current = null
        }
      }

    } catch (error) {
      console.error('Download and decrypt failed:', error)
      alert(error instanceof Error ? error.message : 'Failed to decrypt and download file')
    } finally {
      setDecrypting(false)
    }
  }

  const startScanning = () => {
    setCameraError(null)
    setScanning(true)
  }

  const stopScanning = () => {
    setScanning(false)
  }

  const toggleFacingMode = () => {
    const nextMode: 'environment' | 'user' = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(nextMode)
    // The hook will automatically restart the camera with the new facingMode
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      console.log('Processing uploaded image for QR code...')

      // Decode the QR codes using zxing-wasm worker
      const results = await decodeQRFromImage(file)

      if (!results || results.length === 0) {
        alert('No QR code found in the uploaded image. Please try a different image.')
        return
      }

      console.log('QR codes detected from uploaded image:', results)

      // Use the same handler as camera scan, passing all detected QR codes
      handleQRScan(results)
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

  // Reset inactivity timer whenever a private key is LOADED (CryptoKey present); auto-clear after 5 minutes
  useEffect(() => {
    if (privateKeyClearTimeoutRef.current) {
      clearTimeout(privateKeyClearTimeoutRef.current)
      privateKeyClearTimeoutRef.current = null
    }
    if (privateKeyStatus === 'loaded') {
      privateKeyClearTimeoutRef.current = window.setTimeout(() => {
        setPrivateKeyInput('')
        vaultClearPrivateKey()
        setPrivateKeyStatus('empty')
        setPrivateKeyFingerprint(null)
      }, 5 * 60 * 1000)
    }
  }, [privateKeyStatus])

  // On mount, hydrate status from vault (component remount within tab lifetime)
  useEffect(() => {
    const existing = vaultGetPrivateKey()
    if (existing) {
      setPrivateKeyStatus('loaded')
    }
  }, [])

  // Visibility change handling: clear key if tab hidden longer than threshold
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        pageHiddenAtRef.current = Date.now()
      } else if (document.visibilityState === 'visible') {
        if (pageHiddenAtRef.current) {
          const hiddenFor = Date.now() - pageHiddenAtRef.current
          if (hiddenFor > VISIBILITY_CLEAR_THRESHOLD_MS && vaultGetPrivateKey()) {
            vaultClearPrivateKey()
            setPrivateKeyStatus('empty')
            setPrivateKeyInput('')
            setPrivateKeyFingerprint(null)
            if (privateKeyClearTimeoutRef.current) {
              clearTimeout(privateKeyClearTimeoutRef.current)
              privateKeyClearTimeoutRef.current = null
            }
          }
          pageHiddenAtRef.current = null
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  const handleImportPrivateKey = useCallback(async (raw?: string) => {
    const candidate = (raw !== undefined ? raw : privateKeyInput).trim()
    if (!candidate) return
    setPrivateKeyStatus('importing')
    setPrivateKeyError(null)
    try {
      // Compute Base58 fingerprint (public portion) before import
      try {
        const fp = await getJwkSshFingerprint(candidate)
        setPrivateKeyFingerprint(fp)
      } catch (err) {
        console.warn('Failed to compute fingerprint:', err)
        // If fingerprint cannot be computed (unsupported key), we proceed without it
        setPrivateKeyFingerprint(null)
      }
      await importAndSetPrivateKey(candidate)
      // Clear raw input immediately after successful import
      setPrivateKeyInput('')
      setPrivateKeyStatus('loaded')
    } catch (e: unknown) {
      setPrivateKeyStatus('error')
      const errorMessage = e instanceof Error ? e.message : 'Failed to import private key'
      setPrivateKeyError(errorMessage)
      setPrivateKeyFingerprint(null)
    }
  }, [privateKeyInput, setPrivateKeyStatus, setPrivateKeyError, setPrivateKeyFingerprint, setPrivateKeyInput])

  // Attempt auto-import (debounced) when user types a likely complete JWK
  useEffect(() => {
    if (privateKeyStatus === 'loaded' || privateKeyStatus === 'importing') return
    if (privateKeyImportDebounceRef.current) {
      clearTimeout(privateKeyImportDebounceRef.current)
      privateKeyImportDebounceRef.current = null
    }
    const candidate = privateKeyInput.trim()
    if (!candidate) return
    // Heuristic: must start with { and end with } and contain '"kty"' + '"d"'
    if (candidate.startsWith('{') && candidate.endsWith('}') && /"kty"/.test(candidate) && /"d"/.test(candidate)) {
      privateKeyImportDebounceRef.current = window.setTimeout(() => {
        handleImportPrivateKey()
      }, 500) // 500ms debounce
    }
  }, [privateKeyInput, privateKeyStatus, handleImportPrivateKey])

  // Paste-detect immediate import
  const handlePrivateKeyPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const raw = e.clipboardData.getData('text')
    const text = raw.trim()
    setPrivateKeyInput(text)
    if (text.startsWith('{') && text.endsWith('}') && /"kty"/.test(text)) {
      if (privateKeyImportDebounceRef.current) {
        clearTimeout(privateKeyImportDebounceRef.current)
        privateKeyImportDebounceRef.current = null
      }
      // Direct import using raw text to avoid race with async state update
      handleImportPrivateKey(text)
    }
  }

  return (
    <div className="space-y-6">
      {copiedFeedback && (
        <div className="fixed top-4 left-2/3 -translate-x-1/2 bg-green-600 text-white px-4 py-2 rounded-md shadow-lg z-50 animate-in fade-in slide-in-from-top-2">
          ✓ {copiedFeedback}
        </div>
      )}
      {!scanning && !scannedData && !scannedText && !webrtcReceive.isReceiving && (
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
                <NavLink to="/scan/camera">
                  {({ isActive }) => (
                    <Button
                      variant={isActive ? 'default' : 'outline'}
                      size="sm"
                    >
                      📷 Camera
                    </Button>
                  )}
                </NavLink>
                <NavLink to="/scan/upload">
                  {({ isActive }) => (
                    <Button
                      variant={isActive ? 'default' : 'outline'}
                      size="sm"
                    >
                      📁 Upload Image
                    </Button>
                  )}
                </NavLink>
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
                autoPlay
              />
              <canvas ref={canvasRef} className="hidden" />
              <div className="flex flex-col gap-2 items-center">
                {availableCameras.length > 1 && (
                  <div className="flex items-center gap-3 flex-wrap justify-center">
                    <span className="text-xs font-medium text-muted-foreground">Mode:</span>
                    <code className="text-xs bg-muted px-2 py-1 rounded">{facingMode}</code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      onClick={toggleFacingMode}
                    >
                      🔄 Flip
                    </Button>
                  </div>
                )}
                {cameraError && <p className="text-xs text-red-600">{cameraError}</p>}
              </div>
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
              <>
                <Alert>
                  <AlertDescription className="space-y-4">
                    <div className="font-medium flex items-center gap-2">
                      🔑 Asymmetric Encryption (RSA-OAEP)
                    </div>
                    {scannedData.publicKeyFingerprint && (
                      <div className="flex flex-wrap items-center gap-2 w-full overflow-x-auto">
                        <span className="font-medium text-muted-foreground">🆔 Public Key Fingerprint:</span>
                        <code className="bg-muted px-2 py-1 rounded font-mono text-xs break-all whitespace-pre-wrap w-full max-w-full">
                          {scannedData.publicKeyFingerprint}
                        </code>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(scannedData.publicKeyFingerprint!)}
                          className="h-6 px-2 text-xs"
                        >
                          Copy
                        </Button>
                      </div>
                    )}
                    <div className="space-y-2 w-full justify-self-stretch">
                      <Label htmlFor="privateKeyDec" className="text-sm">Private Key (JWK):</Label>
                      <div className="w-full flex flex-col gap-2">
                        <div className="flex gap-2 items-start">
                          <Input
                            id="privateKeyDec"
                            type="password"
                            value={privateKeyInput}
                            onChange={(e) => setPrivateKeyInput(e.target.value)}
                            onPaste={handlePrivateKeyPaste}
                            onFocus={(e) => {
                              // Select all existing text to make replacement/paste easier
                              // Wrap in setTimeout to ensure mobile browsers sometimes honor it after focus
                              setTimeout(() => {
                                try { e.target.select() } catch {
                                  /* noop */
                                }
                              }, 0)
                            }}
                            placeholder={privateKeyStatus === 'loaded' ? 'Private key loaded' : 'Paste private key (JWK JSON format)'}
                            disabled={privateKeyStatus === 'importing'}
                            className="font-mono text-[11px] w-full block !w-full justify-self-stretch"
                          />
                          {privateKeyStatus !== 'loaded' && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!privateKeyInput.trim() || privateKeyStatus === 'importing'}
                              className="shrink-0 h-8 text-xs"
                              onClick={() => handleImportPrivateKey()}
                            >
                              {privateKeyStatus === 'importing' ? 'Loading...' : 'Load'}
                            </Button>
                          )}
                          {privateKeyStatus === 'loaded' && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="shrink-0 h-8 text-xs"
                              onClick={() => {
                                setPrivateKeyInput('')
                                vaultClearPrivateKey()
                                setPrivateKeyStatus('empty')
                                if (privateKeyClearTimeoutRef.current) {
                                  clearTimeout(privateKeyClearTimeoutRef.current)
                                  privateKeyClearTimeoutRef.current = null
                                }
                              }}
                            >
                              Clear
                            </Button>
                          )}
                        </div>
                        {privateKeyStatus === 'loaded' && (
                          <div className="flex flex-col gap-1">
                            <p className="text-xs text-green-600">✓ Private key imported & stored ephemerally (auto-clears after 5 min inactivity, after download, tab hide, or manual clear)</p>
                            {privateKeyFingerprint && (
                              <div className="flex items-center gap-2 flex-wrap text-xs w-full overflow-x-auto">
                                <span className="font-medium text-muted-foreground">Fingerprint:</span>
                                <code className="bg-muted px-2 py-1 rounded font-mono text-[10px] break-all whitespace-pre-wrap w-full max-w-full">
                                  {privateKeyFingerprint}
                                </code>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  type="button"
                                  onClick={() => copyToClipboard(privateKeyFingerprint)}
                                >
                                  Copy Full
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                        {privateKeyStatus === 'error' && (
                          <p className="text-xs text-red-600">{privateKeyError}</p>
                        )}
                        {privateKeyStatus === 'importing' && (
                          <p className="text-xs text-muted-foreground">Importing private key…</p>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Provide the matching private key to decrypt the embedded AES key and recover the original file.
                    </p>
                  </AlertDescription>
                </Alert>
                <div className="mt-6 space-y-2 text-left">
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-xs text-muted-foreground font-medium m-0">QR Payload (no secrets):</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={() => copyToClipboard(ENCRYPTED_FILE_MAGIC + JSON.stringify({
                        url: scannedData.url,
                        filename: scannedData.filename,
                        encryptionType: 'asymmetric',
                        publicKeyFingerprint: scannedData.publicKeyFingerprint
                      }))}
                    >
                      Copy
                    </Button>
                  </div>
                  <pre className="bg-muted p-3 rounded text-[10px] leading-snug overflow-x-auto whitespace-pre-wrap break-all max-h-40 border border-border w-full max-w-full">
{ENCRYPTED_FILE_MAGIC + JSON.stringify({
  url: scannedData.url,
  filename: scannedData.filename,
  encryptionType: 'asymmetric',
  publicKeyFingerprint: scannedData.publicKeyFingerprint
})}
                  </pre>
                </div>
              </>
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
                disabled={decrypting || (scannedData.encryptionType === 'asymmetric' && privateKeyStatus !== 'loaded')}
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
                  setWebrtcReceive({ isReceiving: false, data: null })
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

      {webrtcReceive.isReceiving && webrtcReceive.data && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-semibold">🌐 WebRTC File Transfer</h2>
            <Button
              onClick={() => {
                setWebrtcReceive({ isReceiving: false, data: null })
                setUploadMode('camera')
              }}
              variant="outline"
            >
              ← Back to Scan
            </Button>
          </div>
          <WebRTCReceiver
            peerId={webrtcReceive.data.peerId}
            encryptionKey={webrtcReceive.data.encryptionKey}
            filename={webrtcReceive.data.filename}
            fileSize={webrtcReceive.data.fileSize}
            onComplete={(file) => {
              console.log('WebRTC file received:', file)
              // Optionally show success message or auto-reset
            }}
            onReset={() => {
              setWebrtcReceive({ isReceiving: false, data: null })
              setUploadMode('camera')
            }}
          />
        </div>
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
                <Button
                  onClick={() => {
                    setScannedData(null)
                    setScannedText(null)
                    setWebrtcReceive({ isReceiving: false, data: null })
                    setUploadMode('camera')
                  }}
                >
                  📷 Scan Another QR
                </Button>
              </div>
              {onGenerateQR && (
                <div className="flex justify-center">
                  <Button
                    onClick={() => onGenerateQR(scannedText)}
                  >
                    🔄 Generate QR Code from Result
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default Scan
