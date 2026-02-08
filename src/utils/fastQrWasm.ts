import initFastQrWasm, {
  generate_qr_matrix,
  generate_qr_png,
  generate_qr_svg,
} from '../../rust/fast-qr-wasm/pkg/fast_qr_wasm'

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

export interface FastQrMatrixGenerateOptions {
  margin?: number
  errorCorrectionLevel?: FastQrErrorCorrectionLevel
  forceByteMode?: boolean
}

export interface FastQrModuleMatrix {
  moduleCount: number
  modules: Uint8Array
}

let wasmInitialized = false
let wasmInitPromise: Promise<void> | null = null

function normalizeMargin(margin?: number): number {
  const normalizedMargin = Number(margin ?? 1)
  if (!Number.isFinite(normalizedMargin) || !Number.isInteger(normalizedMargin) || normalizedMargin < 0) {
    throw new TypeError('Invalid margin: expected a finite integer >= 0')
  }

  return normalizedMargin
}

function normalizePngGenerateOptions(options: FastQrPngGenerateOptions = {}) {
  const width = options.width ?? 300
  const normalizedWidth = Number(width)
  if (!Number.isFinite(normalizedWidth) || !Number.isInteger(normalizedWidth) || normalizedWidth <= 0) {
    throw new TypeError('Invalid width: expected a finite integer > 0')
  }

  const normalizedMargin = normalizeMargin(options.margin)

  return {
    normalizedWidth,
    normalizedMargin,
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
    forceByteMode: options.forceByteMode ?? false,
  }
}

function normalizeSvgGenerateOptions(options: FastQrSvgGenerateOptions = {}) {
  const normalizedMargin = normalizeMargin(options.margin)

  return {
    normalizedMargin,
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
    forceByteMode: options.forceByteMode ?? false,
  }
}

function normalizeMatrixGenerateOptions(options: FastQrMatrixGenerateOptions = {}) {
  const normalizedMargin = normalizeMargin(options.margin)

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

export async function generateFastQrModuleMatrix(
  payload: Uint8Array,
  options: FastQrMatrixGenerateOptions = {}
): Promise<FastQrModuleMatrix> {
  await ensureFastQrWasmInit()

  const { normalizedMargin, errorCorrectionLevel, forceByteMode } =
    normalizeMatrixGenerateOptions(options)

  const matrixBytes = generate_qr_matrix(
    payload,
    normalizedMargin,
    errorCorrectionLevel,
    forceByteMode
  )
  const normalizedBytes =
    matrixBytes instanceof Uint8Array ? matrixBytes : new Uint8Array(matrixBytes)

  if (normalizedBytes.length < 2) {
    throw new Error('Invalid QR matrix payload: missing module count header')
  }

  const moduleCount = (normalizedBytes[0] << 8) | normalizedBytes[1]
  if (moduleCount <= 0) {
    throw new Error('Invalid QR matrix payload: module count must be > 0')
  }

  const expectedLength = 2 + moduleCount * moduleCount
  if (normalizedBytes.length < expectedLength) {
    throw new Error('Invalid QR matrix payload: truncated module data')
  }

  return {
    moduleCount,
    modules: normalizedBytes.slice(2, expectedLength),
  }
}
