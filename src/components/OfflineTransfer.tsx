import { useState, useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { OfflineQRMode } from './OfflineQRMode'
import { OfflineQRReceiver } from './OfflineQRReceiver'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { MAX_FILE_SIZE_FOUNTAIN_FEEDBACK } from './OfflineQRMode'

interface OfflineTransferProps {
  defaultMode?: 'select' | 'send' | 'receive'
}

export default function OfflineTransfer({ defaultMode = 'select' }: OfflineTransferProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'select' | 'send' | 'receive'>(defaultMode)

  // Sync mode with route changes
  useEffect(() => {
    if (location.pathname === '/offline/send') {
      setMode('send')
    } else if (location.pathname === '/offline/receive') {
      setMode('receive')
    } else if (location.pathname === '/offline' || location.pathname === '/offline/') {
      setMode('select')
    }
  }, [location.pathname])

  // Redirect to /offline if on /send route but no file is selected
  useEffect(() => {
    if (location.pathname === '/offline/send' && !selectedFile) {
      navigate('/offline', { replace: true })
    }
  }, [location.pathname, selectedFile, navigate])
  const [backDialogOpen, setBackDialogOpen] = useState(false)
  const [pendingBackContext, setPendingBackContext] = useState<'send' | 'receive' | null>(null)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {

      if (file.size > MAX_FILE_SIZE_FOUNTAIN_FEEDBACK) {
        alert(`File size must be under ${MAX_FILE_SIZE_FOUNTAIN_FEEDBACK / 1024 / 1024}MB. Selected file is ${(file.size / 1024).toFixed(2)}KB. Note: Some transfer modes support smaller limits.`)
        return
      }
      setSelectedFile(file)
      navigate('/offline/send')
    }
  }

  const handleReset = () => {
    setSelectedFile(null)
    navigate('/offline')
  }

  const requestBackNavigation = (context: 'send' | 'receive') => {
    setPendingBackContext(context)
    setBackDialogOpen(true)
  }

  const handleConfirmBackNavigation = () => {
    setBackDialogOpen(false)
    handleReset()
  }

  const handleCancelBackNavigation = () => {
    setBackDialogOpen(false)
    setPendingBackContext(null)
  }

  const backDialogCopy = {
    send: {
      title: 'Leave Sender?',
      description: 'Leaving this screen will stop the current transfer and clear the selected file.',
      confirmLabel: 'Yes, Leave Sender'
    },
    receive: {
      title: 'Leave Receiver?',
      description: 'Leaving will stop the receiver and clear the current scan progress.',
      confirmLabel: 'Yes, Leave Receiver'
    }
  } as const

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-4">
      <Card>
        <CardHeader>
          <CardTitle>Online File Transfer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            For larger files and higher reliability, use Secure Send at{' '}
            <a
              href="https://secure-send-web.andrewtheguy.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              secure-send-web.andrewtheguy.com
            </a>
            . It supports transfers up to 100MB, uses WebRTC P2P for speed, and can
            automatically fall back to encrypted cloud transfer (Nostr mode) if P2P fails.
          </p>
          <p className="text-sm text-muted-foreground">
            No accounts required, and all data is encrypted client-side before any transfer.
          </p>
          <Button asChild>
            <a
              href="https://secure-send-web.andrewtheguy.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Secure Send
            </a>
          </Button>
        </CardContent>
      </Card>

      <header className="text-center space-y-2">
        <h1 className="text-3xl font-bold">Offline QR File Transfer</h1>
        <p className="text-muted-foreground">
          Transfer files up to {MAX_FILE_SIZE_FOUNTAIN_FEEDBACK / 1024 / 1024}MB using animated QR codes - no internet required!
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
                  Select a file (up to {MAX_FILE_SIZE_FOUNTAIN_FEEDBACK / 1024 / 1024}MB) to convert into animated QR codes
                </p>
                <input
                  type="file"
                  onChange={handleFileSelect}
                  className="hidden"
                  id="offline-file-input"
                  accept="*/*"
                />
                <Button
                  onClick={() => document.getElementById('offline-file-input')?.click()}
                  className="w-full"
                  size="lg"
                >
                  Choose File to Send
                </Button>
              </div>
            </CardContent>
          </Card>

          <NavLink to="/scan/camera">
            <Card className="cursor-pointer hover:border-primary transition-colors">
              <CardHeader>
                <CardTitle className="text-center">📥 Receive a File</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground text-center">
                    Use your camera to scan the metadata QR code to begin receiving a file
                  </p>
                  <Button className="w-full" size="lg">
                    Scan Metadata QR
                  </Button>
                </div>
              </CardContent>
            </Card>
          </NavLink>
        </div>
      )}

      {/* Send Mode */}
      {mode === 'send' && selectedFile && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Send File</h2>
            <Button onClick={() => requestBackNavigation('send')} variant="outline">
              ← Back
            </Button>
          </div>

          <Alert>
            <AlertDescription>
              <p className="font-medium mb-2">📱 Instructions:</p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>First, select your transfer mode (Fountain Recommended/Basic or Sequential)</li>
                <li>Have the receiver scan the metadata QR code to initialize the session</li>
                <li>Click "Play" to start the animated data QR codes</li>
                <li>For fountain feedback mode: scan receiver's feedback QR or enter confirmation codes manually</li>
                <li>Keep the animation playing until transfer completes (progress shown on receiver)</li>
                <li>Adjust fps if needed (default: 25 fps fountain, 5 fps sequential, range: 1-60 fps)</li>
              </ul>
            </AlertDescription>
          </Alert>

          <OfflineQRMode file={selectedFile} onReset={handleReset} />
        </div>
      )}

      {/* Receive Mode */}
      {mode === 'receive' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Receive File</h2>
            <Button onClick={() => requestBackNavigation('receive')} variant="outline">
              ← Back
            </Button>
          </div>

          <OfflineQRReceiver />
        </div>
      )}

      {/* Info Section */}
      {mode === 'select' && (
        <Card>
          <CardHeader>
            <CardTitle>How It Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Need online transfers instead? Use{' '}
              <a
                href="https://secure-send-web.andrewtheguy.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Secure Send
              </a>{' '}
              for larger files and more reliable delivery.
            </p>
            <div className="space-y-2">
              <h3 className="font-semibold">✨ Features:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Three transfer modes: Fountain Code (Recommended), Fountain Code (Basic), and Sequential</li>
                <li>Transfer files up to {MAX_FILE_SIZE_FOUNTAIN_FEEDBACK / 1024 / 1024}MB completely offline with feedback mode</li>
                <li>No internet connection required - works completely offline</li>
                <li>Works between any two devices with cameras (some modes work without sender camera)</li>
                <li>Automatic chunking and reconstruction with checksum validation</li>
                <li>Adjustable animation speed (1-60 fps, default 25 fps for fountain mode, 5 fps for sequential)</li>
                <li>Intelligent feedback system for optimized transfers (fountain feedback mode)</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">🔧 Technical Details:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li><strong>Fountain Mode:</strong> 1000-byte source blocks, requires ~105-115% reception for completion</li>
                <li><strong>Sequential Mode:</strong> 800-byte chunks transmitted in order, requires all chunks</li>
                <li><strong>Part-based Transfers:</strong> Large files split into parts (32KB-1MB) with individual checksums</li>
                <li><strong>Receiver Scanning:</strong> ~30 fps (33ms interval) using zxing-wasm binary mode</li>
                <li><strong>Feedback Scanning:</strong> ~10 fps (100ms interval) for sender feedback QR codes</li>
                <li>Binary data encoding (no Base64 overhead in newer modes)</li>
                <li>CRC32 checksums for data integrity verification</li>
                <li>Web Worker-based QR code generation for performance</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">💡 Best Practices:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Use <strong>Fountain Code (Recommended)</strong> for reliable transfers with feedback</li>
                <li>Choose appropriate part size: smaller for slower devices/poor cameras, larger for faster transfers</li>
                <li>Start with default fps (25 for fountain, 5 for sequential), adjust if needed</li>
                <li>Use good lighting for better scanning accuracy</li>
                <li>Keep camera steady and focused on the QR code</li>
                <li>Ensure QR codes fill most of the camera view without cropping</li>
                <li>For devices without cameras on sender side, use manual feedback input or fountain basic mode</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
      <Dialog
        open={backDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelBackNavigation()
          }
        }}
      >
        {pendingBackContext && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{backDialogCopy[pendingBackContext].title}</DialogTitle>
              <DialogDescription>
                {backDialogCopy[pendingBackContext].description}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={handleCancelBackNavigation}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleConfirmBackNavigation}>
                {backDialogCopy[pendingBackContext].confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
