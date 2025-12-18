import { useState, useEffect } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { registerPWA, isOffline, skipWaitingAndReload, addPWAHandler, removePWAHandler, type PWAUpdateEvent } from '@/utils/pwaUtils'

export function PWAStatus() {
  const [isOnline, setIsOnline] = useState(!isOffline())
  const [showUpdateDialog, setShowUpdateDialog] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)

  useEffect(() => {
    // Register PWA on mount
    const handler = {
      onUpdate: (event: PWAUpdateEvent) => {
        if (event.type === 'update-available') {
          setShowUpdateDialog(true)
        } else if (event.type === 'online') {
          setIsOnline(true)
        } else if (event.type === 'offline') {
          setIsOnline(false)
        }
      },
    }

    registerPWA(handler)
    addPWAHandler(handler)

    return () => {
      removePWAHandler(handler)
    }
  }, [])

  const handleInstallUpdate = async () => {
    setIsUpdating(true)
    try {
      await skipWaitingAndReload()
    } catch (error) {
      console.error('Error installing update:', error)
      setIsUpdating(false)
    }
  }

  return (
    <>
      {/* Offline indicator */}
      {!isOnline && (
        <Alert className="fixed bottom-4 left-4 right-4 md:right-auto md:w-96 bg-orange-50 border-orange-200 z-50">
          <AlertDescription className="text-orange-800">
            📡 You are offline. Using cached data. Check your internet connection.
          </AlertDescription>
        </Alert>
      )}

      {/* Update available dialog */}
      <Dialog open={showUpdateDialog} onOpenChange={setShowUpdateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>App Update Available</DialogTitle>
            <DialogDescription>
              A new version of QR Secure Share is available. Update now to get the latest features and improvements.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowUpdateDialog(false)}
              disabled={isUpdating}
            >
              Later
            </Button>
            <Button
              onClick={handleInstallUpdate}
              disabled={isUpdating}
            >
              {isUpdating ? 'Updating...' : 'Update Now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
