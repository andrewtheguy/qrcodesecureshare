import { useState, useEffect, useRef } from 'react'
import Peer from 'peerjs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'

interface WebRTCReceiverProps {
  peerId: string
  encryptionKey: string
  filename: string
  fileSize: number
  onComplete?: (file: File) => void
  onReset?: () => void
}

export function WebRTCReceiver({ peerId, encryptionKey, filename, fileSize, onComplete, onReset }: WebRTCReceiverProps) {
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'receiving' | 'completed' | 'error'>('connecting')
  const [transferProgress, setTransferProgress] = useState(0)
  const [error, setError] = useState<string>('')
  const [receivedFile, setReceivedFile] = useState<File | null>(null)

  const peerRef = useRef<Peer | null>(null)
  const connectionRef = useRef<any>(null)
  const receivedChunksRef = useRef<Uint8Array[]>([])
  const totalReceivedRef = useRef(0)

  useEffect(() => {
    // Initialize Peer.js
    const peer = new Peer()

    peerRef.current = peer

    peer.on('open', () => {
      console.log('Receiver peer opened, connecting to:', peerId)

      // Connect to sender
      const conn = peer.connect(peerId)
      connectionRef.current = conn

      conn.on('open', () => {
        console.log('Connected to sender')
        setConnectionStatus('connected')
      })

      conn.on('data', (data: any) => {
        handleReceivedData(data)
      })

      conn.on('error', (err) => {
        console.error('Connection error:', err)
        setError('Connection failed: ' + err.message)
        setConnectionStatus('error')
      })
    })

    peer.on('error', (err) => {
      console.error('Peer error:', err)
      setError('Peer connection failed: ' + err.message)
      setConnectionStatus('error')
    })

    return () => {
      if (connectionRef.current) {
        connectionRef.current.close()
      }
      if (peerRef.current) {
        peerRef.current.destroy()
      }
    }
  }, [peerId])

  const handleReceivedData = (data: any) => {
    if (data.type === 'file-metadata') {
      console.log('Received file metadata:', data)
      setConnectionStatus('receiving')
      // Reset for new transfer
      receivedChunksRef.current = []
      totalReceivedRef.current = 0
    } else if (data.type === 'file-chunk') {
      // Accumulate chunks
      receivedChunksRef.current.push(new Uint8Array(data.data))
      totalReceivedRef.current += data.data.length
      setTransferProgress((totalReceivedRef.current / fileSize) * 100)
    } else if (data.type === 'file-end') {
      console.log('File transfer complete')
      assembleFile()
    }
  }

  const assembleFile = () => {
    try {
      // Combine all chunks
      const totalSize = receivedChunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0)
      const combined = new Uint8Array(totalSize)
      let offset = 0

      for (const chunk of receivedChunksRef.current) {
        combined.set(chunk, offset)
        offset += chunk.length
      }

      // Create file
      const blob = new Blob([combined])
      const file = new File([blob], filename, { type: 'application/octet-stream' })

      setReceivedFile(file)
      setConnectionStatus('completed')
      setTransferProgress(100)

      if (onComplete) {
        onComplete(file)
      }
    } catch (error) {
      console.error('File assembly error:', error)
      setError('Failed to assemble received file')
      setConnectionStatus('error')
    }
  }

  const decryptAndDownload = async () => {
    if (!receivedFile) return

    try {
      // Decrypt the file using the encryption key from QR code
      const encryptedData = await receivedFile.arrayBuffer()
      const decryptedFile = await decryptFile(new Uint8Array(encryptedData), encryptionKey)

      // Create download link
      const url = URL.createObjectURL(decryptedFile)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

    } catch (error) {
      console.error('Decryption error:', error)
      setError('Failed to decrypt file: ' + (error as Error).message)
    }
  }

  const decryptFile = async (encryptedData: Uint8Array, passphrase: string): Promise<Blob> => {
    // Extract salt, IV, and encrypted data
    const salt = encryptedData.slice(0, 16)
    const iv = encryptedData.slice(16, 28)
    const encrypted = encryptedData.slice(28)

    // Import key derivation function
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    )

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encrypted
    )

    return new Blob([decrypted])
  }

  const handleReset = () => {
    if (connectionRef.current) {
      connectionRef.current.close()
    }
    if (peerRef.current) {
      peerRef.current.destroy()
    }
    if (onReset) onReset()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">📥 WebRTC File Receiver</CardTitle>
        <div className="text-sm text-muted-foreground text-center space-y-1">
          <p className="font-medium">{filename}</p>
          <p>Size: {(fileSize / 1024).toFixed(2)}KB</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Status */}
        <div className="text-center">
          <div className="text-lg font-semibold mb-2">
            Status: {connectionStatus === 'connecting' && '🔗 Connecting...'}
            {connectionStatus === 'connected' && '✅ Connected to sender'}
            {connectionStatus === 'receiving' && '📥 Receiving file...'}
            {connectionStatus === 'completed' && '🎉 File received!'}
            {connectionStatus === 'error' && '❌ Error'}
          </div>

          {connectionStatus === 'receiving' && (
            <Progress value={transferProgress} className="w-full max-w-xs mx-auto" />
          )}
        </div>

        {/* File received */}
        {connectionStatus === 'completed' && receivedFile && (
          <Alert>
            <AlertDescription className="space-y-3">
              <div className="font-medium flex items-center gap-2">
                ✅ File received successfully
              </div>
              <p className="text-sm">
                The encrypted file has been received. Click below to decrypt and download the original file.
              </p>
              <div className="flex justify-center">
                <Button onClick={decryptAndDownload} className="flex items-center gap-2">
                  🔓 Decrypt & Download
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Connection Info */}
        <Alert>
          <AlertDescription className="space-y-2">
            <div className="font-medium">Connection Details:</div>
            <div className="text-sm space-y-1">
              <div><span className="font-semibold">Sender Peer ID:</span> <code className="bg-muted px-2 py-1 rounded text-xs">{peerId}</code></div>
              <div><span className="font-semibold">Encryption:</span> AES-GCM (symmetric)</div>
            </div>
          </AlertDescription>
        </Alert>

        {/* Instructions */}
        <Alert>
          <AlertDescription className="text-sm space-y-1">
            <p className="font-medium mb-1">📱 Instructions:</p>
            <p>1. Keep this page open while the sender transfers the file</p>
            <p>2. The file will be automatically received and decrypted</p>
            <p>3. Click "Decrypt & Download" to save the original file</p>
          </AlertDescription>
        </Alert>

        {/* Actions */}
        <div className="flex gap-2 justify-center flex-wrap">
          {onReset && (
            <Button onClick={handleReset} variant="outline">
              ← Back
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}