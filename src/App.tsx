import { useState, useCallback } from 'react'
import './App.css'

interface UploadResult {
  status: string
  data: {
    url: string
  }
}

function App() {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<Array<{
    name: string
    originalUrl: string
    downloadUrl: string
    uploadTime: string
  }>>([])
  const [uploading, setUploading] = useState(false)

  const convertUrl = (originalUrl: string): string => {
    return originalUrl.replace('http://tmpfiles.org/', 'https://tmpfiles.org/dl/')
  }

  const uploadFile = async (file: File) => {
    const formData = new FormData()
    formData.append('file', file)

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
          uploadTime: new Date().toLocaleString()
        }
        setUploadedFiles(prev => [...prev, fileData])
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

    setUploading(true)
    
    try {
      const uploadPromises = Array.from(files).map(file => uploadFile(file))
      await Promise.all(uploadPromises)
    } catch (error) {
      alert('Some files failed to upload. Please try again.')
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>File Upload PWA</h1>
        <p>Upload files to tmpfiles.org with instant download links</p>
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
              <p>Uploading files...</p>
            </div>
          ) : (
            <>
              <div className="upload-icon">📁</div>
              <p>Drag & drop files here or</p>
              <label className="file-input-label">
                <input
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  className="file-input"
                />
                <span className="file-input-button">Choose Files</span>
              </label>
            </>
          )}
        </div>

        {uploadedFiles.length > 0 && (
          <div className="uploaded-files">
            <h2>Uploaded Files</h2>
            <div className="files-list">
              {uploadedFiles.map((file, index) => (
                <div key={index} className="file-item">
                  <div className="file-info">
                    <strong>{file.name}</strong>
                    <small>{file.uploadTime}</small>
                  </div>
                  <a
                    href={file.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="download-link"
                  >
                    Download
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
