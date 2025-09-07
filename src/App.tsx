import { useState } from 'react'
import Upload from './components/Upload'
import Scan from './components/Scan'
import './App.css'

function App() {
  const [activeTab, setActiveTab] = useState<'upload' | 'scan'>('upload')

  return (
    <div className="app">
      <header className="app-header">
        <h1>Encrypted File Upload</h1>
        <p>Upload files with AES encryption or scan QR codes to retrieve file info</p>
        
        <div className="tabs">
          <button 
            className={`tab ${activeTab === 'upload' ? 'active' : ''}`}
            onClick={() => setActiveTab('upload')}
          >
            📤 Generate QR
          </button>
          <button 
            className={`tab ${activeTab === 'scan' ? 'active' : ''}`}
            onClick={() => setActiveTab('scan')}
          >
            📱 Scan QR
          </button>
        </div>
      </header>

      <main className="main-section">
        {activeTab === 'upload' ? <Upload /> : <Scan />}
      </main>
    </div>
  )
}

export default App
