import { useEffect, useRef, useState } from 'react'
import {
  Bluetooth,
  Ear,
  Headphones,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  SwitchCamera,
  User,
  Video,
  VideoOff,
  Volume2,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import toast from 'react-hot-toast'
import { useChatStore } from '../store/useChatStore'
import { resolveMediaUrl } from '../config'
import {
  CALL_SPEAKER_MODES,
  playRemoteCallAudio,
  setNativeSpeakerMode,
  subscribeNativeAudioRoutes
} from '../utils/callAudio'
import { playSound, startOutgoingRingback, stopOutgoingRingback } from '../utils/sounds'
import { backdropMotionClass, modalMotionClass, useAnimatedPresence } from '../hooks/useAnimatedPresence'
import SpeakerSwitch from './SpeakerSwitch'

const formatTime = (s) => {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec < 10 ? '0' : ''}${sec}`
}

function PeerAvatarCircle({ avatarUrl, peerName, failed, onError, sizeClass = 'h-32 w-32', textClass = 'text-3xl' }) {
  const trimmed = (peerName || '').trim()
  const initial = trimmed && trimmed !== 'Call' ? trimmed.charAt(0).toUpperCase() : ''
  const resolvedUrl = resolveMediaUrl(avatarUrl)

  return (
    <div className={`flex ${sizeClass} items-center justify-center overflow-hidden rounded-full border-2 border-amber-500/30 bg-[#0f1114] shadow-xl shadow-amber-500/5`}>
      {resolvedUrl && !failed ? (
        <img
          src={resolvedUrl}
          alt=""
          onError={onError}
          className="h-full w-full object-cover"
        />
      ) : initial ? (
        <span className={`${textClass} font-black text-zinc-200`}>{initial}</span>
      ) : (
        <User className="h-14 w-14 text-zinc-400" />
      )}
    </div>
  )
}

export default function CallScreen() {
  const {
    activeCall,
    activeConversation,
    chatUser,
    callLocalStream,
    callRemoteStream,
    callIsMuted,
    callSpeakerMode,
    callHeadsetInfo,
    callIsCameraOff,
    callCameraFacing,
    callIsMinimized,
    callTimerSeconds,
    callConnectionState,
    toggleMute,
    setSpeakerMode,
    syncNativeAudioRoutes,
    applyNativeAudioRoutesPayload,
    toggleVideoCamera,
    switchCallCamera,
    minimizeCall,
    restoreCall,
    endCall
  } = useChatStore(useShallow((state) => state))

  const remoteVideoRef = useRef(null)
  const localVideoRef = useRef(null)
  // Tone bookkeeping: one "picked up" cue per call, and the end cue only for a
  // call that had actually been answered.
  const connectedTonePlayedRef = useRef(false)
  const previousCallRef = useRef(null)
  // Mobile browsers can reject the async play() after the "answer" gesture
  // (autoplay policy), leaving a connected call completely silent with no way
  // to start audio. Surface a tap target and retry on the next interaction.
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [controlsHidden, setControlsHidden] = useState(false)
  const [videoSwapped, setVideoSwapped] = useState(false)
  const [switchingCamera, setSwitchingCamera] = useState(false)

  // The call may belong to a conversation other than the one open behind it
  // (incoming calls are detected globally), so resolve its own room.
  const callConversation = useChatStore((state) =>
    state.conversations.find((c) => String(c.id) === String(activeCall?.roomId))
  )

  const isVideo = activeCall?.callType === 'video'

  // The sink element is created and unlocked from the call/answer tap, so the
  // peer's audio can start even when it arrives after that gesture (iOS blocks
  // a first play() from a non-gesture context, which made calls silent).
  const playRemoteAudio = async () => {
    if (!callRemoteStream) return
    const started = await playRemoteCallAudio(callRemoteStream)
    setAudioBlocked(!started)
    if (started) setNativeSpeakerMode(useChatStore.getState().callSpeakerMode)
  }

  // Bind remote audio stream so call voice/audio is heard
  useEffect(() => {
    if (!callRemoteStream) return undefined
    let cancelled = false
    playRemoteCallAudio(callRemoteStream).then((started) => {
      if (cancelled) return
      setAudioBlocked(!started)
      if (started) setNativeSpeakerMode(useChatStore.getState().callSpeakerMode)
    })
    return () => { cancelled = true }
  }, [callRemoteStream])

  // While playback is blocked, the next tap anywhere on the call screen unlocks it.
  useEffect(() => {
    if (!audioBlocked) return undefined
    const retry = () => playRemoteAudio()
    window.addEventListener('pointerdown', retry, { once: true })
    window.addEventListener('touchstart', retry, { once: true })
    return () => {
      window.removeEventListener('pointerdown', retry)
      window.removeEventListener('touchstart', retry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBlocked])

  const isCallerRinging = Boolean(activeCall && activeCall.state === 'ringing' && activeCall.callerId === chatUser?.id)
  const isReconnecting = Boolean(activeCall && activeCall.state === 'active' && callConnectionState === 'disconnected')
  const isConnecting = Boolean(
    activeCall &&
    activeCall.state === 'active' &&
    callConnectionState !== 'connected' &&
    callConnectionState !== 'disconnected'
  )
  const showCallScreen = Boolean(activeCall && (activeCall.state === 'active' || isCallerRinging))

  // Keep native headset availability (Bluetooth / wired) in sync during a call.
  useEffect(() => {
    if (!showCallScreen) return undefined
    syncNativeAudioRoutes()
    return subscribeNativeAudioRoutes(applyNativeAudioRoutesPayload)
  }, [showCallScreen, syncNativeAudioRoutes, applyNativeAudioRoutesPayload])

  // Attach video streams to whichever slot (main vs PiP) currently displays
  // them, and re-bind whenever the screen restores from minimized state or
  // local camera toggles back on.
  useEffect(() => {
    if (!isVideo || callIsMinimized || !showCallScreen) return
    const mainStream = videoSwapped ? callLocalStream : callRemoteStream
    const pipStream = videoSwapped ? callRemoteStream : callLocalStream
    if (remoteVideoRef.current && mainStream) {
      remoteVideoRef.current.srcObject = mainStream
      remoteVideoRef.current.play().catch(() => {})
    }
    if (localVideoRef.current && pipStream) {
      localVideoRef.current.srcObject = pipStream
      localVideoRef.current.play().catch(() => {})
    }
  }, [
    callRemoteStream,
    callLocalStream,
    isVideo,
    callIsMinimized,
    videoSwapped,
    callIsCameraOff,
    showCallScreen
  ])

  // Outgoing ringback while the peer's phone is ringing.
  useEffect(() => {
    const isRinging = Boolean(
      activeCall && activeCall.state === 'ringing' && activeCall.callerId === chatUser?.id
    )
    if (isRinging) startOutgoingRingback()
    else stopOutgoingRingback()
    return () => stopOutgoingRingback()
  }, [activeCall?.state, activeCall?.callerId, chatUser?.id])

  // One "picked up" tone when the media path actually comes up, plus re-sync
  // the selected Loud/Ear/Headset route in case WebRTC initialization changed it.
  useEffect(() => {
    if (callConnectionState === 'connected') {
      setNativeSpeakerMode(useChatStore.getState().callSpeakerMode)
      if (!connectedTonePlayedRef.current) {
        connectedTonePlayedRef.current = true
        playSound('connect')
      }
    }
  }, [callConnectionState])

  // A call that was answered and then disappeared (either side hung up) gets
  // the falling end tone. Also reset transient view toggles between calls.
  useEffect(() => {
    if (activeCall) {
      previousCallRef.current = activeCall
      return
    }
    if (previousCallRef.current) {
      const endedState = previousCallRef.current.state
      previousCallRef.current = null
      connectedTonePlayedRef.current = false
      if (endedState === 'active') playSound('end')
    }
    setControlsHidden(false)
    setVideoSwapped(false)
    setAudioBlocked(false)
  }, [activeCall])

  const matchingActiveConv = String(activeConversation?.id) === String(activeCall?.roomId) ? activeConversation : null
  const currentPeerName =
    activeCall?.peerName ||
    matchingActiveConv?.contact_name ||
    matchingActiveConv?.other_user?.name ||
    callConversation?.contact_name ||
    callConversation?.other_user?.name ||
    activeConversation?.other_user?.name ||
    'Call'

  const currentPeerAvatar =
    activeCall?.peerAvatar ||
    matchingActiveConv?.contact_avatar ||
    matchingActiveConv?.other_user?.profile_image ||
    callConversation?.contact_avatar ||
    callConversation?.other_user?.profile_image ||
    null

  useEffect(() => {
    setAvatarFailed(false)
  }, [currentPeerAvatar])

  const callPresence = useAnimatedPresence(
    showCallScreen
      ? {
          isVideo: Boolean(isVideo),
          isCallerRinging,
          isConnecting,
          isReconnecting,
          isMinimized: Boolean(callIsMinimized),
          peerName: currentPeerName,
          peerAvatar: currentPeerAvatar,
          callTimerSeconds
        }
      : null,
    250
  )

  if (!callPresence.mounted) return null

  const snapshot = callPresence.data || {}
  if (!showCallScreen && snapshot.isMinimized) return null
  const viewIsVideo = showCallScreen ? isVideo : Boolean(snapshot.isVideo)
  const viewIsCallerRinging = showCallScreen ? isCallerRinging : Boolean(snapshot.isCallerRinging)
  const viewIsConnecting = showCallScreen ? isConnecting : Boolean(snapshot.isConnecting)
  const viewIsReconnecting = showCallScreen ? isReconnecting : Boolean(snapshot.isReconnecting)
  const peerName = showCallScreen ? currentPeerName : (snapshot.peerName || 'Call')
  const peerAvatar = showCallScreen ? currentPeerAvatar : (snapshot.peerAvatar || null)
  const displayTimerSeconds = showCallScreen ? callTimerSeconds : (snapshot.callTimerSeconds || 0)

  const statusLabel = viewIsCallerRinging
    ? 'Ringing…'
    : viewIsReconnecting
      ? 'Reconnecting…'
      : viewIsConnecting
        ? 'Connecting…'
        : formatTime(displayTimerSeconds)

  const statusDetailText = viewIsCallerRinging
    ? 'Ringing…'
    : viewIsReconnecting
      ? 'Reconnecting…'
      : viewIsConnecting
        ? 'Connecting…'
        : `${viewIsVideo ? 'Video' : 'Voice'} call in progress`

  const statusDotColor = viewIsReconnecting || viewIsConnecting || viewIsCallerRinging
    ? 'bg-amber-400'
    : 'bg-emerald-500'

  const handleCameraSwitch = async () => {
    if (switchingCamera) return
    setSwitchingCamera(true)
    try {
      const res = await switchCallCamera()
      if (res && !res.success && !res.busy && res.error) {
        toast.error(res.error)
      }
    } finally {
      setSwitchingCamera(false)
    }
  }

  const cycleSpeakerModeForMiniBar = () => {
    const order = callHeadsetInfo?.connected
      ? [CALL_SPEAKER_MODES.LOUD, CALL_SPEAKER_MODES.EAR, CALL_SPEAKER_MODES.HEADSET]
      : [CALL_SPEAKER_MODES.LOUD, CALL_SPEAKER_MODES.EAR]
    const idx = order.indexOf(callSpeakerMode)
    const next = order[(idx + 1) % order.length]
    setSpeakerMode(next)
  }

  // Minimized floating call pill: lets the user browse or reply in chat
  // without ending the call or losing WebRTC/audio playback.
  if (showCallScreen && callIsMinimized) {
    const speakerLabel =
      callSpeakerMode === CALL_SPEAKER_MODES.HEADSET
        ? (callHeadsetInfo?.type === 'bluetooth' ? 'BT' : 'Headset')
        : callSpeakerMode === CALL_SPEAKER_MODES.EAR
          ? 'Ear'
          : 'Loud'
    const SpeakerMiniIcon =
      callSpeakerMode === CALL_SPEAKER_MODES.HEADSET
        ? (callHeadsetInfo?.type === 'bluetooth' ? Bluetooth : Headphones)
        : callSpeakerMode === CALL_SPEAKER_MODES.EAR
          ? Ear
          : Volume2

    return (
      <div className="pointer-events-none fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top,0px))] z-[105] flex justify-center">
        <div className="pointer-events-auto animate-popover-spring flex w-full max-w-md flex-col gap-2 rounded-2xl border border-amber-400/30 bg-[#0c0d10]/95 px-3 py-2.5 shadow-2xl shadow-black/70 backdrop-blur-md">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={restoreCall}
              aria-label={`Return to call with ${peerName}`}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer transition active:opacity-80"
            >
              <div className="relative h-9 w-9 shrink-0 rounded-full bg-[#15171c]">
                <PeerAvatarCircle
                  avatarUrl={peerAvatar}
                  peerName={peerName}
                  failed={avatarFailed}
                  onError={() => setAvatarFailed(true)}
                  sizeClass="h-full w-full"
                  textClass="text-sm"
                />
                <span className={`absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full ring-2 ring-[#0c0d10] ${statusDotColor}`} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-white">{peerName}</p>
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                  <span>{statusLabel}</span>
                  {callIsMuted && <span className="text-rose-400">· Muted</span>}
                </div>
              </div>
            </button>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={cycleSpeakerModeForMiniBar}
                className="inline-flex h-8 items-center gap-1 rounded-xl border border-amber-400/30 bg-amber-400/15 px-2 text-[11px] font-semibold text-[#facc15] transition active:scale-95 cursor-pointer"
                aria-label={`Speaker mode: ${speakerLabel}. Tap to switch`}
                title={`Speaker: ${speakerLabel}`}
              >
                <SpeakerMiniIcon className="h-3.5 w-3.5" />
                <span>{speakerLabel}</span>
              </button>
              <button
                type="button"
                onClick={toggleMute}
                className={`flex h-8 w-8 items-center justify-center rounded-xl border transition active:scale-95 cursor-pointer ${
                  callIsMuted
                    ? 'border-rose-500/40 bg-rose-500/20 text-rose-400'
                    : 'border-white/10 bg-white/5 text-white'
                }`}
                aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {callIsMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={restoreCall}
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-200 transition active:scale-95 cursor-pointer"
                aria-label="Expand call screen"
                title="Expand"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={endCall}
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-rose-500/50 bg-rose-600 text-white transition active:scale-95 cursor-pointer"
                aria-label="End call"
                title="End call"
              >
                <Phone className="h-3.5 w-3.5 rotate-[135deg]" />
              </button>
            </div>
          </div>

          {audioBlocked && (
            <button
              type="button"
              onClick={playRemoteAudio}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-amber-400/30 bg-amber-500/15 py-1.5 text-[11px] font-semibold text-[#facc15] active:scale-[0.99] cursor-pointer"
            >
              <Volume2 className="h-3.5 w-3.5" /> Tap to hear the call
            </button>
          )}
        </div>
      </div>
    )
  }

  // Video calls are edge-to-edge on phones (like a normal mobile call app):
  // the remote feed fills the screen, controls float on top and respect the
  // safe areas. Voice calls keep the compact card below.
  if (viewIsVideo) {
    const mainIsLocal = videoSwapped && Boolean(callLocalStream)
    const mainStream = mainIsLocal ? callLocalStream : callRemoteStream
    const pipIsRemote = videoSwapped && Boolean(callRemoteStream)
    const pipStream = pipIsRemote ? callRemoteStream : callLocalStream
    const mainMirrored = mainIsLocal && callCameraFacing === 'user'
    const pipMirrored = !pipIsRemote && callCameraFacing === 'user'
    const canSwapFeeds = Boolean(showCallScreen && callRemoteStream && callLocalStream)

    return (
      <div
        className={`fixed inset-0 z-[115] bg-black ${backdropMotionClass(callPresence.isClosing)}`}
        role="dialog"
        aria-modal="true"
        aria-label="Active video call"
      >
        <div
          className="absolute inset-0"
          onClick={() => {
            if (showCallScreen && !viewIsCallerRinging && !audioBlocked) {
              setControlsHidden((prev) => !prev)
            }
          }}
        >
          {showCallScreen && mainStream && !(mainIsLocal && callIsCameraOff) ? (
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              muted
              className={`h-full w-full bg-zinc-900 object-cover ${mainMirrored ? '-scale-x-100' : ''}`}
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0b0c0e]">
              {mainIsLocal && callIsCameraOff ? (
                <>
                  <div className="flex h-24 w-24 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300">
                    <VideoOff className="h-10 w-10" />
                  </div>
                  <p className="text-xs font-medium text-zinc-400">Your camera is off</p>
                </>
              ) : (
                <div className="h-32 w-32 overflow-hidden rounded-full">
                  <PeerAvatarCircle
                    avatarUrl={peerAvatar}
                    peerName={peerName}
                    failed={avatarFailed}
                    onError={() => setAvatarFailed(true)}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {audioBlocked && (
          <button
            type="button"
            onClick={playRemoteAudio}
            className="absolute left-1/2 top-[max(5.75rem,calc(env(safe-area-inset-top,0px)+5rem))] z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/20 px-4 py-2 text-[13px] font-semibold text-[#facc15] backdrop-blur-sm active:scale-95"
          >
            <Volume2 className="h-4 w-4" /> Tap to hear the call
          </button>
        )}

        {/* Top bar: peer name + duration over a readable gradient */}
        <div
          className={`absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 pb-12 pt-[max(0.9rem,env(safe-area-inset-top,0px))] transition-opacity duration-200 ${
            controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[17px] font-semibold text-white">{peerName}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs font-medium text-white/75">
                <span className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full animate-pulse ${statusDotColor}`} />
                  {statusLabel}
                </span>
                {callIsMuted && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/25 px-2 py-0.5 text-[10.5px] font-semibold text-rose-200">
                    <MicOff className="h-3 w-3" /> Muted
                  </span>
                )}
                {callIsCameraOff && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] font-semibold text-zinc-200">
                    <VideoOff className="h-3 w-3" /> Cam off
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {showCallScreen && (
                <button
                  type="button"
                  onClick={minimizeCall}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition active:scale-95 cursor-pointer"
                  aria-label="Minimize call"
                  title="Minimize"
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={endCall}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition active:scale-95 cursor-pointer"
                aria-label="End call"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Corner PiP preview (tap to swap local/remote feed when both exist) */}
        {showCallScreen && pipStream && (
          <button
            type="button"
            onClick={() => {
              if (canSwapFeeds) setVideoSwapped((prev) => !prev)
            }}
            disabled={!canSwapFeeds}
            aria-label={canSwapFeeds ? 'Swap camera view' : 'Local camera preview'}
            className={`absolute right-4 aspect-[3/4] w-24 overflow-hidden rounded-2xl border border-white/25 bg-black shadow-2xl transition-all sm:w-32 ${
              canSwapFeeds ? 'cursor-pointer active:scale-95' : 'cursor-default'
            } ${
              controlsHidden
                ? 'bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))]'
                : 'bottom-[calc(env(safe-area-inset-bottom,0px)_+_12.5rem)]'
            }`}
          >
            {!pipIsRemote && callIsCameraOff ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-zinc-900 text-zinc-400">
                <VideoOff className="h-5 w-5" />
                <span className="text-[10px] font-medium">Off</span>
              </div>
            ) : (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={`h-full w-full object-cover ${pipMirrored ? '-scale-x-100' : ''}`}
              />
            )}
          </button>
        )}

        {/* Bottom controls over a gradient, above the gesture bar */}
        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pt-16 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] transition-opacity duration-200 ${
            controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
        >
          <div className="flex flex-col items-center gap-4">
            <SpeakerSwitch
              mode={callSpeakerMode}
              onChange={setSpeakerMode}
              headsetInfo={callHeadsetInfo}
              variant="overlay"
            />
            <div className="flex items-start justify-center gap-4 sm:gap-5">
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={toggleMute}
                  className={`flex h-13 w-13 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-full border backdrop-blur-sm transition active:scale-95 cursor-pointer ${
                    callIsMuted
                      ? 'border-rose-500/40 bg-rose-500/25 text-rose-300'
                      : 'border-white/20 bg-white/10 text-white'
                  }`}
                  aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {callIsMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
                </button>
                <span className="text-[10.5px] font-medium text-white/75">
                  {callIsMuted ? 'Unmute' : 'Mute'}
                </span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={toggleVideoCamera}
                  disabled={!callLocalStream}
                  className={`flex h-13 w-13 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-full border backdrop-blur-sm transition active:scale-95 cursor-pointer disabled:opacity-45 ${
                    callIsCameraOff
                      ? 'border-rose-500/40 bg-rose-500/25 text-rose-300'
                      : 'border-white/20 bg-white/10 text-white'
                  }`}
                  aria-label={callIsCameraOff ? 'Turn camera on' : 'Turn camera off'}
                >
                  {callIsCameraOff ? <VideoOff className="h-6 w-6" /> : <Video className="h-6 w-6" />}
                </button>
                <span className="text-[10.5px] font-medium text-white/75">
                  {callIsCameraOff ? 'Cam on' : 'Camera'}
                </span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={handleCameraSwitch}
                  disabled={!callLocalStream || switchingCamera}
                  className="flex h-13 w-13 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white backdrop-blur-sm transition active:scale-95 cursor-pointer disabled:opacity-45"
                  aria-label="Switch front or back camera"
                >
                  <SwitchCamera className={`h-6 w-6 ${switchingCamera ? 'animate-pulse' : ''}`} />
                </button>
                <span className="text-[10.5px] font-medium text-white/75">Flip</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={endCall}
                  className="flex h-13 w-13 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-full border border-rose-500/50 bg-rose-600 text-white shadow-[0_0_24px_rgba(239,68,68,0.4)] transition active:scale-95 cursor-pointer"
                  aria-label="End call"
                >
                  <Phone className="h-6 w-6 rotate-[135deg]" />
                </button>
                <span className="text-[10.5px] font-medium text-rose-300">End</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`fixed inset-0 z-[115] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] ${backdropMotionClass(callPresence.isClosing)}`}
      role="dialog"
      aria-modal="true"
      aria-label="Active call"
    >
      <div
        className={`w-full max-w-md max-h-[94dvh] rounded-3xl sm:rounded-[32px] border border-white/10 bg-[#090a0c] shadow-2xl overflow-hidden flex flex-col ${modalMotionClass(callPresence.isClosing)}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 sm:py-5 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-10 w-10 shrink-0 rounded-2xl border border-white/10 flex items-center justify-center bg-white/5">
              <Phone className="h-5 w-5 text-[#facc15]" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider truncate">
                {viewIsCallerRinging ? 'Calling…' : 'Voice Call'} · {peerName}
              </p>
              <p className="text-[17px] sm:text-[20px] font-semibold text-white">
                {statusLabel}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {showCallScreen && (
              <button
                type="button"
                onClick={minimizeCall}
                className="h-9 w-9 rounded-full border border-white/10 flex items-center justify-center text-zinc-200 hover:bg-white/10 active:scale-95 transition cursor-pointer"
                aria-label="Minimize call"
                title="Minimize"
              >
                <Minimize2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={endCall}
              className="h-9 w-9 rounded-full border border-white/10 flex items-center justify-center text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              aria-label="End call"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="flex min-h-full flex-col items-center justify-center py-6 sm:py-8 px-4 sm:px-6">
          {/* Peer avatar + live connection indicator */}
          <div className="relative w-full aspect-square max-w-[180px] sm:max-w-[220px] mx-auto mb-5 sm:mb-6">
            <PeerAvatarCircle
              avatarUrl={peerAvatar}
              peerName={peerName}
              failed={avatarFailed}
              onError={() => setAvatarFailed(true)}
              sizeClass="w-full h-full"
              textClass="text-5xl"
            />

            <div className="absolute right-1 bottom-1 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#090a0c]">
              <div className={`h-2.5 w-2.5 rounded-full animate-pulse ${statusDotColor}`} />
            </div>
          </div>

          <div className="text-center mb-5 sm:mb-6">
            <p className={`text-xs sm:text-sm font-medium tracking-wide ${
              viewIsReconnecting ? 'text-amber-400' : 'text-zinc-400'
            }`}>
              {statusDetailText}
            </p>
            {callIsMuted && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-rose-300">
                <MicOff className="h-3 w-3" /> Mic muted
              </span>
            )}
            {audioBlocked && (
              <button
                type="button"
                onClick={playRemoteAudio}
                className="mt-3 inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/20 px-4 py-2 text-[13px] font-semibold text-[#facc15] active:scale-95"
              >
                <Volume2 className="h-4 w-4" /> Tap to hear the call
              </button>
            )}
          </div>

          {/* Controls */}
          <div className="flex w-full flex-col items-center gap-4 px-2 pb-2">
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
                  title={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-label={callIsMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {callIsMuted ? (
                    <MicOff className="h-5 w-5 text-rose-400" />
                  ) : (
                    <Mic className="h-5 w-5 text-white" />
                  )}
                </button>
                <span className="text-[11px] font-medium text-zinc-400">
                  {callIsMuted ? 'Unmute' : 'Mute'}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={endCall}
                  className="h-12 w-12 sm:h-13 sm:w-13 shrink-0 rounded-2xl border border-rose-500/50 bg-rose-600 flex items-center justify-center text-white shadow-[0_0_20px_rgba(239,68,68,0.35)] transition-all hover:bg-rose-500 active:scale-95 cursor-pointer"
                  title="End call"
                  aria-label="End call"
                >
                  <Phone className="h-6 w-6 rotate-[135deg]" />
                </button>
                <span className="text-[11px] font-medium text-rose-400">End</span>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
