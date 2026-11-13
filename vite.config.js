import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Official Chat — standalone frontend (separate Vercel project/domain from the
// JDLX Mobile storefront). No Capacitor, no storefront PWA shell here.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    emptyOutDir: true,
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
