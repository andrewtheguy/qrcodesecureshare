import { useState } from 'react'
import { AnimatedQRCode } from './AnimatedQRCode'
import { AnimatedQRReceiver } from './AnimatedQRReceiver'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { MAX_FILE_SIZE } from './AnimatedQRCode'

export default function OfflineTransfer() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'select' | 'send' | 'receive'>('select')

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {

      if (file.size > MAX_FILE_SIZE) {
        alert(`File size must be under ${MAX_FILE_SIZE / 1024}KB. Selected file is ${(file.size / 1024).toFixed(2)}KB`)
        return
      }
      setSelectedFile(file)
      setMode('send')
    }
  }

  const handleReset = () => {
    setSelectedFile(null)
    setMode('select')
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-4">
      <header className="text-center space-y-2">
        <h1 className="text-3xl font-bold">Offline QR File Transfer</h1>
        <p className="text-muted-foreground">
          Transfer files up to ${MAX_FILE_SIZE / 1024}KB using animated QR codes - no internet required!
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
                  Select a file (max {MAX_FILE_SIZE / 1024}KB) to convert into animated QR codes
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
                  Use your camera to scan animated QR codes and receive a file
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
      {mode === 'send' && selectedFile && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Send File</h2>
            <Button onClick={handleReset} variant="outline">
              ← Back
            </Button>
          </div>

          <Alert>
            <AlertDescription>
              <p className="font-medium mb-2">📱 Instructions:</p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>Click "Play" to start the QR code animation</li>
                <li>Have the receiver scan the animated QR codes</li>
                <li>Keep the animation playing until all chunks are received</li>
                <li>Adjust speed if needed (2-3 fps recommended)</li>
              </ul>
            </AlertDescription>
          </Alert>

          <AnimatedQRCode file={selectedFile} onReset={handleReset} />
        </div>
      )}

      {/* Receive Mode */}
      {mode === 'receive' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Receive File</h2>
            <Button onClick={handleReset} variant="outline">
              ← Back
            </Button>
          </div>

          <AnimatedQRReceiver />
        </div>
      )}

      {/* Info Section */}
      {mode === 'select' && (
        <Card>
          <CardHeader>
            <CardTitle>How It Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <h3 className="font-semibold">✨ Features:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Transfer files up to {MAX_FILE_SIZE / 1024}KB completely offline</li>
                <li>No internet connection required</li>
                <li>Works between any two devices with cameras</li>
                <li>Automatic chunking and reconstruction</li>
                <li>Adjustable animation speed (1-5 fps)</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">🔧 Technical Details:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Files split into ~1.2KB chunks per QR code</li>
                <li>Base64 encoding for binary data</li>
                <li>Automatic deduplication of scanned chunks</li>
                <li>Progress tracking for both sender and receiver</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="font-semibold">💡 Best Practices:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Use good lighting for better scanning</li>
                <li>Keep camera steady and focused</li>
                <li>Start with 2-3 fps, adjust as needed</li>
                <li>Ensure QR codes fill most of the camera view</li>
                <li>Smaller files transfer faster (aim for under 10KB)</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
