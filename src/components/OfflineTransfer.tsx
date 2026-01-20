import OfflineQRTransfer from './OfflineQRTransfer'

interface OfflineTransferProps {
  defaultMode?: 'select' | 'send' | 'receive'
}

export default function OfflineTransfer({ defaultMode = 'select' }: OfflineTransferProps) {
  return (
    <div className="max-w-4xl mx-auto p-4">
      {/* Unified Transfer Interface */}
      <OfflineQRTransfer defaultMode={defaultMode} />
    </div>
  )
}
