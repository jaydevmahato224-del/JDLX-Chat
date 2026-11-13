import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// Official Chat — standalone frontend (separate Vercel project/domain from the
// JDLX Mobile storefront). No Capacitor, no storefront PWA shell here.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // Stamp the service worker cache with a per-build id so every deploy
      // invalidates the previous app shell. Falls back to a static name if the
      // file cannot be read, which keeps the build usable either way.
      name: 'sw-build-version',
      apply: 'build',
      closeBundle() {
        try {
          const buildId =
            (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 10) || String(Date.now())
          const swPath = 'dist/sw.js'
          const source = readFileSync(swPath, 'utf8')
          writeFileSync(swPath, source.replaceAll('__BUILD_ID__', buildId))
        } catch {
          /* non-fatal: sw keeps its static cache name */
        }

        // The CSP in vercel.json pins the inline theme script by SHA-256. If
        // that script ever changes without updating the hash, the browser would
        // silently block it. Fail the build instead of shipping a broken CSP.
        try {
          const html = readFileSync('dist/index.html', 'utf8')
          const inline = /<script>([\s\S]*?)<\/script>/.exec(html)
          const csp = readFileSync('vercel.json', 'utf8')
          const pinned = /sha256-([A-Za-z0-9+/=]+)/.exec(csp)
          if (inline && pinned) {
            const actual = createHash('sha256').update(inline[1]).digest('base64')
            if (actual !== pinned[1]) {
              throw new Error(
                `CSP hash mismatch: inline theme script hashes to sha256-${actual}. ` +
                  'Update the Content-Security-Policy in vercel.json.'
              )
            }
          }
        } catch (error) {
          if (String(error?.message).startsWith('CSP hash mismatch')) throw error
        }
      }
    }
  ],
  build: {
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep the rarely-changing framework and auth SDK in their own long-lived
        // chunks so an app-code deploy does not invalidate the whole bundle.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('react-router')) return 'router'
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) {
            return 'react-vendor'
          }
          return undefined
        }
      }
    }
  },
  server: {
    port: 5177,
    host: true,
  },
  preview: {
    port: 5177,
    host: true,
  },
})
