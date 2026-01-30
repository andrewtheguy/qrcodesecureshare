import { Link } from 'react-router-dom'
import { Button, buttonVariants } from '@/components/ui/button'
import Logo from '@/components/Logo'
import { cn } from '@/lib/utils'

const features = [
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
    <div className="min-h-[calc(100vh-4rem)]">
      {/* Hero Section */}
      <div className="relative isolate overflow-hidden bg-white">
        {/* Background Pattern */}
        <svg
          className="absolute inset-0 -z-10 h-full w-full stroke-slate-200 [mask-image:radial-gradient(100%_100%_at_top_right,white,transparent)]"
          aria-hidden="true"
        >
          <defs>
            <pattern
              id="hero-pattern"
              width={40}
              height={40}
              x="50%"
              y={-1}
              patternUnits="userSpaceOnUse"
            >
              <path d="M.5 40V.5H40" fill="none" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" strokeWidth={0} fill="url(#hero-pattern)" />
        </svg>
        
        {/* Gradient Blobs */}
        <div
          className="absolute left-[calc(50%-11rem)] top-0 -z-10 transform-gpu blur-3xl sm:left-[calc(50%-30rem)]"
          aria-hidden="true"
        >
          <div
            className="aspect-[1155/678] w-[36.125rem] -translate-x-1/2 bg-gradient-to-tr from-[#ff80b5] to-[#9089fc] opacity-20 sm:left-[calc(50%-30rem)]"
            style={{
              clipPath:
                'polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)',
            }}
          />
        </div>
        <div
          className="absolute right-[calc(50%-4rem)] top-10 -z-10 transform-gpu blur-3xl sm:left-[calc(50%+36rem)]"
          aria-hidden="true"
        >
          <div
            className="aspect-[1155/678] w-[36.125rem] -translate-x-1/2 bg-gradient-to-tr from-[#80ffdb] to-[#3a86ff] opacity-20"
            style={{
              clipPath:
                'polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)',
            }}
          />
        </div>

        <div className="px-6 py-12 md:py-20 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="flex justify-center mb-6">
               <div className="p-3 bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm ring-1 ring-slate-900/5">
                <Logo className="w-16 h-16" />
              </div>
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
              QR Secure Share
            </h1>
            <p className="mt-4 text-lg leading-7 text-slate-600">
              Generate, scan, and transfer data securely using QR codes.
              <span className="block mt-1 font-medium text-slate-900">
                Works completely offline with client-side only processing.
              </span>
              <span className="block mt-1 text-sm text-slate-500 italic">
                Processed entirely on your device — nothing is ever sent to a server.
              </span>
            </p>
            <div className="mt-8 flex items-center justify-center gap-x-4">
              <Button asChild size="lg" className="rounded-full w-36 sm:w-44 h-12 text-base font-semibold shadow-md hover:shadow-lg transition-all">
                <Link to="/generate">🔲 Generate <span className="hidden sm:inline">QR</span></Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full w-36 sm:w-44 h-12 text-base font-semibold bg-white/50 backdrop-blur-sm shadow-sm hover:shadow-md transition-all">
                <Link to="/scan">📸 Scan <span className="hidden sm:inline">QR</span></Link>
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto flex flex-col gap-4 px-4 py-8 lg:pb-16">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2 px-2">Advanced Features</h2>
        {features.map((feature) => (
          <Button
            key={feature.link}
            asChild
            variant="ghost"
            className={cn(
              "flex items-center gap-4 p-5 rounded-2xl border border-slate-200/70 shadow-sm hover:shadow-md transition-all h-auto w-full justify-start",
              feature.bgClass
            )}
          >
            <Link to={feature.link}>
              <div className="text-3xl flex-shrink-0">{feature.icon}</div>
              <div className="flex-1 min-w-0 text-left">
                <h3 className="font-semibold text-lg text-slate-900">{feature.title}</h3>
                <p className="text-slate-600 text-sm whitespace-normal">{feature.description}</p>
              </div>
              <div className={cn(buttonVariants(), "flex-shrink-0 w-24 hidden sm:flex")}>
                {feature.buttonText}
              </div>
            </Link>
          </Button>
        ))}
      </div>
    </div>
  )
}
