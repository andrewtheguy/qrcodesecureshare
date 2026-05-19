import initRxingWasm, { read_qr_codes_rgba } from '../../rust/rxing-wasm/pkg/rxing_wasm'

export interface RxingReaderOptions {
  tryHarder?: boolean
  tryInvert?: boolean
  useHybridBinarizer?: boolean
  /**
   * Cap on the number of symbols returned per frame. Pass `0` to remove the cap.
   * Pass `1` when only one detection is needed (lets the multi-decode loop
   * short-circuit on the first valid result). Mirrors zxing-wasm's option of
   * the same name; default matches zxing-wasm (`255`).
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
