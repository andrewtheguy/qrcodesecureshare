import { useState, useEffect } from 'react'
import { computeChecksum } from '@/utils/checksum'
import { OFFLINE_METADATA_MAGIC } from '@/constants'
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainQRSender } from './fountain_qr/FountainQRSender'
import { generateQRTextDataURL } from '@/utils/qrUtils'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { DEFAULT_BLOCK_SIZE, PART_SIZE_OPTIONS, type PartSizeOption } from '@/utils/fountainConfig'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { 
  RefreshCw, 
  ArrowRight, 
  ShieldCheck, 
  Smartphone, 
  Maximize2, 
  Settings,
  QrCode,
  FileDigit,
  TriangleAlert,
  Play
} from 'lucide-react'

const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`


interface OfflineQRModeProps {
  file: File | null
  onReset?: () => void
}

export const MAX_FILE_SIZE_FOUNTAIN_FEEDBACK = 5 * 1024 * 1024  // 5MB for feedback mode
export const MAX_FILE_SIZE_FOUNTAIN_SIMPLE = 2 * 1024 * 1024    // 2MB for simple mode

type TransferMode = 'fountain-feedback' | 'fountain-simple'

interface FountainMetadata {
  type: 'METADATA'
  mode: 'fountain'
  version: 1
  sessionId: number
  fileName: string
  fileType: string
  fileSize: number
  timestamp: number
  totalSourceBlocks: number
  blockSize: number
  chunkSize: number
  checksumAlg: 'crc32'
  checksum: string
  feedbackEnabled: boolean
  partBasedMode?: boolean
  partSize?: number
}

type MetadataJson = FountainMetadata | null

export function OfflineQRMode({ file, onReset }: OfflineQRModeProps) {
   const [transferMode, setTransferMode] = useState<TransferMode | null>(null)
   const [step, setStep] = useState<'mode' | 'partSize' | 'metadata' | 'transfer'>('mode')
   const [metadataQR, setMetadataQR] = useState<string>('')
   const [metadataJson, setMetadataJson] = useState<MetadataJson>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [metadataError, setMetadataError] = useState<string>('')
  const [senderRemountKey, setSenderRemountKey] = useState(0) // force remount of sender components when restarting
  const [currentSessionId, setCurrentSessionId] = useState<number>(0)
  const [modeSizeError, setModeSizeError] = useState<string>('')
  const [feedbackEnabled, setFeedbackEnabled] = useState(true)
  const [partSizeOption, setPartSizeOption] = useState<PartSizeOption>('LARGE')
  const [exitDialogOpen, setExitDialogOpen] = useState(false)
  const [pendingExitAction, setPendingExitAction] = useState<'metadata' | 'mode' | 'reset' | null>(null)

  // ------------------------------------------------------------------
  // Metadata Preparation Logic (now centralized here per requirement)
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!file || !transferMode || step !== 'metadata') return

    let cancelled = false
    const prepare = async () => {
      try {
        setMetadataLoading(true)
        setMetadataError('')
        setMetadataQR('')

        if (transferMode === 'fountain-feedback' || transferMode === 'fountain-simple') {
          // Fountain metadata requires computing totalSourceBlocks using blockSize (600) logic similar to FountainQRSender
          const arrayBuffer = await file.arrayBuffer()
          const size = arrayBuffer.byteLength
          const totalSourceBlocks = Math.ceil(size / DEFAULT_BLOCK_SIZE)
          const checksum = await computeChecksum(new Uint8Array(arrayBuffer), 'crc32')
          const sessionId = Math.floor(Math.random() * 65536)
          setCurrentSessionId(sessionId)

          // Window mode removed - always disabled

          const meta: FountainMetadata = {
            type: 'METADATA',
            mode: 'fountain',
            version: 1,
            sessionId: sessionId,
            fileName: file.name,
            fileType: file.type || 'application/octet-stream',
            fileSize: size,
            timestamp: Date.now(),
            totalSourceBlocks,
            blockSize: DEFAULT_BLOCK_SIZE,
            chunkSize: DEFAULT_BLOCK_SIZE, // include for parity
            checksumAlg: 'crc32',
            checksum,
            feedbackEnabled,
            partBasedMode: feedbackEnabled, // Enable part-based mode for feedback transfers
            partSize: feedbackEnabled ? PART_SIZE_OPTIONS[partSizeOption] : undefined
          }
          if (cancelled) return
          const qrUrl = await generateQRTextDataURL(OFFLINE_METADATA_MAGIC + JSON.stringify(meta), {
            width: 400,
            errorCorrectionLevel: 'M'
          })
          if (cancelled) return
          setMetadataJson(meta)
          setMetadataQR(qrUrl)
        }
      } catch (e) {
        if (!cancelled) {
          setMetadataError('Failed to prepare metadata QR')
          console.error('Metadata preparation error:', e)
        }
      } finally {
        if (!cancelled) setMetadataLoading(false)
      }
    }
    prepare()
    return () => { cancelled = true }
  }, [file, transferMode, step, feedbackEnabled, partSizeOption])

  const handleSelectMode = (mode: TransferMode) => {
     if (!file) return

     let maxSize: number
     let modeName: string

     if (mode === 'fountain-feedback') {
       maxSize = MAX_FILE_SIZE_FOUNTAIN_FEEDBACK
       modeName = 'Fountain (Recommended)'
     } else {
       maxSize = MAX_FILE_SIZE_FOUNTAIN_SIMPLE
       modeName = 'Fountain (Basic)'
     }

     if (file.size > maxSize) {
       setModeSizeError(`${modeName} mode supports files up to ${(maxSize / (maxSize >= 1024 * 1024 ? 1024 * 1024 : 1024)).toFixed(0)}${maxSize >= 1024 * 1024 ? 'MB' : 'KB'}. Your file is ${(file.size / 1024).toFixed(2)}KB. Please select a different mode or choose a smaller file.`)
       return
     }

     setModeSizeError('')
     setTransferMode(mode)

    if (mode === 'fountain-feedback') {
      setFeedbackEnabled(true)
      setPartSizeOption('LARGE')
      // Go to part size configuration step instead of metadata
      setStep('partSize')
    } else if (mode === 'fountain-simple') {
      setFeedbackEnabled(false)
      setStep('metadata')
    }

     setMetadataQR('')
     setMetadataJson(null)
   }

  const handleContinueToMetadata = () => {
    setStep('metadata')
  }

  const handleStartTransfer = () => {
    setStep('transfer')
    // Force remount of sender by incrementing sender remount key (so internal state like metadata chunk is fresh)
    setSenderRemountKey(id => id + 1)
  }

  const handleResetSession = () => {
    setTransferMode(null)
    setStep('mode')
    setMetadataQR('')
    setMetadataJson(null)
    setMetadataError('')
    setMetadataLoading(false)
    setSenderRemountKey(id => id + 1)
    setCurrentSessionId(0)
    setModeSizeError('')
    setFeedbackEnabled(true)
    if (onReset) onReset()
  }

  const exitActionContent = {
    metadata: {
      title: 'Leave Transfer?',
      description: 'Going back to the metadata screen will stop the current QR playback and reset progress. Continue?',
      confirmLabel: 'Yes, Go to Metadata'
    },
    mode: {
      title: 'Change Mode?',
      description: 'Switching transfer mode will discard the current session settings and QR codes.',
      confirmLabel: 'Yes, Change Mode'
    },
    reset: {
      title: 'Reset Session?',
      description: 'Resetting will clear the current transfer and return to file selection. This cannot be undone.',
      confirmLabel: 'Yes, Reset Session'
    }
  } as const

  const requestExitAction = (action: 'metadata' | 'mode' | 'reset') => {
    setPendingExitAction(action)
    setExitDialogOpen(true)
  }

  const handleConfirmExitAction = () => {
    if (!pendingExitAction) {
      setExitDialogOpen(false)
      return
    }

    if (pendingExitAction === 'metadata') {
      setStep('metadata')
      setSenderRemountKey(id => id + 1)
      setMetadataQR('')
      setMetadataJson(null)
      setMetadataError('')
      setMetadataLoading(false)
    } else if (pendingExitAction === 'mode') {
      setTransferMode(null)
      setStep('mode')
      setMetadataQR('')
      setMetadataJson(null)
      setMetadataError('')
      setMetadataLoading(false)
      setSenderRemountKey(id => id + 1)
      setFeedbackEnabled(true)
    } else if (pendingExitAction === 'reset') {
      handleResetSession()
    }

    setPendingExitAction(null)
    setExitDialogOpen(false)
  }

  const handleCancelExitAction = () => {
    setPendingExitAction(null)
    setExitDialogOpen(false)
  }


  if (!file) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-muted-foreground">No file selected</p>
        </CardContent>
      </Card>
    )
  }

  // -----------------------------------------------------------
  // STEP 1: MODE SELECTION
  // -----------------------------------------------------------
  if (step === 'mode' || !transferMode) {
    return (
      <Card className="border-none shadow-none bg-transparent">
        <div className="space-y-6">
          <div className="text-center space-y-1">
             <h3 className="text-lg font-semibold">Select Transfer Mode</h3>
             <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground flex-wrap">
                <FileDigit className="w-4 h-4 shrink-0" />
                <span className="font-medium break-all">{file.name}</span>
                <span className="opacity-50">|</span>
                <span className="shrink-0">{(file.size / 1024).toFixed(2)} KB</span>
             </div>
          </div>

          {modeSizeError && (
            <Alert variant="destructive">
               <TriangleAlert className="h-4 w-4" />
              <AlertDescription>{modeSizeError}</AlertDescription>
            </Alert>
          )}

          <div className="grid md:grid-cols-2 gap-4">
             {/* Interactive Mode (Recommended) */}
             <div
                className="relative group cursor-pointer"
                role="button"
                tabIndex={0}
                onClick={() => handleSelectMode('fountain-feedback')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    if (event.key === ' ') {
                      event.preventDefault()
                    }
                    handleSelectMode('fountain-feedback')
                  }
                }}
             >
                <div className="absolute inset-0 bg-primary/5 rounded-xl border-2 border-primary/20 group-hover:border-primary transition-colors" />
                <div className="relative p-6 space-y-4">
                   <div className="flex items-center gap-3">
                      <div className="p-2 rounded-full bg-primary/10 text-primary">
                         <RefreshCw className="w-6 h-6" />
                      </div>
                      <div className="flex-1">
                         <h4 className="font-bold text-base">Interactive</h4>
                         <p className="text-xs text-primary font-medium">Recommended</p>
                      </div>
                   </div>
                   
                   <ul className="space-y-2 text-sm text-muted-foreground">
                      <li className="flex items-start gap-2">
                         <ShieldCheck className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                         <span>Receiver tells sender what parts are missing</span>
                      </li>
                      <li className="flex items-start gap-2">
                         <Smartphone className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
                         <span>Works with or without camera on sender</span>
                      </li>
                      <li className="flex items-start gap-2">
                         <Settings className="w-4 h-4 text-purple-500 mt-0.5 shrink-0" />
                         <span>Supports QR scan or manual code feedback</span>
                      </li>
                      <li className="flex items-start gap-2">
                         <Maximize2 className="w-4 h-4 text-orange-500 mt-0.5 shrink-0" />
                         <span>Up to {mb(MAX_FILE_SIZE_FOUNTAIN_FEEDBACK)}</span>
                      </li>
                   </ul>
                </div>
             </div>

             {/* Basic Mode */}
             <div
                className="relative group cursor-pointer"
                role="button"
                tabIndex={0}
                onClick={() => handleSelectMode('fountain-simple')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    if (event.key === ' ') {
                      event.preventDefault()
                    }
                    handleSelectMode('fountain-simple')
                  }
                }}
             >
                <div className="absolute inset-0 bg-muted/30 rounded-xl border-2 border-transparent group-hover:border-muted-foreground/30 transition-colors" />
                <div className="relative p-6 space-y-4">
                   <div className="flex items-center gap-3">
                      <div className="p-2 rounded-full bg-muted text-muted-foreground">
                         <ArrowRight className="w-6 h-6" />
                      </div>
                      <div>
                         <h4 className="font-bold text-base">One-Way</h4>
                         <p className="text-xs text-muted-foreground font-medium">Basic</p>
                      </div>
                   </div>
                   
                   <ul className="space-y-2 text-sm text-muted-foreground">
                      <li className="flex items-start gap-2">
                         <span className="w-4 h-4 flex items-center justify-center font-bold text-muted-foreground/50">1</span>
                         <span>No sender interaction required during transfer</span>
                      </li>
                      <li className="flex items-start gap-2">
                         <span className="w-4 h-4 flex items-center justify-center font-bold text-muted-foreground/50">2</span>
                         <span>Continuous data stream until completion</span>
                      </li>
                      <li className="flex items-start gap-2">
                         <Maximize2 className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                         <span>Up to {mb(MAX_FILE_SIZE_FOUNTAIN_SIMPLE)}</span>
                      </li>
                   </ul>
                </div>
             </div>
          </div>

          <div className="flex justify-center pt-2">
            {onReset && (
               <Button onClick={onReset} variant="ghost" size="sm" className="text-muted-foreground">
                  Select Different File
               </Button>
            )}
          </div>
        </div>
      </Card>
    )
  }

  // -----------------------------------------------------------
  // STEP 2: PART SIZE CONFIG
  // -----------------------------------------------------------
  if (step === 'partSize' && transferMode === 'fountain-feedback') {
    const defaultLabel = '1024 KB (1 MB)'
    const originalFileSizeLabel = `${(file.size / 1024).toFixed(2)} KB`

    return (
      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-primary/10 text-primary">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <CardTitle>Transfer Configuration</CardTitle>
              <p className="text-sm text-muted-foreground">Optimize for your device</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
            <FileDigit className="w-4 h-4 shrink-0" />
            <span className="font-medium break-all">{file.name}</span>
            <span className="opacity-50">|</span>
            <span className="shrink-0">{originalFileSizeLabel}</span>
          </div>

          <div className="space-y-3">
            <Label className="text-base font-medium">Part Size</Label>
            <p className="text-sm text-muted-foreground">
              Files are split into parts for efficient transfer with checksum validation. Smaller part sizes work better for devices with slower QR decoding or poor cameras. <strong>Default: {defaultLabel}.</strong>
            </p>
            
            <RadioGroup 
              value={partSizeOption} 
              onValueChange={(value: PartSizeOption) => setPartSizeOption(value)} 
              className="space-y-3 pt-2"
            >
              <div>
                <RadioGroupItem value="LARGE" id="opt-LARGE" className="peer sr-only" />
                <Label
                  htmlFor="opt-LARGE"
                  className="flex items-center justify-between rounded-md border-2 border-muted bg-popover px-4 py-2.5 text-sm hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
                >
                  <span className="font-medium">1 MB</span>
                </Label>
              </div>

              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="advanced-part-sizes" className="border-none">
                  <AccordionTrigger className="py-2 text-sm text-muted-foreground hover:text-foreground hover:no-underline">
                    Advanced
                  </AccordionTrigger>
                  <AccordionContent className="pb-0">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                      {[
                        { val: 'MEDIUM', label: '512 KB' },
                        { val: 'SMALL', label: '256 KB' },
                        { val: 'TINY', label: '32 KB' }
                      ].map((opt) => (
                        <div key={opt.val}>
                          <RadioGroupItem value={opt.val} id={`opt-${opt.val}`} className="peer sr-only" />
                          <Label
                            htmlFor={`opt-${opt.val}`}
                            className="flex items-center justify-center rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
                          >
                            <span className="font-bold text-base">{opt.label}</span>
                          </Label>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </RadioGroup>
          </div>
        </CardContent>
        <CardFooter className="flex justify-between pt-0 pb-6">
          <Button onClick={() => setStep('mode')} variant="outline">
            Back
          </Button>
          <Button onClick={handleContinueToMetadata}>
            Continue
          </Button>
        </CardFooter>
      </Card>
    )
  }

  // -----------------------------------------------------------
  // STEP 3: METADATA
  // -----------------------------------------------------------
  if (step === 'metadata' && transferMode) {
    return (
      <Card className="overflow-hidden">
        <div className="bg-muted/30 border-b p-4 text-center">
           <h3 className="font-semibold flex items-center justify-center gap-2">
              <QrCode className="w-4 h-4" />
              Scan on Receiver
           </h3>
        </div>
        
        <CardContent className="p-6 space-y-6">
          {metadataError && (
            <Alert variant="destructive">
              <AlertDescription>{metadataError}</AlertDescription>
            </Alert>
          )}

          {!metadataError && (
            <div className="flex flex-col items-center gap-6">
              {/* QR Code Container */}
              <div className="relative group">
                <div className="bg-white p-4 rounded-xl shadow-sm border">
                  {metadataQR ? (
                    <img
                      src={metadataQR}
                      alt="Metadata QR"
                      className="w-full max-w-[280px] h-auto block"
                    />
                  ) : (
                    <div className="w-[280px] h-[280px] bg-muted/20 animate-pulse rounded" />
                  )}
                </div>
                {/* Scan indicator */}
                <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-bold px-3 py-1 rounded-full shadow-lg">
                   SCAN ME
                </div>
              </div>

              <div className="space-y-4 w-full max-w-sm text-center">
                 <p className="text-sm text-muted-foreground">
                    {metadataLoading 
                       ? 'Generating secure metadata...' 
                       : 'Scan this code with the receiver device to initialize the secure channel.'}
                 </p>
                 
                 {(transferMode === 'fountain-feedback' || transferMode === 'fountain-simple') && !feedbackEnabled && (
                    <div className="bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 text-xs p-3 rounded-md text-left flex gap-2">
                       <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
                       <p>Receiver will operate in basic (no-feedback) mode.</p>
                    </div>
                 )}
              </div>
            </div>
          )}

        </CardContent>

        <CardFooter className="flex flex-col gap-3 bg-muted/10 p-6 pt-2">
           <Button
              onClick={handleStartTransfer}
              size="lg"
              className="w-full text-lg shadow-lg shadow-primary/20"
              disabled={!metadataQR || metadataLoading}
            >
              <Play className="w-5 h-5 mr-2 fill-current" />
              Start Transfer
            </Button>
            
            <div className="flex gap-2 w-full">
               <Button
                  onClick={() => {
                     setStep('mode')
                     setFeedbackEnabled(true)
                  }}
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={metadataLoading}
               >
                  Change Mode
               </Button>
               {onReset && (
                  <Button
                     onClick={handleResetSession}
                     variant="ghost"
                     size="sm"
                     className="flex-1"
                     disabled={metadataLoading}
                  >
                     Cancel
                  </Button>
               )}
            </div>
        </CardFooter>
      </Card>
    )
  }

  // -----------------------------------------------------------
  // STEP 4: TRANSFER
  // -----------------------------------------------------------
  // Show selected transfer mode component (skip their internal metadata stage)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">🔁 Fountain Code Transfer</CardTitle>
        <div className="text-sm text-muted-foreground text-center space-y-1">
          <p className="font-medium">{file.name}</p>
          <p>Size: {(file.size / 1024).toFixed(2)}KB</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode Switch Button */}
        <div className="flex gap-2 flex-wrap">
          <Button
            onClick={() => requestExitAction('metadata')}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            ← Metadata
          </Button>
          <Button
            onClick={() => requestExitAction('mode')}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            Change Mode
          </Button>
          {onReset && (
            <Button onClick={() => requestExitAction('reset')} variant="outline" size="sm" className="flex-1">
              Reset Session
            </Button>
          )}
        </div>

        {/* Render appropriate sender component */}
        {metadataJson &&
          (transferMode === 'fountain-feedback' || transferMode === 'fountain-simple') &&
          metadataJson.mode === 'fountain' && (
            <FountainQRSender
              key={`fount-${senderRemountKey}`}
              file={file}
              sessionId={currentSessionId}
              feedbackEnabled={feedbackEnabled}
              checksum={metadataJson.checksum}
              checksumAlg={metadataJson.checksumAlg}
              partSizeOption={partSizeOption}
            />
          )}
        <Dialog
          open={exitDialogOpen}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelExitAction()
            }
          }}
        >
          {pendingExitAction && (
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>{exitActionContent[pendingExitAction].title}</DialogTitle>
                <DialogDescription>
                  {exitActionContent[pendingExitAction].description}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={handleCancelExitAction}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleConfirmExitAction}>
                  {exitActionContent[pendingExitAction].confirmLabel}
                </Button>
              </DialogFooter>
            </DialogContent>
          )}
        </Dialog>
      </CardContent>
    </Card>
  )
}
