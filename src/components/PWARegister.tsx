import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

export function PWARegister() {
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false)

  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      console.log('Service Worker registered:', swUrl)
      // Check for updates every hour
      if (registration) {
        setInterval(() => {
          registration.update()
        }, 60 * 60 * 1000)
      }
    },
    onRegisterError(error: Error) {
      console.error('Service Worker registration error:', error)
    },
  })

  useEffect(() => {
    if (offlineReady) {
      console.log('App is ready to work offline')
    }
  }, [offlineReady])

  useEffect(() => {
    if (needRefresh) {
      setShowUpdatePrompt(true)
    }
  }, [needRefresh])

  const handleUpdate = () => {
    setShowUpdatePrompt(false)
    updateServiceWorker(true)
  }

  const handleDismiss = () => {
    setShowUpdatePrompt(false)
    setOfflineReady(false)
    setNeedRefresh(false)
  }

  if (!showUpdatePrompt && !offlineReady) {
    return null
  }

  return (
    <div className="fixed bottom-4 right-4 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg p-4 max-w-sm z-50">
      {offlineReady && !needRefresh && (
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              App ready to work offline
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              You can now use this app without an internet connection.
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {needRefresh && (
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              New version available
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              A new version of this app is ready.
            </p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleUpdate}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
              >
                Update
              </button>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
