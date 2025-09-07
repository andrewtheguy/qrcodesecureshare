import { useState, useCallback } from 'react'
import CryptoJS from 'crypto-js'
import './App.css'

interface UploadResult {
  status: string
  data: {
    url: string
  }
}

function App() {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<{
    name: string
    originalUrl: string
    downloadUrl: string
    uploadTime: string
    passphrase: string
  } | null>(null)
  const [uploading, setUploading] = useState(false)

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

  const encryptFile = async (file: File, passphrase: string): Promise<File> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer
          const wordArray = CryptoJS.lib.WordArray.create(arrayBuffer)
          const encrypted = CryptoJS.AES.encrypt(wordArray, passphrase)
          
          // Convert to binary data (Uint8Array) instead of base64 string
          const encryptedBytes = new Uint8Array(encrypted.ciphertext.words.length * 4)
          for (let i = 0; i < encrypted.ciphertext.words.length; i++) {
            const word = encrypted.ciphertext.words[i]
            encryptedBytes[i * 4] = (word >>> 24) & 0xff
            encryptedBytes[i * 4 + 1] = (word >>> 16) & 0xff
            encryptedBytes[i * 4 + 2] = (word >>> 8) & 0xff
            encryptedBytes[i * 4 + 3] = word & 0xff
          }
          
          const blob = new Blob([encryptedBytes], { type: 'application/octet-stream' })
          const encryptedFile = new File([blob], `${file.name}.enc`, { type: 'application/octet-stream' })
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
          uploadTime: new Date().toLocaleString(),
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>Encrypted File Upload</h1>
        <p>Upload one file at a time with AES encryption to tmpfiles.org</p>
      </header>

      <main className="upload-section">
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

              <div className="json-section">
                <div className="json-label">📄 JSON Output:</div>
                <div className="json-container">
                  <pre className="json-output">{JSON.stringify({
                    status: "success",
                    data: {
                      url: uploadedFile.downloadUrl,
                      passphrase: uploadedFile.passphrase,
                      filename: uploadedFile.name,
                      uploadedAt: uploadedFile.uploadTime
                    }
                  }, null, 2)}</pre>
                  <button 
                    className="copy-btn"
                    onClick={() => copyToClipboard(JSON.stringify({
                      status: "success",
                      data: {
                        url: uploadedFile.downloadUrl,
                        passphrase: uploadedFile.passphrase,
                        filename: uploadedFile.name,
                        uploadedAt: uploadedFile.uploadTime
                      }
                    }, null, 2))}
                    title="Copy JSON to clipboard"
                  >
                    📋 Copy JSON
                  </button>
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
      </main>
    </div>
  )
}

export default App
