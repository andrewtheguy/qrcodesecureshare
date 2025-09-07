import { useState, useCallback, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { ENCRYPTED_FILE_MAGIC } from '../constants'

interface UploadResult {
  status: string
  data: {
    url: string
  }
}

interface UploadedFile {
  name: string
  originalUrl: string
  downloadUrl: string
  uploadTime: string
  passphrase: string
}

const Upload = () => {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('')
  const [mode, setMode] = useState<'file' | 'text'>('file')
  const [textInput, setTextInput] = useState('')
  const [textQrGenerated, setTextQrGenerated] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const convertUrl = (originalUrl: string): string => {
    return originalUrl.replace('http://tmpfiles.org/', 'https://tmpfiles.org/dl/')
  }

  const generatePassphrase = (): string => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*()_+-=[]{}|~'
    let passphrase = ''
    for (let i = 0; i < 32; i++) {
      passphrase += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return passphrase
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

  const encryptFile = async (file: File, passphrase: string): Promise<File> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer
          
          // Generate random salt and IV (nonce for GCM)
          const salt = crypto.getRandomValues(new Uint8Array(16))
          const iv = crypto.getRandomValues(new Uint8Array(12)) // GCM uses 12-byte IV
          
          // Derive key from passphrase
          const key = await deriveKey(passphrase, salt)
          
          // Encrypt the file data using AES-GCM
          const encryptedData = await crypto.subtle.encrypt(
            {
              name: 'AES-GCM',
              iv: iv
            },
            key,
            arrayBuffer
          )
          
          // Combine salt + iv + encrypted data (includes auth tag)
          const encryptedBytes = new Uint8Array(salt.length + iv.length + encryptedData.byteLength)
          encryptedBytes.set(salt, 0)
          encryptedBytes.set(iv, salt.length)
          encryptedBytes.set(new Uint8Array(encryptedData), salt.length + iv.length)
          
          const blob = new Blob([encryptedBytes], { type: 'application/octet-stream' })
          const encryptedFile = new File([blob], 'file.enc', { type: 'application/octet-stream' })
          resolve(encryptedFile)
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = reject
      reader.readAsArrayBuffer(file)
    })
  }

  const uploadFile = async (file: File) => {
    const passphrase = generatePassphrase()
    const encryptedFile = await encryptFile(file, passphrase)
    
    const formData = new FormData()
    formData.append('file', encryptedFile)

    try {
      const response = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const result: UploadResult = await response.json()
      
      if (result.status === 'success') {
        const downloadUrl = convertUrl(result.data.url)
        const fileData = {
          name: file.name,
          originalUrl: result.data.url,
          downloadUrl,
          uploadTime: new Date().toISOString(),
          passphrase
        }
        setUploadedFile(fileData)
        return fileData
      } else {
        throw new Error('Upload failed')
      }
    } catch (error) {
      console.error('Upload error:', error)
      throw error
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    
    const file = files[0]
    setUploading(true)
    
    try {
      await uploadFile(file)
    } catch (error) {
      alert('File failed to upload. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }, [])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files)
  }

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

  const generateQRCode = useCallback(async (payload: string) => {
    try {
      const canvas = canvasRef.current
      if (canvas) {
        await QRCode.toCanvas(canvas, payload, {
          width: 300,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
      }
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      })
      setQrCodeUrl(dataUrl)
    } catch (error) {
      console.error('QR Code generation failed:', error)
    }
  }, [])

  const generateTextQR = (text: string) => {
    if (text.trim()) {
      // Generate QR code for plain text (no magic header)
      generateQRCode(text.trim())
      setTextQrGenerated(true)
    } else {
      setTextQrGenerated(false)
      setQrCodeUrl('')
    }
  }

  const resetTextMode = () => {
    setTextInput('')
    setTextQrGenerated(false)
    setQrCodeUrl('')
  }

  const resetFileMode = () => {
    setUploadedFile(null)
    setQrCodeUrl('')
  }

  useEffect(() => {
    if (uploadedFile) {
      const qrData = {
        url: uploadedFile.downloadUrl,
        passphrase: uploadedFile.passphrase,
        filename: uploadedFile.name,
        //uploadedAt: uploadedFile.uploadTime
      }
      // Add magic header to indicate this is an encrypted file download QR
      const qrPayload = ENCRYPTED_FILE_MAGIC + JSON.stringify(qrData)
      generateQRCode(qrPayload)
    }
  }, [uploadedFile, generateQRCode])

  return (
    <div className="flex flex-col gap-8">
      <div className="flex justify-center gap-4 mb-4">
        <button 
          className={`px-5 py-3 rounded-full font-medium transition-all duration-300 border-2 flex items-center gap-2 ${
            mode === 'file' 
              ? 'gradient-primary text-white border-primary-500' 
              : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
          }`}
          onClick={() => {
            setMode('file')
            resetTextMode()
          }}
        >
          📁 Upload File
        </button>
        <button 
          className={`px-5 py-3 rounded-full font-medium transition-all duration-300 border-2 flex items-center gap-2 ${
            mode === 'text' 
              ? 'gradient-primary text-white border-primary-500' 
              : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
          }`}
          onClick={() => {
            setMode('text')
            resetFileMode()
          }}
        >
          📝 Text QR Code
        </button>
      </div>

      {mode === 'file' ? (
        <div
          className={`border-3 border-dashed rounded-xl p-12 text-center transition-all duration-300 cursor-pointer ${
            isDragging 
              ? 'border-primary-500 bg-primary-50 scale-105' 
              : uploading 
                ? 'border-primary-700 bg-purple-50 cursor-not-allowed'
                : 'border-gray-300 bg-gray-50 hover:border-gray-400'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-4">
              <div className="w-10 h-10 border-4 border-gray-300 border-t-primary-500 rounded-full spinner"></div>
              <p className="text-gray-600">Encrypting and uploading file...</p>
            </div>
          ) : (
            <>
              <div className="text-5xl mb-4">📁</div>
              <p className="mb-6 text-lg text-gray-600">Drag & drop a file here or</p>
              <label className="cursor-pointer">
                <input
                  type="file"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <span className="inline-block px-6 py-3 gradient-primary text-white rounded-lg font-medium transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
                  Choose File
                </span>
              </label>
            </>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl p-8 shadow-lg text-center">
          <div className="text-5xl mb-4">📝</div>
          <p className="mb-6 text-lg text-gray-600">Enter text to generate a QR code</p>
          <div className="flex flex-col items-center max-w-lg mx-auto">
            <textarea
              value={textInput}
              onChange={(e) => {
                setTextInput(e.target.value)
                generateTextQR(e.target.value)
              }}
              placeholder="Type your text here..."
              className="w-full p-3 border-2 border-gray-200 rounded-lg text-base resize-y min-h-[100px] transition-colors focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
              rows={4}
            />
          </div>
        </div>
      )}

      {uploadedFile && (
        <div className="uploaded-file">
          <h2>✅ File Uploaded Successfully</h2>
          <div className="file-card">
            <div className="file-header">
              <strong className="file-name">{uploadedFile.name}</strong>
              <small className="upload-time">{uploadedFile.uploadTime}</small>
            </div>
            
            <div className="passphrase-section">
              <div className="passphrase-label">🔐 Decryption Passphrase:</div>
              <div className="passphrase-container">
                <code className="passphrase">{uploadedFile.passphrase}</code>
                <button 
                  className="copy-btn"
                  onClick={() => copyToClipboard(uploadedFile.passphrase)}
                  title="Copy passphrase to clipboard"
                >
                  📋 Copy
                </button>
              </div>
              <small className="passphrase-note">
                Save this passphrase - you'll need it to decrypt the file!
              </small>
            </div>

            <div className="qr-section">
              <div className="qr-label">📱 QR Code:</div>
              <div className="qr-container">
                <canvas
                  ref={canvasRef}
                  className="qr-canvas"
                  style={{ display: 'none' }}
                />
                {qrCodeUrl && (
                  <img 
                    src={qrCodeUrl} 
                    alt="QR Code with file URL and passphrase"
                    className="qr-image"
                  />
                )}
                <p className="qr-description">
                  Scan with your phone to get the download URL and passphrase
                </p>
              </div>
            </div>
            
            <div className="actions">
              <a
                href={uploadedFile.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="download-link"
              >
                📥 Download Encrypted File
              </a>
              <button 
                className="new-upload-btn"
                onClick={() => setUploadedFile(null)}
              >
                Upload Another File
              </button>
            </div>
          </div>
        </div>
      )}

      {textQrGenerated && qrCodeUrl && (
        <div className="bg-white rounded-xl shadow-lg">
          <div className="bg-gray-50 rounded-lg border-l-4 border-green-500">
            <div className="flex flex-col items-center gap-2">
              <canvas
                ref={canvasRef}
                style={{ display: 'none' }}
              />
              <img 
                src={qrCodeUrl} 
                alt="QR Code with text content"
                className="rounded-lg shadow-md"
              />
              <p className="text-gray-600 text-sm text-center">
                Scan with your phone to read the text
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Upload