import { useState, useEffect } from 'react'
import { computeChecksum } from '@/utils/checksum'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SequentialQRSender } from './SequentialQRSender'
import { FountainQRSender } from './FountainQRSender'
import QRCode from 'qrcode'
import { Progress } from '@/components/ui/progress'

interface AnimatedQRCodeProps {
  file: File | null
  onReset?: () => void
}

export const MAX_FILE_SIZE = 512 * 1024 // 512KB

type TransferMode = 'sequential' | 'fountain'

export function AnimatedQRCode({ file, onReset }: AnimatedQRCodeProps) {
  const [transferMode, setTransferMode] = useState<TransferMode | null>(null)
  const [error, setError] = useState<string>('')
  const [step, setStep] = useState<'mode' | 'metadata' | 'transfer'>('mode')
  const [metadataQR, setMetadataQR] = useState<string>('')
  const [metadataJson, setMetadataJson] = useState<any | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [metadataError, setMetadataError] = useState<string>('')
  const [sessionId, setSessionId] = useState(0) // force remount of sender components when restarting

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
          const CHUNK_SIZE = 1200
          const arrayBuffer = await file.arrayBuffer()
            // arrayBuffer length is available but we need byte length specifically
          const bytes = new Uint8Array(arrayBuffer)
          const totalDataChunks = Math.ceil(bytes.length / CHUNK_SIZE)
          const checksum = await computeChecksum(bytes, 'crc32')
          const meta = {
            type: 'METADATA',
            mode: 'sequential',
            version: 1,
            fileName: file.name,
            fileType: file.type || 'application/octet-stream',
            fileSize: bytes.length,
            totalChunks: totalDataChunks,
            chunkSize: CHUNK_SIZE,
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
          const BLOCK_SIZE = 600
          const arrayBuffer = await file.arrayBuffer()
          const size = arrayBuffer.byteLength
          const totalSourceBlocks = Math.ceil(size / BLOCK_SIZE)
          const checksum = await computeChecksum(new Uint8Array(arrayBuffer), 'crc32')
          const meta = {
            type: 'METADATA',
            mode: 'fountain',
            version: 1,
            fileName: file.name,
            fileType: file.type || 'application/octet-stream',
            fileSize: size,
            timestamp: Date.now(),
            totalSourceBlocks,
            blockSize: BLOCK_SIZE,
            chunkSize: BLOCK_SIZE, // include for parity
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
        !cancelled && setMetadataLoading(false)
      }
    }
    prepare()
    return () => { cancelled = true }
  }, [file, transferMode, step])

  const handleSelectMode = (mode: TransferMode) => {
    setTransferMode(mode)
    setStep('metadata')
    setMetadataQR('')
    setMetadataJson(null)
  }

  const handleStartTransfer = () => {
    setStep('transfer')
    // Force remount of sender by incrementing session id (so internal state like metadata chunk is fresh)
    setSessionId(id => id + 1)
  }

  const handleResetSession = () => {
    setTransferMode(null)
    setStep('mode')
    setMetadataQR('')
    setMetadataJson(null)
    setMetadataError('')
    setMetadataLoading(false)
    setSessionId(id => id + 1)
    if (onReset) onReset()
  }

  // Validate file size
  if (file && file.size > MAX_FILE_SIZE) {
    return (
      <Card>
        <CardContent className="p-6">
          <Alert variant="destructive">
            <AlertDescription>
              File size ({(file.size / 1024).toFixed(2)}KB) exceeds maximum of {(MAX_FILE_SIZE / 1024).toFixed(2)}KB
            </AlertDescription>
          </Alert>
          {onReset && (
            <Button onClick={onReset} className="mt-4 w-full">
              Try Another File
            </Button>
          )}
        </CardContent>
      </Card>
    )
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
          {/* Sequential Mode */}
          <Button
            onClick={() => handleSelectMode('sequential')}
            variant="outline"
            className="w-full h-auto py-6 flex flex-col items-start gap-2"
          >
            <div className="font-bold text-lg">📋 Sequential Transfer</div>
            <div className="text-sm text-left text-muted-foreground">
              • Sends chunks in order (1, 2, 3...)<br/>
              • Receiver needs ALL chunks<br/>
              • Can skip missed chunks with feedback QR<br/>
              • Best for reliable connections
            </div>
          </Button>

          {/* Fountain Mode */}
          <Button
            onClick={() => handleSelectMode('fountain')}
            variant="outline"
            className="w-full h-auto py-6 flex flex-col items-start gap-2"
          >
            <div className="font-bold text-lg">🔁 Fountain Code Transfer</div>
            <div className="text-sm text-left text-muted-foreground">
              • Generates random coded chunks<br/>
              • Receiver needs only ~110% of chunks<br/>
              • Can skip/miss chunks and still decode<br/>
              • Best for unreliable connections
            </div>
          </Button>

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
            {transferMode === 'sequential' ? '📋 Sequential Transfer Metadata' : '🔁 Fountain Transfer Metadata'}
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
              <div className="flex justify-center bg-white p-4 rounded-lg min-h-[420px] w-full">
                {metadataLoading ? (
                  <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100 rounded">
                    <p className="text-muted-foreground">Preparing metadata QR...</p>
                  </div>
                ) : metadataQR ? (
                  <img src={metadataQR} alt="Metadata QR" className="max-w-full h-auto" />
                ) : (
                  <div className="w-[400px] h-[400px] flex items-center justify-center bg-gray-100 rounded">
                    <p className="text-muted-foreground">Awaiting metadata...</p>
                  </div>
                )}
              </div>
              {metadataJson && (
                <div className="w-full space-y-2 text-xs text-muted-foreground">
                  <div className="font-medium text-center text-sm">
                    📦 Scan this metadata QR code first on the receiver
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="font-semibold">Name:</span> {metadataJson.fileName}</div>
                    <div><span className="font-semibold">Size:</span> {(metadataJson.fileSize / 1024).toFixed(2)}KB</div>
                    {transferMode === 'sequential' && (
                      <>
                        <div><span className="font-semibold">Chunks:</span> {metadataJson.totalChunks}</div>
                        <div><span className="font-semibold">Chunk Size:</span> {metadataJson.chunkSize} bytes</div>
                      </>
                    )}
                    {transferMode === 'fountain' && (
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
              onClick={() => setStep('mode')}
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
          {transferMode === 'sequential' ? '📋 Sequential Transfer' : '🔁 Fountain Code Transfer'}
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
          <SequentialQRSender key={`seq-${sessionId}`} file={file} />
        ) : (
          <FountainQRSender key={`fount-${sessionId}`} file={file} />
        )}
      </CardContent>
    </Card>
  )
}
