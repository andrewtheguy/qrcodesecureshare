import { useState, useRef } from 'react'
import Upload from './components/Upload'
import Scan from './components/Scan'
import OfflineTransferDemo from './components/OfflineTransferDemo'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import './App.css'
import './utils/generateKeys' // Load key generation utility

function App() {
  const [activeTab, setActiveTab] = useState("upload")
  const uploadRef = useRef<{ setTextFromScan: (text: string) => void }>(null)

  const handleGenerateQRFromScan = (text: string) => {
    // Switch to upload tab and set the text
    setActiveTab("upload")
    // Use a small delay to ensure the tab switch completes
    setTimeout(() => {
      uploadRef.current?.setTextFromScan(text)
    }, 100)
  }

  const tabs = [
    { value: "upload", label: "Generate QR", icon: "📤" },
    { value: "scan", label: "Scan QR", icon: "📱" },
    { value: "offline", label: "Offline Transfer", icon: "🔄" },
  ]

  return (
    <div className="max-w-4xl mx-auto min-h-screen px-2 sm:px-4">
      <header className="text-center mb-3 sm:mb-4 pt-1 sm:pt-2">
        <h1 className="text-base sm:text-3xl md:text-4xl font-bold mb-1 sm:mb-4 bg-gradient-to-r from-primary to-secondary bg-clip-text">
          <span>QR Secure Share</span>
        </h1>
      </header>

      <main>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          {/* Mobile: Dropdown Select (only if more than 3 tabs) */}
          {tabs.length > 3 && (
            <div className="sm:hidden mb-4">
              <Select value={activeTab} onValueChange={setActiveTab}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {tabs.find(t => t.value === activeTab)?.icon} {tabs.find(t => t.value === activeTab)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tabs.map((tab) => (
                    <SelectItem key={tab.value} value={tab.value}>
                      {tab.icon} {tab.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Horizontal Tabs (desktop always, mobile only if 3 or fewer tabs) */}
          <TabsList className={`${tabs.length > 3 ? 'hidden sm:grid' : 'grid'} w-full grid-cols-${tabs.length} mb-4`}>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="flex items-center gap-1 md:gap-2">
                <span className="hidden md:inline">{tab.icon}</span> {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="upload" className="">
            <Upload ref={uploadRef} />
          </TabsContent>
          <TabsContent value="scan" className="">
            <Scan onGenerateQR={handleGenerateQRFromScan} />
          </TabsContent>
          <TabsContent value="offline" className="">
            <OfflineTransferDemo />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

export default App
