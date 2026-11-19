import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ChatErrorBoundary from './ChatErrorBoundary.jsx'
import './index.css'

// Standalone JDLX Official Chat app — completely separate from the storefront.
// This document/app shares zero auth state with jdlxmobile.in.

// Auto-heal dynamic chunk preload errors (prevents blank screen after new bundle builds).
// Guard against a reload loop: if the freshly loaded bundle still references a
// missing chunk (bad CDN/proxy cache), reloading forever would trap the user.
const CHUNK_RELOAD_KEY = 'jdlx_chunk_reloaded'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  try {
    const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0)
    if (Date.now() - lastReload < 15000) return
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  } catch {
    // sessionStorage unavailable (private mode/quota): still attempt one reload.
  }
  window.location.reload()
})

if ('serviceWorker' in navigator && !import.meta.env.PROD) {
  // In development, automatically unregister any stale service workers to ensure 100% fresh Vite HMR
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister().catch(() => {})
    }
  }).catch(() => {})
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true
      window.location.reload()
    }
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update().catch(() => {})
    }).catch((err) => {
      console.warn('JDLX Chat SW registration error:', err)
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ChatErrorBoundary>
      <App />
    </ChatErrorBoundary>
  </React.StrictMode>,
)
