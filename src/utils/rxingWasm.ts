import initRxingWasm, { decode_qr_rgba } from '../../rust/rxing-wasm/pkg/rxing_wasm'

export interface RxingReaderOptions {
  tryHarder?: boolean
  tryInvert?: boolean
  useHybridBinarizer?: boolean
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

export async function decodeQrFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: RxingReaderOptions = {}
): Promise<Uint8Array | null> {
  await ensureRxingWasmInit()

  const { tryHarder = false, tryInvert = false, useHybridBinarizer = true } = options

  const result = decode_qr_rgba(
    toUint8Array(rgba),
    width,
    height,
    tryHarder,
    tryInvert,
    useHybridBinarizer
  )

  return result ?? null
}

export async function decodeQrFromImageData(
  imageData: ImageData,
  options: RxingReaderOptions = {}
): Promise<Uint8Array | null> {
  return decodeQrFromRgba(imageData.data, imageData.width, imageData.height, options)
}
