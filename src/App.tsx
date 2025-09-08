import { useState, useRef } from 'react'
import Upload from './components/Upload'
import Scan from './components/Scan'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import './App.css'

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

  return (
    <div className="max-w-4xl mx-auto min-h-screen">
      <header className="text-center mb-4">
        <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-primary to-secondary bg-clip-text">
          QR Code Secure Data Share
        </h1>
      </header>

      <main>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="upload" className="flex items-center gap-2">
              📤 Generate QR
            </TabsTrigger>
            <TabsTrigger value="scan" className="flex items-center gap-2">
              📱 Scan QR
            </TabsTrigger>
          </TabsList>
          <TabsContent value="upload" className="">
            <Upload ref={uploadRef} />
          </TabsContent>
          <TabsContent value="scan" className="">
            <Scan onGenerateQR={handleGenerateQRFromScan} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

export default App
