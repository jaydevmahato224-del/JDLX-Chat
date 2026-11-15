import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from './store/useChatStore'
import { initChatNativePush, syncChatPushToken } from './utils/nativePush'

// Route-level code splitting: the login screen no longer downloads the ~10k-line
// chat screen (and QRCode/emoji/lightbox code) before the user is authenticated.
const ChatLogin = lazy(() => import('./pages/ChatLogin'))
const ChatConversation = lazy(() => import('./pages/ChatConversation'))
const RecoveryPinModal = lazy(() => import('./components/RecoveryPinModal'))

// Standalone Official Chat — routes only exist for this app; the JDLX Store is
// a separate frontend (external link back to the store opens a new tab).
function App() {
  const {
    chatToken,
    chatUser,
    resolvedChatTheme,
    setSystemPrefersDark,
    fetchChatBranding,
    initRealtimeAuth
  } = useChatStore(useShallow((state) => state))

  // Load the official room branding once (Fetch official chat name & logo)
  useEffect(() => {
    fetchChatBranding()
  }, [fetchChatBranding])

  // Private Realtime channels: fetch the short-lived Supabase JWT once per
  // session. No-op when VITE_SUPABASE_PRIVATE_CHANNELS is not enabled.
  useEffect(() => {
    if (!chatToken || !chatUser?.id) return undefined
    initRealtimeAuth().catch(() => {})
    return undefined
  }, [chatToken, chatUser?.id, initRealtimeAuth])

  // Native FCM registration (no-op on the web). The token is re-reported on
  // every login/account switch so pushes always target the current chat user.
  useEffect(() => {
    if (!chatToken || !chatUser?.id) return undefined
    let cancelled = false
    initChatNativePush().then(() => {
      if (!cancelled) syncChatPushToken()
    })
    return () => { cancelled = true }
  }, [chatToken, chatUser?.id])

  // Follow the OS appearance while the saved preference is "system".
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setSystemPrefersDark(media.matches)
    sync()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync)
      return () => media.removeEventListener('change', sync)
    }
    media.addListener(sync)
    return () => media.removeListener(sync)
  }, [setSystemPrefersDark])

  // Keep <html>/<body> in sync for Tailwind dark: variants and native chrome.
  useEffect(() => {
    const root = document.documentElement
    const isDark = resolvedChatTheme === 'dark'
    root.classList.toggle('dark', isDark)
    root.style.colorScheme = isDark ? 'dark' : 'light'
    document.body.classList.toggle('official-chat-dark', isDark)
    const metas = document.querySelectorAll('meta[name="theme-color"]')
    metas.forEach((m) => m.setAttribute('content', isDark ? '#09090b' : '#ffffff'))
    const appleStatusMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    if (appleStatusMeta) {
      appleStatusMeta.setAttribute('content', isDark ? 'black' : 'default')
    }
  }, [resolvedChatTheme])

  const isChatAuthed = Boolean(chatToken && chatUser)
  const isDark = resolvedChatTheme === 'dark'
  const routeFallback = (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading JDLX Chat"
      className={`min-h-[100dvh] flex flex-col items-center justify-center gap-4 ${isDark ? 'bg-[#090a0c]' : 'bg-[#f6f7f9]'}`}
    >
      <div className={`w-11 h-11 rounded-2xl border flex items-center justify-center overflow-hidden ${isDark ? 'border-white/10 bg-[#141519]' : 'border-slate-200 bg-white shadow-sm'}`}>
        <img src="/logo192.png" alt="" className="w-full h-full object-contain" />
      </div>
      <div className={`w-6 h-6 rounded-full border-2 border-t-transparent animate-spin ${isDark ? 'border-white/15 border-t-[#f0b429]' : 'border-slate-300 border-t-[#c98a04]'}`} />
    </div>
  )

  return (
    <Router>
      {/* Chat-styled toast notifications */}
      <Toaster
        position="top-center"
        toastOptions={{
          duration: 3200,
          style: {
            background: isDark ? '#14171b' : '#ffffff',
            color: isDark ? '#f4f5f7' : '#101828',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : '#e4e7ec'}`,
            borderRadius: '12px',
            boxShadow: isDark ? '0 18px 40px -20px rgba(0,0,0,0.9)' : '0 16px 36px -22px rgba(16,24,40,0.35)',
            padding: '10px 14px',
            fontSize: '13px',
            fontWeight: 500,
            maxWidth: '400px'
          },
          success: { iconTheme: { primary: '#e0a92b', secondary: '#14171b' } },
          error: { iconTheme: { primary: '#dc2626', secondary: '#ffffff' } }
        }}
      />

      <Suspense fallback={routeFallback}>
      <Routes>
        {/* Direct Root Route: instant landing on /chat when logged in, without flashing /login */}
        <Route
          path="/"
          element={
            isChatAuthed ? (
              <Navigate to="/chat" replace />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        <Route path="/login" element={<ChatLogin />} />
        {/* Alias kept for backend OAuth error redirects (/chat/login?error=...) */}
        <Route path="/chat/login" element={<ChatLogin />} />

        <Route
          path="/chat"
          element={
            isChatAuthed ? (
              <ChatConversation />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* Invite entry (@username deep link lands here) — login page reads the
            ?ref= param itself */}
        <Route path="/chat/invite" element={<ChatLogin />} />

        {/* Default → login */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>

      {/* PIN-encrypted E2EE key backup: setup on this device, unlock on a new one. */}
      <RecoveryPinModal />
      </Suspense>
    </Router>
  )
}

export default App
