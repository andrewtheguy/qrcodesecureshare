import { Link } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const features = [
  {
    icon: '🔲',
    title: 'Generate QR Code',
    description: 'Create QR codes from text instantly. Supports compression for longer content and generates scannable codes in seconds.',
    link: '/generate',
    buttonText: 'Generate QR'
  },
  {
    icon: '📸',
    title: 'Scan QR Code',
    description: 'Scan QR codes using your camera or upload an image. Automatically detects compressed content and extracts data.',
    link: '/scan',
    buttonText: 'Scan QR'
  },
  {
    icon: '📤',
    title: 'Offline File Transfer',
    description: 'Transfer files between devices using animated QR codes - no internet required. Uses fountain codes for reliable delivery.',
    link: '/offline',
    buttonText: 'Transfer Files'
  }
]

export default function HomePage() {
  return (
    <div className="min-h-[calc(100vh-4rem)] px-4 py-8">
      {/* Hero Section */}
      <header className="text-center py-12">
        <div className="inline-block px-8 py-6 rounded-2xl bg-white/80 border border-slate-200/70 shadow-sm backdrop-blur-sm">
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900">
            QR Secure Share
          </h1>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto mt-4">
            Generate, scan, and transfer data securely using QR codes.
            Works completely offline with client-side processing.
          </p>
        </div>
      </header>

      {/* Feature Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        {features.map((feature) => (
          <Card
            key={feature.link}
            className="transition-all duration-200 hover:shadow-xl hover:-translate-y-1 shadow-lg"
          >
            <CardHeader>
              <div className="text-4xl mb-2">{feature.icon}</div>
              <CardTitle className="text-xl">{feature.title}</CardTitle>
              <CardDescription>{feature.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="w-full">
                <Link to={feature.link}>{feature.buttonText}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
