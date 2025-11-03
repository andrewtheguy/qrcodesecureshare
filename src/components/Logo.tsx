export default function Logo({ className = "w-12 h-12" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Dark Background */}
      <rect width="100" height="100" fill="#000000" />

      {/* QR Code Corner Markers */}
      <g>
        {/* Top Left */}
        <rect x="12" y="12" width="24" height="24" fill="#ffffff" />
        <rect x="16" y="16" width="16" height="16" fill="#000000" />
        <rect x="20" y="20" width="8" height="8" fill="#ffffff" />

        {/* Top Right */}
        <rect x="64" y="12" width="24" height="24" fill="#ffffff" />
        <rect x="68" y="16" width="16" height="16" fill="#000000" />
        <rect x="72" y="20" width="8" height="8" fill="#ffffff" />

        {/* Bottom Left */}
        <rect x="12" y="64" width="24" height="24" fill="#ffffff" />
        <rect x="16" y="68" width="16" height="16" fill="#000000" />
        <rect x="20" y="72" width="8" height="8" fill="#ffffff" />
      </g>

      {/* QR Code Data Dots */}
      <g>
        <rect x="42" y="16" width="4" height="4" fill="#ffffff" />
        <rect x="48" y="16" width="4" height="4" fill="#ffffff" />
        <rect x="54" y="16" width="4" height="4" fill="#ffffff" />
        <rect x="42" y="22" width="4" height="4" fill="#ffffff" />
        <rect x="54" y="22" width="4" height="4" fill="#ffffff" />
        <rect x="42" y="28" width="4" height="4" fill="#ffffff" />
        <rect x="16" y="42" width="4" height="4" fill="#ffffff" />
        <rect x="22" y="42" width="4" height="4" fill="#ffffff" />
        <rect x="16" y="48" width="4" height="4" fill="#ffffff" />
        <rect x="22" y="54" width="4" height="4" fill="#ffffff" />
        <rect x="64" y="42" width="4" height="4" fill="#ffffff" />
        <rect x="70" y="48" width="4" height="4" fill="#ffffff" />
        <rect x="76" y="54" width="4" height="4" fill="#ffffff" />
      </g>

      {/* Lock Icon in Center */}
      <g transform="translate(50, 52)">
        {/* Lock Shackle */}
        <path
          d="M -9 -5 L -9 -11 C -9 -15 -6 -18 -2 -18 L 2 -18 C 6 -18 9 -15 9 -11 L 9 -5"
          stroke="#ffffff"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />

        {/* Lock Body */}
        <rect
          x="-12"
          y="-5"
          width="24"
          height="18"
          rx="3"
          fill="#ffffff"
        />

        {/* Keyhole */}
        <circle
          cx="0"
          cy="2"
          r="3"
          fill="#000000"
        />
        <rect
          x="-1.5"
          y="2"
          width="3"
          height="5"
          rx="1.5"
          fill="#000000"
        />
      </g>
    </svg>
  )
}
