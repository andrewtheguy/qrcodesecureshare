import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { copyFileSync } from 'fs'
import { resolve } from 'path'

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
        console.warn('⚠ Failed to copy QR scanner worker:', error.message)
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
    ]
  },
  plugins: [
    copyQrWorkerPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}']
      },
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
      manifest: {
        name: 'File Upload PWA',
        short_name: 'FileUpload',
        description: 'Progressive Web App for uploading files to tmpfiles.org',
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
