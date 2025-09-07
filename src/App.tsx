import { useState } from 'react'
import Upload from './components/Upload'
import Scan from './components/Scan'
import './App.css'

function App() {
  const [activeTab, setActiveTab] = useState<'upload' | 'scan'>('upload')

  return (
    <div className="max-w-4xl mx-auto px-8 py-8 min-h-screen">
      <header className="text-center mb-12">
        <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-primary-500 to-primary-700 bg-clip-text text-transparent">
          Encrypted File Upload
        </h1>
        <p className="text-gray-600 text-lg">
          Upload files with AES encryption or scan QR codes to retrieve file info
        </p>
        
        <div className="flex justify-center gap-4 mt-8">
          <button 
            className={`px-6 py-3 rounded-full font-medium transition-all duration-300 border-2 ${
              activeTab === 'upload' 
                ? 'gradient-primary text-white border-primary-500' 
                : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
            }`}
            onClick={() => setActiveTab('upload')}
          >
            📤 Generate QR
          </button>
          <button 
            className={`px-6 py-3 rounded-full font-medium transition-all duration-300 border-2 ${
              activeTab === 'scan' 
                ? 'gradient-primary text-white border-primary-500' 
                : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
            }`}
            onClick={() => setActiveTab('scan')}
          >
            📱 Scan QR
          </button>
        </div>
      </header>

      <main className="mt-8">
        {activeTab === 'upload' ? <Upload /> : <Scan />}
      </main>
    </div>
  )
}

export default App
