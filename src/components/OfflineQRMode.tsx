import { useState, useEffect } from 'react'
import { computeChecksum } from '@/utils/checksum'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { SequentialQRSender, CHUNK_SIZE as SEQUENTIAL_CHUNK_SIZE } from './SequentialQRSender'
import { FountainQRSender } from './FountainQRSender'
import { FountainQRSenderLegacy } from './FountainQRSenderLegacy'
import QRCode from 'qrcode'
import { Progress } from '@/components/ui/progress'
import { DEFAULT_BLOCK_SIZE, WINDOW_ENABLE_THRESHOLD, WINDOW_HALF_THRESHOLD, SEGMENT_SIZE_BYTES, WINDOW_EXPANSION_SIZE_BYTES } from '@/utils/fountainConfig'

const kb = (n: number) => `${Math.round(n / 1024)}KB`
const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`

// Camera detection utility function
const checkCameraAvailability = async (): Promise<boolean> => {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return false
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.some(device => device.kind === 'videoinput')
  } catch (error) {
    console.warn('Camera detection failed:', error)
    return false
  }
}

interface OfflineQRModeProps {
  file: File | null
  onReset?: () => void
}

export const MAX_FILE_SIZE_SEQUENTIAL = 512 * 1024
export const MAX_FILE_SIZE_FOUNTAIN = 2 * 1024 * 1024
export const MAX_FILE_SIZE_FOUNTAIN_LEGACY = 512 * 1024

type TransferMode = 'sequential' | 'fountain' | 'fountain-legacy'

interface SequentialMetadata {
  type: 'METADATA'
  mode: 'sequential'
  version: 1
  sessionId: number
  fileName: string
  fileType: string
  fileSize: number
  totalChunks: number
  chunkSize: number
  timestamp: number
  checksumAlg: 'crc32'
  checksum: string
}

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
  windowEnabled: boolean
  initialWindowBlocks: number
  windowExpansionSizeBytes: number
  segmentSizeBytes: number
  windowStart: number
  feedbackEnabled: boolean
}

interface FountainLegacyMetadata {
  type: 'METADATA'
  mode: 'fountain-legacy'
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
}

type MetadataJson = SequentialMetadata | FountainMetadata | FountainLegacyMetadata | null

export function OfflineQRMode({ file, onReset }: OfflineQRModeProps) {
   const [transferMode, setTransferMode] = useState<TransferMode | null>(null)
   const [step, setStep] = useState<'mode' | 'metadata' | 'transfer'>('mode')
   const [metadataQR, setMetadataQR] = useState<string>('')
   const [metadataJson, setMetadataJson] = useState<MetadataJson>(null)
   const [metadataLoading, setMetadataLoading] = useState(false)
   const [metadataError, setMetadataError] = useState<string>('')
   const [senderRemountKey, setSenderRemountKey] = useState(0) // force remount of sender components when restarting
   const [currentSessionId, setCurrentSessionId] = useState<number>(0)
   const [modeSizeError, setModeSizeError] = useState<string>('')
   const [cameraDetectionDialog, setCameraDetectionDialog] = useState(false)
   const [cameraAutoDetected, setCameraAutoDetected] = useState<boolean | null>(null)
   const [feedbackEnabled, setFeedbackEnabled] = useState(true)

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

        if (transferMode === 'sequential') {
           // Sequential metadata requires file length + chunk calculation
           const arrayBuffer = await file.arrayBuffer()
             // arrayBuffer length is available but we need byte length specifically
           const bytes = new Uint8Array(arrayBuffer)
           const totalDataChunks = Math.ceil(bytes.length / SEQUENTIAL_CHUNK_SIZE)
           const checksum = await computeChecksum(bytes, 'crc32')
           const sessionId = Math.floor(Math.random() * 65536)
           setCurrentSessionId(sessionId)
           const meta: SequentialMetadata = {
             type: 'METADATA',
             mode: 'sequential',
             version: 1,
             sessionId: sessionId,
             fileName: file.name,
             fileType: file.type || 'application/octet-stream',
             fileSize: bytes.length,
             totalChunks: totalDataChunks,
             chunkSize: SEQUENTIAL_CHUNK_SIZE,
             timestamp: Date.now(),
             checksumAlg: 'crc32',
             checksum
           }
          if (cancelled) return
          const utf8Bytes = new TextEncoder().encode(JSON.stringify(meta))
          const qrUrl = await QRCode.toDataURL([{ data: utf8Bytes, mode: 'byte' }], {
            width: 400,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#FFFFFF' }
          })
          if (cancelled) return
          setMetadataJson(meta)
          setMetadataQR(qrUrl)
        } else if (transferMode === 'fountain') {
           // Fountain metadata requires computing totalSourceBlocks using blockSize (600) logic similar to FountainQRSender
           const arrayBuffer = await file.arrayBuffer()
           const size = arrayBuffer.byteLength
           const totalSourceBlocks = Math.ceil(size / DEFAULT_BLOCK_SIZE)
           const checksum = await computeChecksum(new Uint8Array(arrayBuffer), 'crc32')
           const sessionId = Math.floor(Math.random() * 65536)
           setCurrentSessionId(sessionId)

           // Calculate window configuration
           let windowEnabled = false
           let initialWindowBlocks = totalSourceBlocks
           if (size >= WINDOW_ENABLE_THRESHOLD) {
             windowEnabled = true
             if (size <= WINDOW_HALF_THRESHOLD) {
               initialWindowBlocks = Math.ceil(totalSourceBlocks * 0.5)
             } else {
               initialWindowBlocks = Math.min(Math.ceil(SEGMENT_SIZE_BYTES / DEFAULT_BLOCK_SIZE), totalSourceBlocks)
             }
           }

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
            windowEnabled,
            initialWindowBlocks,
            windowExpansionSizeBytes: WINDOW_EXPANSION_SIZE_BYTES,
            segmentSizeBytes: SEGMENT_SIZE_BYTES,
            windowStart: 0,
            feedbackEnabled
          }
          if (cancelled) return
            const utf8Bytes = new TextEncoder().encode(JSON.stringify(meta))
            const qrUrl = await QRCode.toDataURL([{ data: utf8Bytes, mode: 'byte' }], {
              width: 400,
              margin: 2,
              errorCorrectionLevel: 'M',
              color: { dark: '#000000', light: '#FFFFFF' }
            })
            if (cancelled) return
            setMetadataJson(meta)
            setMetadataQR(qrUrl)
        } else if (transferMode === 'fountain-legacy') {
           // Fountain legacy metadata (no windowing)
           const arrayBuffer = await file.arrayBuffer()
           const size = arrayBuffer.byteLength
           const totalSourceBlocks = Math.ceil(size / DEFAULT_BLOCK_SIZE)
           const checksum = await computeChecksum(new Uint8Array(arrayBuffer), 'crc32')
           const sessionId = Math.floor(Math.random() * 65536)
           setCurrentSessionId(sessionId)

          const meta: FountainLegacyMetadata = {
            type: 'METADATA',
            mode: 'fountain-legacy',
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
            checksum
          }
          if (cancelled) return
            const utf8Bytes = new TextEncoder().encode(JSON.stringify(meta))
            const qrUrl = await QRCode.toDataURL([{ data: utf8Bytes, mode: 'byte' }], {
              width: 400,
              margin: 2,
              errorCorrectionLevel: 'M',
              color: { dark: '#000000', light: '#FFFFFF' }
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
  }, [file, transferMode, step, feedbackEnabled])

  const handleSelectMode = async (mode: TransferMode) => {
    if (!file) return

    let maxSize: number
    let modeName: string

    if (mode === 'sequential') {
      maxSize = MAX_FILE_SIZE_SEQUENTIAL
      modeName = 'Sequential'
    } else if (mode === 'fountain') {
      maxSize = MAX_FILE_SIZE_FOUNTAIN
      modeName = 'Fountain (Windowed)'
    } else {
      maxSize = MAX_FILE_SIZE_FOUNTAIN_LEGACY
      modeName = 'Fountain (Simple)'
    }

    if (file.size > maxSize) {
      setModeSizeError(`${modeName} mode supports files up to ${(maxSize / (maxSize >= 1024 * 1024 ? 1024 * 1024 : 1024)).toFixed(0)}${maxSize >= 1024 * 1024 ? 'MB' : 'KB'}. Your file is ${(file.size / 1024).toFixed(2)}KB. Please select a different mode or choose a smaller file.`)
      return
    }

    setModeSizeError('')

    if (mode === 'fountain') {
      // For fountain mode, check camera availability first
      const cameraAvailable = await checkCameraAvailability()
      setCameraAutoDetected(cameraAvailable)
      setCameraDetectionDialog(true)
      setTransferMode(mode)
    } else {
      // For other modes, proceed directly
      setTransferMode(mode)
      setStep('metadata')
      setMetadataQR('')
      setMetadataJson(null)
    }
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
    setCameraDetectionDialog(false)
    setCameraAutoDetected(null)
    setFeedbackEnabled(true)
    if (onReset) onReset()
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

  // Mode selection screen
  if (step === 'mode' || !transferMode) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-center">Select Transfer Mode</CardTitle>
          <div className="text-sm text-muted-foreground text-center space-y-1">
            <p className="font-medium">{file.name}</p>
            <p>Size: {(file.size / 1024).toFixed(2)}KB</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {modeSizeError && (
            <Alert variant="destructive">
              <AlertDescription>{modeSizeError}</AlertDescription>
            </Alert>
          )}
          {/* Fountain Mode - RECOMMENDED (shown first)
              Fountain coding is preferred for files large enough to need chunking.
              Sequential mode may be deprecated or code-frozen in the future as a backup option only. */}
          <Button
            onClick={() => handleSelectMode('fountain')}
            variant="outline"
            className="w-full h-auto py-6 flex flex-col items-start gap-2 border-2 border-primary"
          >
            <div className="font-bold text-lg">🔁 Fountain Code Transfer (Recommended)</div>
            <div className="text-sm text-left text-muted-foreground">
              • Generates random coded chunks with segment-based windowing for large files<br/>
              • Receiver needs ~105-115% of source blocks (varies by file size)<br/>
              • Can skip/miss chunks and still decode<br/>
              • Preferred for large files<br/>
              • Supports files up to {mb(MAX_FILE_SIZE_FOUNTAIN)}<br/>
              • Uses feedback QR codes for optimal performance
            </div>
          </Button>

          {/* Fountain Legacy Mode - Simple/No Camera */}
          <Button
            onClick={() => handleSelectMode('fountain-legacy')}
            variant="outline"
            className="w-full h-auto py-6 flex flex-col items-start gap-2"
          >
            <div className="font-bold text-lg">🔁 Fountain Code (Simple) - No Camera Needed</div>
            <div className="text-sm text-left text-muted-foreground">
              • Generates random coded chunks (no windowing)<br/>
              • No feedback scanning required - works without camera<br/>
              • Receiver needs ~110% of source blocks<br/>
              • Ideal for senders without camera access<br/>
              • Maximum file size: {kb(MAX_FILE_SIZE_FOUNTAIN_LEGACY)}
            </div>
          </Button>

          {/* Sequential Mode - Legacy/Backup
              Not recommended for large files. May become backup-only or code-frozen. */}
          <Button
            onClick={() => handleSelectMode('sequential')}
            variant="outline"
            className="w-full h-auto py-6 flex flex-col items-start gap-2"
          >
            <div className="font-bold text-lg">📋 Sequential Transfer</div>
            <div className="text-sm text-left text-muted-foreground">
              • Sends chunks in order (1, 2, 3...)<br/>
              • Receiver needs ALL chunks, which might need to be repeated<br/>
              • Can speed up by skipping received chunks with feedback QR<br/>
              • Not ideal for large files<br/>
              • Maximum file size: {kb(MAX_FILE_SIZE_SEQUENTIAL)}
            </div>
          </Button>

          {/* Camera Detection Confirmation Dialog */}
          <Dialog open={cameraDetectionDialog} onOpenChange={(open) => {
            if (!open) {
              // Reset transferMode and cameraAutoDetected so selection can be made cleanly again
              setTransferMode(null)
              setCameraAutoDetected(null)
              setFeedbackEnabled(true)
            }
            setCameraDetectionDialog(open)
          }}>
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>Camera Detection for Feedback Mode</DialogTitle>
                <DialogDescription>
                  {cameraAutoDetected === true && "Camera detected on your device!"}
                  {cameraAutoDetected === false && "No camera detected on your device."}
                  {cameraAutoDetected === null && "Checking camera availability..."}
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <p className="text-sm text-muted-foreground mb-4">
                  Can you scan QR codes with your camera? This enables feedback mode for optimal transfer performance.
                </p>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p><strong>Feedback Mode:</strong> Sender scans receiver's feedback QR codes to optimize chunk generation.</p>
                  <p><strong>No-Feedback Mode:</strong> Transfer completes using random chunk generation only.</p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setFeedbackEnabled(false)
                    setCameraDetectionDialog(false)
                    setStep('metadata')
                    setMetadataQR('')
                    setMetadataJson(null)
                  }}
                >
                  No, I cannot scan
                </Button>
                <Button
                  onClick={() => {
                    setFeedbackEnabled(true)
                    setCameraDetectionDialog(false)
                    setStep('metadata')
                    setMetadataQR('')
                    setMetadataJson(null)
                  }}
                >
                  Yes, I can scan
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {onReset && (
            <Button onClick={onReset} variant="outline" className="w-full">
              Select Different File
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  // Metadata screen (centralized metadata QR + info)
  if (step === 'metadata' && transferMode) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-center">
            {transferMode === 'sequential' ? '📋 Sequential Transfer Metadata' : transferMode === 'fountain-legacy' ? '🔁 Fountain Transfer Metadata (Simple Mode)' : '🔁 Fountain Transfer Metadata'}
          </CardTitle>
          <div className="text-sm text-muted-foreground text-center space-y-1">
            <p className="font-medium">{file.name}</p>
            <p>Size: {(file.size / 1024).toFixed(2)}KB</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {metadataError && (
            <Alert variant="destructive">
              <AlertDescription>{metadataError}</AlertDescription>
            </Alert>
          )}

          {!metadataError && (
            <div className="flex flex-col items-center gap-4">
              {/* QR Code Container (no captions inside to avoid overlap) */}
              <div className="flex justify-center bg-white p-4 rounded-lg w-full">
                <div className="relative">
                  {metadataQR ? (
                    <img
                      src={metadataQR}
                      alt="Metadata QR"
                      className="max-w-full h-auto block"
                    />
                  ) : (
                    <div className="w-[400px] h-[400px] bg-gray-100 rounded" />
                  )}
                </div>
              </div>

              {/* Caption / Status moved OUTSIDE the QR area */}
              <div className="w-full text-center text-xs text-muted-foreground min-h-[1.25rem] flex items-center justify-center">
                {metadataLoading && 'Preparing metadata QR...'}
                {!metadataLoading && !metadataQR && 'Awaiting metadata...'}
                {!metadataLoading && metadataQR && '📦 Scan this metadata QR code first on the receiver'}
              </div>

              {/* Warning message for no-feedback mode */}
              {transferMode === 'fountain' && !feedbackEnabled && (
                <Alert variant="default">
                  <AlertDescription className="text-sm">
                    ⚠️ Sender cannot scan QR codes - Receiver will operate in no-feedback mode. The receiver should not generate feedback QR codes during transfer. Transfer will complete using random chunk generation only.
                  </AlertDescription>
                </Alert>
              )}

              {metadataJson && (
                <div className="w-full space-y-2 text-xs text-muted-foreground">
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="font-semibold">Name:</span> {metadataJson.fileName}</div>
                    <div><span className="font-semibold">Size:</span> {(metadataJson.fileSize / 1024).toFixed(2)}KB</div>
                    {transferMode === 'sequential' && metadataJson.mode === 'sequential' && (
                      <>
                        <div><span className="font-semibold">Chunks:</span> {metadataJson.totalChunks}</div>
                        <div><span className="font-semibold">Chunk Size:</span> {metadataJson.chunkSize} bytes</div>
                      </>
                    )}
                    {(transferMode === 'fountain' || transferMode === 'fountain-legacy') && (metadataJson.mode === 'fountain' || metadataJson.mode === 'fountain-legacy') && (
                      <>
                        <div><span className="font-semibold">Blocks:</span> {metadataJson.totalSourceBlocks}</div>
                        <div><span className="font-semibold">Block Size:</span> {metadataJson.blockSize} bytes</div>
                      </>
                    )}
                    <div className="col-span-2"><span className="font-semibold">Type:</span> {metadataJson.fileType}</div>
                    {metadataJson.checksum && (
                      <div className="col-span-2 break-all"><span className="font-semibold">Checksum ({metadataJson.checksumAlg}):</span> {metadataJson.checksum}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {metadataLoading && (
            <Progress value={45} />
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={() => {
                setStep('mode')
                setCameraDetectionDialog(false)
                setCameraAutoDetected(null)
                setFeedbackEnabled(true)
              }}
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={metadataLoading}
            >
              ← Change Mode
            </Button>
            {onReset && (
              <Button
                onClick={handleResetSession}
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={metadataLoading}
              >
                Different File
              </Button>
            )}
            <Button
              onClick={handleStartTransfer}
              size="sm"
              className="flex-1"
              disabled={!metadataQR || metadataLoading}
            >
              Start Transfer ▶
            </Button>
          </div>

          <Alert>
            <AlertDescription className="text-xs space-y-1">
              <p className="font-medium mb-1">Instructions:</p>
              <p>1. Receiver scans this metadata QR code first.</p>
              <p>2. Then click Start Transfer to begin animated data QR codes.</p>
              <p>3. You can always restart the session to regenerate fresh metadata.</p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  // Show selected transfer mode component (skip their internal metadata stage)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">
          {transferMode === 'sequential' ? '📋 Sequential Transfer' : transferMode === 'fountain-legacy' ? '🔁 Fountain Code Transfer (Simple)' : '🔁 Fountain Code Transfer'}
        </CardTitle>
        <div className="text-sm text-muted-foreground text-center space-y-1">
          <p className="font-medium">{file.name}</p>
          <p>Size: {(file.size / 1024).toFixed(2)}KB</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode Switch Button */}
        <div className="flex gap-2 flex-wrap">
          <Button
            onClick={() => setStep('metadata')}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            ← Metadata
          </Button>
          <Button
            onClick={() => { setStep('mode'); setTransferMode(null) }}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            Change Mode
          </Button>
          {onReset && (
            <Button onClick={handleResetSession} variant="outline" size="sm" className="flex-1">
              Reset Session
            </Button>
          )}
        </div>

        {/* Render appropriate sender component */}
         {transferMode === 'sequential' ? (
           <SequentialQRSender key={`seq-${senderRemountKey}`} file={file} sessionId={currentSessionId} />
         ) : transferMode === 'fountain' ? (
           <FountainQRSender key={`fount-${senderRemountKey}`} file={file} sessionId={currentSessionId} />
         ) : (
           <FountainQRSenderLegacy key={`fount-legacy-${senderRemountKey}`} file={file} />
         )}
      </CardContent>
    </Card>
  )
}
