import { Info } from 'lucide-react'
import { APP_VERSION, GIT_COMMIT_HASH } from '@/lib/app-version'

export default function Footer() {
  return (
    <footer className="w-full border-t border-white/10 bg-transparent mt-auto">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-center px-6 py-4 text-xs text-muted-foreground">
        <details className="group relative">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm px-0.5 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span>{`v${APP_VERSION}`}</span>
            <Info className="h-3.5 w-3.5" />
          </summary>
          <div className="absolute bottom-full left-1/2 mb-2 w-[280px] -translate-x-1/2 rounded-md border border-white/10 bg-background p-2 text-xs leading-relaxed shadow-md">
            Compatibility is not expected between v0.0.x versions. Sender and
            receiver should use the same app version.
            <div className="mt-1 text-muted-foreground">{`v${APP_VERSION} (${GIT_COMMIT_HASH})`}</div>
          </div>
        </details>
      </div>
    </footer>
  )
}
