import { useState, useEffect } from 'react'
import { WebRTCSender } from './WebRTCSender'
import { WebRTCReceiver } from './WebRTCReceiver'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface WebRTCScanData {
  type: 'webrtc-transfer'
  peerId: string
  encryptionKey: string
  filename: string
  fileSize: number
}

interface WebRTCTransferDemoProps {
  scannedData?: WebRTCScanData | null
  onScanRequest?: () => void
  onClearScannedData?: () => void
}

export default function WebRTCTransferDemo({ scannedData: propScannedData, onScanRequest, onClearScannedData }: WebRTCTransferDemoProps = {}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'select' | 'send' | 'receive'>('select')
  const [encryptionKey, setEncryptionKey] = useState<string>('')
  const [scannedData, setScannedData] = useState<WebRTCScanData | null>(null)

  // Handle scanned data from props
  useEffect(() => {
    if (propScannedData && propScannedData.type === 'webrtc-transfer') {
      setScannedData(propScannedData)
      setMode('receive')
    }
  }, [propScannedData])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      // Generate encryption key
      const key = generateEncryptionKey()
      setEncryptionKey(key)
      setSelectedFile(file)
      setMode('send')
    }
  }

  const generateEncryptionKey = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*()_+-=[]{}|~'
    let key = ''
    for (let i = 0; i < 32; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return key
  }

  const handleReset = () => {
    setSelectedFile(null)
    setMode('select')
    setEncryptionKey('')
    setScannedData(null)
    if (onClearScannedData) {
      onClearScannedData()
    }
  }

  const handleScanComplete = (data: WebRTCScanData) => {
    setScannedData(data)
    setMode('receive')
  }

  const handleReceiveComplete = (file: File) => {
    // File has been received and decrypted
    console.log('File received:', file)
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-4">
      <header className="text-center space-y-2">
        <h1 className="text-3xl font-bold">🌐 WebRTC File Transfer</h1>
        <p className="text-muted-foreground">
          Transfer encrypted files peer-to-peer using WebRTC - no servers required!
        </p>
      </header>

      {/* Mode Selection */}
      {mode === 'select' && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="cursor-pointer hover:border-primary transition-colors">
            <CardHeader>
              <CardTitle className="text-center">📤 Send a File</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground text-center">
                  Select a file to encrypt and share via WebRTC peer-to-peer connection
                </p>
                <input
                  type="file"
                  onChange={handleFileSelect}
                  className="hidden"
                  id="webrtc-file-input"
                  accept="*/*"
                />
                <Button
                  onClick={() => document.getElementById('webrtc-file-input')?.click()}
                  className="w-full"
                  size="lg"
                >
                  Choose File to Send
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:border-primary transition-colors"
            onClick={() => setMode('receive')}
          >
            <CardHeader>
              <CardTitle className="text-center">📥 Receive a File</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground text-center">
                  Scan a WebRTC connection QR code to receive an encrypted file
                </p>
                <Button className="w-full" size="lg">
                  Start Receiving
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Send Mode */}
      {mode === 'send' && selectedFile && encryptionKey && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Send File via WebRTC</h2>
            <Button onClick={handleReset} variant="outline">
              ← Back
            </Button>
          </div>

          <Alert>
            <AlertDescription>
              <p className="font-medium mb-2">🔐 Encryption Details:</p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>Files are encrypted with AES-GCM using a random 32-character key</li>
                <li>The encryption key is embedded in the QR code</li>
                <li>Receiver automatically decrypts the file upon receipt</li>
                <li>No server storage - direct peer-to-peer transfer</li>
              </ul>
            </AlertDescription>
          </Alert>

          <WebRTCSender
            encryptedFile={selectedFile}
            encryptionKey={encryptionKey}
            onReset={handleReset}
          />
        </div>
      )}

      {/* Receive Mode */}
      {mode === 'receive' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Receive File via WebRTC</h2>
            <Button onClick={handleReset} variant="outline">
              ← Back
            </Button>
          </div>

          {scannedData ? (
            <WebRTCReceiver
              peerId={scannedData.peerId}
              encryptionKey={scannedData.encryptionKey}
              filename={scannedData.filename}
              fileSize={scannedData.fileSize}
              onComplete={handleReceiveComplete}
              onReset={handleReset}
            />
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <div className="space-y-4">
                  <div className="text-6xl">📷</div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold">Scan WebRTC Connection QR</h3>
                    <p className="text-muted-foreground">
                      Use your camera to scan the QR code from the sender to establish a WebRTC connection
                    </p>
                  </div>
                  <div className="flex gap-2 justify-center">
                    <Button onClick={onScanRequest} className="flex items-center gap-2">
                      📷 Scan QR Code
                    </Button>
                    <Button onClick={() => setMode('select')} variant="outline">
                      ← Back
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Info Section */}
      {mode === 'select' && (
        <Card>
          <CardHeader>
            <CardTitle>How WebRTC Transfer Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <h3 className="font-semibold">✨ Features:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Direct peer-to-peer file transfer using WebRTC</li>
                <li>No intermediate servers required for file data</li>
                <li>Files are encrypted with AES-GCM symmetric encryption</li>
                <li>Automatic decryption on the receiver side</li>
                <li>Works across different networks (NAT traversal)</li>
                <li>Real-time progress tracking</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">🔧 Technical Details:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Uses Peer.js library for WebRTC connection management</li>
                <li>STUN servers for NAT traversal</li>
                <li>File data sent in 16KB chunks</li>
                <li>32-character random encryption keys</li>
                <li>PBKDF2 key derivation with 100,000 iterations</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">💡 Best Practices:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Ensure both devices are connected to the internet</li>
                <li>Keep the sender page open during transfer</li>
                <li>Large files may take time depending on connection speed</li>
                <li>Both devices should be relatively close for best performance</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}