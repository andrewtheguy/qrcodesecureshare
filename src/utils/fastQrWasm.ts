import initFastQrWasm, { generate_qr_png, generate_qr_svg } from '../../rust/fast-qr-wasm/pkg/fast_qr_wasm'

export type FastQrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

export interface FastQrPngGenerateOptions {
  width?: number
  margin?: number
  errorCorrectionLevel?: FastQrErrorCorrectionLevel
  forceByteMode?: boolean
}

export interface FastQrSvgGenerateOptions {
  margin?: number
  errorCorrectionLevel?: FastQrErrorCorrectionLevel
  forceByteMode?: boolean
}

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

function normalizePngGenerateOptions(options: FastQrPngGenerateOptions = {}) {
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

  return {
    normalizedWidth,
    normalizedMargin,
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
    forceByteMode: options.forceByteMode ?? false,
  }
}

function normalizeSvgGenerateOptions(options: FastQrSvgGenerateOptions = {}) {
  const margin = options.margin ?? 1
  const normalizedMargin = Number(margin)
  if (!Number.isFinite(normalizedMargin) || !Number.isInteger(normalizedMargin) || normalizedMargin < 0) {
    throw new TypeError('Invalid margin: expected a finite integer >= 0')
  }

  return {
    normalizedMargin,
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
    forceByteMode: options.forceByteMode ?? false,
  }
}

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
  options: FastQrPngGenerateOptions = {}
): Promise<Uint8Array> {
  await ensureFastQrWasmInit()

  const { normalizedWidth, normalizedMargin, errorCorrectionLevel, forceByteMode } = normalizePngGenerateOptions(options)

  const pngBytes = generate_qr_png(
    payload,
    normalizedWidth,
    normalizedMargin,
    errorCorrectionLevel,
    forceByteMode
  )

  return pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes)
}

export async function generateFastQrSvgString(
  payload: Uint8Array,
  options: FastQrSvgGenerateOptions = {}
): Promise<string> {
  await ensureFastQrWasmInit()

  const { normalizedMargin, errorCorrectionLevel, forceByteMode } = normalizeSvgGenerateOptions(options)

  return generate_qr_svg(
    payload,
    normalizedMargin,
    errorCorrectionLevel,
    forceByteMode
  )
}
