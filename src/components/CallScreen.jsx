import { Phone, Mic, Volume2, VolumeX, X, User, Video } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../store/useChatStore'

export default function CallScreen() {
  const {
    activeCall,
    activeConversation,
    chatUser,
    callLocalStream,
    callRemoteStream,
    callIsMuted,
    callIsSpeakerOn,
    callTimerSeconds,
    toggleMute,
    toggleSpeaker,
    endCall
  } = useChatStore(useShallow((state) => state))

  if (!activeCall) return null

  const isCallerRinging = activeCall.state === 'ringing' && activeCall.callerId === chatUser?.id
  if (activeCall.state !== 'active' && !isCallerRinging) return null

  const isVideo = activeCall.callType === 'video'
  const peerName =
    activeConversation?.other_user?.name ||
    activeConversation?.other_user?.username ||
    'Call'

  const formatTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec < 10 ? '0' : ''}${sec}`
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Active call"
    >
      <div
        className="w-full max-w-md rounded-[30px] border border-white/10 bg-[#090a0c] shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 shrink-0 rounded-full border border-white/10 flex items-center justify-center bg-white/5">
              {isVideo ? <Video className="h-5 w-5 text-[#facc15]" /> : <Phone className="h-5 w-5 text-[#facc15]" />}
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                {isCallerRinging ? 'Calling…' : isVideo ? 'Video Call' : 'Voice Call'} · {peerName}
              </p>
              <p className="text-[20px] font-semibold text-white">
                {isCallerRinging ? 'Ringing…' : formatTime(callTimerSeconds)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={endCall}
            className="h-9 w-9 shrink-0 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-white/5 transition"
            aria-label="End call"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col items-center justify-center py-8 px-6">
          {/* Remote video (video mode) or large avatar (voice) */}
          <div className="relative w-full aspect-square max-w-[220px] mx-auto mb-6">
            {isVideo && callRemoteStream ? (
              <video
                autoPlay
                playsInline
                muted
                srcObject={callRemoteStream}
                className="w-full h-full rounded-full object-cover bg-zinc-900"
              />
            ) : (
              <div className="w-full h-full rounded-full border border-white/10 bg-[#0f1114] flex items-center justify-center">
                <User className="h-12 w-12 text-zinc-500" />
              </div>
            )}
            {/* Local mic indicator (voice) or local video (video) */}
            <div className="absolute -right-1 -bottom-1 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#090a0c]">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            </div>
          </div>

          <div className="text-center mb-8">
            <p className="text-zinc-400 text-sm uppercase tracking-wider">
              {isVideo ? 'Video' : 'Voice'} call in progress
            </p>
          </div>

          {/* Controls */}
          <div className="flex w-full justify-center gap-5 px-4 pb-2">
            <button
              type="button"
              onClick={toggleMute}
              className="h-12 w-12 shrink-0 rounded-full border border-white/10 flex items-center justify-center transition-colors"
              aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <Mic className={`h-5 w-5 ${callIsMuted ? 'text-rose-400' : 'text-white'}`} />
            </button>
            <button
              type="button"
              onClick={toggleSpeaker}
              className="h-12 w-12 shrink-0 rounded-full border border-white/10 flex items-center justify-center transition-colors"
              aria-label={callIsSpeakerOn ? 'Turn off speaker' : 'Turn on speaker'}
            >
              {callIsSpeakerOn ? (
                <Volume2 className="h-5 w-5 text-white" />
              ) : (
                <VolumeX className="h-5 w-5 text-zinc-400" />
              )}
            </button>
            <button
              type="button"
              onClick={endCall}
              className="h-12 w-12 shrink-0 rounded-full border border-rose-500/40 bg-rose-500/10 flex items-center justify-center text-rose-400 shadow-[0_0_20px_rgba(239,68,68,0.25)] transition-all hover:scale-105 active:scale-95"
              aria-label="End call"
            >
              <Phone className="h-6 w-6" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
