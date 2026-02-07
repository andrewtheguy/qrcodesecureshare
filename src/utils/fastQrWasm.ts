import initFastQrWasm, { generate_qr_png } from '../../rust/fast-qr-wasm/pkg/fast_qr_wasm'

export type FastQrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

export interface FastQrGenerateOptions {
  width?: number
  margin?: number
  errorCorrectionLevel?: FastQrErrorCorrectionLevel
  forceByteMode?: boolean
}

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

export async function ensureFastQrWasmInit(): Promise<void> {
  if (wasmInitialized) return

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      await initFastQrWasm()
      wasmInitialized = true
    })().catch((error) => {
      wasmInitPromise = null
      throw error
    })
  }

  await wasmInitPromise
}

export async function generateFastQrPngBytes(
  payload: Uint8Array,
  options: FastQrGenerateOptions = {}
): Promise<Uint8Array> {
  await ensureFastQrWasmInit()

  const width = options.width ?? 300
  const margin = options.margin ?? 1
  const normalizedWidth = Number(width)
  if (!Number.isFinite(normalizedWidth) || !Number.isInteger(normalizedWidth) || normalizedWidth <= 0) {
    throw new TypeError('Invalid width: expected a finite integer > 0')
  }

  const normalizedMargin = Number(margin)
  if (!Number.isFinite(normalizedMargin) || !Number.isInteger(normalizedMargin) || normalizedMargin < 0) {
    throw new TypeError('Invalid margin: expected a finite integer >= 0')
  }

  const errorCorrectionLevel = options.errorCorrectionLevel ?? 'M'
  const forceByteMode = options.forceByteMode ?? false

  const pngBytes = generate_qr_png(
    payload,
    normalizedWidth,
    normalizedMargin,
    errorCorrectionLevel,
    forceByteMode
  )

  return pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes)
}
