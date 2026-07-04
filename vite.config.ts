import path from 'node:path'
import tailwindcss from "@tailwindcss/vite"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

function getGitCommitHash(): string {
  // Cloudflare Pages exposes the deployed commit via this env var. Local builds
  // fall back to a placeholder to avoid confusion about which commit is running.
  const cfSha = process.env.CF_PAGES_COMMIT_SHA
  return cfSha ? cfSha.slice(0, 7) : 'local'
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __GIT_COMMIT_HASH__: JSON.stringify(getGitCommitHash()),
  },
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
