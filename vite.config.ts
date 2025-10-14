import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { copyFileSync } from 'fs'
import { resolve } from 'path'
import path from 'path'
import tailwindcss from "@tailwindcss/vite"

// Custom plugin to copy QR scanner worker
const copyQrWorkerPlugin = () => {
  return {
    name: 'copy-qr-worker',
    buildStart() {
      // Copy QR scanner worker to public directory during build
      try {
        const workerSrc = resolve('node_modules/qr-scanner/qr-scanner-worker.min.js')
        const workerDest = resolve('public/qr-scanner-worker.min.js')
        copyFileSync(workerSrc, workerDest)
        console.log('✓ Copied QR scanner worker to public directory')
      } catch (error) {
        console.warn('⚠ Failed to copy QR scanner worker:', (error as Error).message)
      }
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: true,
    allowedHosts: [
      'localhost',
      '.trycloudflare.com'
    ],
    // Disable all caching in development
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    },
    // Disable HMR
    hmr: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      external: ['src/utils/fountainCode.legacy.ts'],
    },
  },
  plugins: [
    copyQrWorkerPlugin(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}']
      },
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
      manifest: {
        name: 'QR Code Secure Data Share',
        short_name: 'QR Code Share',
        description: 'Progressive Web App for QR Code Secure Data Share with encrypted file upload for large data.',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ],
})
