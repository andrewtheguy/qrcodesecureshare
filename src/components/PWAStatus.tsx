import { useState, useEffect } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { registerPWA, isOffline, addPWAHandler, removePWAHandler, type PWAUpdateEvent } from '@/utils/pwaUtils'

/**
 * PWA Status Component
 * Displays offline indicator when network is unavailable
 * Updates are applied automatically with network-first strategy
 */
export function PWAStatus() {
  const [isOnline, setIsOnline] = useState(!isOffline())

  useEffect(() => {
    // Register PWA on mount
    const handler = {
      onUpdate: (event: PWAUpdateEvent) => {
        // With network-first strategy and autoUpdate, updates are applied automatically
        // Just track online/offline status for UI indicators
        if (event.type === 'online') {
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

  return (
    <>
      {/* Offline indicator - only show when network is unavailable */}
      {!isOnline && (
        <Alert className="fixed bottom-4 left-4 right-4 md:right-auto md:w-96 bg-orange-50 border-orange-200 z-50">
          <AlertDescription className="text-orange-800">
            📡 You are offline. Using cached data. Check your internet connection.
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}
