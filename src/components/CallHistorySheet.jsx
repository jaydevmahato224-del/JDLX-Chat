import { useEffect, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Loader2, Phone, PhoneMissed, RefreshCw, Video, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../store/useChatStore'
import { resolveMediaUrl } from '../config'
import { useDialogA11y } from '../hooks/useDialogA11y'
import { backdropMotionClass, sheetModalMotionClass, useAnimatedPresence } from '../hooks/useAnimatedPresence'

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const mins = Math.floor(total / 60)
  const rest = total % 60
  return `${mins}:${String(rest).padStart(2, '0')}`
}

// Short, chat-app style stamp: today -> time, this year -> "12 Nov", older -> date.
function formatWhen(epochSeconds) {
  const d = new Date((Number(epochSeconds) || 0) * 1000)
  if (!epochSeconds) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const opts = d.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' }
  return d.toLocaleDateString([], opts)
}

function subtitle(item) {
  if (item.outcome === 'completed') return formatDuration(item.duration_seconds)
  if (item.outcome === 'in_progress') return 'In progress'
  if (item.outcome === 'missed') return 'Missed'
  if (item.outcome === 'no_answer') return 'No answer'
  if (item.outcome === 'declined') return 'Declined'
  return 'Cancelled'
}

function HistoryPeerAvatar({ src, name, isLight }) {
  const [failed, setFailed] = useState(false)
  const resolved = resolveMediaUrl(src)
  const initial = (name || 'Unknown').trim().charAt(0).toUpperCase()

  return (
    <div className={`relative h-10 w-10 shrink-0 overflow-hidden rounded-full ${
      isLight ? 'bg-slate-100 text-slate-600' : 'bg-[#1e1e24] text-zinc-400'
    }`}>
      {resolved && !failed ? (
        <img
          src={resolved}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-sm font-black">
          {initial}
        </span>
      )}
    </div>
  )
}

/**
 * Call history for the signed-in user (GET /chat/calls/history). Tapping a row
 * opens that conversation, so the sheet is also the fastest way back to a
 * recent caller.
 */
export default function CallHistorySheet() {
  const {
    callHistoryOpen,
    closeCallHistory,
    callHistory,
    callHistoryLoading,
    callHistoryError,
    fetchCallHistory,
    conversations,
    selectConversation,
    resolvedChatTheme
  } = useChatStore(useShallow((s) => ({
    callHistoryOpen: s.callHistoryOpen,
    closeCallHistory: s.closeCallHistory,
    callHistory: s.callHistory,
    callHistoryLoading: s.callHistoryLoading,
    callHistoryError: s.callHistoryError,
    fetchCallHistory: s.fetchCallHistory,
    conversations: s.conversations,
    selectConversation: s.selectConversation,
    resolvedChatTheme: s.resolvedChatTheme
  })))

  const isLight = resolvedChatTheme === 'light'
  const dialogRef = useDialogA11y(callHistoryOpen, closeCallHistory)

  useEffect(() => {
    if (callHistoryOpen) fetchCallHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callHistoryOpen])

  const presence = useAnimatedPresence(callHistoryOpen, 290)

  if (!presence.mounted) return null

  const openChat = (roomId) => {
    const conv = (conversations || []).find((c) => String(c.id) === String(roomId))
    closeCallHistory()
    if (conv) selectConversation(conv)
  }

  return (
    <div
      className={`fixed inset-0 z-[90] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4 ${backdropMotionClass(presence.isClosing)}`}
      onClick={closeCallHistory}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-b-0 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] shadow-2xl sm:rounded-3xl sm:border sm:pb-0 ${sheetModalMotionClass(presence.isClosing, 'sm')} ${
          isLight
            ? 'border-slate-200 bg-white text-slate-900'
            : 'border-[#26262c] bg-[#111114] text-white'
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Call history"
      >
        <div className="flex justify-center pt-2.5 pb-1 sm:hidden" aria-hidden="true">
          <div className="h-1 w-10 rounded-full bg-zinc-400/35" />
        </div>
        <div className={`flex items-center justify-between border-b px-4 py-3 ${
          isLight ? 'border-slate-200' : 'border-[#222228]'
        }`}>
          <div className="flex items-center gap-2">
            <Phone className={`h-4 w-4 ${isLight ? 'text-amber-600' : 'text-amber-400'}`} />
            <div className={`text-sm font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>Call history</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fetchCallHistory({ force: true })}
              className={`rounded-full p-2 transition cursor-pointer ${
                isLight ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-800' : 'text-zinc-400 hover:bg-[#1c1c22] hover:text-zinc-200'
              }`}
              aria-label="Refresh call history"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${callHistoryLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={closeCallHistory}
              className={`rounded-full p-2 transition cursor-pointer ${
                isLight ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-800' : 'text-zinc-400 hover:bg-[#1c1c22] hover:text-zinc-200'
              }`}
              aria-label="Close call history"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-[120px] flex-1 overflow-y-auto overscroll-contain px-2 py-2 custom-scrollbar">
          {callHistoryLoading && callHistory.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs font-semibold text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading calls…
            </div>
          )}

          {!callHistoryLoading && callHistoryError && (
            <div className="flex flex-col items-center gap-3 py-10">
              <div className={`text-xs font-semibold ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>{callHistoryError}</div>
              <button
                type="button"
                onClick={() => fetchCallHistory({ force: true })}
                className="rounded-full bg-amber-400 px-4 py-1.5 text-xs font-black text-black cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!callHistoryLoading && !callHistoryError && callHistory.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-zinc-500">
              <Phone className="h-6 w-6 opacity-60" />
              <div className="text-xs font-semibold">No calls yet</div>
              <div className={`text-[11px] ${isLight ? 'text-slate-400' : 'text-zinc-600'}`}>
                Calls you make or receive will appear here.
              </div>
            </div>
          )}

          {callHistory.map((item) => {
            const isVideo = item.call_type === 'video'
            const missed = item.outcome === 'missed' || item.outcome === 'no_answer'
            const Icon = missed ? PhoneMissed : isVideo ? Video : Phone
            const DirectionIcon = item.direction === 'outgoing' ? ArrowUpRight : ArrowDownLeft
            const peer = item.peer || {}
            const name = peer.name || peer.username || 'Unknown'
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => openChat(item.room_id)}
                className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition cursor-pointer ${
                  isLight ? 'hover:bg-slate-100/80' : 'hover:bg-[#18181d]'
                }`}
              >
                <HistoryPeerAvatar src={peer.profile_image} name={name} isLight={isLight} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[13px] font-bold ${
                    missed ? 'text-rose-500' : isLight ? 'text-slate-900' : 'text-zinc-100'
                  }`}>
                    {name}
                  </div>
                  <div className={`mt-0.5 flex items-center gap-1 text-[11px] font-semibold ${
                    isLight ? 'text-slate-500' : 'text-zinc-500'
                  }`}>
                    <DirectionIcon className="h-3 w-3 shrink-0" />
                    <Icon className="h-3 w-3 shrink-0" />
                    <span>{subtitle(item)}</span>
                    <span className="opacity-60">·</span>
                    <span>{formatWhen(item.started_at)}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
