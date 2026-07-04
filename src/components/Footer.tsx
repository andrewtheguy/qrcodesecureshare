import { BUILD_TIME, GIT_BRANCH, GIT_COMMIT_HASH } from '@/lib/app-version'

const buildDate = new Date(BUILD_TIME)
const buildLabel = Number.isNaN(buildDate.getTime())
  ? BUILD_TIME
  : buildDate.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })

export default function Footer() {
  return (
    <footer className="w-full border-t border-white/10 bg-transparent mt-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-6 py-4 text-xs text-muted-foreground">
        <span>QR Secure Share</span>
        <span aria-hidden="true">·</span>
        <span className="font-mono">{`${GIT_BRANCH}@${GIT_COMMIT_HASH}`}</span>
        <span aria-hidden="true">·</span>
        <span>{`built ${buildLabel}`}</span>
      </div>
    </footer>
  )
}
