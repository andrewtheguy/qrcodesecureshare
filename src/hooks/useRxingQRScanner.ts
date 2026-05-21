import { useCallback, useEffect, useRef, useState } from 'react'
import { isMobileDevice } from '@/lib/utils'
import type { RxingReaderOptions } from '@/utils/rxingWasm'
import RxingWorker from '@/workers/rxing-qr-scanner.worker?worker'

interface UseRxingQRScannerOptions {
  onScan: (data: Uint8Array[]) => void
  onError?: (error: string) => void
  onCameraReady?: () => void
  isScanning: boolean
  facingMode?: 'environment' | 'user'
  scanInterval?: number
  debounceMs?: number
  readerOptions?: RxingReaderOptions
  preferLowRes?: boolean
}

// Wait briefly before requesting camera access so React refs and recently stopped streams can settle.
const DELAY_BEFORE_START_MS = 100

function isSameScan(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function useRxingQRScanner(options: UseRxingQRScannerOptions) {
  const {
    onScan,
    onError,
    onCameraReady,
    isScanning,
    facingMode = 'environment',
    scanInterval = 125,
    debounceMs = 0,
    readerOptions = {},
    preferLowRes = false,
  } = options

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scanLoopRef = useRef<number | null>(null)
  const isScanningRef = useRef<boolean>(false)
  const desiredScanningRef = useRef<boolean>(false)
  const startTokenRef = useRef<number>(0)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const lastScannedRef = useRef<Uint8Array>(new Uint8Array())
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

  useEffect(() => {
    const worker = new RxingWorker()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'result') {
        if (e.data.data.length > 0) {
          const scannedData = e.data.data[0] as Uint8Array
          const now = Date.now()
          if (
            debounceMs > 0 &&
            isSameScan(scannedData, lastScannedRef.current) &&
            now - lastScanTimeRef.current < debounceMs
          ) {
            return
          }
          lastScannedRef.current = scannedData
          lastScanTimeRef.current = now

          onScan(e.data.data)
        }
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

    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      return
    }

    try {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      if (canvas.width === 0 || canvas.height === 0) {
        return
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

      workerRef.current.postMessage(
        {
          type: 'scan',
          imageData,
          options: readerOptions,
        },
        [imageData.data.buffer]
      )
    } catch (err) {
      console.error('Error scanning frame:', err)
    }
  }, [readerOptions])

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
    desiredScanningRef.current = false
    startTokenRef.current += 1

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current)
      scanLoopRef.current = null
    }
  }, [])

  const startCameraScanning = useCallback(async () => {
    const startToken = startTokenRef.current + 1
    startTokenRef.current = startToken
    desiredScanningRef.current = true
    try {
      // Give refs and any recently stopped stream time to settle before getUserMedia.
      await new Promise((resolve) => setTimeout(resolve, DELAY_BEFORE_START_MS))

      if (startTokenRef.current !== startToken || !desiredScanningRef.current) {
        return
      }
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
      if (startTokenRef.current !== startToken || !desiredScanningRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      cameraStreamRef.current = stream
      videoRef.current.srcObject = stream

      if (startTokenRef.current !== startToken || !desiredScanningRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        cameraStreamRef.current = null
        if (videoRef.current) {
          videoRef.current.srcObject = null
        }
        return
      }
      await videoRef.current.play()

      await enumerateCameras()

      if (onCameraReady && startTokenRef.current === startToken && desiredScanningRef.current) {
        onCameraReady()
      }

      if (startTokenRef.current === startToken && desiredScanningRef.current) {
        startScanLoop()
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to access camera'
      if (onError && desiredScanningRef.current && startTokenRef.current === startToken) {
        onError(`Camera access denied or unavailable. Please check your permissions. ${errorMessage}`)
      }
      stopCameraScanning()
    }
  }, [facingMode, preferLowRes, enumerateCameras, onCameraReady, onError, startScanLoop, stopCameraScanning])

  const switchCamera = useCallback(async () => {
    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current)
      scanLoopRef.current = null
    }

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    await new Promise((resolve) => setTimeout(resolve, DELAY_BEFORE_START_MS))

    await startCameraScanning()
  }, [startCameraScanning])

  const switchCameraRef = useRef(switchCamera)
  useEffect(() => {
    switchCameraRef.current = switchCamera
  }, [switchCamera])

  useEffect(() => {
    if (isScanning && !isScanningRef.current) {
      startCameraScanning()
    } else if (!isScanning && isScanningRef.current) {
      stopCameraScanning()
    }
  }, [isScanning, startCameraScanning, stopCameraScanning])

  const cameraSettingsRef = useRef({ facingMode, preferLowRes })
  useEffect(() => {
    const previousSettings = cameraSettingsRef.current
    const cameraSettingsChanged =
      previousSettings.facingMode !== facingMode || previousSettings.preferLowRes !== preferLowRes

    cameraSettingsRef.current = { facingMode, preferLowRes }

    if (cameraSettingsChanged && isScanningRef.current) {
      void switchCameraRef.current()
    }
  }, [facingMode, preferLowRes, isScanningRef])

  useEffect(() => {
    const videoEl = videoRef.current
    return () => {
      isScanningRef.current = false
      desiredScanningRef.current = false
      startTokenRef.current += 1
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (scanLoopRef.current !== null) {
        cancelAnimationFrame(scanLoopRef.current)
      }
      // Small delay to ensure the camera is fully released before a new instance
      // tries to access it; prevents "media was removed from the document" errors
      // when rapidly switching components.
      if (videoEl) {
        setTimeout(() => {
          videoEl.srcObject = null
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
