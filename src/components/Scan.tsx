import { useState, useRef, useEffect } from 'react'
import QrScanner from 'qr-scanner'

interface ScannedData {
  url: string
  passphrase: string
  filename: string
  uploadedAt?: string
}

const Scan = () => {
  const [scannedData, setScannedData] = useState<ScannedData | null>(null)
  const [scanning, setScanning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      const textArea = document.createElement('textarea')
      textArea.value = text
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
    }
  }

  const startScanning = async () => {
    try {
      setScanning(true)
      console.log('Starting QR scanner...')
      
      // Set worker path - file is copied by Vite plugin during build
      QrScanner.WORKER_PATH = '/qr-scanner-worker.min.js'
      
      // Wait for the next render cycle to ensure video element exists
      await new Promise(resolve => setTimeout(resolve, 100))
      
      if (!videoRef.current) {
        throw new Error('Video element not available')
      }
      
      const scanner = new QrScanner(
        videoRef.current,
        (result) => {
          console.log('QR code detected:', result)
          try {
            const data = JSON.parse(result.data)
            console.log('Parsed JSON:', data)
            setScannedData(data)
            stopScanning()
          } catch (error) {
            console.error('Invalid JSON in QR code:', error)
            alert('QR code does not contain valid JSON data')
          }
        },
        {
          returnDetailedScanResult: true,
          highlightScanRegion: true,
          highlightCodeOutline: true,
        }
      )
      scannerRef.current = scanner
      await scanner.start()
      console.log('QR scanner started successfully')
    } catch (error) {
      console.error('Failed to start QR scanner:', error)
      alert(`Failed to access camera: ${error.message}. Please ensure camera permissions are granted.`)
      setScanning(false)
    }
  }

  const stopScanning = () => {
    if (scannerRef.current) {
      scannerRef.current.stop()
      scannerRef.current.destroy()
      scannerRef.current = null
    }
    setScanning(false)
  }

  useEffect(() => {
    return () => {
      stopScanning()
    }
  }, [])

  return (
    <div className="scan-section">
      <div className="scanner-container">
        {!scanning && !scannedData && (
          <div className="scanner-intro">
            <div className="scanner-icon">📷</div>
            <h2>Scan QR Code</h2>
            <p>Scan a QR code from a previously uploaded file to retrieve the download URL and passphrase</p>
            <button className="start-scan-btn" onClick={startScanning}>
              Start Camera
            </button>
          </div>
        )}
        
        {scanning && (
          <div className="scanner-active">
            <video
              ref={videoRef}
              className="scanner-video"
              playsInline
              muted
            />
            <button className="stop-scan-btn" onClick={stopScanning}>
              Stop Scanning
            </button>
          </div>
        )}
        
        {scannedData && (
          <div className="scanned-result">
            <h2>✅ QR Code Scanned</h2>
            <div className="scanned-file-card">
              <div className="file-header">
                <strong className="file-name">{scannedData.filename}</strong>
              </div>
              
              <div className="passphrase-section">
                <div className="passphrase-label">🔐 Decryption Passphrase:</div>
                <div className="passphrase-container">
                  <code className="passphrase">{scannedData.passphrase}</code>
                  <button 
                    className="copy-btn"
                    onClick={() => copyToClipboard(scannedData.passphrase)}
                    title="Copy passphrase to clipboard"
                  >
                    📋 Copy
                  </button>
                </div>
              </div>
              
              <div className="actions">
                <a
                  href={scannedData.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="download-link"
                >
                  📥 Download Encrypted File
                </a>
                <button 
                  className="new-scan-btn"
                  onClick={() => setScannedData(null)}
                >
                  Scan Another QR
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Scan