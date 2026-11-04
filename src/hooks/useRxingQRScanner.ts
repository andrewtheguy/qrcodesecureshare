import { useCallback, useEffect, useRef, useState } from 'react';
import { isMobileDevice } from '@/lib/utils';
import type { RxingReaderOptions } from '@/utils/rxingWasm';
import RxingWorker from '@/workers/rxing-qr-scanner.worker?worker';

interface UseRxingQRScannerOptions {
  onScan: (data: Uint8Array[]) => void;
  onError?: (error: string) => void;
  onCameraReady?: () => void;
  isScanning: boolean;
  facingMode?: 'environment' | 'user';
  scanInterval?: number;
  /**
   * Drop a read whose bytes match the previous read when it comes within this
   * many milliseconds of it. `Number.POSITIVE_INFINITY` drops every repeat.
   */
  debounceMs?: number;
  readerOptions?: RxingReaderOptions;
  preferLowRes?: boolean;
  /**
   * How many decoding workers to run, each holding one frame at a time. Capped
   * at one fewer than the device's cores, so the page keeps a core.
   */
  workerCount?: number;
}

type ScanLoopHandle =
  | { kind: 'video'; video: HTMLVideoElement; id: number }
  | { kind: 'animation'; id: number };

// Wait briefly before requesting camera access so React refs and recently stopped streams can settle.
const DELAY_BEFORE_START_MS = 100;

/** A message a person can act on, for why the camera did not start. */
function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Connect a camera, or upload an image of the QR code instead.';
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow camera access for this site in your browser settings, or upload an image of the QR code instead.';
    case 'NotSupportedError':
      return 'This browser does not allow camera access on this page. Open it over HTTPS in an up-to-date browser, or upload an image of the QR code instead.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera could not be started. It may be in use by another app; close it and try again, or upload an image of the QR code instead.';
    default:
      return `The camera could not be started${err instanceof Error && err.message ? ` (${err.message})` : ''}. Try again, or upload an image of the QR code instead.`;
  }
}

/**
 * Whether frames can go to the worker as ImageBitmaps for it to read on an
 * OffscreenCanvas (Chrome 69+, Firefox 105+, Safari 16.4+).
 */
function canReadFramesInWorker(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}

function isSameScan(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
    workerCount = 1,
  } = options;

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanLoopRef = useRef<ScanLoopHandle | null>(null);
  const isScanningRef = useRef<boolean>(false);
  const desiredScanningRef = useRef<boolean>(false);
  const startTokenRef = useRef<number>(0);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  // Each worker holds one frame at a time. A frame that arrives while every
  // worker is busy is not queued; it marks `pendingFrameRef` so the newest
  // frame is read the moment a worker is free.
  const workersRef = useRef<Worker[]>([]);
  const idleWorkersRef = useRef<Worker[]>([]);
  const readFramesInWorkerRef = useRef<boolean>(canReadFramesInWorker());
  const pendingFrameRef = useRef<boolean>(false);
  const lastFrameScanTimeRef = useRef<number>(Number.NEGATIVE_INFINITY);
  const lastScannedRef = useRef<Uint8Array>(new Uint8Array());
  const lastScanTimeRef = useRef<number>(0);
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>(
    [],
  );

  // Callers pass fresh callbacks and options on most renders. Reading them
  // through refs keeps the worker and scan loop alive across those renders.
  const onScanRef = useRef(onScan);
  const debounceMsRef = useRef(debounceMs);
  const readerOptionsRef = useRef(readerOptions);
  const scanIntervalRef = useRef(scanInterval);
  useEffect(() => {
    onScanRef.current = onScan;
    debounceMsRef.current = debounceMs;
    readerOptionsRef.current = readerOptions;
    scanIntervalRef.current = scanInterval;
  });

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(
        (device) => device.kind === 'videoinput',
      );
      setAvailableCameras(videoDevices);
    } catch (err) {
      console.error('Failed to enumerate cameras:', err);
    }
  }, []);

  /**
   * Sends the video's current frame to `worker`; false if none was sent.
   * Where the browser can, the frame goes over as an ImageBitmap and the
   * worker reads its pixels, so the page's thread never waits on a readback.
   * Otherwise the pixels are read here on a canvas.
   */
  const scanVideoFrame = useCallback((worker: Worker): boolean => {
    const video = videoRef.current;
    if (!video) return false;

    if (
      video.readyState !== video.HAVE_ENOUGH_DATA ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return false;
    }

    if (readFramesInWorkerRef.current) {
      createImageBitmap(video).then(
        (frame) => {
          // The pool was replaced while the bitmap was made (the scanner
          // unmounted), so this worker is gone.
          if (!workersRef.current.includes(worker)) {
            frame.close();
            return;
          }
          worker.postMessage(
            { type: 'scanFrame', frame, options: readerOptionsRef.current },
            [frame],
          );
        },
        (err: unknown) => {
          console.warn(
            'createImageBitmap failed; reading frames on the page instead:',
            err,
          );
          readFramesInWorkerRef.current = false;
          releaseWorkerRef.current(worker);
        },
      );
      return true;
    }

    const canvas = canvasRef.current;
    if (!canvas) return false;

    try {
      // Setting a canvas's size clears and may reallocate it, so only do it
      // when the video's size changes.
      if (
        canvas.width !== video.videoWidth ||
        canvas.height !== video.videoHeight
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      worker.postMessage(
        {
          type: 'scan',
          imageData,
          options: readerOptionsRef.current,
        },
        [imageData.data.buffer],
      );
      return true;
    } catch (err) {
      console.error('Error scanning frame:', err);
      return false;
    }
  }, []);

  /** Scans a frame if the interval has passed and a worker is free. */
  const offerFrame = useCallback(
    (now: number) => {
      if (now - lastFrameScanTimeRef.current < scanIntervalRef.current) return;
      const worker = idleWorkersRef.current.pop();
      if (!worker) {
        pendingFrameRef.current = true;
        return;
      }
      pendingFrameRef.current = false;
      if (scanVideoFrame(worker)) {
        lastFrameScanTimeRef.current = now;
      } else {
        idleWorkersRef.current.push(worker);
      }
    },
    [scanVideoFrame],
  );

  /** Returns a worker to the idle pool and gives it the pending frame, if any. */
  const releaseWorker = useCallback(
    (worker: Worker) => {
      if (
        !workersRef.current.includes(worker) ||
        idleWorkersRef.current.includes(worker)
      ) {
        return;
      }
      idleWorkersRef.current.push(worker);
      if (pendingFrameRef.current && isScanningRef.current) {
        offerFrame(performance.now());
      }
    },
    [offerFrame],
  );
  const releaseWorkerRef = useRef(releaseWorker);
  useEffect(() => {
    releaseWorkerRef.current = releaseWorker;
  }, [releaseWorker]);

  useEffect(() => {
    const cores = navigator.hardwareConcurrency || 2;
    const count = Math.max(1, Math.min(workerCount, cores - 1));
    const workers = Array.from({ length: count }, () => new RxingWorker());
    workersRef.current = workers;
    idleWorkersRef.current = [...workers];

    const handleResult = (data: { data: Uint8Array[]; error?: string }) => {
      if (data.error) {
        console.error('Worker decode error:', data.error);
      }
      if (data.data.length === 0) return;

      const scannedData = data.data[0];
      const debounce = debounceMsRef.current;
      if (debounce > 0) {
        const now = Date.now();
        if (
          isSameScan(scannedData, lastScannedRef.current) &&
          now - lastScanTimeRef.current < debounce
        ) {
          return;
        }
        // Keep a copy: callers may transfer the read's buffer elsewhere.
        lastScannedRef.current = scannedData.slice();
        lastScanTimeRef.current = now;
      }

      onScanRef.current(data.data);
    };

    for (const worker of workers) {
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'result') {
          handleResult(e.data);
        }
        releaseWorker(worker);
      };
      worker.onerror = (err) => {
        console.error('Worker error:', err);
        releaseWorker(worker);
      };
    }

    return () => {
      for (const worker of workers) worker.terminate();
      workersRef.current = [];
      idleWorkersRef.current = [];
      pendingFrameRef.current = false;
    };
  }, [releaseWorker, workerCount]);

  const cancelScanLoop = useCallback(() => {
    const handle = scanLoopRef.current;
    if (!handle) return;
    scanLoopRef.current = null;
    if (handle.kind === 'video') {
      handle.video.cancelVideoFrameCallback(handle.id);
    } else {
      cancelAnimationFrame(handle.id);
    }
  }, []);

  const startScanLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // requestVideoFrameCallback fires once per new camera frame, so no frame
    // is read twice and none is skipped by a display refresh that is out of
    // step with the camera. Browsers without it fall back to animation frames.
    const useVideoFrames = 'requestVideoFrameCallback' in video;

    const scheduleNext = () => {
      if (!isScanningRef.current) return;
      scanLoopRef.current = useVideoFrames
        ? {
            kind: 'video',
            video,
            id: video.requestVideoFrameCallback(onFrame),
          }
        : { kind: 'animation', id: requestAnimationFrame(onFrame) };
    };

    const onFrame = (now: DOMHighResTimeStamp) => {
      if (!isScanningRef.current) return;
      offerFrame(now);
      scheduleNext();
    };

    cancelScanLoop();
    lastFrameScanTimeRef.current = Number.NEGATIVE_INFINITY;
    pendingFrameRef.current = false;
    isScanningRef.current = true;
    scheduleNext();
  }, [offerFrame, cancelScanLoop]);

  const stopCameraScanning = useCallback(() => {
    isScanningRef.current = false;
    desiredScanningRef.current = false;
    pendingFrameRef.current = false;
    startTokenRef.current += 1;

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      cameraStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    cancelScanLoop();
  }, [cancelScanLoop]);

  const startCameraScanning = useCallback(async () => {
    const startToken = startTokenRef.current + 1;
    startTokenRef.current = startToken;
    desiredScanningRef.current = true;
    try {
      // Give refs and any recently stopped stream time to settle before getUserMedia.
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BEFORE_START_MS),
      );

      if (startTokenRef.current !== startToken || !desiredScanningRef.current) {
        return;
      }
      if (!videoRef.current) {
        throw new Error('Video element not available');
      }

      const isMobile = isMobileDevice();
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
      };

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException(
          'getUserMedia is unavailable',
          'NotSupportedError',
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (startTokenRef.current !== startToken || !desiredScanningRef.current) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      cameraStreamRef.current = stream;
      videoRef.current.srcObject = stream;

      if (startTokenRef.current !== startToken || !desiredScanningRef.current) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        cameraStreamRef.current = null;
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
        return;
      }
      await videoRef.current.play();

      await enumerateCameras();

      if (
        onCameraReady &&
        startTokenRef.current === startToken &&
        desiredScanningRef.current
      ) {
        onCameraReady();
      }

      if (startTokenRef.current === startToken && desiredScanningRef.current) {
        startScanLoop();
      }
    } catch (err) {
      console.error('Failed to start camera:', err);
      if (
        onError &&
        desiredScanningRef.current &&
        startTokenRef.current === startToken
      ) {
        onError(describeCameraError(err));
      }
      stopCameraScanning();
    }
  }, [
    facingMode,
    preferLowRes,
    enumerateCameras,
    onCameraReady,
    onError,
    startScanLoop,
    stopCameraScanning,
  ]);

  const switchCamera = useCallback(async () => {
    cancelScanLoop();

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      cameraStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    await new Promise((resolve) => setTimeout(resolve, DELAY_BEFORE_START_MS));

    await startCameraScanning();
  }, [startCameraScanning, cancelScanLoop]);

  const switchCameraRef = useRef(switchCamera);
  useEffect(() => {
    switchCameraRef.current = switchCamera;
  }, [switchCamera]);

  useEffect(() => {
    if (isScanning && !isScanningRef.current) {
      startCameraScanning();
    } else if (!isScanning && isScanningRef.current) {
      stopCameraScanning();
    }
  }, [isScanning, startCameraScanning, stopCameraScanning]);

  const cameraSettingsRef = useRef({ facingMode, preferLowRes });
  useEffect(() => {
    const previousSettings = cameraSettingsRef.current;
    const cameraSettingsChanged =
      previousSettings.facingMode !== facingMode ||
      previousSettings.preferLowRes !== preferLowRes;

    cameraSettingsRef.current = { facingMode, preferLowRes };

    if (cameraSettingsChanged && isScanningRef.current) {
      void switchCameraRef.current();
    }
  }, [facingMode, preferLowRes]);

  useEffect(() => {
    const videoEl = videoRef.current;
    return () => {
      isScanningRef.current = false;
      desiredScanningRef.current = false;
      startTokenRef.current += 1;
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => {
          track.stop();
        });
      }
      cancelScanLoop();
      // Small delay to ensure the camera is fully released before a new instance
      // tries to access it; prevents "media was removed from the document" errors
      // when rapidly switching components.
      if (videoEl) {
        setTimeout(() => {
          videoEl.srcObject = null;
        }, 50);
      }
    };
  }, [cancelScanLoop]);

  return {
    videoRef,
    canvasRef,
    switchCamera,
    availableCameras,
  };
}
