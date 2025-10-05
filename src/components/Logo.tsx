export default function Logo({ className = "w-12 h-12" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* QR Code Grid Background */}
      <rect x="8" y="8" width="84" height="84" rx="10" fill="url(#bg-gradient)" />

      {/* Gradient Definitions */}
      <defs>
        <linearGradient id="bg-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="qr-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient id="lock-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
      </defs>

      {/* QR Code Corner Markers */}
      <g>
        {/* Top Left */}
        <rect x="14" y="14" width="22" height="22" rx="3" stroke="url(#qr-gradient)" strokeWidth="3" fill="none" />
        <rect x="20" y="20" width="10" height="10" rx="2" fill="url(#qr-gradient)" />

        {/* Top Right */}
        <rect x="64" y="14" width="22" height="22" rx="3" stroke="url(#qr-gradient)" strokeWidth="3" fill="none" />
        <rect x="70" y="20" width="10" height="10" rx="2" fill="url(#qr-gradient)" />

        {/* Bottom Left */}
        <rect x="14" y="64" width="22" height="22" rx="3" stroke="url(#qr-gradient)" strokeWidth="3" fill="none" />
        <rect x="20" y="70" width="10" height="10" rx="2" fill="url(#qr-gradient)" />
      </g>

      {/* QR Code Data Dots */}
      <g opacity="0.8">
        <rect x="42" y="16" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="49" y="16" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="56" y="16" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="42" y="23" width="5" height="5" rx="1.5" fill="#2563eb" />
        <rect x="56" y="23" width="5" height="5" rx="1.5" fill="#2563eb" />
        <rect x="42" y="30" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="16" y="42" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="23" y="42" width="5" height="5" rx="1.5" fill="#2563eb" />
        <rect x="16" y="49" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="23" y="56" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="64" y="42" width="5" height="5" rx="1.5" fill="#3b82f6" />
        <rect x="71" y="49" width="5" height="5" rx="1.5" fill="#2563eb" />
        <rect x="78" y="56" width="5" height="5" rx="1.5" fill="#3b82f6" />
      </g>

      {/* Lock Icon in Center */}
      <g transform="translate(50, 52)">
        {/* Lock Shackle */}
        <path
          d="M -10 -6 L -10 -12 C -10 -16 -6.5 -19 -2.5 -19 L 2.5 -19 C 6.5 -19 10 -16 10 -12 L 10 -6"
          stroke="url(#lock-gradient)"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
        />

        {/* Lock Body */}
        <rect
          x="-13"
          y="-6"
          width="26"
          height="20"
          rx="4"
          fill="url(#lock-gradient)"
        />

        {/* Keyhole */}
        <circle
          cx="0"
          cy="2"
          r="3.5"
          fill="white"
        />
        <rect
          x="-1.5"
          y="2"
          width="3"
          height="6"
          rx="1.5"
          fill="white"
        />
      </g>
    </svg>
  )
}
