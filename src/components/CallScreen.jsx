import { useEffect, useRef } from 'react'
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

  const remoteAudioRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const localVideoRef = useRef(null)

  // The call may belong to a conversation other than the one open behind it
  // (incoming calls are detected globally), so resolve its own room.
  const callConversation = useChatStore((state) =>
    state.conversations.find((c) => String(c.id) === String(activeCall?.roomId))
  )

  const isVideo = activeCall?.callType === 'video'

  // Bind remote audio stream so call voice/audio is heard
  useEffect(() => {
    if (remoteAudioRef.current && callRemoteStream) {
      remoteAudioRef.current.srcObject = callRemoteStream
      remoteAudioRef.current.play().catch(() => {})
    }
  }, [callRemoteStream])

  // Bind remote video stream for video calls
  useEffect(() => {
    if (remoteVideoRef.current && callRemoteStream && isVideo) {
      remoteVideoRef.current.srcObject = callRemoteStream
      remoteVideoRef.current.play().catch(() => {})
    }
  }, [callRemoteStream, isVideo])

  // Bind local camera preview
  useEffect(() => {
    if (localVideoRef.current && callLocalStream && isVideo) {
      localVideoRef.current.srcObject = callLocalStream
      localVideoRef.current.play().catch(() => {})
    }
  }, [callLocalStream, isVideo])

  if (!activeCall) return null

  const isCallerRinging = activeCall.state === 'ringing' && activeCall.callerId === chatUser?.id
  if (activeCall.state !== 'active' && !isCallerRinging) return null

  const peerName =
    activeCall?.peerName ||
    (String(activeConversation?.id) === String(activeCall?.roomId)
      ? activeConversation?.contact_name || activeConversation?.other_user?.name
      : null) ||
    callConversation?.contact_name ||
    callConversation?.other_user?.name ||
    activeConversation?.other_user?.name ||
    'Call'

  const formatTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec < 10 ? '0' : ''}${sec}`
  }

  // Video calls are edge-to-edge on phones (like a normal mobile call app):
  // the remote feed fills the screen, controls float on top and respect the
  // safe areas. The old 190px square inside a card was far too small for a
  // phone camera feed. Voice calls keep the compact card below.
  if (isVideo) {
    return (
      <div
        className="fixed inset-0 z-[60] bg-black"
        role="dialog"
        aria-modal="true"
        aria-label="Active video call"
      >
        {/* Hidden audio element keeps the peer's voice audible */}
        <audio ref={remoteAudioRef} autoPlay playsInline />

        {callRemoteStream ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 h-full w-full bg-zinc-900 object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0c0e]">
            <div className="flex h-32 w-32 items-center justify-center rounded-full border-2 border-amber-500/30 bg-[#0f1114] shadow-xl shadow-amber-500/5">
              <User className="h-14 w-14 text-zinc-400" />
            </div>
          </div>
        )}

        {/* Top bar: peer name + duration over a readable gradient */}
        <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 pb-12 pt-[max(0.9rem,env(safe-area-inset-top,0px))]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[17px] font-semibold text-white">{peerName}</p>
              <p className="mt-0.5 flex items-center gap-2 text-xs font-medium text-white/70">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                {isCallerRinging ? 'Ringing…' : formatTime(callTimerSeconds)}
              </p>
            </div>
            <button
              type="button"
              onClick={endCall}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition active:scale-95 cursor-pointer"
              aria-label="End call"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Local camera preview (PiP) */}
        {callLocalStream && (
          <div className="absolute right-4 bottom-[calc(env(safe-area-inset-bottom,0px)_+_8.5rem)] aspect-[3/4] w-24 overflow-hidden rounded-2xl border border-white/25 bg-black shadow-2xl sm:w-32">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full -scale-x-100 object-cover"
            />
          </div>
        )}

        {/* Bottom controls over a gradient, above the gesture bar */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-6 pt-16 pb-[max(1.4rem,env(safe-area-inset-bottom,0px))]">
          <div className="flex items-center justify-center gap-5">
            <button
              type="button"
              onClick={toggleMute}
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border backdrop-blur-sm transition active:scale-95 cursor-pointer ${
                callIsMuted
                  ? 'border-rose-500/40 bg-rose-500/25 text-rose-300'
                  : 'border-white/20 bg-white/10 text-white'
              }`}
              aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <Mic className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={endCall}
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-rose-500/50 bg-rose-600 text-white shadow-[0_0_24px_rgba(239,68,68,0.4)] transition active:scale-95 cursor-pointer"
              aria-label="End call"
            >
              <Phone className="h-7 w-7 rotate-[135deg]" />
            </button>
            <button
              type="button"
              onClick={toggleSpeaker}
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border backdrop-blur-sm transition active:scale-95 cursor-pointer ${
                callIsSpeakerOn
                  ? 'border-amber-400/40 bg-amber-400/20 text-[#facc15]'
                  : 'border-white/20 bg-white/10 text-white'
              }`}
              aria-label={callIsSpeakerOn ? 'Turn off speaker' : 'Turn on speaker'}
            >
              {callIsSpeakerOn ? <Volume2 className="h-6 w-6" /> : <VolumeX className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Active call"
    >
      {/* Hidden audio element to output remote peer audio */}
      <audio ref={remoteAudioRef} autoPlay playsInline />

      <div
        className="w-full max-w-md max-h-[94dvh] rounded-3xl sm:rounded-[32px] border border-white/10 bg-[#090a0c] shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 sm:py-5 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-10 w-10 shrink-0 rounded-2xl border border-white/10 flex items-center justify-center bg-white/5">
              {isVideo ? <Video className="h-5 w-5 text-[#facc15]" /> : <Phone className="h-5 w-5 text-[#facc15]" />}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider truncate">
                {isCallerRinging ? 'Calling…' : isVideo ? 'Video Call' : 'Voice Call'} · {peerName}
              </p>
              <p className="text-[17px] sm:text-[20px] font-semibold text-white">
                {isCallerRinging ? 'Ringing…' : formatTime(callTimerSeconds)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={endCall}
            className="h-9 w-9 shrink-0 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
            aria-label="End call"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col items-center justify-center py-6 sm:py-8 px-4 sm:px-6">
          {/* Remote video (video mode) or large avatar (voice) */}
          <div className="relative w-full aspect-square max-w-[190px] xs:max-w-[220px] sm:max-w-[240px] mx-auto mb-5 sm:mb-6">
            {isVideo && callRemoteStream ? (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full rounded-3xl object-cover bg-zinc-900 shadow-2xl border border-white/10"
              />
            ) : (
              <div className="w-full h-full rounded-full border-2 border-amber-500/30 bg-[#0f1114] flex items-center justify-center shadow-xl shadow-amber-500/5">
                <User className="h-14 w-14 sm:h-16 sm:w-16 text-zinc-400" />
              </div>
            )}

            {/* Local preview (video mode) or mic indicator (voice) */}
            {isVideo && callLocalStream ? (
              <div className="absolute -right-2 -bottom-2 w-16 h-16 sm:w-20 sm:h-20 rounded-2xl overflow-hidden border-2 border-white/20 shadow-xl bg-black">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover -scale-x-100"
                />
              </div>
            ) : (
              <div className="absolute -right-1 -bottom-1 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#090a0c]">
                <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              </div>
            )}
          </div>

          <div className="text-center mb-5 sm:mb-6">
            <p className="text-zinc-400 text-xs sm:text-sm font-medium tracking-wide">
              {isVideo ? 'Video' : 'Voice'} call in progress
            </p>
          </div>

          {/* Controls */}
          <div className="flex w-full justify-center gap-4 sm:gap-5 px-2 pb-2">
            <button
              type="button"
              onClick={toggleMute}
              className={`h-12 w-12 sm:h-13 sm:w-13 shrink-0 rounded-2xl border flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                callIsMuted
                  ? 'bg-rose-500/20 border-rose-500/40 text-rose-400'
                  : 'bg-white/5 border-white/10 text-white hover:bg-white/10'
              }`}
              title={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
              aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <Mic className={`h-5 w-5 ${callIsMuted ? 'text-rose-400' : 'text-white'}`} />
            </button>
            <button
              type="button"
              onClick={toggleSpeaker}
              className={`h-12 w-12 sm:h-13 sm:w-13 shrink-0 rounded-2xl border flex items-center justify-center transition-all cursor-pointer active:scale-95 ${
                callIsSpeakerOn
                  ? 'bg-amber-500/20 border-yellow-500/40 text-[#facc15]'
                  : 'bg-white/5 border-white/10 text-white hover:bg-white/10'
              }`}
              title={callIsSpeakerOn ? 'Turn off speaker' : 'Turn on speaker'}
              aria-label={callIsSpeakerOn ? 'Turn off speaker' : 'Turn on speaker'}
            >
              {callIsSpeakerOn ? (
                <Volume2 className="h-5 w-5 text-[#facc15]" />
              ) : (
                <VolumeX className="h-5 w-5 text-zinc-400" />
              )}
            </button>
            <button
              type="button"
              onClick={endCall}
              className="h-12 w-12 sm:h-13 sm:w-13 shrink-0 rounded-2xl border border-rose-500/50 bg-rose-600 flex items-center justify-center text-white shadow-[0_0_20px_rgba(239,68,68,0.35)] transition-all hover:bg-rose-500 active:scale-95 cursor-pointer"
              title="End call"
              aria-label="End call"
            >
              <Phone className="h-6 w-6 rotate-[135deg]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
