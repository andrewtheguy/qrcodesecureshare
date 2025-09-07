import { useState, useRef, useEffect } from 'react'
import QrScanner from 'qr-scanner'
import { ENCRYPTED_FILE_MAGIC } from '../constants'

interface EncryptedFileData {
  url: string
  passphrase: string
  filename: string
  uploadedAt?: string
}

const Scan = () => {
  const [scannedData, setScannedData] = useState<EncryptedFileData | null>(null)
  const [scannedText, setScannedText] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [decrypting, setDecrypting] = useState(false)
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

  const deriveKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
    const encoder = new TextEncoder()
    const passphraseKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    )

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passphraseKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  const decryptFile = async (encryptedData: ArrayBuffer, passphrase: string): Promise<{ data: ArrayBuffer, filename: string }> => {
    try {
      const encryptedBytes = new Uint8Array(encryptedData)
      
      // Extract salt, IV, and encrypted data
      const salt = encryptedBytes.slice(0, 16)
      const iv = encryptedBytes.slice(16, 28) // 12 bytes for GCM
      const encrypted = encryptedBytes.slice(28)
      
      // Derive key from passphrase
      const key = await deriveKey(passphrase, salt)
      
      // Decrypt the data using AES-GCM
      const decryptedData = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv
        },
        key,
        encrypted
      )
      
      return {
        data: decryptedData,
        filename: scannedData?.filename || 'decrypted-file'
      }
    } catch (error) {
      console.error('Decryption failed:', error)
      throw new Error('Failed to decrypt file. Please check the passphrase.')
    }
  }

  const downloadDecryptedFile = async () => {
    if (!scannedData) return
    
    try {
      setDecrypting(true)
      
      // Use CORS proxy to fetch the encrypted file
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(scannedData.url)}`
      const response = await fetch(proxyUrl)
      
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`)
      }
      
      const encryptedData = await response.arrayBuffer()
      
      // Decrypt the file
      const { data, filename } = await decryptFile(encryptedData, scannedData.passphrase)
      
      // Create blob and download decrypted file
      const blob = new Blob([data])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      
    } catch (error) {
      console.error('Download and decrypt failed:', error)
      alert(error instanceof Error ? error.message : 'Failed to decrypt and download file')
    } finally {
      setDecrypting(false)
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
          
          // Check if QR code contains encrypted file data
          if (result.data.startsWith(ENCRYPTED_FILE_MAGIC)) {
            try {
              const jsonData = result.data.substring(ENCRYPTED_FILE_MAGIC.length)
              const data = JSON.parse(jsonData) as EncryptedFileData
              console.log('Parsed encrypted file data:', data)
              setScannedData(data)
              setScannedText(null)
              stopScanning()
            } catch (error) {
              console.error('Invalid encrypted file data in QR code:', error)
              alert('QR code contains invalid encrypted file data')
            }
          } else {
            // Regular text QR code
            console.log('Regular text QR code:', result.data)
            setScannedText(result.data)
            setScannedData(null)
            stopScanning()
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
    <div className="flex flex-col gap-8">
      <div className="bg-white rounded-xl p-8 shadow-lg text-center">
        {!scanning && !scannedData && (
          <div className="flex flex-col items-center gap-4">
            <div className="text-6xl mb-4">📷</div>
            <h2 className="text-2xl font-bold text-gray-800">Scan QR Code</h2>
            <p className="text-gray-600 max-w-md mb-6">
              Scan a QR code from a previously uploaded file to retrieve the download URL and passphrase
            </p>
            <button 
              className="px-6 py-3 gradient-primary text-white rounded-lg font-medium transition-all duration-200 hover:-translate-y-0.5"
              onClick={startScanning}
            >
              Start Camera
            </button>
          </div>
        )}
        
        {scanning && (
          <div className="flex flex-col items-center gap-4">
            <video
              ref={videoRef}
              className="w-full max-w-md rounded-lg bg-black"
              playsInline
              muted
            />
            <button 
              className="px-6 py-3 gradient-primary text-white rounded-lg font-medium transition-all duration-200 hover:-translate-y-0.5"
              onClick={stopScanning}
            >
              Stop Scanning
            </button>
          </div>
        )}
        
        {scannedData && (
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-6 text-green-600">✅ Encrypted File QR Code Scanned</h2>
            <div className="bg-gray-50 rounded-lg p-6 border-l-4 border-green-500">
              <div className="mb-4">
                <strong className="text-xl text-gray-800">{scannedData.filename}</strong>
              </div>
              
              <div className="my-6">
                <div className="block text-base text-gray-800 mb-3 font-medium">🔐 Decryption Passphrase:</div>
                <div className="flex items-center justify-center gap-3 mb-2 flex-wrap">
                  <code className="bg-gray-800 text-gray-200 px-4 py-3 rounded-md font-mono text-sm break-all">
                    {scannedData.passphrase}
                  </code>
                  <button 
                    className="px-4 py-3 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors text-sm font-medium"
                    onClick={() => copyToClipboard(scannedData.passphrase)}
                    title="Copy passphrase to clipboard"
                  >
                    📋 Copy
                  </button>
                </div>
              </div>
              
              <div className="flex gap-4 justify-center flex-wrap">
                <button
                  onClick={downloadDecryptedFile}
                  disabled={decrypting}
                  className={`px-6 py-3 rounded-md font-medium text-base transition-all duration-200 ${
                    decrypting 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-green-600 hover:bg-green-700 hover:-translate-y-0.5'
                  } text-white flex items-center gap-2`}
                >
                  {decrypting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full spinner"></div>
                      Decrypting...
                    </>
                  ) : (
                    '📥 Download Original File'
                  )}
                </button>
                <button 
                  className={`px-6 py-3 rounded-md font-medium transition-colors ${
                    decrypting 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-primary-500 hover:bg-primary-600'
                  } text-white`}
                  onClick={() => {
                    setScannedData(null)
                    setScannedText(null)
                  }}
                  disabled={decrypting}
                >
                  Scan Another QR
                </button>
              </div>
            </div>
          </div>
        )}

        {scannedText && (
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-6 text-green-600">✅ QR Code Scanned</h2>
            <div className="bg-gray-50 rounded-lg p-6 border-l-4 border-green-500">
              <div className="flex items-center gap-2 mb-4 justify-center">
                <span className="text-2xl">📄</span>
                <strong className="text-lg">Text Content</strong>
              </div>
              
              <div className="flex flex-col gap-4 items-center">
                <pre className="bg-gray-800 text-gray-200 p-4 rounded-md font-mono text-sm whitespace-pre-wrap break-words max-w-full max-h-[300px] overflow-y-auto m-0 text-left">
                  {scannedText}
                </pre>
                <button 
                  className="px-4 py-3 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors text-sm font-medium"
                  onClick={() => copyToClipboard(scannedText)}
                  title="Copy text to clipboard"
                >
                  📋 Copy Text
                </button>
              </div>
              
              <div className="mt-6">
                <button 
                  className="px-6 py-3 bg-primary-500 text-white rounded-md font-medium hover:bg-primary-600 transition-colors"
                  onClick={() => {
                    setScannedData(null)
                    setScannedText(null)
                  }}
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