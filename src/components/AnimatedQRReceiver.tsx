import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SequentialQRReceiver } from './SequentialQRReceiver'
import { FountainQRReceiver } from './FountainQRReceiver'

type TransferMode = 'sequential' | 'fountain' | null

export function AnimatedQRReceiver() {
  const [transferMode, setTransferMode] = useState<TransferMode>(null)

  // Mode selection screen
  if (!transferMode) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-center">Select Receiving Mode</CardTitle>
          <p className="text-sm text-muted-foreground text-center">
            Choose the same mode the sender is using
          </p>
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
              • Receives chunks in order (1, 2, 3...)<br/>
              • Needs ALL chunks to complete<br/>
              • Can request missing chunks via feedback QR<br/>
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
              • Receives random coded chunks<br/>
              • Only needs ~110% of chunks to decode<br/>
              • Can skip/miss chunks and still succeed<br/>
              • Best for unreliable connections
            </div>
          </Button>
        </CardContent>
      </Card>
    )
  }

  // Show selected receiver component
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-center">
          {transferMode === 'sequential' ? '📋 Sequential Receiver' : '🔁 Fountain Code Receiver'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode Switch Button */}
        <Button
          onClick={() => setTransferMode(null)}
          variant="outline"
          size="sm"
          className="w-full"
        >
          ← Change Mode
        </Button>

        {/* Render appropriate receiver component */}
        {transferMode === 'sequential' ? (
          <SequentialQRReceiver />
        ) : (
          <FountainQRReceiver />
        )}
      </CardContent>
    </Card>
  )
}
