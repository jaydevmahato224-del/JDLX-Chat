import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ChatErrorBoundary from './ChatErrorBoundary.jsx'
import './index.css'

// Standalone JDLX Official Chat app — completely separate from the storefront.
// This document/app shares zero auth state with jdlxmobile.in.

// Auto-heal dynamic chunk preload errors (prevents blank screen after new bundle builds)
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
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
