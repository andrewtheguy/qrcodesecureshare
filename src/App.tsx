import { useState, useRef } from 'react'
import Upload from './components/Upload'
import Scan from './components/Scan'
import OfflineTransferDemo from './components/OfflineTransferDemo'
import './App.css'
import './utils/generateKeys' // Load key generation utility

function App() {
  const [activeTab, setActiveTab] = useState("generateqr")
  const uploadRef = useRef<{ setTextFromScan: (text: string) => void }>(null)

  const handleGenerateQRFromScan = (text: string) => {
    // Switch to generate QR tab and set the text
    setActiveTab("generateqr")
    // Use a small delay to ensure the tab switch completes
    setTimeout(() => {
      uploadRef.current?.setTextFromScan(text)
    }, 100)
  }

  const tabs = [
    { value: "generateqr", label: "Generate QR Code", icon: "📝" },
    { value: "upload", label: "Upload File", icon: "📁" },
    { value: "scan", label: "Scan QR", icon: "📱" },
    { value: "offline", label: "Offline Transfer", icon: "🔄" },
  ]

  return (
    <div className="min-h-screen">
      {/* Navbar */}
      <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center h-16 gap-8">
            {/* Logo/Brand */}
            <div className="flex-shrink-0">
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">
                QR Secure Share
              </h1>
            </div>

            {/* Navigation Links */}
            <div className="flex space-x-1 sm:space-x-4">
              {tabs.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={`px-3 sm:px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeTab === tab.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <span className="flex items-center gap-1 sm:gap-2">
                    <span className="text-base sm:text-lg">{tab.icon}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-2 py-4">
        {activeTab === "generateqr" && <Upload ref={uploadRef} mode="text" />}
        {activeTab === "upload" && <Upload mode="file" />}
        {activeTab === "scan" && <Scan onGenerateQR={handleGenerateQRFromScan} />}
        {activeTab === "offline" && <OfflineTransferDemo />}
      </main>
    </div>
  )
}

export default App
