// QR Generation Worker
// Offloads expensive QRCode.toDataURL calls from main thread

import QRCode from 'qrcode'

// Listen for messages from main thread
self.onmessage = async (e: MessageEvent) => {
  const { type, id, binaryString, options } = e.data

  if (type === 'generate') {
    try {
      const qrUrl = await QRCode.toDataURL(binaryString, options)
      self.postMessage({ type: 'success', id, qrUrl })
    } catch (error) {
      self.postMessage({ type: 'error', id, error: (error as Error).message })
    }
  }
}