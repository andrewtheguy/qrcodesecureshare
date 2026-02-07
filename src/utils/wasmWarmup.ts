import { ensureFastQrWasmInit } from './fastQrWasm'
import { ensureWasmInit } from './fountainCodeWasm'
import { ZXING_WASM_FILENAME } from './zxingWasmAsset'

let wasmWarmupStarted = false

async function prefetchZXingWasm(): Promise<void> {
  const zxingWasmUrl = `${import.meta.env.BASE_URL}${ZXING_WASM_FILENAME}`
  const response = await fetch(zxingWasmUrl, { cache: 'force-cache' })
  if (!response.ok) {
    throw new Error(`Failed to prefetch zxing wasm: ${response.status} ${response.statusText}`)
  }
  await response.arrayBuffer()
}

async function warmupWasmModules(): Promise<void> {
  const results = await Promise.allSettled([
    ensureFastQrWasmInit(),
    ensureWasmInit(),
    prefetchZXingWasm(),
  ])

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[WASM Warmup] Warmup task failed:', result.reason)
    }
  }
}

export function startWasmWarmup(): void {
  if (wasmWarmupStarted || typeof window === 'undefined') {
    return
  }

  wasmWarmupStarted = true

  const runWarmup = () => {
    void warmupWasmModules().catch((error) => {
      console.warn('[WASM Warmup] Warmup failed:', error)
    })
  }

  if (navigator.onLine) {
    runWarmup()
    return
  }

  window.addEventListener('online', runWarmup, { once: true })
}
