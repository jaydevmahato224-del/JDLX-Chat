import { useEffect } from 'react'
import { Phone, Video, X, PhoneOff } from 'lucide-react'
import { useChatStore } from '../store/useChatStore'
import { backdropMotionClass, modalMotionClass, useAnimatedPresence } from '../hooks/useAnimatedPresence'

// Copy for the moment right after a call drops. 'completed' wins whenever the
// call had actually connected, whatever the caller/callee intent was.
const OUTCOME_COPY = {
  completed: 'Call ended',
  no_answer: 'No answer',
  missed: 'Missed call',
  declined: 'Call declined',
  cancelled: 'Call cancelled',
  failed: 'Call failed'
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const mins = Math.floor(total / 60)
  const rest = total % 60
  return `${mins}:${String(rest).padStart(2, '0')}`
}

/**
 * Post-call summary: who it was, whether it connected, and how long it lasted,
 * with a one-tap redial. Rendered by the conversation page next to CallScreen,
 * so it appears for calls that were answered elsewhere in the app too.
 */
export default function CallEndedScreen() {
  const callEndedInfo = useChatStore((s) => s.callEndedInfo)
  const dismissCallEnded = useChatStore((s) => s.dismissCallEnded)
  const initiateCall = useChatStore((s) => s.initiateCall)
  const activeCall = useChatStore((s) => s.activeCall)

  // Auto-dismiss so the summary never blocks the conversation behind it. A new
  // incoming call cancels it immediately (the modal takes over the screen).
  useEffect(() => {
    if (!callEndedInfo) return undefined
    if (activeCall) {
      dismissCallEnded()
      return undefined
    }
    const timer = setTimeout(() => dismissCallEnded(), 7000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callEndedInfo, activeCall])

  const presence = useAnimatedPresence(callEndedInfo, 180)

  if (!presence.mounted) return null

  const info = callEndedInfo || presence.data
  if (!info) return null
  const completed = info.outcome === 'completed'
  const isVideo = info.callType === 'video'
  const initial = (info.peerName || '?').trim().charAt(0).toUpperCase()
  const redial = () => {
    dismissCallEnded()
    initiateCall(info.roomId, info.callType).then((res) => {
      if (res && res.success === false) console.warn('redial failed:', res.error)
    }).catch(() => {})
  }

  return (
    <div className={`fixed inset-0 z-[95] flex items-center justify-center bg-[#0b0b0d] px-6 ${backdropMotionClass(presence.isClosing)}`}>
      <div className={`w-full max-w-sm text-center ${modalMotionClass(presence.isClosing)}`}>
        <div className="mx-auto mb-5 flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-[#1b1b20] ring-2 ring-[#2a2a31]">
          {info.peerAvatar ? (
            <img src={info.peerAvatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-3xl font-black text-zinc-300">{initial}</span>
          )}
        </div>

        <div className="mb-1 text-xl font-black text-white">{info.peerName}</div>
        <div className={`text-sm font-semibold ${completed ? 'text-emerald-400' : 'text-amber-400'}`}>
          {OUTCOME_COPY[info.outcome] || 'Call ended'}
          {completed ? ` · ${formatDuration(info.durationSeconds)}` : ''}
        </div>
        <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          {isVideo ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
          {isVideo ? 'Video call' : 'Voice call'}
          <span className="text-zinc-600">·</span>
          {info.direction === 'outgoing' ? 'Outgoing' : 'Incoming'}
        </div>

        <div className="mt-8 flex items-center justify-center gap-6">
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={redial}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/25 transition active:scale-95"
              aria-label="Call again"
              title="Call again"
            >
              {isVideo ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
            </button>
            <span className="text-[11px] font-semibold text-zinc-400">Call again</span>
          </div>

          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={dismissCallEnded}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1e1e24] text-zinc-300 ring-1 ring-[#2c2c34] transition active:scale-95"
              aria-label="Close call summary"
              title="Close"
            >
              <X className="h-5 w-5" />
            </button>
            <span className="text-[11px] font-semibold text-zinc-400">Done</span>
          </div>
        </div>

        {!completed && (
          <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-zinc-600">
            <PhoneOff className="h-3 w-3" />
            {info.direction === 'outgoing' ? 'The other side did not pick up.' : 'You missed this call.'}
          </div>
        )}
      </div>
    </div>
  )
}
