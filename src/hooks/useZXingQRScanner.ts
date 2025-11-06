import { useRef, useEffect, useCallback, useState } from 'react'
import { isMobileDevice } from '@/lib/utils'
import ZXingWorker from '@/workers/zxing-qr-scanner.worker?worker'
import type { ReaderOptions } from 'zxing-wasm/reader'

interface UseZXingQRScannerOptionsBase {
  onError?: (error: string) => void
  onCameraReady?: () => void
  isScanning: boolean
  facingMode?: 'environment' | 'user'
  scanInterval?: number
  debounceMs?: number // Debounce duplicate scans within this time window (ms)
  readerOptions?: Partial<ReaderOptions> // Custom reader options for barcode detection
  preferLowRes?: boolean // Use lower resolution on mobile devices for better performance
}

interface UseZXingQRScannerBinaryOptions extends UseZXingQRScannerOptionsBase {
  onScan: (data: Uint8Array[]) => void
  binary: true
}

interface UseZXingQRScannerTextOptions extends UseZXingQRScannerOptionsBase {
  onScan: (data: string[]) => void
  binary?: false
}

type UseZXingQRScannerOptions = UseZXingQRScannerBinaryOptions | UseZXingQRScannerTextOptions

export function useZXingQRScanner(options: UseZXingQRScannerOptions) {
  const {
    onScan,
    onError,
    onCameraReady,
    isScanning,
    facingMode = 'environment',
    scanInterval = 125, // Default to 125ms between scans
    binary = false, // Default to text mode for backward compatibility
    debounceMs = 0, // No debounce by default
    readerOptions = {}, // Custom reader options
    preferLowRes = false, // Default to standard resolution
  } = options

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scanLoopRef = useRef<number | null>(null)
  const isScanningRef = useRef<boolean>(false)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const lastScannedRef = useRef<string>('')
  const lastScanTimeRef = useRef<number>(0)
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([])

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter((device) => device.kind === 'videoinput')
      setAvailableCameras(videoDevices)
    } catch (err) {
      console.error('Failed to enumerate cameras:', err)
    }
  }, [])

  // Initialize worker
  useEffect(() => {
    const worker = new ZXingWorker()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'result') {
        if (e.data.data && Array.isArray(e.data.data) && e.data.data.length > 0) {
          // Debounce duplicate scans
          const scannedData = e.data.data[0]
          const now = Date.now()
          if (debounceMs > 0 && scannedData === lastScannedRef.current && now - lastScanTimeRef.current < debounceMs) {
            // Skip this duplicate scan
            return
          }
          lastScannedRef.current = scannedData
          lastScanTimeRef.current = now

          // QR codes found! Pass all detected QR codes
          onScan(e.data.data)
        }
        // If error or no data, silently continue scanning
        if (e.data.error) {
          console.error('Worker decode error:', e.data.error)
        }
      }
    }

    worker.onerror = (err) => {
      console.error('Worker error:', err)
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [onScan, debounceMs])

  const scanVideoFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !workerRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current

    // Check if video is ready
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      return
    }

    try {
      // Set canvas size to match video
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      if (canvas.width === 0 || canvas.height === 0) {
        return
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      // Draw current video frame to canvas
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

      // Get ImageData from canvas
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

      // Send to worker for decoding using transferable object for performance
      // The ArrayBuffer will be transferred (not copied) to the worker
      workerRef.current.postMessage(
        {
          type: 'scan',
          imageData,
          binary,
          options: readerOptions,
        },
        [imageData.data.buffer]
      )
    } catch (err) {
      // Silent fail - continue scanning
      console.error('Error scanning frame:', err)
    }
  }, [binary, readerOptions])

  const startScanLoop = useCallback(() => {
    let lastScanTime = 0

    const scanFrame = () => {
      if (!isScanningRef.current) {
        return
      }

      const now = Date.now()
      if (now - lastScanTime >= scanInterval) {
        scanVideoFrame()
        lastScanTime = now
      }

      if (isScanningRef.current) {
        scanLoopRef.current = requestAnimationFrame(scanFrame)
      }
    }

    isScanningRef.current = true
    scanFrame()
  }, [scanInterval, scanVideoFrame])

  const stopCameraScanning = useCallback(() => {
    isScanningRef.current = false

    // Stop camera stream
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }

    // Stop video element
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    // Cancel animation frame
    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current)
      scanLoopRef.current = null
    }
  }, [])

  const startCameraScanning = useCallback(async () => {
    try {
      // Wait for video element to be rendered in DOM
      await new Promise((resolve) => setTimeout(resolve, 100))

      if (!videoRef.current) {
        throw new Error('Video element not available')
      }

      const isMobile = isMobileDevice()
      const constraints: MediaStreamConstraints = {
        video: isMobile
          ? {
              facingMode: facingMode,
              width: { ideal: preferLowRes ? 640 : 1280 },
              height: { ideal: preferLowRes ? 480 : 720 },
            }
          : {
              facingMode: facingMode,
            },
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      cameraStreamRef.current = stream
      videoRef.current.srcObject = stream

      // Wait for video to load and play
      await videoRef.current.play()

      await enumerateCameras()

      if (onCameraReady) {
        onCameraReady()
      }

      startScanLoop()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to access camera'
      if (onError) {
        onError(`Camera access denied or unavailable. Please check your permissions. ${errorMessage}`)
      }
      isScanningRef.current = false
    }
  }, [facingMode, preferLowRes, enumerateCameras, onCameraReady, onError, startScanLoop])

  const switchCamera = useCallback(async () => {
    // Don't use stopCameraScanning as it sets isScanningRef to false
    // Instead, manually stop the stream and loop, then restart

    // Cancel animation frame
    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current)
      scanLoopRef.current = null
    }

    // Stop camera stream
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }

    // Stop video element
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    // Wait a bit before restarting
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Restart camera (isScanningRef is still true)
    await startCameraScanning()
  }, [startCameraScanning])

  // Start/stop scanning based on isScanning prop
  useEffect(() => {
    if (isScanning && !isScanningRef.current) {
      startCameraScanning()
    } else if (!isScanning && isScanningRef.current) {
      stopCameraScanning()
    }
  }, [isScanning, startCameraScanning, stopCameraScanning])

  // Restart camera when facingMode changes (only if already scanning)
  const facingModeRef = useRef(facingMode)
  useEffect(() => {
    // Skip on initial mount
    if (facingModeRef.current !== facingMode && isScanningRef.current) {
      switchCamera()
    }
    facingModeRef.current = facingMode
    // switchCamera intentionally omitted from dependency array: we only care about facingMode
    // changes triggering the effect. switchCamera is called for its side effects (camera restart),
    // not for its identity. Including it would cause unnecessary effect re-runs on every mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isScanningRef.current = false
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (scanLoopRef.current !== null) {
        cancelAnimationFrame(scanLoopRef.current)
      }
      // Add a small delay to ensure camera is fully released before new instance tries to access it
      // This prevents "media was removed from the document" errors when rapidly switching components
      if (videoRef.current) {
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.srcObject = null
          }
        }, 50)
      }
    }
  }, [])

  return {
    videoRef,
    canvasRef,
    switchCamera,
    availableCameras,
  }
}
