import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainQRReceiver } from './fountain_qr/FountainQRReceiver'

interface DetectedMetadata {
  name: string
  size: number
  type: string
  sessionId: number
  checksum: string
  checksumAlg: string
  totalSourceBlocks: number
  blockSize: number
  feedbackEnabled: boolean
  partBasedMode?: boolean
  partSize?: number
}

export function OfflineQRReceiver() {
  const location = useLocation()
  const navigate = useNavigate()
  const [detectedMetadata, setDetectedMetadata] = useState<DetectedMetadata | null>(null)

  // Load metadata from location state on mount
  useEffect(() => {
    interface LocationState {
      metadata?: {
        fileName: string
        fileSize: number
        fileType: string
        sessionId: number
        checksum: string
        checksumAlg: string
        totalSourceBlocks?: number
        blockSize?: number
        feedbackEnabled?: boolean
        partBasedMode?: boolean
        partSize?: number
      }
    }
    const state = location.state as LocationState | null
    if (state?.metadata) {
      const parsed = state.metadata

      if (parsed.totalSourceBlocks !== undefined && parsed.blockSize !== undefined && parsed.feedbackEnabled !== undefined) {
        setDetectedMetadata({
          name: parsed.fileName,
          size: parsed.fileSize,
          type: parsed.fileType,
          sessionId: parsed.sessionId,
          totalSourceBlocks: parsed.totalSourceBlocks,
          blockSize: parsed.blockSize,
          checksum: parsed.checksum,
          checksumAlg: parsed.checksumAlg,
          feedbackEnabled: parsed.feedbackEnabled,
          partBasedMode: parsed.partBasedMode,
          partSize: parsed.partSize
        })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Error state - should not happen during normal flow
  if (!detectedMetadata) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-center text-red-600">Error</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>
              No metadata found. Please scan a metadata QR code first from the Scan page.
            </AlertDescription>
          </Alert>
          <Button onClick={() => navigate('/scan/camera')} className="w-full">
            Go to Scan Page
          </Button>
        </CardContent>
      </Card>
    )
  }

  // Show receiver component
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">🔁 Fountain Code Receiver</CardTitle>
        <p className="text-sm text-muted-foreground text-center">
          {detectedMetadata.name} • {(detectedMetadata.size / 1024).toFixed(2)}KB
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          onClick={() => navigate('/scan/camera')}
          variant="outline"
          size="sm"
          className="w-full"
        >
          ← Back to Scan
        </Button>

        <FountainQRReceiver
          initialMetadata={{
            name: detectedMetadata.name,
            size: detectedMetadata.size,
            type: detectedMetadata.type,
            sessionId: detectedMetadata.sessionId,
            totalSourceBlocks: detectedMetadata.totalSourceBlocks,
            blockSize: detectedMetadata.blockSize,
            checksum: detectedMetadata.checksum,
            checksumAlg: detectedMetadata.checksumAlg,
            feedbackEnabled: detectedMetadata.feedbackEnabled,
            partBasedMode: detectedMetadata.partBasedMode,
            partSize: detectedMetadata.partSize
          }}
        />
      </CardContent>
    </Card>
  )
}
