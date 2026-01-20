import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { OfflineQRMode } from './OfflineQRMode'
import { OfflineQRReceiver } from './OfflineQRReceiver'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { ScanLine, ArrowLeft, Info, FileUp, Smartphone, Globe, TriangleAlert, Shield, ExternalLink } from 'lucide-react'

import { MAX_FILE_SIZE_FOUNTAIN_FEEDBACK } from './OfflineQRMode'

interface OfflineQRTransferProps {
  defaultMode?: 'select' | 'send' | 'receive'
  onModeChange?: (mode: 'select' | 'send' | 'receive') => void
}

let cachedSelectedFile: File | null = null

export default function OfflineQRTransfer({ defaultMode = 'select', onModeChange }: OfflineQRTransferProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [selectedFile, setSelectedFile] = useState<File | null>(cachedSelectedFile)
  const [mode, setMode] = useState<'select' | 'send' | 'receive'>(defaultMode)

  // Sync mode with route changes
  useEffect(() => {
    if (location.pathname === '/offline/send') {
      setMode('send')
    } else if (location.pathname === '/offline/receive') {
      setMode('receive')
    } else if (location.pathname === '/transfer' || location.pathname === '/transfer/') {
      setMode('select')
    }
  }, [location.pathname])

  // Notify parent of mode changes
  useEffect(() => {
    onModeChange?.(mode)
  }, [mode, onModeChange])

  // Redirect to /transfer if on /send route but no file is selected
  useEffect(() => {
    if (location.pathname === '/offline/send' && !selectedFile) {
      navigate('/transfer', { replace: true })
    }
  }, [location.pathname, selectedFile, navigate])
  
  const [backDialogOpen, setBackDialogOpen] = useState(false)
  const [onlineConfirmOpen, setOnlineConfirmOpen] = useState(false)
  const [pendingBackContext, setPendingBackContext] = useState<'send' | 'receive' | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > MAX_FILE_SIZE_FOUNTAIN_FEEDBACK) {
        alert(`File size must be under ${MAX_FILE_SIZE_FOUNTAIN_FEEDBACK / 1024 / 1024}MB. Selected file is ${(file.size / 1024).toFixed(2)}KB.`)
        return
      }
      setSelectedFile(file)
      cachedSelectedFile = file
      navigate('/offline/send')
    }
  }

  const handleReset = () => {
    setSelectedFile(null)
    cachedSelectedFile = null
    navigate('/transfer')
    // Reset file input value so selecting the same file again works
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const requestBackNavigation = (context: 'send' | 'receive') => {
    setPendingBackContext(context)
    setBackDialogOpen(true)
  }

  const handleConfirmBackNavigation = () => {
    setBackDialogOpen(false)
    handleReset()
  }

  const handleCancelBackNavigation = () => {
    setBackDialogOpen(false)
    setPendingBackContext(null)
  }

  const backDialogCopy = {
    send: {
      title: 'Leave Sender?',
      description: 'Leaving this screen will stop the current transfer and clear the selected file.',
      confirmLabel: 'Yes, Leave Sender'
    },
    receive: {
      title: 'Leave Receiver?',
      description: 'Leaving will stop the receiver and clear the current scan progress.',
      confirmLabel: 'Yes, Leave Receiver'
    }
  } as const

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header - Only show in select mode for cleaner look during transfer */}
      {mode === 'select' && (
        <header className="text-center space-y-2 mb-8">
          <h2 className="text-3xl font-bold tracking-tight">File Transfer</h2>
          <p className="text-muted-foreground text-lg">
            Choose your preferred transfer method
          </p>
        </header>
      )}

      {/* Mode Selection */}
      {mode === 'select' && (
        <div className="space-y-8">
          <div className="grid md:grid-cols-3 gap-6">
            {/* Send Card */}
            <Card 
              className="relative overflow-hidden group cursor-pointer hover:border-primary/50 hover:shadow-lg transition-all duration-300"
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <CardContent className="p-6 flex flex-col items-center text-center space-y-4 h-full">
                <div className="p-4 rounded-full bg-primary/10 text-primary group-hover:scale-110 transition-transform duration-300">
                  <FileUp className="w-8 h-8" />
                </div>
                <div className="space-y-2 flex-1">
                  <h3 className="text-xl font-bold">Offline Send</h3>
                  <p className="text-sm text-muted-foreground">
                    Convert file to QR stream for receiver to scan
                  </p>
                </div>
                <div className="w-full pt-2">
                  <input
                    type="file"
                    onChange={handleFileSelect}
                    className="hidden"
                    id="offline-file-input"
                    accept="*/*"
                    ref={fileInputRef}
                    onClick={(e) => e.stopPropagation()} 
                  />
                  <Button
                    onClick={(e) => {
                      e.stopPropagation()
                      fileInputRef.current?.click()
                    }}
                    className="w-full"
                    variant="outline"
                  >
                    Select File
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Receive Card */}
            <NavLink to="/scan/camera" className="block h-full">
              <Card className="relative overflow-hidden group cursor-pointer hover:border-primary/50 hover:shadow-lg transition-all duration-300 h-full">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                <CardContent className="p-6 flex flex-col items-center text-center space-y-4 h-full">
                  <div className="p-4 rounded-full bg-primary/10 text-primary group-hover:scale-110 transition-transform duration-300">
                    <Smartphone className="w-8 h-8" />
                  </div>
                  <div className="space-y-2 flex-1">
                    <h3 className="text-xl font-bold">Offline Receive</h3>
                    <p className="text-sm text-muted-foreground">
                      Scan QR stream to receive and save file
                    </p>
                  </div>
                  <div className="w-full pt-2">
                    <Button className="w-full" variant="outline">
                      <ScanLine className="mr-2 h-4 w-4" />
                      Scan
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </NavLink>

            {/* Online Transfer Card */}
            <Card 
              className="relative overflow-hidden group cursor-pointer hover:border-primary/50 hover:shadow-lg transition-all duration-300 h-full"
              onClick={() => setOnlineConfirmOpen(true)}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <CardContent className="p-6 flex flex-col items-center text-center space-y-4 h-full">
                <div className="p-4 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform duration-300">
                  <Globe className="w-8 h-8" />
                </div>
                <div className="space-y-2 flex-1">
                  <div className="flex items-center justify-center gap-2">
                    <h3 className="text-xl font-bold">Online Send</h3>
                    <span className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-[10px] font-bold px-2 py-0.5 rounded-full">FAST</span>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">
                      Up to 100MB via WebRTC/Nostr
                    </p>
                    <div className="flex items-center justify-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                      <Shield className="w-3 h-3" />
                      <span>AES-256 End-to-End Encrypted</span>
                    </div>
                  </div>
                </div>
                <div className="w-full pt-2">
                  <Button className="w-full" variant="outline">
                    Open Secure Send
                    <ExternalLink className="ml-2 w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-col items-center space-y-4">
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 font-medium bg-amber-50 dark:bg-amber-950/30 px-4 py-2 rounded-full border border-amber-200 dark:border-amber-900">
              <Info className="w-4 h-4" />
              <span>Offline transfer is optimized for files up to {MAX_FILE_SIZE_FOUNTAIN_FEEDBACK / 1024 / 1024}MB</span>
            </div>

            <Accordion type="single" collapsible className="w-full max-w-3xl">
              <AccordionItem value="how-it-works" className="border-none">
                <AccordionTrigger className="justify-center text-muted-foreground hover:text-foreground hover:no-underline py-2">
                   How does Offline Transfer work?
                </AccordionTrigger>
                <AccordionContent>
                  <Card className="bg-muted/50 border-none shadow-none mt-4">
                    <CardContent className="p-6 space-y-6">
                      <div className="grid sm:grid-cols-2 gap-6">
                        <div className="space-y-3">
                          <h3 className="font-semibold flex items-center gap-2">
                            <span className="bg-primary/10 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span>
                            Fountain Data Stream
                          </h3>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            Files are split into small chunks using Fountain codes. This acts like a "data fountain" where the sender broadcasts a continuous stream of QR frames.
                          </p>
                        </div>
                        <div className="space-y-3">
                          <h3 className="font-semibold flex items-center gap-2">
                            <span className="bg-primary/10 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span>
                            Feedback System
                          </h3>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            The receiver shows feedback QR codes back to the sender to signal which parts are missing, making the transfer significantly faster and more reliable.
                          </p>
                        </div>
                        <div className="space-y-3">
                          <h3 className="font-semibold flex items-center gap-2">
                            <span className="bg-primary/10 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">3</span>
                            Air-Gapped Security
                          </h3>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            All processing is local. No data ever leaves your device via the internet, making it ideal for highly sensitive data or air-gapped environments.
                          </p>
                        </div>
                        <div className="space-y-3">
                          <h3 className="font-semibold flex items-center gap-2">
                            <span className="bg-primary/10 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">4</span>
                            Device Agnostic
                          </h3>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            No Wi-Fi, Bluetooth, or local network pairing required. Works between any devices with a screen and camera regardless of OS.
                          </p>
                        </div>
                        <div className="space-y-3 sm:col-span-2 border-t pt-4">
                          <h3 className="font-semibold flex items-center gap-2 text-amber-600 dark:text-amber-400">
                            <TriangleAlert className="w-4 h-4" />
                            Limitations & Requirements
                          </h3>
                          <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-2 text-sm text-muted-foreground">
                            <li className="flex items-start gap-2">
                              <span className="text-primary font-bold">•</span>
                              <span><strong>File Size:</strong> Optimized for small files (up to 5MB). Larger files take significantly longer due to QR density limits.</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="text-primary font-bold">•</span>
                              <span><strong>Speed Factors:</strong> Transfer speed depends on screen brightness, camera focus, and device processing power (typically 5-20 KB/s).</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="text-primary font-bold">•</span>
                              <span><strong>Environment:</strong> Requires steady hands and decent lighting. Glare on screens or very low light can interfere with QR scanning.</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <span className="text-primary font-bold">•</span>
                              <span><strong>Visual Path:</strong> Needs a clear line of sight between devices. Screen protectors or scratched lenses may reduce reliability.</span>
                            </li>
                          </ul>

                          <div className="mt-4 bg-blue-50 dark:bg-blue-900/20 p-4 rounded-md border border-blue-100 dark:border-blue-900/50">
                            <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-300 flex items-center gap-2 mb-2">
                              <Globe className="w-3 h-3" />
                              When to use Online Send instead?
                            </h4>
                            <ul className="text-sm text-blue-800 dark:text-blue-400 space-y-1 ml-5 list-disc">
                              <li>Transferring <strong>large files</strong> (up to 100MB) or folders</li>
                              <li>When <strong>speed</strong> is a priority (uses WebRTC P2P)</li>
                              <li>When devices are <strong>remote</strong> or not side-by-side</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </div>
      )}

      {/* Send Mode */}
      {mode === 'send' && selectedFile && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Button 
              onClick={() => requestBackNavigation('send')} 
              variant="ghost" 
              size="icon"
              className="rounded-full hover:bg-muted"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h2 className="text-xl font-semibold">Setup Transfer</h2>
          </div>

          <Alert className="bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900">
            <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <AlertDescription className="text-blue-700 dark:text-blue-300">
              Prepare your file for transmission. Follow the steps below to generate the QR stream.
            </AlertDescription>
          </Alert>

          <OfflineQRMode file={selectedFile} onReset={handleReset} />
        </div>
      )}

      {/* Receive Mode */}
      {mode === 'receive' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Button 
              onClick={() => requestBackNavigation('receive')} 
              variant="ghost" 
              size="icon"
              className="rounded-full hover:bg-muted"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h2 className="text-xl font-semibold">Receive File</h2>
          </div>

          <OfflineQRReceiver />
        </div>
      )}

      {/* Back Navigation Confirmation Dialog */}
      <Dialog
        open={backDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelBackNavigation()
          }
        }}
      >
        {pendingBackContext && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{backDialogCopy[pendingBackContext].title}</DialogTitle>
              <DialogDescription>
                {backDialogCopy[pendingBackContext].description}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={handleCancelBackNavigation}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleConfirmBackNavigation}>
                {backDialogCopy[pendingBackContext].confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* Online Transfer Confirmation Dialog */}
      <Dialog open={onlineConfirmOpen} onOpenChange={setOnlineConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Continue to Online Transfer?</DialogTitle>
            <DialogDescription>
              You are about to visit <strong>securesend.kuvi.app</strong> for online file transfer.
              <br /><br />
              This is a <strong>sister site</strong> managed by the same developer. It requires an internet connection and uses end-to-end encryption to keep your files secure.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOnlineConfirmOpen(false)}>
              Cancel
            </Button>
            <Button asChild onClick={() => setOnlineConfirmOpen(false)}>
              <a href="https://securesend.kuvi.app/" target="_blank" rel="noopener noreferrer">
                Continue to Secure Send <ExternalLink className="ml-2 w-4 h-4" />
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}