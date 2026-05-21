import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import tailwindcss from "@tailwindcss/vite"

// @ts-expect-error - vite-plugin-eslint has type definition issues with package.json exports
import eslint from 'vite-plugin-eslint'


// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  server: {
    host: true,
    allowedHosts: [
      'localhost',
      '.trycloudflare.com'
    ],
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
    format: 'es' as const,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    eslint({
      // Optional: Configure eslint plugin behavior
      // failOnWarning: false, // Don't fail the build on warnings
      failOnError: true,   // Fail the build on errors
      // cache: false,        // Disable cache for faster linting during development
    }),
    ...(command === 'build' ? [VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Cache all static assets including workers and WASM
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,wasm}'],
        // Increase max file size cap for cached WASM modules
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
      },
      manifest: {
        name: 'QR Code Secure Share',
        short_name: 'QR Secure',
        description: 'QR Scanner with secure file transfer via QR codes offline',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    })] : []),
  ],
  // Testing Recommendations:
  // 1. Run `npm run build` and check the `dist` directory for worker chunks
  // 2. Look for files like `fountainDecoder.worker-[hash].js` and `qrGenerator.worker-[hash].js`
  // 3. Test in production build using `npm run preview`
  // 4. Verify workers load correctly in builds
  // 5. Check browser DevTools Network tab to confirm workers are loaded
}))
