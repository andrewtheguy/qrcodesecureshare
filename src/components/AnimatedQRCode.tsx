import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SequentialQRSender } from './SequentialQRSender'
import { FountainQRSender } from './FountainQRSender'

interface AnimatedQRCodeProps {
  file: File | null
  onReset?: () => void
}

export const MAX_FILE_SIZE = 512 * 1024 // 512KB

type TransferMode = 'sequential' | 'fountain'

export function AnimatedQRCode({ file, onReset }: AnimatedQRCodeProps) {
  const [transferMode, setTransferMode] = useState<TransferMode | null>(null)
  const [error, setError] = useState<string>('')

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
  if (!transferMode) {
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
            onClick={() => setTransferMode('sequential')}
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
            onClick={() => setTransferMode('fountain')}
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

  // Show selected transfer mode component
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
        <div className="flex gap-2">
          <Button
            onClick={() => setTransferMode(null)}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            ← Change Mode
          </Button>
          {onReset && (
            <Button onClick={onReset} variant="outline" size="sm" className="flex-1">
              Different File
            </Button>
          )}
        </div>

        {/* Render appropriate sender component */}
        {transferMode === 'sequential' ? (
          <SequentialQRSender file={file} />
        ) : (
          <FountainQRSender file={file} />
        )}
      </CardContent>
    </Card>
  )
}
