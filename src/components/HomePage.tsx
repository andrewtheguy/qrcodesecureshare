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
    <div className="space-y-8">
      {/* Hero Section */}
      <header className="text-center space-y-4 py-8">
        <h1 className="text-4xl font-bold">QR Secure Share</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Generate, scan, and transfer data securely using QR codes.
          Works completely offline with client-side processing.
        </p>
      </header>

      {/* Feature Cards Grid */}
      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}
      >
        {features.map((feature) => (
          <Card
            key={feature.link}
            className="transition-all duration-200 hover:shadow-lg hover:-translate-y-1"
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
