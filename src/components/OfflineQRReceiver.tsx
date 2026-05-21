import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

// Parse and validate metadata from location state
function parseLocationMetadata(state: LocationState | null): { metadata: DetectedMetadata | null; error: string | null } {
  if (!state?.metadata) {
    return { metadata: null, error: null }
  }

  const parsed = state.metadata

  // Validate all required fields
  const missingFields: string[] = []
  if (!parsed.fileName) missingFields.push('fileName')
  if (parsed.fileSize === undefined) missingFields.push('fileSize')
  if (!parsed.fileType) missingFields.push('fileType')
  if (parsed.sessionId === undefined) missingFields.push('sessionId')
  if (!parsed.checksum) missingFields.push('checksum')
  if (!parsed.checksumAlg) missingFields.push('checksumAlg')
  if (parsed.totalSourceBlocks === undefined) missingFields.push('totalSourceBlocks')
  if (parsed.blockSize === undefined) missingFields.push('blockSize')
  if (parsed.feedbackEnabled === undefined) missingFields.push('feedbackEnabled')

  if (missingFields.length > 0) {
    const errorMsg = `Malformed metadata: missing ${missingFields.join(', ')}`
    console.warn('[OfflineQRReceiver]', errorMsg, parsed)
    return { metadata: null, error: errorMsg }
  }

  // Build metadata with required fields (guaranteed to be defined after validation above)
  const metadata: DetectedMetadata = {
    name: parsed.fileName,
    size: parsed.fileSize,
    type: parsed.fileType,
    sessionId: parsed.sessionId,
    checksum: parsed.checksum,
    checksumAlg: parsed.checksumAlg,
    totalSourceBlocks: parsed.totalSourceBlocks as number,
    blockSize: parsed.blockSize as number,
    feedbackEnabled: parsed.feedbackEnabled as boolean,
  }

  // Add optional part-based fields only if defined
  if (parsed.partBasedMode !== undefined) {
    metadata.partBasedMode = parsed.partBasedMode
  }
  if (parsed.partSize !== undefined) {
    metadata.partSize = parsed.partSize
  }

  return { metadata, error: null }
}

export function OfflineQRReceiver() {
  const location = useLocation()
  const navigate = useNavigate()

  // Initialize metadata synchronously from location.state to avoid error flash
  const [{ detectedMetadata, metadataError }] = useState(() => {
    const { metadata, error } = parseLocationMetadata(location.state as LocationState | null)
    return { detectedMetadata: metadata, metadataError: error }
  })

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
              {metadataError || 'No metadata found. Please scan a metadata QR code first from the Scan page.'}
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

        <FountainQRReceiver initialMetadata={detectedMetadata} />
      </CardContent>
    </Card>
  )
}
