import { useEffect, useRef, useState } from 'react'
import QrScanner from 'qr-scanner'

interface UseQRScannerOptions {
  onScan: (data: string) => void
  isScanning: boolean
  debounceMs?: number
}

export function useQRScanner({ onScan, isScanning, debounceMs = 500 }: UseQRScannerOptions) {
  const [error, setError] = useState<string>('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)
  const onScanRef = useRef(onScan)

  // Keep the callback ref up to date
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    if (!isScanning || !videoRef.current) {
      // Stop scanner if already running
      if (scannerRef.current) {
        scannerRef.current.stop()
        scannerRef.current.destroy()
        scannerRef.current = null
      }
      return
    }

    // Don't recreate scanner if already running
    if (scannerRef.current) {
      return
    }

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
    scanner.start().catch((err) => {
      console.error('Scanner start error:', err)
      setError('Failed to start camera. Please ensure camera permissions are granted.')
    })

    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop()
        scannerRef.current.destroy()
        scannerRef.current = null
      }
    }
  }, [isScanning, debounceMs])

  const stopScanner = () => {
    if (scannerRef.current) {
      scannerRef.current.stop()
    }
  }

  const restartScanner = async () => {
    if (scannerRef.current && videoRef.current) {
      try {
        await scannerRef.current.start()
      } catch (err) {
        console.error('Scanner restart error:', err)
        setError('Failed to restart camera')
      }
    }
  }

  return {
    videoRef,
    scannerRef,
    error,
    setError,
    stopScanner,
    restartScanner
  }
}
