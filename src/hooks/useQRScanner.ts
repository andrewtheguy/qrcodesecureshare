import { useEffect, useRef } from 'react'
import QrScanner from 'qr-scanner'
import { isMobileDevice } from '@/lib/utils'

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
  /**
   * Maximum scans per second. Defaults to 8 for mobile, 15 for desktop.
   * Lower values reduce battery consumption on mobile devices.
   */
  maxScansPerSecond?: number
  /**
   * Enable visual highlights (scan region and code outline).
   * Defaults to false on mobile to reduce rendering overhead, true on desktop.
   */
  enableVisualHighlights?: boolean
  /**
   * Preferred camera to use. Defaults to 'environment' (rear camera).
   */
  preferredCamera?: 'environment' | 'user'
}

QrScanner.WORKER_PATH = '/qr-scanner-worker.min.js'

export function useQRScanner({
  onScan,
  isScanning,
  debounceMs = 500,
  onError,
  onStart,
  onStop,
  maxScansPerSecond,
  enableVisualHighlights,
  preferredCamera = 'environment'
}: UseQRScannerOptions) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const startInProgressRef = useRef<boolean>(false)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)
  const lastConstraintsRef = useRef<MediaTrackConstraints | null>(null)
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
        scannerRef.current.stop()
        scannerRef.current.destroy()
        scannerRef.current = null
        onStopRef.current?.()
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

    // Mobile optimization strategy:
    // - Reduce scan rate from 25 fps to 8 fps on mobile to save battery
    // - Disable visual highlights on mobile to reduce rendering overhead
    // - Constrain video resolution to prevent unnecessary high-res processing
    const isMobile = isMobileDevice()
    const scanRate = maxScansPerSecond ?? (isMobile ? 8 : 15)
    const showHighlights = enableVisualHighlights ?? !isMobile

    console.log(`[useQRScanner] Mobile: ${isMobile}, Scan rate: ${scanRate} fps, Visual highlights: ${showHighlights}`)

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
        maxScansPerSecond: scanRate,
        highlightScanRegion: showHighlights,
        highlightCodeOutline: showHighlights,
        preferredCamera: preferredCamera,
      }
    )

    scannerRef.current = scanner

    const baseConstraints: MediaTrackConstraints = {
      ...(preferredCamera
        ? { facingMode: { ideal: preferredCamera } }
        : {}),
      ...(isMobile
        ? {
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        : {})
    }
    lastConstraintsRef.current = {
      ...baseConstraints,
      width: baseConstraints.width ? { ...baseConstraints.width } : undefined,
      height: baseConstraints.height ? { ...baseConstraints.height } : undefined
    }

    const startPromise = Object.keys(baseConstraints).length > 0
      ? scanner.start(baseConstraints)
      : scanner.start()

    startPromise.then(() => {
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
        scannerToStop.stop()
        // Add a small delay to ensure camera is released
        setTimeout(() => {
          scannerToStop.destroy()
          onStopRef.current?.()
        }, 50)
        scannerRef.current = null
        startInProgressRef.current = false
      }
    }
  }, [isScanning, debounceMs, maxScansPerSecond, enableVisualHighlights, preferredCamera])

  const stopScanner = () => {
    if (scannerRef.current) {
      scannerRef.current.stop()
    }
  }

  const restartScanner = async () => {
    if (scannerRef.current && videoRef.current) {
      try {
        startInProgressRef.current = true
        const constraints = lastConstraintsRef.current
        if (constraints) {
          const clonedConstraints: MediaTrackConstraints = {
            ...constraints,
            width: constraints.width ? { ...constraints.width } : undefined,
            height: constraints.height ? { ...constraints.height } : undefined
          }
          await scannerRef.current.start(clonedConstraints)
        } else {
          await scannerRef.current.start()
        }
        onStartRef.current?.()
      } catch (err) {
        console.error('Scanner restart error:', err)
        onErrorRef.current?.('Failed to restart camera')
      } finally {
        startInProgressRef.current = false
      }
    }
  }

  return {
    videoRef,
    scannerRef,
    stopScanner,
    restartScanner
  }
}
