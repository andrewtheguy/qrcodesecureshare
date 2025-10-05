import { useState, useRef } from 'react'
import Upload from './components/Upload'
import Scan from './components/Scan'
import OfflineTransferDemo from './components/OfflineTransferDemo'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import './App.css'
import './utils/generateKeys' // Load key generation utility

function App() {
  const [activeTab, setActiveTab] = useState("generateqr")
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
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
    { value: "generateqr", label: "Generate QR Code", icon: "🔲" },
    { value: "upload", label: "Upload File", icon: "📤" },
    { value: "scan", label: "Scan QR", icon: "📸" },
    { value: "offline", label: "Offline Transfer", icon: "🔄" },
  ]

  const activeTabInfo = tabs.find(tab => tab.value === activeTab)

  return (
    <div className="min-h-screen">
      {/* Navbar */}
      <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo/Brand - Hidden on mobile */}
            <div className="items-center gap-3">
              <span className="text-2xl">🔐</span>
              <h1 className="hidden md:flex text-lg sm:text-xl font-bold text-foreground">
                QR Secure Share
              </h1>
            </div>

            {/* Mobile: Current Selection */}
            <div className="flex items-center gap-2 md:hidden">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground">
                  <span className="text-lg">{activeTabInfo?.icon}</span>
                  <span className="text-sm font-semibold">{activeTabInfo?.label}</span>
                </div>
              </div>
            </div>

            {/* Mobile: Hamburger Menu */}
            <div className="md:hidden">
              <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-72">
                  <div className="flex flex-col gap-2 mt-8">
                    {tabs.map((tab) => (
                      <button
                        key={tab.value}
                        onClick={() => {
                          setActiveTab(tab.value)
                          setMobileMenuOpen(false)
                        }}
                        className={`px-4 py-3 rounded-md text-left font-medium transition-colors ${
                          activeTab === tab.value
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        }`}
                      >
                        <span className="flex items-center gap-3">
                          <span className="text-xl">{tab.icon}</span>
                          <span>{tab.label}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </SheetContent>
              </Sheet>
            </div>

            {/* Desktop Navigation Links */}
            <div className="hidden md:flex space-x-1">
              {tabs.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeTab === tab.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-lg">{tab.icon}</span>
                    <span>{tab.label}</span>
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
