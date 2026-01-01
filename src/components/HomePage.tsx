import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

const features = [
  {
    icon: '🔲',
    title: 'Generate QR Code',
    description: 'Create QR codes from text instantly. Supports compression for longer content.',
    link: '/generate',
    buttonText: 'Generate'
  },
  {
    icon: '📸',
    title: 'Scan QR Code',
    description: 'Scan QR codes using your camera or choose an image.',
    link: '/scan',
    buttonText: 'Scan'
  },
  {
    icon: '📤',
    title: 'Offline File Transfer',
    description: 'Transfer files between devices using animated QR codes - no internet required.',
    link: '/transfer',
    buttonText: 'Transfer'
  }
]

export default function HomePage() {
  return (
    <div className="min-h-[calc(100vh-4rem)] px-4 py-2 lg:py-8">
      {/* Hero Section */}
      <header className="py-4 md:py-12 max-w-3xl mx-auto">
        <div className="px-8 py-6 rounded-2xl bg-white/80 border border-slate-200/70 shadow-sm backdrop-blur-sm text-center">
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900">
            QR Secure Share
          </h1>
          <p className="text-lg text-slate-600 mt-4">
            Generate, scan, and transfer data securely using QR codes.
            Works completely offline with client-side processing.
          </p>
        </div>
      </header>

      {/* Feature List */}
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        {features.map((feature) => (
          <Link
            key={feature.link}
            to={feature.link}
            className="flex items-center gap-4 p-5 rounded-2xl bg-white/80 border border-slate-200/70 shadow-sm backdrop-blur-sm hover:bg-slate-50/80 hover:shadow-md transition-all"
          >
            <div className="text-3xl flex-shrink-0">{feature.icon}</div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-lg text-slate-900">{feature.title}</h3>
              <p className="text-slate-600 text-sm">{feature.description}</p>
            </div>
            <Button className="flex-shrink-0 w-24">{feature.buttonText}</Button>
          </Link>
        ))}
      </div>
    </div>
  )
}
