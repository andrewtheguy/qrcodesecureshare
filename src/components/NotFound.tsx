import { Link, useLocation } from 'react-router-dom'
import Logo from '@/components/Logo'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  const location = useLocation()

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-6 py-12">
      <div className="mx-auto max-w-md text-center">
        <div className="flex justify-center mb-6">
          <div className="p-3 bg-white/80 backdrop-blur-sm rounded-2xl shadow-sm ring-1 ring-slate-900/5">
            <Logo className="w-16 h-16" />
          </div>
        </div>
        <p className="text-sm font-semibold text-slate-400 uppercase tracking-wider">404</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          Page not found
        </h1>
        <p className="mt-4 text-base leading-7 text-slate-600">
          We couldn't find <span className="font-mono text-slate-900 break-all">{location.pathname}</span>.
          The page may have moved or never existed.
        </p>
        <div className="mt-8 flex items-center justify-center gap-x-4">
          <Button asChild size="lg" className="rounded-full h-12 px-6 text-base font-semibold shadow-md hover:shadow-lg transition-all">
            <Link to="/">🏠 Go home</Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="rounded-full h-12 px-6 text-base font-semibold bg-white/50 backdrop-blur-sm shadow-sm hover:shadow-md transition-all">
            <Link to="/scan">📸 Scan QR</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
