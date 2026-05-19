import { ensureFastQrWasmInit } from './fastQrWasm'
import { ensureWasmInit } from './fountainCodeWasm'
import { ensureRxingWasmInit } from './rxingWasm'

let wasmWarmupStarted = false

async function warmupWasmModules(): Promise<void> {
  const results = await Promise.allSettled([
    ensureFastQrWasmInit(),
    ensureWasmInit(),
    ensureRxingWasmInit(),
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
    void warmupWasmModules()
  }

  if (navigator.onLine) {
    runWarmup()
    return
  }

  window.addEventListener('online', runWarmup, { once: true })
}
