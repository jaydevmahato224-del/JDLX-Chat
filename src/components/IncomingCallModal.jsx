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

  const displayName =
    activeConversation?.other_user?.name ||
    activeConversation?.other_user?.username ||
    'Incoming Call'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Incoming call"
    >
      <div
        className="w-full max-w-md rounded-[30px] border border-white/10 bg-[#090a0c] shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 shrink-0 rounded-full border border-white/10 flex items-center justify-center bg-white/5">
              <Phone className="h-5 w-5 text-[#facc15]" />
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Incoming Call</p>
              <p className="text-[20px] font-semibold text-white">{displayName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={endCall}
            className="h-9 w-9 shrink-0 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-white/5 transition"
            aria-label="Decline call"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col items-center justify-center py-8 px-6">
          <div className="relative">
            <div className="absolute inset-0 rounded-full border border-white/5 bg-gradient-to-b from-white/5 to-transparent" />
            <div className="relative z-10 flex h-32 w-32 shrink-0 items-center justify-center rounded-full border-2 border-[#facc15]/40 bg-[#090a0c]/80">
              <Phone className="h-10 w-10 text-[#facc15]" />
            </div>
          </div>

          <div className="mt-6 text-center">
            <p className="text-zinc-400 text-sm">Ringing…</p>
            <p className="text-white text-xl font-medium mt-1">{activeCall.callType === 'video' ? 'Video Call' : 'Voice Call'}</p>
          </div>

          {/* Controls */}
          <div className="mt-8 flex w-full justify-center gap-4 px-4">
            <button
              type="button"
              onClick={toggleMute}
              className="h-12 w-12 shrink-0 rounded-full border border-white/10 flex items-center justify-center transition-colors"
              aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <Mic className={`h-5 w-5 ${callIsMuted ? 'text-rose-400' : 'text-[#facc15]'}`} />
            </button>
            <button
              type="button"
              onClick={() => answerCall(activeCall.callerId)}
              className="h-14 w-14 shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 flex items-center justify-center text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.25)] transition-all hover:scale-105 active:scale-95"
              aria-label="Accept call"
            >
              <Phone className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={toggleSpeaker}
              className="h-12 w-12 shrink-0 rounded-full border border-white/10 flex items-center justify-center transition-colors"
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
