import { useState, useCallback } from 'react'
import OfflineQRTransfer from './OfflineQRTransfer'

interface OfflineTransferProps {
  defaultMode?: 'select' | 'send' | 'receive'
}

export default function OfflineTransfer({ defaultMode = 'select' }: OfflineTransferProps) {
  const [, setIsTransferActive] = useState(defaultMode !== 'select')

  const handleModeChange = useCallback((mode: 'select' | 'send' | 'receive') => {
    setIsTransferActive(mode !== 'select')
  }, [])

  return (
    <div className="max-w-4xl mx-auto p-4">
      {/* Unified Transfer Interface */}
      <OfflineQRTransfer defaultMode={defaultMode} onModeChange={handleModeChange} />
    </div>
  )
}