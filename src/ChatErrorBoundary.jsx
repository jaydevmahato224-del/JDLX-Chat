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
        <div
          role="alert"
          className="fixed inset-0 z-[99999] flex flex-col items-center justify-center bg-[#090a0c] p-6 font-sans text-white select-none"
        >
          <div className="mb-5 flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-[#14171b] shadow-2xl">
            <img src="/logo192.png" alt="JDLX Chat" className="h-full w-full object-contain" />
          </div>
          <h2 className="mb-1 text-lg font-semibold tracking-tight text-zinc-100">
            Something went wrong
          </h2>
          <p className="mb-5 max-w-sm text-center text-[13px] leading-relaxed text-zinc-400">
            JDLX Chat hit an unexpected error. Reload to resume your encrypted session — your chats are safe.
          </p>

          {errorMsg && (
            <div className="mb-6 max-w-sm break-all rounded-xl border border-white/10 bg-[#14171b] px-3 py-2 text-center font-mono text-[11px] leading-relaxed text-zinc-500 select-text">
              {errorMsg}
            </div>
          )}

          <div className="flex w-full max-w-sm flex-col gap-2.5 sm:flex-row">
            <button
              type="button"
              onClick={this.handleReload}
              className="ui-btn ui-btn-primary flex-1"
            >
              Reload Chat
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              className="ui-btn ui-btn-secondary flex-1 border-white/15 bg-white/5 text-zinc-300 hover:bg-white/10"
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
