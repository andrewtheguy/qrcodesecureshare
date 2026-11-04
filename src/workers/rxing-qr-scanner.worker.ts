import {
  type RxingReaderOptions,
  readQrCodesFromImageData,
} from '@/utils/rxingWasm';

interface ScanMessage {
  type: 'scan';
  imageData: ImageData;
  options?: RxingReaderOptions;
}

/** A camera frame, transferred so the pixels are read here, off the page's thread. */
interface ScanFrameMessage {
  type: 'scanFrame';
  frame: ImageBitmap;
  options?: RxingReaderOptions;
}

interface ScanResult {
  type: 'result';
  data: Uint8Array[];
  error?: string;
}

interface UnexpectedMessageResponse {
  type: 'error';
  error: string;
  unexpectedType: string;
  originalMessage: unknown;
}

function isScanMessage(data: unknown): data is ScanMessage | ScanFrameMessage {
  if (typeof data !== 'object' || data === null) return false;
  const type = (data as { type?: unknown }).type;
  return type === 'scan' || type === 'scanFrame';
}

let frameCanvas: OffscreenCanvas | null = null;
let frameContext: OffscreenCanvasRenderingContext2D | null = null;

/** Reads a frame's pixels on a canvas kept across frames, resized only when the size changes. */
function readFrame(frame: ImageBitmap): ImageData {
  const { width, height } = frame;
  if (!frameCanvas) {
    frameCanvas = new OffscreenCanvas(width, height);
    frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
  } else if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
  }
  if (!frameContext) {
    throw new Error('OffscreenCanvas 2D context is unavailable in this worker');
  }
  frameContext.drawImage(frame, 0, 0);
  return frameContext.getImageData(0, 0, width, height);
}

self.onmessage = async (e: MessageEvent<unknown>) => {
  if (isScanMessage(e.data)) {
    const scan = e.data;
    try {
      const { options } = scan;
      let imageData: ImageData;
      if (scan.type === 'scanFrame') {
        try {
          imageData = readFrame(scan.frame);
        } finally {
          scan.frame.close();
        }
      } else {
        imageData = scan.imageData;
      }

      const readerOptions: RxingReaderOptions = {
        // Defaults tuned for general-purpose QR scanning: skip the heavier
        // `tryHarder` + `tryInvert` passes, adaptive binarizer for noisy
        // camera output, no binarizer fallback (the extra pipeline pass is
        // not worth it on the fast scanner default — callers that want
        // robustness opt in via `MAXIMIZED_DETECTION_OPTIONS`). Rotation is
        // handled natively by rxing's finder-pattern canonical reordering,
        // so no rotation-retry flag is needed. Single-symbol output is
        // enforced at the wasm boundary in `readQrCodesFromRgba`.
        tryHarder: false,
        tryInvert: false,
        binarizer: 'hybrid',
        binarizerFallback: false,
        ...options,
      };

      const data = await readQrCodesFromImageData(imageData, readerOptions);

      const message: ScanResult = { type: 'result', data };
      self.postMessage(message);
    } catch (error) {
      const message: ScanResult = {
        type: 'result',
        data: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      self.postMessage(message);
    }
  } else {
    const unexpectedType =
      typeof e.data === 'object' && e.data !== null && 'type' in e.data
        ? String((e.data as Record<string, unknown>).type)
        : 'unknown';

    const errorMessage = `Unexpected message type received: ${unexpectedType}`;
    console.warn(errorMessage, e.data);

    const errorResponse: UnexpectedMessageResponse = {
      type: 'error',
      error: errorMessage,
      unexpectedType,
      originalMessage: e.data,
    };
    self.postMessage(errorResponse);
  }
};
