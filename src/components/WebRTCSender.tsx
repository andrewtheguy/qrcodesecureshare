import { useState, useEffect, useRef, useCallback } from 'react'
import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import QRCode from 'qrcode'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'

interface WebRTCSenderProps {
  encryptedFile: File
  encryptionKey: string
  originalFilename: string
  onReset?: () => void
}

export function WebRTCSender({ encryptedFile, encryptionKey, originalFilename, onReset }: WebRTCSenderProps) {
  const [peerId, setPeerId] = useState<string>('')
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'waiting' | 'connected' | 'transferring' | 'completed' | 'error'>('connecting')
  const [transferProgress, setTransferProgress] = useState(0)
  const [error, setError] = useState<string>('')

  const peerRef = useRef<Peer | null>(null)
  const connectionRef = useRef<DataConnection | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isInitializedRef = useRef<boolean>(false)
  const isCleaningUpRef = useRef<boolean>(false)

  const sendFile = useCallback(async (conn: DataConnection) => {
        try {
            setConnectionStatus('transferring')
            setTransferProgress(0)

            // Read file as ArrayBuffer
            const arrayBuffer = await encryptedFile.arrayBuffer()
            const uint8Array = new Uint8Array(arrayBuffer)

            // Send file metadata first
            const metadata = {
                type: 'file-metadata',
                filename: encryptedFile.name,
                size: encryptedFile.size,
                mimeType: encryptedFile.type
            }
            conn.send(metadata)

            // Send file data in chunks
            const chunkSize = 16384 // 16KB chunks
            let sent = 0

            for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.slice(i, i + chunkSize)
                conn.send({
                    type: 'file-chunk',
                    data: chunk,
                    offset: i,
                    total: uint8Array.length
                })
                sent = i + chunk.length
                setTransferProgress((sent / uint8Array.length) * 100)

                // Small delay to prevent overwhelming the connection
                await new Promise(resolve => setTimeout(resolve, 10))
            }

            // Send end marker
            conn.send({ type: 'file-end' })

            setConnectionStatus('completed')
            setTransferProgress(100)

        } catch (error) {
            console.error('File transfer error:', error)
            setError('File transfer failed: ' + (error as Error).message)
            setConnectionStatus('error')
        }
  }, [encryptedFile])

  useEffect(() => {
    // Prevent double initialization in React Strict Mode
    if (isInitializedRef.current) {
      return
    }

    // Initialize Peer.js with configuration
    const peer = new Peer({
      debug: 2, // Enable debug logging (0=none, 1=errors, 2=warnings, 3=all)
    })

    peerRef.current = peer
    isInitializedRef.current = true

    // Add timeout to detect connection issues
    const connectionTimeout = setTimeout(() => {
      if (!peerId) {
        setError('Connection timeout: Unable to connect to PeerJS server. This may be due to network restrictions or firewall blocking. Please check your internet connection or try a different network.')
        setConnectionStatus('error')
      }
    }, 15000) // 15 second timeout

    peer.on('open', (id) => {
      clearTimeout(connectionTimeout)
      setPeerId(id)
      setConnectionStatus('waiting')

      // Generate QR code with peer ID and encryption key
      const qrData = JSON.stringify({
        type: 'webrtc-transfer',
        peerId: id,
        encryptionKey: encryptionKey,
        filename: originalFilename,
        fileSize: encryptedFile.size
      })

      generateQRCode(qrData)
    })

    peer.on('connection', (conn) => {
      setConnectionStatus('connected')
      connectionRef.current = conn

      conn.on('open', () => {
        sendFile(conn)
      })

      conn.on('error', (err) => {
        setError('Connection failed: ' + err.message)
        setConnectionStatus('error')
      })
    })

    peer.on('error', (err) => {
      clearTimeout(connectionTimeout)

      let errorMessage = 'Peer connection failed: ' + err.message

      // Provide more helpful error messages based on error type
      if (err.type === 'network') {
        errorMessage = 'Network error: Unable to connect to PeerJS server. Please check your internet connection.'
      } else if (err.type === 'server-error') {
        errorMessage = 'Server error: The PeerJS signaling server is unavailable. Please try again later.'
      } else if (err.type === 'socket-error') {
        errorMessage = 'Socket error: Unable to establish WebSocket connection. This may be blocked by your firewall or network.'
      } else if (err.type === 'socket-closed') {
        errorMessage = 'Connection closed: The connection to the signaling server was closed unexpectedly.'
      }

      setError(errorMessage)
      setConnectionStatus('error')
    })

    peer.on('disconnected', () => {
      // Ignore disconnection during cleanup
      if (isCleaningUpRef.current) {
        return
      }

      setError('Disconnected from signaling server. Attempting to reconnect...')
      peer.reconnect()
    })

    return () => {
      isCleaningUpRef.current = true
      clearTimeout(connectionTimeout)
      if (connectionRef.current) {
        connectionRef.current.close()
        connectionRef.current = null
      }
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null // Clear the ref to allow re-initialization
        isInitializedRef.current = false // Allow re-initialization on next mount
      }
      isCleaningUpRef.current = false
    }
  }, [encryptedFile, encryptionKey, originalFilename, sendFile])

  const generateQRCode = async (data: string) => {
    try {
      const canvas = canvasRef.current
      if (canvas) {
        await QRCode.toCanvas(canvas, data, {
          width: 300,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
      }
      const dataUrl = await QRCode.toDataURL(data, {
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
      setError('Failed to generate QR code')
    }
  }

  const handleReset = () => {
    if (connectionRef.current) {
      connectionRef.current.close()
      connectionRef.current = null
    }
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
      isInitializedRef.current = false // Allow re-initialization on reset
    }
    if (onReset) onReset()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">🌐 WebRTC File Transfer (Sender)</CardTitle>
        <div className="text-sm text-muted-foreground text-center space-y-1">
          <p className="font-medium">{originalFilename}</p>
          <p>Size: {(encryptedFile.size / 1024).toFixed(2)}KB</p>
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
            {connectionStatus === 'waiting' && '⏳ Waiting for receiver...'}
            {connectionStatus === 'connected' && '✅ Receiver connected'}
            {connectionStatus === 'transferring' && '📤 Transferring...'}
            {connectionStatus === 'completed' && '🎉 Transfer complete!'}
            {connectionStatus === 'error' && '❌ Error'}
          </div>

          {connectionStatus === 'transferring' && (
            <Progress value={transferProgress} className="w-full max-w-xs mx-auto" />
          )}
        </div>

        {/* QR Code */}
        {qrCodeUrl && connectionStatus !== 'completed' && connectionStatus !== 'error' && (
          <div className="flex flex-col items-center gap-4">
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            <img
              src={qrCodeUrl}
              alt="WebRTC Connection QR"
              className="max-w-full h-auto rounded-lg shadow-sm"
            />
            <p className="text-sm text-muted-foreground text-center max-w-xs">
              Have the receiver scan this QR code to connect and receive the file
            </p>
          </div>
        )}

        {/* Connection Info */}
        {peerId && (
          <Alert>
            <AlertDescription className="space-y-2">
              <div className="font-medium">Connection Details:</div>
              <div className="text-sm space-y-1">
                <div><span className="font-semibold">Peer ID:</span> <code className="bg-muted px-2 py-1 rounded text-xs">{peerId}</code></div>
                <div><span className="font-semibold">Encryption:</span> AES-GCM (symmetric)</div>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Instructions */}
        {connectionStatus === 'waiting' && (
          <Alert>
            <AlertDescription className="text-sm space-y-1">
              <p className="font-medium mb-1">📱 Instructions:</p>
              <p>1. Have the receiver scan the QR code above</p>
              <p>2. The receiver will automatically connect and download the file</p>
              <p>3. Keep this page open until transfer completes</p>
            </AlertDescription>
          </Alert>
        )}

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
