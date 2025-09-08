import Upload from './components/Upload'
import Scan from './components/Scan'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import './App.css'

function App() {
  return (
    <div className="max-w-4xl mx-auto px-8 py-8 min-h-screen">
      <header className="text-center mb-12">
        <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-primary to-secondary bg-clip-text">
          Secure Data Share
        </h1>
        <p className="text-muted-foreground text-lg">
          Share data securely with QR code with encrypted file upload for large data.
        </p>
      </header>

      <main>
        <Tabs defaultValue="upload" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="upload" className="flex items-center gap-2">
              📤 Generate QR
            </TabsTrigger>
            <TabsTrigger value="scan" className="flex items-center gap-2">
              📱 Scan QR
            </TabsTrigger>
          </TabsList>
          <TabsContent value="upload" className="mt-8">
            <Upload />
          </TabsContent>
          <TabsContent value="scan" className="mt-8">
            <Scan />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

export default App
