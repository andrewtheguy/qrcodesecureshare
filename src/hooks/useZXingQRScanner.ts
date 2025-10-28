import { useRef, useEffect, useCallback } from 'react'
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'
import { isMobileDevice } from '@/lib/utils'

interface UseZXingQRScannerOptions {
  onScan: (data: string) => void
  onError?: (error: string) => void
  onCameraReady?: () => void
  isScanning: boolean
  facingMode?: 'environment' | 'user'
  scanInterval?: number
}

export function useZXingQRScanner(options: UseZXingQRScannerOptions) {
  const {
    onScan,
    onError,
    onCameraReady,
    isScanning,
    facingMode = 'environment',
    scanInterval,
  } = options

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scanLoopRef = useRef<number | null>(null)
  const isScanningRef = useRef<boolean>(false)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const availableCamerasRef = useRef<MediaDeviceInfo[]>([])

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter((device) => device.kind === 'videoinput')
      availableCamerasRef.current = videoDevices
    } catch (err) {
      console.error('Failed to enumerate cameras:', err)
    }
  }, [])

  const scanVideoFrame = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return

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

      // Decode with zxing-wasm
      const readerOptions: ReaderOptions = {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: true,
      }

      const results = await readBarcodes(imageData, readerOptions)

      if (results.length > 0) {
        // QR code found!
        onScan(results[0].text)
      }
    } catch (err) {
      // Silent fail - continue scanning
      console.error('Error scanning frame:', err)
    }
  }, [onScan])

  const startScanLoop = useCallback(() => {
    const isMobile = isMobileDevice()
    const interval = scanInterval ?? (isMobile ? 125 : 67) // ms between scans

    let lastScanTime = 0

    const scanFrame = async () => {
      if (!isScanningRef.current) {
        return
      }

      const now = Date.now()
      if (now - lastScanTime >= interval) {
        await scanVideoFrame()
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
              width: { ideal: 1280 },
              height: { ideal: 720 },
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
  }, [facingMode, enumerateCameras, onCameraReady, onError, startScanLoop])

  const switchCamera = useCallback(async () => {
    stopCameraScanning()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await startCameraScanning()
  }, [stopCameraScanning, startCameraScanning])

  // Start/stop scanning based on isScanning prop
  useEffect(() => {
    if (isScanning && !isScanningRef.current) {
      startCameraScanning()
    } else if (!isScanning && isScanningRef.current) {
      stopCameraScanning()
    }
  }, [isScanning, startCameraScanning, stopCameraScanning])

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
    }
  }, [])

  return {
    videoRef,
    canvasRef,
    switchCamera,
    availableCameras: availableCamerasRef.current,
  }
}
