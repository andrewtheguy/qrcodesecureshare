import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import tailwindcss from "@tailwindcss/vite"
import { VitePWA } from 'vite-plugin-pwa'

// @ts-expect-error - vite-plugin-eslint has type definition issues with package.json exports
import eslint from 'vite-plugin-eslint'

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
export default defineConfig(({ mode }) => ({
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
    verifyWorkerBuildPlugin(),
    react(),
    tailwindcss(),
    eslint({
      // Optional: Configure eslint plugin behavior
      // failOnWarning: false, // Don't fail the build on warnings
      failOnError: true,   // Fail the build on errors
      // cache: false,        // Disable cache for faster linting during development
    }),
    // PWA plugin - only enabled in production builds
    ...(mode === 'production' ? [VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icon.svg', 'icon-ios.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'QR Code Secure Share',
        short_name: 'QR Secure',
        description: 'Secure file transfer via QR codes with offline support',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png'
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // Network-first strategy: Always try network first, fallback to cache
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
              },
              networkTimeoutSeconds: 10
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              }
            }
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images-cache',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
              }
            }
          }
        ],
        // Skip waiting and claim clients for immediate updates
        skipWaiting: true,
        clientsClaim: true
      },
      devOptions: {
        enabled: false // Explicitly disable in development
      }
    })] : [])
  ],
  // Testing Recommendations:
  // 1. Run `npm run build` and check the `dist` directory for worker chunks
  // 2. Look for files like `fountainDecoder.worker-[hash].js` and `qrGenerator.worker-[hash].js`
  // 3. Test in production build using `npm run preview`
  // 4. Verify workers load correctly in builds
  // 5. Check browser DevTools Network tab to confirm workers are loaded
  // 6. For PWA: Check Application tab in DevTools for service worker and manifest
}))
