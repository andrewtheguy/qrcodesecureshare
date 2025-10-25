import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync } from 'fs'
import { resolve } from 'path'
import path from 'path'
import tailwindcss from "@tailwindcss/vite"
import { VitePWA } from 'vite-plugin-pwa'

// @ts-expect-error - vite-plugin-eslint has type definition issues with package.json exports
import eslint from 'vite-plugin-eslint'

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

// Custom plugin to verify worker build output
const verifyWorkerBuildPlugin = () => {
  interface RollupChunk {
    type: 'chunk'
    facadeModuleId?: string
    fileName: string
    code: string
  }

  return {
    name: 'verify-worker-build',
    writeBundle(options: unknown, bundle: Record<string, unknown>) {
      const workerChunks: [string, RollupChunk][] = []
      for (const [_key, chunk] of Object.entries(bundle)) {
        if (typeof chunk === 'object' && chunk !== null && 'type' in chunk && chunk.type === 'chunk') {
          const chunkObj = chunk as RollupChunk
          if (typeof chunkObj.facadeModuleId === 'string' && /src\/workers\/.+\.worker\.(t|j)sx?$/.test(chunkObj.facadeModuleId)) {
            workerChunks.push([_key, chunkObj])
          }
        }
      }
      if (workerChunks.length > 0) {
        console.log('✓ Worker chunks found in build output:')
        workerChunks.forEach(([, chunk]) => {
          const size = chunk.code.length / 1024
          console.log(`  - ${chunk.fileName} (${size.toFixed(2)} KB)`)
        })
      } else {
        console.warn('⚠ No worker chunks found in build output')
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
      // Configure chunk naming for predictable worker chunk names
      // Workers are automatically split into separate chunks by Vite
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  // Explicit worker configuration for consistency and clarity
  // Workers are handled automatically by Vite's built-in support with ?worker suffix
  // This configuration ensures ES module format for better performance
  // Note: fountainDecoder.worker.ts and qrGenerator.worker.ts dependencies (fountainCode, checksum)
  // are properly bundled and not externalized, ensuring workers are self-contained
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  plugins: [
    copyQrWorkerPlugin(),
    verifyWorkerBuildPlugin(),
    react(),
    tailwindcss(),
    eslint({
      // Optional: Configure eslint plugin behavior
      // failOnWarning: false, // Don't fail the build on warnings
      failOnError: true,   // Fail the build on errors
      // cache: false,        // Disable cache for faster linting during development
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icon.svg', 'vite.svg', 'qr-scanner-worker.min.js'],
      manifest: {
        name: 'QR Code Secure Data Share',
        short_name: 'QR Share',
        description: 'Securely share data using QR codes with end-to-end encryption',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          },
          {
            src: '/favicon.ico',
            sizes: '16x16',
            type: 'image/x-icon'
          }
        ]
      },
      workbox: {
        // Cache all static assets
        globPatterns: ['**/*.{js,css,html,ico,svg,woff,woff2}'],
        // Maximum cache size (50MB)
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024,
        // Runtime caching strategies
        runtimeCaching: [
          {
            // Cache all JavaScript modules including workers
            urlPattern: /^.*\.(js|mjs)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'js-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Cache CSS files
            urlPattern: /^.*\.css$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'css-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              }
            }
          },
          {
            // Cache images
            urlPattern: /^.*\.(png|jpg|jpeg|svg|gif|webp|ico)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              }
            }
          },
          {
            // Network first for HTML pages with long cache for offline use
            urlPattern: /^.*\.html$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year - maximize offline time
              },
              networkTimeoutSeconds: 3 // Fallback to cache quickly if network is slow/offline
            }
          }
        ],
        // Skip waiting to activate new service worker immediately
        skipWaiting: true,
        clientsClaim: true,
        // Clean up old caches
        cleanupOutdatedCaches: true
      },
      devOptions: {
        enabled: false, // Disable PWA in development to avoid caching issues
        type: 'module'
      }
    })
  ],
  // Testing Recommendations:
  // 1. Run `npm run build` and check the `dist` directory for worker chunks
  // 2. Look for files like `fountainDecoder.worker-[hash].js` and `qrGenerator.worker-[hash].js`
  // 3. Test in production build using `npm run preview`
  // 4. Verify workers load correctly in both online and offline (PWA) modes
  // 5. Check browser DevTools Network tab to confirm workers are loaded and cached
})
