import { Link } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

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
    <div className="min-h-[calc(100vh-4rem)] px-4 py-2 lg:py-8">
      {/* Hero Section */}
      <header className="text-center py-4 md:py-12">
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
          <Link key={feature.link} to={feature.link} className="block">
            <Card className="transition-all duration-200 hover:shadow-xl hover:-translate-y-1 shadow-lg h-full flex flex-col cursor-pointer">
              <CardHeader className="items-center text-center flex-1">
                <div className="text-4xl mb-2">{feature.icon}</div>
                <CardTitle className="text-xl">{feature.title}</CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto">
                <div className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md text-center font-medium">
                  {feature.buttonText}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
