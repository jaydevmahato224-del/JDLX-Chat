import { Capacitor, registerPlugin } from '@capacitor/core'

// Native counterpart: android/.../CallAudioPlugin.java. Registered lazily so
// the web build (where the plugin does not exist) never calls into it.
const CallAudio = registerPlugin('CallAudio')

export const CALL_SPEAKER_MODES = {
  LOUD: 'loud',
  EAR: 'ear',
  HEADSET: 'headset'
}

export const normalizeSpeakerMode = (mode) => {
  if (mode === CALL_SPEAKER_MODES.EAR) return CALL_SPEAKER_MODES.EAR
  if (mode === CALL_SPEAKER_MODES.HEADSET) return CALL_SPEAKER_MODES.HEADSET
  return CALL_SPEAKER_MODES.LOUD
}

export const isNativeCallAudioAvailable = () =>
  typeof window !== 'undefined' && Capacitor?.isNativePlatform?.() === true

export const startNativeCallAudio = async ({ video = false, speakerMode, speaker = true } = {}) => {
  if (!isNativeCallAudioAvailable()) return null
  const mode = speakerMode !== undefined
    ? normalizeSpeakerMode(speakerMode)
    : (speaker === false ? CALL_SPEAKER_MODES.EAR : CALL_SPEAKER_MODES.LOUD)
  try {
    return await CallAudio.start({ video, mode, speaker: mode === CALL_SPEAKER_MODES.LOUD })
  } catch (e) {
    console.warn('native call audio start failed:', e)
    return null
  }
}

export const setNativeSpeakerMode = async (mode) => {
  if (!isNativeCallAudioAvailable()) return null
  const targetMode = normalizeSpeakerMode(mode)
  try {
    return await CallAudio.setSpeakerMode({
      mode: targetMode,
      enabled: targetMode === CALL_SPEAKER_MODES.LOUD
    })
  } catch (e) {
    console.warn('native speaker switch failed:', e)
    return null
  }
}

export const setNativeSpeaker = async (enabled) =>
  setNativeSpeakerMode(enabled ? CALL_SPEAKER_MODES.LOUD : CALL_SPEAKER_MODES.EAR)

export const getNativeCallAudioRoutes = async () => {
  if (!isNativeCallAudioAvailable()) {
    return { hasHeadset: false, headsetType: '', mode: CALL_SPEAKER_MODES.LOUD }
  }
  try {
    return await CallAudio.getAudioRoutes()
  } catch (e) {
    console.warn('native audio routes query failed:', e)
    return { hasHeadset: false, headsetType: '', mode: CALL_SPEAKER_MODES.LOUD }
  }
}

export const subscribeNativeAudioRoutes = (onChange) => {
  if (!isNativeCallAudioAvailable() || typeof onChange !== 'function') {
    return () => {}
  }
  let listenerHandle = null
  let disposed = false
  Promise.resolve(CallAudio.addListener('audioRoutesChanged', (payload) => {
    if (!disposed) onChange(payload || {})
  }))
    .then((handle) => {
      if (disposed) {
        try { handle?.remove?.() } catch { /* ignore */ }
      } else {
        listenerHandle = handle
      }
    })
    .catch(() => {})
  return () => {
    disposed = true
    if (listenerHandle && typeof listenerHandle.remove === 'function') {
      try { listenerHandle.remove() } catch { /* ignore */ }
    }
  }
}

export const stopNativeCallAudio = async () => {
  if (!isNativeCallAudioAvailable()) return
  try {
    await CallAudio.stop()
  } catch (e) {
    console.warn('native call audio stop failed:', e)
  }
}

// 50ms of silence, 8kHz mono PCM WAV. Only used to activate the audio element
// inside the call/answer tap.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='

// iOS — Home Screen web apps especially — only lets an <audio> element start
// playing inside a user gesture. The peer's WebRTC track arrives long after the
// call/answer tap, so the play() issued from that point is rejected and the
// call is silent even though signalling and the microphone work fine. The sink
// is created and played (silently) from the tap itself; once an element has
// been activated by a gesture, the later play() with the real stream is allowed.
let remoteAudioSink = null

const getRemoteAudioSink = () => {
  if (typeof document === 'undefined' || !document.body) return null
  if (remoteAudioSink && remoteAudioSink.isConnected) return remoteAudioSink
  const el = document.createElement('audio')
  el.setAttribute('playsinline', 'true')
  el.setAttribute('webkit-playsinline', 'true')
  el.autoplay = true
  el.preload = 'auto'
  el.style.display = 'none'
  document.body.appendChild(el)
  remoteAudioSink = el
  return el
}

/** Unlock remote-audio playback. Call this synchronously from the tap handler. */
export const unlockRemoteAudio = () => {
  const el = getRemoteAudioSink()
  if (!el) return
  try {
    el.muted = false
    el.volume = 1
    if (!el.srcObject && !el.getAttribute('src')) el.src = SILENT_WAV
    const started = el.play()
    if (started && typeof started.catch === 'function') started.catch(() => {})
  } catch (e) {
    console.warn('remote audio unlock failed:', e)
  }
}

/** Play the peer's stream through the unlocked sink. Resolves true when it started. */
export const playRemoteCallAudio = async (stream) => {
  const el = getRemoteAudioSink()
  if (!el || !stream) return false
  try {
    // The silent clip must go, or the element keeps the data URI as its source.
    if (el.getAttribute('src')) el.removeAttribute('src')
    el.srcObject = stream
    el.muted = false
    el.volume = 1
    await el.play()
    return true
  } catch (e) {
    console.warn('remote call audio play blocked:', e)
    return false
  }
}

export const stopRemoteCallAudio = () => {
  const el = remoteAudioSink
  if (!el) return
  try { el.pause() } catch { /* ignore */ }
  try { el.srcObject = null } catch { /* ignore */ }
  try { el.removeAttribute('src') } catch { /* ignore */ }
}
