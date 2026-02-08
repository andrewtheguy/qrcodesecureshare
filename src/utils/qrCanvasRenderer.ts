export interface QrCanvasRenderOptions {
  size: number
  darkColor?: string
  lightColor?: string
}

export function renderQrModulesToCanvas(
  canvas: HTMLCanvasElement,
  moduleCount: number,
  modules: Uint8Array,
  options: QrCanvasRenderOptions
): void {
  if (!canvas) {
    throw new Error('Canvas is required for QR render')
  }
  if (moduleCount <= 0) {
    throw new Error('Invalid module count for QR render')
  }
  if (modules.length !== moduleCount * moduleCount) {
    throw new Error('Invalid module payload length for QR render')
  }

  const parsedSize = Number(options.size)
  if (!Number.isFinite(parsedSize)) {
    throw new Error(
      `Invalid QR render size: expected a finite number, received ${String(options.size)}`
    )
  }

  const size = Math.max(1, Math.floor(parsedSize))
  const pixelSize = Math.floor(size / moduleCount)
  if (pixelSize <= 0) {
    throw new Error('Target canvas size is too small for QR matrix')
  }

  const renderedSize = pixelSize * moduleCount
  if (canvas.width !== renderedSize) {
    canvas.width = renderedSize
  }
  if (canvas.height !== renderedSize) {
    canvas.height = renderedSize
  }

  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    throw new Error('Unable to acquire canvas context for QR render')
  }

  context.imageSmoothingEnabled = false
  const darkColor = options.darkColor ?? '#000000'
  const lightColor = options.lightColor ?? '#FFFFFF'

  context.fillStyle = lightColor
  context.fillRect(0, 0, renderedSize, renderedSize)

  context.fillStyle = darkColor

  let index = 0
  for (let y = 0; y < moduleCount; y += 1) {
    const top = y * pixelSize
    for (let x = 0; x < moduleCount; x += 1) {
      if (modules[index] !== 0) {
        context.fillRect(x * pixelSize, top, pixelSize, pixelSize)
      }
      index += 1
    }
  }
}
