import initRxingWasm, { read_qr_codes_rgba } from '../../rust/rxing-wasm/pkg/rxing_wasm'

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
   * Retry at 90°, 180°, 270° rotations if earlier passes yield no result.
   * Mirrors zxing-wasm's option of the same name. The QR finder is itself
   * rotation-invariant for upright codes; this covers cameras held
   * sideways / upside-down.
   */
  tryRotate?: boolean
  /**
   * When `true`, use rxing's adaptive `HybridBinarizer` (more accurate);
   * when `false`, the faster but less robust `GlobalHistogramBinarizer`.
   * Closest equivalent to zxing-wasm's `binarizer: "LocalAverage"` vs
   * `"GlobalHistogram"`. (zxing-wasm's `FixedThreshold` and `BoolCast`
   * variants are not available — rxing doesn't ship them.)
   */
  useHybridBinarizer?: boolean
  /**
   * Cap on the number of symbols returned per frame. Pass `0` to remove the
   * cap. Pass `1` when only one detection is needed (lets the multi-decode
   * loop short-circuit on the first valid result). Mirrors zxing-wasm's
   * option of the same name; default matches zxing-wasm (`255`).
   */
  maxNumberOfSymbols?: number
}

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
    tryRotate = false,
    useHybridBinarizer = true,
    maxNumberOfSymbols = 255,
  } = options

  // `read_qr_codes_rgba` returns a JS Array of Uint8Array (one entry per
  // detected symbol). wasm-bindgen types it as `Array<any>`; narrow it here.
  const results = read_qr_codes_rgba(
    toUint8Array(rgba),
    width,
    height,
    tryHarder,
    tryInvert,
    tryRotate,
    useHybridBinarizer,
    maxNumberOfSymbols
  ) as Uint8Array[]

  return results
}

export async function readQrCodesFromImageData(
  imageData: ImageData,
  options: RxingReaderOptions = {}
): Promise<Uint8Array[]> {
  return readQrCodesFromRgba(imageData.data, imageData.width, imageData.height, options)
}
