import { Alert, AlertDescription } from '@/components/ui/alert'

interface OfflineMetadataDetailsProps {
  metadata: {
    fileName: string
    fileSize: number
    totalSourceBlocks: number
  }
}

export function OfflineMetadataDetails({ metadata }: OfflineMetadataDetailsProps) {
  const estimatedChunks = Math.ceil(metadata.totalSourceBlocks * 1.1)

  return (
    <div className="space-y-3">
      {/* File Info */}
      <Alert>
        <AlertDescription>
          <div className="space-y-2">
            <p className="font-medium text-lg">{metadata.fileName}</p>
            <div className="text-sm text-muted-foreground space-y-1">
              <p>📦 Size: {(metadata.fileSize / 1024).toFixed(2)}KB</p>
              <p>🔢 Source Blocks: {metadata.totalSourceBlocks}</p>
              <p>📊 Est. Chunks Needed: ~{estimatedChunks}</p>
            </div>
          </div>
        </AlertDescription>
      </Alert>

      {/* Mode Info */}
      <Alert>
        <AlertDescription>
          <p className="font-medium mb-2">🔁 Fountain Code Mode</p>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Receives random coded chunks</li>
            <li>Only needs ~110% of chunks to decode</li>
            <li>Can skip/miss chunks and still succeed</li>
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  )
}
