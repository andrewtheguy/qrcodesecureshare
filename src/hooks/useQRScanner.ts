import { useEffect, useRef } from 'react'
import QrScanner from 'qr-scanner'

interface UseQRScannerOptions {
  onScan: (data: string) => void
  isScanning: boolean
  debounceMs?: number
  /**
   * Optional error callback. If not provided, errors will only be logged to console.
   * This allows components to handle errors gracefully while keeping the hook flexible.
   */
  onError?: (errorMessage: string) => void
  onStart?: () => void
  onStop?: () => void
}

export function useQRScanner({ onScan, isScanning, debounceMs = 500, onError, onStart, onStop }: UseQRScannerOptions) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const startInProgressRef = useRef<boolean>(false)
  const cleanupPromiseRef = useRef<Promise<void> | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)
  const onScanRef = useRef(onScan)
  const onErrorRef = useRef(onError)
  const onStartRef = useRef(onStart)
  const onStopRef = useRef(onStop)

  // Keep the callback refs up to date
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    onStartRef.current = onStart
  }, [onStart])

  useEffect(() => {
    onStopRef.current = onStop
  }, [onStop])

  useEffect(() => {
    if (!isScanning || !videoRef.current) {
      // Stop scanner if already running
      if (scannerRef.current) {
        console.log('[useQRScanner] Stopping scanner because isScanning is false')
        const scannerToStop = scannerRef.current
        scannerToStop.stop()

        // Create cleanup promise that resolves after a small delay
        const cleanup = new Promise<void>((resolve) => {
          setTimeout(() => {
            scannerToStop.destroy()
            onStopRef.current?.()
            resolve()
          }, 50)
        })

        cleanupPromiseRef.current = cleanup
        scannerRef.current = null
      }
      return
    }

    // Don't recreate scanner if already running
    if (scannerRef.current || startInProgressRef.current) {
      console.log(`[useQRScanner] Skipping scanner creation: scanner already exists or start is in progress. scannerRef.current=${!!scannerRef.current}, startInProgressRef.current=${startInProgressRef.current}`)
      return
    }

    console.log('[useQRScanner] Creating new QrScanner instance')
    startInProgressRef.current = true
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        // Debounce duplicate scans
        const now = Date.now()
        if (result.data === lastScannedRef.current && now - lastScanTimeRef.current < debounceMs) {
          return
        }
        lastScannedRef.current = result.data
        lastScanTimeRef.current = now

        onScanRef.current(result.data)
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      }
    )

    scannerRef.current = scanner
    scanner.start().then(() => {
      console.log('[useQRScanner] Scanner started successfully')
      onStartRef.current?.()
      startInProgressRef.current = false
    }).catch((err) => {
      console.error('Scanner start error:', err)
      const errorMessage = err instanceof Error ? err.message : String(err)
      onErrorRef.current?.(`Failed to start camera: ${errorMessage}. Please ensure camera permissions are granted.`)
      startInProgressRef.current = false
    })

    return () => {
      const scannerToStop = scannerRef.current
      if (scannerToStop) {
        console.log('[useQRScanner] Cleanup: stopping and destroying scanner')
        const cleanupStartTime = Date.now()
        scannerToStop.stop()

        // Create cleanup promise that resolves when camera is fully released
        const cleanup = new Promise<void>((resolve) => {
          // Add a small delay to ensure camera is released
          setTimeout(() => {
            scannerToStop.destroy()
            const cleanupDuration = Date.now() - cleanupStartTime
            console.log(`[useQRScanner] Cleanup complete after ${cleanupDuration}ms`)
            onStopRef.current?.()
            resolve()
          }, 50)
        })

        cleanupPromiseRef.current = cleanup
        scannerRef.current = null
      }
    }
  }, [isScanning, debounceMs])

  const stopScanner = async (): Promise<void> => {
    if (scannerRef.current) {
      const scannerToStop = scannerRef.current
      console.log('[useQRScanner] Manual stop requested')
      const cleanupStartTime = Date.now()
      scannerToStop.stop()

      // Create and store cleanup promise
      const cleanup = new Promise<void>((resolve) => {
        setTimeout(() => {
          scannerToStop.destroy()
          const cleanupDuration = Date.now() - cleanupStartTime
          console.log(`[useQRScanner] Manual stop cleanup complete after ${cleanupDuration}ms`)
          onStopRef.current?.()
          resolve()
        }, 50)
      })

      cleanupPromiseRef.current = cleanup
      scannerRef.current = null
      startInProgressRef.current = false

      return cleanup
    }
    return Promise.resolve()
  }

  const forceRecreate = async () => {
    // Stop any existing scanner
    if (scannerRef.current) {
      const scannerToStop = scannerRef.current
      scannerToStop.stop()
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          scannerToStop.destroy()
          onStopRef.current?.()
          resolve()
        }, 50)
      })
      scannerRef.current = null
      startInProgressRef.current = false
    }

    // Create new scanner
    if (videoRef.current && !startInProgressRef.current) {
      startInProgressRef.current = true
      const scanner = new QrScanner(
        videoRef.current,
        (result) => {
          // Debounce duplicate scans
          const now = Date.now()
          if (result.data === lastScannedRef.current && now - lastScanTimeRef.current < debounceMs) {
            return
          }
          lastScannedRef.current = result.data
          lastScanTimeRef.current = now

          onScanRef.current(result.data)
        },
        {
          returnDetailedScanResult: true,
          highlightScanRegion: true,
          highlightCodeOutline: true,
        }
      )

      scannerRef.current = scanner
      scanner.start().then(() => {
        console.log('[useQRScanner] Scanner force recreated successfully')
        onStartRef.current?.()
        startInProgressRef.current = false
      }).catch((err) => {
        console.error('Scanner force recreate error:', err)
        const errorMessage = err instanceof Error ? err.message : String(err)
        onErrorRef.current?.(`Failed to recreate camera: ${errorMessage}`)
        startInProgressRef.current = false
      })
    }
  }

  const restartScanner = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.start()
      } catch (err) {
        console.error('Scanner restart error:', err)
        onErrorRef.current?.('Failed to restart camera')
      }
    } else if (videoRef.current && !startInProgressRef.current) {
      // Create new scanner if none exists
      startInProgressRef.current = true
      const scanner = new QrScanner(
        videoRef.current,
        (result) => {
          // Debounce duplicate scans
          const now = Date.now()
          if (result.data === lastScannedRef.current && now - lastScanTimeRef.current < debounceMs) {
            return
          }
          lastScannedRef.current = result.data
          lastScanTimeRef.current = now

          onScanRef.current(result.data)
        },
        {
          returnDetailedScanResult: true,
          highlightScanRegion: true,
          highlightCodeOutline: true,
        }
      )

      scannerRef.current = scanner
      scanner.start().then(() => {
        console.log('[useQRScanner] Scanner restarted (created) successfully')
        onStartRef.current?.()
        startInProgressRef.current = false
      }).catch((err) => {
        console.error('Scanner restart creation error:', err)
        const errorMessage = err instanceof Error ? err.message : String(err)
        onErrorRef.current?.(`Failed to restart camera: ${errorMessage}`)
        startInProgressRef.current = false
      })
    }
  }

  const waitForCleanup = (): Promise<void> => {
    return cleanupPromiseRef.current || Promise.resolve()
  }

  return {
    videoRef,
    scannerRef,
    stopScanner,
    restartScanner,
    forceRecreate,
    waitForCleanup
  }
}
