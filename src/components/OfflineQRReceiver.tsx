import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FountainQRReceiver } from './fountain_qr/FountainQRReceiver'
import { ArrowLeft, Download, FileText, AlertCircle } from 'lucide-react'

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
    totalSourceBlocks: parsed.totalSourceBlocks!,
    blockSize: parsed.blockSize!,
    feedbackEnabled: parsed.feedbackEnabled!,
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
      <Card className="border-destructive/50">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-2">
            <div className="p-3 rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="w-8 h-8" />
            </div>
          </div>
          <CardTitle className="text-xl">Missing Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>
              {metadataError || 'No file metadata found. Please scan the sender\'s metadata QR code first.'}
            </AlertDescription>
          </Alert>
          <Button onClick={() => navigate('/scan/camera')} className="w-full">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Return to Scan
          </Button>
        </CardContent>
      </Card>
    )
  }

  // Show receiver component
  return (
    <Card className="overflow-hidden border-primary/20 shadow-lg">
      <CardHeader className="bg-muted/10 pb-4 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="p-2 rounded-full bg-primary/10 text-primary">
                <Download className="w-5 h-5" />
             </div>
             <div>
                <CardTitle className="text-lg">Receiving File</CardTitle>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-0.5">
                   <FileText className="w-3 h-3" />
                   <span className="font-medium truncate max-w-[150px]">{detectedMetadata.name}</span>
                   <span className="opacity-50">•</span>
                   <span>{(detectedMetadata.size / 1024).toFixed(2)} KB</span>
                </div>
             </div>
          </div>
          
          <Button
            onClick={() => navigate('/scan/camera')}
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            title="Cancel & Return"
          >
             <ArrowLeft className="w-4 h-4 mr-2" />
             Back
          </Button>
        </div>
      </CardHeader>
      
      <CardContent className="p-0">
        {/* Wrapper for the actual logic component which we don't touch */}
        <div className="p-4">
           <FountainQRReceiver initialMetadata={detectedMetadata} />
        </div>
      </CardContent>
    </Card>
  )
}