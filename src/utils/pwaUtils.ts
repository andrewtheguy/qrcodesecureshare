/**
 * PWA Utilities - Service Worker registration and offline handling
 */

export interface PWAUpdateEvent {
  type: 'update-available' | 'update-installed' | 'offline' | 'online'
}

export interface PWAHandler {
  onUpdate?: (event: PWAUpdateEvent) => void
  onError?: (error: Error) => void
}

let registration: ServiceWorkerRegistration | null | undefined = null
const handlers: Set<PWAHandler> = new Set()

/**
 * Register PWA service worker and handle updates
 */
export async function registerPWA(handler?: PWAHandler) {
  if (!('serviceWorker' in navigator)) {
    console.log('Service Workers not supported')
    return
  }

  if (handler) {
    handlers.add(handler)
  }

  try {
    // The service worker is registered by vite-plugin-pwa automatically
    // We just need to listen for updates
    registration = await navigator.serviceWorker.getRegistration()

    if (!registration) {
      // Try to find it by scope
      const registrations = await navigator.serviceWorker.getRegistrations()
      if (registrations.length > 0) {
        registration = registrations[0]
      }
    }

    if (registration) {
      // Listen for updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration?.installing
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New service worker is ready, app needs refresh
              notifyHandlers({ type: 'update-available' })
            }
          })
        }
      })

      console.log('Service Worker registered and monitored')
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    console.error('Service Worker registration failed:', err)
    notifyHandlers(undefined, err)
  }

  // Listen for online/offline events
  window.addEventListener('online', () => {
    notifyHandlers({ type: 'online' })
  })

  window.addEventListener('offline', () => {
    notifyHandlers({ type: 'offline' })
  })
}

/**
 * Check if currently offline
 */
export function isOffline(): boolean {
  return !navigator.onLine
}

/**
 * Check if online
 */
export function isOnline(): boolean {
  return navigator.onLine
}

/**
 * Skip waiting and reload (install pending update)
 */
export async function skipWaitingAndReload() {
  // Get all service workers
  const registrations = await navigator.serviceWorker.getRegistrations()

  for (const reg of registrations) {
    if (reg.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      // Listen for controller change and reload
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload()
      })
      break
    }
  }
}

/**
 * Add a handler for PWA events
 */
export function addPWAHandler(handler: PWAHandler) {
  handlers.add(handler)
}

/**
 * Remove a handler
 */
export function removePWAHandler(handler: PWAHandler) {
  handlers.delete(handler)
}

/**
 * Get current service worker registration
 */
export function getServiceWorkerRegistration() {
  return registration
}

/**
 * Notify all handlers of an event
 */
function notifyHandlers(event: PWAUpdateEvent | undefined, error?: Error) {
  handlers.forEach((handler) => {
    if (error && handler.onError) {
      handler.onError(error)
    } else if (event && handler.onUpdate) {
      handler.onUpdate(event)
    }
  })
}

/**
 * Force check for updates
 */
export async function checkForUpdates() {
  try {
    if (registration) {
      await registration.update()
    }
  } catch (error) {
    console.error('Error checking for updates:', error)
  }
}
