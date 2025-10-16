// QR Generation Worker
// Offloads expensive QRCode.toDataURL calls from main thread

import QRCode from 'qrcode'

// Listen for messages from main thread
self.onmessage = async (e: MessageEvent) => {
  const { type, id, binaryString, options } = e.data

  if (type === 'generate') {
    try {
      const svgString = await new Promise<string>((resolve, reject) => {
        QRCode.toString(binaryString, { ...options, type: 'svg' }, (err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
      const qrUrl = 'data:image/svg+xml;base64,' + btoa(svgString)
      self.postMessage({ type: 'success', id, qrUrl })
    } catch (error) {
      self.postMessage({ type: 'error', id, error: (error as Error).message })
    }
  }
}