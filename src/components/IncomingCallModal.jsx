import { useEffect, useRef, useState } from 'react'
import { Phone, Mic, MicOff, X, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore, CALL_RING_TIMEOUT_MS } from '../store/useChatStore'
import { resolveMediaUrl } from '../config'
import toast from 'react-hot-toast'
import { startIncomingRingtone, stopIncomingRingtone, unlockSounds } from '../utils/sounds'
import { subscribeNativeAudioRoutes } from '../utils/callAudio'
import { backdropMotionClass, modalMotionClass, useAnimatedPresence } from '../hooks/useAnimatedPresence'
import SpeakerSwitch from './SpeakerSwitch'

export default function IncomingCallModal() {
  const {
    activeCall,
    activeConversation,
    chatUser,
    callIsMuted,
    callSpeakerMode,
    callHeadsetInfo,
    toggleMute,
    setSpeakerMode,
    syncNativeAudioRoutes,
    applyNativeAudioRoutesPayload,
    answerCall,
    endCall
  } = useChatStore(useShallow((state) => state))

  // Answering takes a mic permission prompt plus an SDP round-trip. On a slow
  // link that is several seconds of nothing, so people tap again — each tap
  // fired another answer request (the later ones get 404 "No ringing call")
  // and the call appeared not to connect. The ref blocks the extra taps
  // immediately; the state only drives the disabled/spinner UI.
  const answeringRef = useRef(false)
  const [answering, setAnswering] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)

  const handleAnswer = async () => {
    if (answeringRef.current) return
    answeringRef.current = true
    stopIncomingRingtone()
    setAnswering(true)
    // Answering silences the ringtone immediately. If it fails while the call
    // is still ringing (mic denied, expired offer), resume it — the modal
    // staying open but silent reads as a missed call.
    const resumeRingingIfStillIncoming = () => {
      const state = useChatStore.getState()
      const call = state.activeCall
      if (call && call.state === 'ringing' && String(call.callerId) !== String(state.chatUser?.id)) {
        startIncomingRingtone()
      }
    }
    try {
      const res = await answerCall()
      if (res && !res.success) {
        toast.error(res.error || 'Call failed')
        resumeRingingIfStillIncoming()
      }
    } catch (e) {
      toast.error(e?.message || 'Call failed')
      resumeRingingIfStillIncoming()
    } finally {
      answeringRef.current = false
      setAnswering(false)
    }
  }

  // Stop ringing on the same clock the caller uses (CALL_RING_TIMEOUT_MS), so
  // the two sides never disagree about whether the call is still live. The
  // guard lives INSIDE the effect so the hook order stays stable across renders
  // (early returns must come after all hooks — rules of hooks).
  useEffect(() => {
    if (!activeCall || activeCall.state !== 'ringing') return undefined
    const t = setTimeout(() => {
      toast('Call timed out')
      endCall()
    }, CALL_RING_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [activeCall?.callerId, activeCall?.state, endCall])

  // Ring the phone while the prompt is up. Stops on answer/decline, when the
  // caller hangs up (activeCall cleared) or when this modal unmounts.
  useEffect(() => {
    const isIncoming = Boolean(
      activeCall && activeCall.state === 'ringing' && activeCall.callerId !== chatUser?.id
    )
    if (!isIncoming) {
      stopIncomingRingtone()
      return undefined
    }
    unlockSounds()
    startIncomingRingtone()
    return () => stopIncomingRingtone()
  }, [activeCall?.state, activeCall?.callerId, activeCall?.roomId, chatUser?.id])

  const isIncomingVisible = Boolean(
    activeCall && activeCall.state === 'ringing' && activeCall.callerId !== chatUser?.id
  )

  useEffect(() => {
    if (!isIncomingVisible) return undefined
    syncNativeAudioRoutes()
    return subscribeNativeAudioRoutes(applyNativeAudioRoutesPayload)
  }, [isIncomingVisible, syncNativeAudioRoutes, applyNativeAudioRoutesPayload])

  const matchingConv = String(activeConversation?.id) === String(activeCall?.roomId) ? activeConversation : null
  const currentPeerAvatar =
    activeCall?.peerAvatar ||
    matchingConv?.contact_avatar ||
    matchingConv?.other_user?.profile_image ||
    null

  useEffect(() => {
    setAvatarFailed(false)
  }, [currentPeerAvatar])

  const presence = useAnimatedPresence(
    isIncomingVisible
      ? {
          peerName:
            activeCall.peerName ||
            matchingConv?.contact_name ||
            matchingConv?.other_user?.name ||
            matchingConv?.other_user?.username ||
            'Incoming Call',
          peerAvatar: currentPeerAvatar,
          callType: activeCall.callType || 'voice'
        }
      : null,
    250
  )

  if (!presence.mounted) return null

  const displayName = presence.data?.peerName || 'Incoming Call'
  const displayAvatar = resolveMediaUrl(currentPeerAvatar || presence.data?.peerAvatar || '')
  const displayCallType = activeCall?.callType || presence.data?.callType || 'voice'

  return (
    <div
      className={`fixed inset-0 z-[110] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] ${backdropMotionClass(presence.isClosing)}`}
      role="dialog"
      aria-modal="true"
      aria-label="Incoming call"
    >
      <div
        className={`w-full max-w-md max-h-[94dvh] rounded-3xl sm:rounded-[32px] border border-white/10 bg-[#090a0c] shadow-2xl overflow-hidden flex flex-col ${modalMotionClass(presence.isClosing)}`}
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
            disabled={answering}
            className="h-9 w-9 shrink-0 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-white/10 active:scale-95 transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Decline call"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="flex min-h-full flex-col items-center justify-center py-6 sm:py-8 px-4 sm:px-6">
          <div className="relative">
            <div className="absolute inset-0 rounded-full border border-white/5 bg-gradient-to-b from-white/5 to-transparent animate-pulse" />
            <div className="relative z-10 flex h-28 w-28 sm:h-32 sm:w-32 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-[#facc15]/40 bg-[#090a0c]/80 shadow-[0_0_30px_rgba(250,204,21,0.15)]">
              {displayAvatar && !avatarFailed ? (
                <img
                  src={displayAvatar}
                  alt=""
                  onError={() => setAvatarFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <Phone className="h-9 w-9 sm:h-10 sm:w-10 text-[#facc15]" />
              )}
            </div>
          </div>

          <div className="mt-5 sm:mt-6 text-center">
            <p className="text-zinc-400 text-xs sm:text-sm font-medium">Ringing…</p>
            <p className="text-white text-lg sm:text-xl font-bold mt-1">{displayCallType === 'video' ? 'Video Call' : 'Voice Call'}</p>
            {callIsMuted && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-rose-300">
                <MicOff className="h-3 w-3" /> Mic muted
              </span>
            )}
          </div>

          {/* Controls */}
          <div className="mt-6 sm:mt-7 flex w-full flex-col items-center gap-4 px-2">
            <SpeakerSwitch
              mode={callSpeakerMode}
              onChange={setSpeakerMode}
              headsetInfo={callHeadsetInfo}
              variant="card"
            />
            <div className="flex w-full justify-center gap-6">
              <div className="flex flex-col items-center gap-1.5">
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
                  {callIsMuted ? (
                    <MicOff className="h-5 w-5 text-rose-400" />
                  ) : (
                    <Mic className="h-5 w-5 text-[#facc15]" />
                  )}
                </button>
                <span className="text-[11px] font-medium text-zinc-400">
                  {callIsMuted ? 'Unmute' : 'Mute'}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleAnswer}
                  disabled={answering}
                  className="h-12 w-12 sm:h-13 sm:w-13 shrink-0 rounded-2xl border border-emerald-500/50 bg-emerald-600 flex items-center justify-center text-white shadow-[0_0_24px_rgba(16,185,129,0.35)] transition-all hover:bg-emerald-500 hover:scale-105 active:scale-95 cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
                  aria-label={answering ? 'Connecting call' : 'Accept call'}
                >
                  {answering ? <Loader2 className="h-6 w-6 animate-spin" /> : <Phone className="h-6 w-6" />}
                </button>
                <span className="text-[11px] font-medium text-emerald-400">
                  {answering ? 'Joining…' : 'Accept'}
                </span>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
