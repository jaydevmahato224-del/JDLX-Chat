import React from 'react'

export class ChatErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('JDLX Chat Uncaught Render Error:', error, errorInfo)
  }

  handleReload = () => {
    try {
      sessionStorage.removeItem('jdlx_chunk_reloaded')
      if ('caches' in window) {
        caches.keys().then((keys) => {
          keys.forEach((k) => caches.delete(k))
        }).catch(() => {})
      }
    } catch {}
    window.location.reload()
  }

  handleReset = () => {
    try {
      if ('caches' in window) {
        caches.keys().then((keys) => {
          keys.forEach((k) => caches.delete(k))
        }).catch(() => {})
      }
      localStorage.removeItem('jdlx_chat_token')
      localStorage.removeItem('jdlx_chat_refresh_token')
      localStorage.removeItem('jdlx_chat_user')
      sessionStorage.clear()
    } catch {}
    window.location.href = '/login'
  }

  render() {
    if (this.state.hasError) {
      const errorMsg = this.state.error?.message || String(this.state.error || 'Unknown startup error')
      return (
        <div className="fixed inset-0 z-[99999] bg-[#09090b] text-white flex flex-col items-center justify-center p-6 select-none font-sans">
          <div className="w-16 h-16 rounded-3xl bg-gradient-to-tr from-[#eab308] to-[#facc15] p-0.5 shadow-xl shadow-yellow-500/20 mb-5">
            <div className="w-full h-full rounded-[22px] bg-[#09090b] flex items-center justify-center font-black text-xl text-[#facc15]">
              JDLX
            </div>
          </div>
          <h2 className="text-lg font-black tracking-tight mb-1 text-zinc-100">
            JDLX Chat Messenger
          </h2>
          <p className="text-xs text-zinc-400 max-w-xs text-center mb-4 leading-relaxed">
            The application encountered a brief startup hiccup. Tap below to resume your encrypted session.
          </p>

          {errorMsg && (
            <div className="max-w-xs mb-5 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-400 text-center break-all select-text">
              {errorMsg}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5 w-full max-w-xs">
            <button
              type="button"
              onClick={this.handleReload}
              className="flex-1 py-3 px-4 rounded-2xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] text-xs font-black shadow-lg shadow-yellow-500/20 active:scale-95 transition-all cursor-pointer text-center"
            >
              Reload Chat
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              className="py-3 px-4 rounded-2xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700/60 text-xs font-bold active:scale-95 transition-all cursor-pointer text-center"
            >
              Reset Session
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ChatErrorBoundary
