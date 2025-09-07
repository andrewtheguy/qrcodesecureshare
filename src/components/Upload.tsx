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
          width: 200,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
      }
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 200,
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
    <div className="upload-section">
      <div className="mode-selector">
        <button 
          className={`mode-btn ${mode === 'file' ? 'active' : ''}`}
          onClick={() => {
            setMode('file')
            resetTextMode()
          }}
        >
          📁 Upload File
        </button>
        <button 
          className={`mode-btn ${mode === 'text' ? 'active' : ''}`}
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
          className={`drop-zone ${isDragging ? 'dragging' : ''} ${uploading ? 'uploading' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {uploading ? (
            <div className="upload-status">
              <div className="spinner"></div>
              <p>Encrypting and uploading file...</p>
            </div>
          ) : (
            <>
              <div className="upload-icon">📁</div>
              <p>Drag & drop a file here or</p>
              <label className="file-input-label">
                <input
                  type="file"
                  onChange={handleFileSelect}
                  className="file-input"
                />
                <span className="file-input-button">Choose File</span>
              </label>
            </>
          )}
        </div>
      ) : (
        <div className="text-input-zone">
          <div className="text-input-icon">📝</div>
          <p>Enter text to generate a QR code</p>
          <div className="text-input-container">
            <textarea
              value={textInput}
              onChange={(e) => {
                setTextInput(e.target.value)
                generateTextQR(e.target.value)
              }}
              placeholder="Type your text here..."
              className="text-input"
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
        <div className="text-qr-result">
          <div className="qr-card">
            <div className="qr-section">
              <div className="qr-container">
                <canvas
                  ref={canvasRef}
                  className="qr-canvas"
                  style={{ display: 'none' }}
                />
                <img 
                  src={qrCodeUrl} 
                  alt="QR Code with text content"
                  className="qr-image"
                />
                <p className="qr-description">
                  Scan with your phone to read the text
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Upload