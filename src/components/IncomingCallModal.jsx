import { useEffect } from 'react'
import { Phone, Mic, Volume2, VolumeX, X, Loader2, RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../store/useChatStore'
import toast from 'react-hot-toast'

export default function IncomingCallModal() {
  const {
    activeCall,
    activeConversation,
    chatUser,
    callIsMuted,
    callIsSpeakerOn,
    toggleMute,
    toggleSpeaker,
    answerCall,
    endCall
  } = useChatStore(useShallow((state) => state))

  // Auto-decline after ~45s if no answer. The guard lives INSIDE the effect so
  // the hook order stays stable across renders (early returns must come after
  // all hooks — rules of hooks).
  useEffect(() => {
    if (!activeCall || activeCall.state !== 'ringing') return undefined
    const t = setTimeout(() => {
      toast('Call timed out')
      endCall()
    }, 45000)
    return () => clearTimeout(t)
  }, [activeCall?.callerId, activeCall?.state, endCall])

  if (!activeCall || activeCall.state !== 'ringing') return null
  // The caller's own outgoing call also sits in 'ringing' state; they get the
  // CallScreen ("Calling…") instead of an incoming-call prompt for themselves.
  if (activeCall.callerId === chatUser?.id) return null

  // activeConversation may be a different chat (or absent) now that calls are
  // detected globally; the ringing call carries the caller's name.
  const displayName =
    activeCall.peerName ||
    (String(activeConversation?.id) === String(activeCall.roomId)
      ? activeConversation?.other_user?.name || activeConversation?.other_user?.username
      : null) ||
    'Incoming Call'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Incoming call"
    >
      <div
        className="w-full max-w-md max-h-[94dvh] rounded-3xl sm:rounded-[32px] border border-white/10 bg-[#090a0c] shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 sm:py-5 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-10 w-10 shrink-0 rounded-2xl border border-white/10 flex items-center justify-center bg-white/5">
              <Phone className="h-5 w-5 text-[#facc15]" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Incoming Call</p>
              <p className="text-[18px] sm:text-[20px] font-semibold text-white truncate">{displayName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={endCall}
            className="h-9 w-9 shrink-0 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
            aria-label="Decline call"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col items-center justify-center py-6 sm:py-8 px-4 sm:px-6">
          <div className="relative">
            <div className="absolute inset-0 rounded-full border border-white/5 bg-gradient-to-b from-white/5 to-transparent animate-pulse" />
            <div className="relative z-10 flex h-28 w-28 sm:h-32 sm:w-32 shrink-0 items-center justify-center rounded-full border-2 border-[#facc15]/40 bg-[#090a0c]/80 shadow-[0_0_30px_rgba(250,204,21,0.15)]">
              <Phone className="h-9 w-9 sm:h-10 sm:w-10 text-[#facc15]" />
            </div>
          </div>

          <div className="mt-5 sm:mt-6 text-center">
            <p className="text-zinc-400 text-xs sm:text-sm font-medium">Ringing…</p>
            <p className="text-white text-lg sm:text-xl font-bold mt-1">{activeCall.callType === 'video' ? 'Video Call' : 'Voice Call'}</p>
          </div>

          {/* Controls */}
          <div className="mt-6 sm:mt-8 flex w-full justify-center gap-4 px-2">
            <button
              type="button"
              onClick={toggleMute}
              className={`h-12 w-12 sm:h-13 sm:w-13 shrink-0 rounded-2xl border flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                callIsMuted
                  ? 'bg-rose-500/20 border-rose-500/40 text-rose-400'
                  : 'bg-white/5 border-white/10 text-white hover:bg-white/10'
              }`}
              aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <Mic className={`h-5 w-5 ${callIsMuted ? 'text-rose-400' : 'text-[#facc15]'}`} />
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const res = await answerCall()
                  if (res && !res.success) toast.error(res.error || 'Call failed')
                } catch (e) {
                  toast.error(e?.message || 'Call failed')
                }
              }}
              className="h-13 w-13 sm:h-14 sm:w-14 shrink-0 rounded-2xl border border-emerald-500/50 bg-emerald-600 flex items-center justify-center text-white shadow-[0_0_24px_rgba(16,185,129,0.35)] transition-all hover:bg-emerald-500 hover:scale-105 active:scale-95 cursor-pointer"
              aria-label="Accept call"
            >
              <Phone className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={toggleSpeaker}
              className={`h-12 w-12 sm:h-13 sm:w-13 shrink-0 rounded-2xl border flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                callIsSpeakerOn
                  ? 'bg-amber-500/20 border-yellow-500/40 text-[#facc15]'
                  : 'bg-white/5 border-white/10 text-white hover:bg-white/10'
              }`}
              aria-label={callIsSpeakerOn ? 'Turn off speaker' : 'Turn on speaker'}
            >
              {callIsSpeakerOn ? (
                <Volume2 className="h-5 w-5 text-[#facc15]" />
              ) : (
                <VolumeX className="h-5 w-5 text-zinc-400" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
