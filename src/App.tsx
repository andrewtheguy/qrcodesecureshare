import { useState, useRef, useEffect } from 'react'
import { Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom'
import Upload from './components/Upload'
import Scan from './components/Scan'
import OfflineTransfer from './components/OfflineTransfer'
import Logo from './components/Logo'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import './App.css'
import './utils/generateKeys' // Load key generation utility

function App() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const location = useLocation()

  const tabs = [
    { path: "/", label: "Generate QR Code", icon: "🔲" },
    { path: "/scan", label: "Scan QR", icon: "📸" },
    { path: "/offline", label: "Upload File", icon: "📤" },
  ]

  const activeTabInfo = tabs.find(tab => {
    // For scan route, match both /scan/camera and /scan/upload
    if (tab.path === '/scan') {
      return location.pathname.startsWith('/scan')
    }
    // For offline route, match /offline, /offline/send and /offline/receive
    if (tab.path === '/offline') {
      return location.pathname.startsWith('/offline')
    }
    return location.pathname === tab.path
  }) || tabs[0]

  return (
    <div className="min-h-screen">
      {/* Navbar */}
      <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo/Brand */}
            <div className="flex items-center gap-3">
              <Logo />
              <h1 className="hidden md:block text-lg sm:text-xl font-bold text-foreground">
                QR Secure Share
              </h1>
            </div>

            {/* Mobile: Current Selection */}
            <div className="flex items-center gap-2 md:hidden">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground">
                <span className="text-lg">{activeTabInfo?.icon}</span>
                <span className="text-sm font-semibold">{activeTabInfo?.label}</span>
              </div>
            </div>

            {/* Mobile: Hamburger Menu */}
            <div className="md:hidden">
              <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-72">
                  <div className="flex flex-col gap-2 mt-8">
                    {tabs.map((tab) => (
                      <NavLink
                        key={tab.path}
                        to={tab.path}
                        onClick={() => setMobileMenuOpen(false)}
                        className={({ isActive }) => {
                          // For nested routes, also match nested paths
                          let active = isActive
                          if (tab.path === '/scan') {
                            active = location.pathname.startsWith('/scan')
                          } else if (tab.path === '/offline') {
                            active = location.pathname.startsWith('/offline')
                          }
                          return `px-4 py-3 rounded-md text-left font-medium transition-colors ${
                            active
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                          }`
                        }}
                      >
                        <span className="flex items-center gap-3">
                          <span className="text-xl">{tab.icon}</span>
                          <span>{tab.label}</span>
                        </span>
                      </NavLink>
                    ))}
                  </div>
                </SheetContent>
              </Sheet>
            </div>

            {/* Desktop Navigation Links */}
            <div className="hidden md:flex space-x-1">
              {tabs.map((tab) => (
                <NavLink
                  key={tab.path}
                  to={tab.path}
                  className={({ isActive }) => {
                    // For nested routes, also match nested paths
                    let active = isActive
                    if (tab.path === '/scan') {
                      active = location.pathname.startsWith('/scan')
                    } else if (tab.path === '/offline') {
                      active = location.pathname.startsWith('/offline')
                    }
                    return `px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-lg">{tab.icon}</span>
                    <span>{tab.label}</span>
                  </span>
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-2 py-4">
        <Routes>
          <Route path="/" element={<UploadWithState />} />
          <Route path="/upload" element={<Navigate to="/offline" replace />} />
          <Route path="/scan">
            <Route index element={<Navigate to="/scan/camera" replace />} />
            <Route path="camera" element={<ScanWithNavigation defaultMode="camera" />} />
            <Route path="upload" element={<ScanWithNavigation defaultMode="file" />} />
          </Route>
          <Route path="/offline">
            <Route index element={<OfflineTransfer defaultMode="select" />} />
            <Route path="send" element={<OfflineTransfer defaultMode="send" />} />
            <Route path="receive" element={<OfflineTransfer defaultMode="receive" />} />
          </Route>
        </Routes>
      </main>
    </div>
  )
}

// Wrapper component for Upload that handles location state
function UploadWithState() {
  const location = useLocation()
  const uploadRef = useRef<{ setTextFromScan: (text: string) => void }>(null)

  // Handle text passed from Scan component via navigation state
  useEffect(() => {
    const state = location.state as { text?: string } | null
    if (state?.text && uploadRef.current) {
      const text = state.text
      setTimeout(() => {
        uploadRef.current?.setTextFromScan(text)
      }, 100)
    }
  }, [location.state])

  return <Upload ref={uploadRef} />
}

// Wrapper component for Scan that handles navigation to Generate
function ScanWithNavigation({ defaultMode }: { defaultMode?: 'camera' | 'file' }) {
  const navigate = useNavigate()

  const handleGenerateQR = (text: string) => {
    navigate('/', { state: { text } })
  }

  return <Scan onGenerateQR={handleGenerateQR} defaultMode={defaultMode} />
}

export default App
