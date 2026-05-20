import initRxingWasm, { read_qr_codes_rgba } from '@andrewtheguy/rxing-wasm'

/**
 * Which binarizer to apply when thresholding the luminance buffer.
 * - `'hybrid'` (default) — rxing's adaptive `HybridBinarizer`, equivalent to
 *   zxing-wasm's `"LocalAverage"`. Per-8×8-block thresholds; robust to
 *   uneven illumination (vignetting, glare, gradients) but slower.
 * - `'global'` — rxing's `GlobalHistogramBinarizer`, equivalent to
 *   zxing-wasm's `"GlobalHistogram"`. Single image-wide threshold; faster
 *   but defeated by uneven lighting. Decodes stylized clean-bg QRs that
 *   confuse Hybrid's local thresholds (e.g. colored finder patterns).
 *
 * The two binarizers fail on disjoint inputs — use `binarizerFallback` to
 * cover both failure modes at the cost of an extra pipeline pass.
 *
 * `'fixed'` and `'boolcast'` from zxing-wasm are intentionally omitted —
 * rxing-vendored doesn't ship them.
 */
export type Binarizer = 'hybrid' | 'global'

export interface RxingReaderOptions {
  /**
   * Spend more time looking for finder patterns by densifying the scan
   * (rxing's `TryHarder` hint).
   */
  tryHarder?: boolean
  /**
   * Retry with the BitMatrix flipped if the first pass yields no result.
   * Covers white-on-dark / inverted-reflectance codes. Mirrors zxing-wasm's
   * option of the same name.
   */
  tryInvert?: boolean
  /**
   * Primary binarizer. Default `'hybrid'`, matching upstream zxing-wasm's
   * `LocalAverage` default.
   */
  binarizer?: Binarizer
  /**
   * When `true` and the primary binarizer produces no results, retry the
   * full pipeline once with the opposite binarizer. Default `false`,
   * matching upstream which picks one binarizer per call. Enable on
   * one-shot image-upload paths where robustness matters more than cost;
   * leave disabled on battery-critical live scanning loops.
   */
  binarizerFallback?: boolean
}

// Hardcoded to 1: every consumer in this app reads only `results[0]`, so the
// underlying multi-decode loop short-circuits on the first valid detection.
const MAX_NUMBER_OF_SYMBOLS = 1

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

export async function ensureRxingWasmInit(): Promise<void> {
  if (wasmInitialized) return

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      await initRxingWasm()
      wasmInitialized = true
    })().catch((error) => {
      wasmInitPromise = null
      throw error
    })
  }

  await wasmInitPromise
}

function toUint8Array(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export async function readQrCodesFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: RxingReaderOptions = {}
): Promise<Uint8Array[]> {
  await ensureRxingWasmInit()

  const {
    tryHarder = false,
    tryInvert = false,
    binarizer = 'hybrid',
    binarizerFallback = false,
  } = options

  // `read_qr_codes_rgba` returns a JS Array of Uint8Array (one entry per
  // detected symbol). wasm-bindgen types it as `Array<any>`; narrow it here.
  const results = read_qr_codes_rgba(
    toUint8Array(rgba),
    width,
    height,
    tryHarder,
    tryInvert,
    binarizer === 'hybrid',
    binarizerFallback,
    MAX_NUMBER_OF_SYMBOLS
  ) as Uint8Array[]

  return results
}

export async function readQrCodesFromImageData(
  imageData: ImageData,
  options: RxingReaderOptions = {}
): Promise<Uint8Array[]> {
  return readQrCodesFromRgba(imageData.data, imageData.width, imageData.height, options)
}
