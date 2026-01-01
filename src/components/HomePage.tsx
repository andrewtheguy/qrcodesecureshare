import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

const features = [
  {
    icon: '🔲',
    title: 'Generate QR Code',
    description: 'Create QR codes from text instantly. Supports compression for longer content.',
    link: '/generate',
    buttonText: 'Generate',
    bgClass: 'bg-gradient-to-r from-amber-50 to-stone-100 hover:from-amber-100 hover:to-stone-200'
  },
  {
    icon: '📸',
    title: 'Scan QR Code',
    description: 'Scan QR codes using your camera or choose an image.',
    link: '/scan',
    buttonText: 'Scan',
    bgClass: 'bg-gradient-to-r from-emerald-50 to-teal-50 hover:from-emerald-100 hover:to-teal-100'
  },
  {
    icon: '📤',
    title: 'Offline File Transfer',
    description: 'Transfer files between devices using animated QR codes - no internet required.',
    link: '/transfer',
    buttonText: 'Transfer',
    bgClass: 'bg-gradient-to-r from-slate-100 to-blue-100 hover:from-slate-200 hover:to-blue-200'
  }
]

export default function HomePage() {
  return (
    <div className="min-h-[calc(100vh-4rem)] px-4 py-2 lg:py-8">
      {/* Hero Section */}
      <header className="py-4 md:py-12 max-w-3xl mx-auto">
        <div
          className="px-8 py-6 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200/70 shadow-sm text-center"
        >
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900">
            QR Secure Share
          </h1>
          <p className="text-lg text-slate-700 mt-4">
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
            className={`flex items-center gap-4 p-5 rounded-2xl border border-slate-200/70 shadow-sm hover:shadow-md transition-all ${feature.bgClass}`}
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
