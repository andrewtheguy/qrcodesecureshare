import { useState, useCallback } from 'react'
import OfflineQRTransfer from './OfflineQRTransfer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface OfflineTransferProps {
  defaultMode?: 'select' | 'send' | 'receive'
}

export default function OfflineTransfer({ defaultMode = 'select' }: OfflineTransferProps) {
  const [isTransferActive, setIsTransferActive] = useState(defaultMode !== 'select')

  const handleModeChange = useCallback((mode: 'select' | 'send' | 'receive') => {
    setIsTransferActive(mode !== 'select')
  }, [])

  return (
    <div className="space-y-6 max-w-2xl mx-auto p-4">
      <header className="text-center space-y-2">
        <h1 className="text-3xl font-bold">File Transfer</h1>
        <p className="text-muted-foreground">
          Transfer files securely - online or offline
        </p>
      </header>

      {/* Online Transfer Section - Hidden when offline transfer is active */}
      {!isTransferActive && (
        <Card>
          <CardHeader>
            <CardTitle>Online Transfer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              For larger files or folders and faster speed, use Secure Send at{' '}
              <a
                href="https://securesend.kuvi.app/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                securesend.kuvi.app
              </a>
              . It supports transfers up to 100MB, uses WebRTC P2P for speed, and can
              automatically fall back to encrypted cloud transfer (Nostr mode) if P2P fails.
            </p>
            <p className="text-sm text-muted-foreground">
              No accounts required, and all data is encrypted client-side before any transfer.
            </p>
            <Button asChild>
              <a
                href="https://securesend.kuvi.app/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Secure Send
              </a>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Offline QR Transfer Section */}
      <OfflineQRTransfer defaultMode={defaultMode} onModeChange={handleModeChange} />
    </div>
  )
}
