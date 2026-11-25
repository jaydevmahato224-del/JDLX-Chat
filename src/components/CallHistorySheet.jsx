import { useEffect } from 'react'
import { ArrowDownLeft, ArrowUpRight, Loader2, Phone, PhoneMissed, RefreshCw, Video, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../store/useChatStore'

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
    selectConversation
  } = useChatStore(useShallow((s) => ({
    callHistoryOpen: s.callHistoryOpen,
    closeCallHistory: s.closeCallHistory,
    callHistory: s.callHistory,
    callHistoryLoading: s.callHistoryLoading,
    callHistoryError: s.callHistoryError,
    fetchCallHistory: s.fetchCallHistory,
    conversations: s.conversations,
    selectConversation: s.selectConversation
  })))

  useEffect(() => {
    if (callHistoryOpen) fetchCallHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callHistoryOpen])

  useEffect(() => {
    if (!callHistoryOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') closeCallHistory() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [callHistoryOpen, closeCallHistory])

  if (!callHistoryOpen) return null

  const openChat = (roomId) => {
    const conv = (conversations || []).find((c) => String(c.id) === String(roomId))
    closeCallHistory()
    if (conv) selectConversation(conv)
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
      onClick={closeCallHistory}
      role="presentation"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-[#26262c] bg-[#111114] sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Call history"
      >
        <div className="flex items-center justify-between border-b border-[#222228] px-4 py-3">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-amber-400" />
            <div className="text-sm font-black text-white">Call history</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fetchCallHistory({ force: true })}
              className="rounded-full p-1.5 text-zinc-400 transition hover:bg-[#1c1c22] hover:text-zinc-200"
              aria-label="Refresh call history"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${callHistoryLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={closeCallHistory}
              className="rounded-full p-1.5 text-zinc-400 transition hover:bg-[#1c1c22] hover:text-zinc-200"
              aria-label="Close call history"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-[120px] flex-1 overflow-y-auto px-2 py-2">
          {callHistoryLoading && callHistory.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs font-semibold text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading calls…
            </div>
          )}

          {!callHistoryLoading && callHistoryError && (
            <div className="flex flex-col items-center gap-3 py-10">
              <div className="text-xs font-semibold text-zinc-400">{callHistoryError}</div>
              <button
                type="button"
                onClick={() => fetchCallHistory({ force: true })}
                className="rounded-full bg-amber-400 px-4 py-1.5 text-xs font-black text-black"
              >
                Retry
              </button>
            </div>
          )}

          {!callHistoryLoading && !callHistoryError && callHistory.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-zinc-500">
              <Phone className="h-6 w-6 opacity-60" />
              <div className="text-xs font-semibold">No calls yet</div>
              <div className="text-[11px] text-zinc-600">Calls you make or receive will appear here.</div>
            </div>
          )}

          {callHistory.map((item) => {
            const isVideo = item.call_type === 'video'
            const missed = item.outcome === 'missed' || item.outcome === 'no_answer'
            const Icon = missed ? PhoneMissed : isVideo ? Video : Phone
            const DirectionIcon = item.direction === 'outgoing' ? ArrowUpRight : ArrowDownLeft
            const peer = item.peer || {}
            const name = peer.name || peer.username || 'Unknown'
            const initial = name.trim().charAt(0).toUpperCase()
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => openChat(item.room_id)}
                className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition hover:bg-[#18181d]"
              >
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full bg-[#1e1e24]">
                  {peer.profile_image ? (
                    <img src={peer.profile_image} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-sm font-black text-zinc-400">
                      {initial}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[13px] font-bold ${missed ? 'text-red-400' : 'text-zinc-100'}`}>
                    {name}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-zinc-500">
                    <DirectionIcon className="h-3 w-3" />
                    <Icon className="h-3 w-3" />
                    <span>{subtitle(item)}</span>
                    <span className="text-zinc-600">·</span>
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
