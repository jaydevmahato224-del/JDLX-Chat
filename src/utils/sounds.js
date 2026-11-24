// Chat + call sound effects.
//
// Everything here is synthesised with the Web Audio API instead of shipping
// mp3 assets: the tones stay a few hundred bytes, they work offline inside the
// APK, and there is no decode delay on the first message. A real chat app needs
// a distinct cue for each event — send, receive, ring, ringback, connect, end —
// so the user can tell what happened without looking at the screen.
//
// Browsers refuse to start an AudioContext outside a user gesture. `unlockSounds`
// is called from the taps that already exist (send, call, answer), and every
// later tone reuses that context.

// Shares the key the existing "Sound Effects" setting already writes, so the
// old preference keeps working.
const SOUND_KEY = 'jdlx_chat_sound'
const isBrowser = typeof window !== 'undefined'

let ctx = null
let masterGain = null
let ringtoneTimer = null
let ringbackTimer = null

export const isSoundEnabled = () => {
  if (!isBrowser) return false
  try {
    // Default ON: an app that is silent until configured feels broken.
    const raw = window.localStorage.getItem(SOUND_KEY)
    return raw === null ? true : raw !== 'false' && raw !== '0'
  } catch {
    return true
  }
}

export const setSoundEnabled = (enabled) => {
  if (!isBrowser) return
  try {
    window.localStorage.setItem(SOUND_KEY, enabled ? 'true' : 'false')
  } catch { /* private mode / quota */ }
  if (!enabled) {
    stopIncomingRingtone()
    stopOutgoingRingback()
  }
}

const getCtx = () => {
  if (!isBrowser) return null
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return null
  if (!ctx) {
    try {
      ctx = new Ctor()
      masterGain = ctx.createGain()
      masterGain.gain.value = 0.55
      masterGain.connect(ctx.destination)
    } catch {
      ctx = null
      return null
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

/** Create/resume the audio context from a user gesture. Safe to call often. */
export const unlockSounds = () => {
  getCtx()
}

// One enveloped oscillator. `slideTo` glides the pitch for the sweeps used by
// the connect/end cues; a plain tone keeps a constant frequency.
const tone = (freq, startAt, duration, { type = 'sine', gain = 0.22, slideTo = null } = {}) => {
  const c = getCtx()
  if (!c || !masterGain) return
  const osc = c.createOscillator()
  const env = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, startAt)
  if (slideTo) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), startAt + duration)
  }
  env.gain.setValueAtTime(0.0001, startAt)
  env.gain.exponentialRampToValueAtTime(gain, startAt + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  osc.connect(env)
  env.connect(masterGain)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.03)
}

const vibrate = (pattern) => {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
    }
  } catch { /* unsupported */ }
}

/**
 * Play a one-shot cue.
 * send | receive | notification | connect | end | error
 */
export const playSound = (name) => {
  if (!isSoundEnabled()) return
  const c = getCtx()
  if (!c) return
  const now = c.currentTime + 0.01

  switch (name) {
    // Outgoing message: a short rising blip, quiet enough to send in bursts.
    case 'send':
      tone(760, now, 0.07, { gain: 0.14 })
      tone(1140, now + 0.045, 0.09, { gain: 0.11 })
      break

    // Incoming message: the familiar two-note ding.
    case 'receive':
      tone(988, now, 0.11, { gain: 0.2 })
      tone(1319, now + 0.09, 0.16, { gain: 0.18 })
      break

    // Background/notification ping: three quick notes.
    case 'notification':
      tone(659, now, 0.09, { gain: 0.16 })
      tone(880, now + 0.11, 0.09, { gain: 0.16 })
      tone(1175, now + 0.22, 0.13, { gain: 0.14 })
      break

    // Call connected: rising two-tone "picked up" cue.
    case 'connect':
      tone(660, now, 0.14, { gain: 0.2 })
      tone(990, now + 0.13, 0.2, { gain: 0.18 })
      break

    // Call ended: falling tone.
    case 'end':
      tone(560, now, 0.16, { gain: 0.2, slideTo: 380 })
      tone(380, now + 0.15, 0.24, { gain: 0.16, slideTo: 260 })
      break

    case 'error':
      tone(240, now, 0.12, { type: 'square', gain: 0.12 })
      tone(200, now + 0.14, 0.16, { type: 'square', gain: 0.1 })
      break

    default:
      break
  }
}

/**
 * Incoming-call ringtone: two dual-tone bursts, then a pause, repeated until
 * stopped. Accompanied by a vibration burst so a muted phone still alerts.
 */
export const startIncomingRingtone = () => {
  if (!isSoundEnabled()) return
  stopIncomingRingtone()
  const ring = () => {
    if (!isSoundEnabled()) {
      stopIncomingRingtone()
      return
    }
    const c = getCtx()
    if (!c) return
    const base = c.currentTime + 0.02
    for (const offset of [0, 0.62]) {
      tone(440, base + offset, 0.4, { gain: 0.17 })
      tone(480, base + offset, 0.4, { gain: 0.17 })
    }
    vibrate([420, 200, 420])
  }
  ring()
  ringtoneTimer = setInterval(ring, 2800)
}

export const stopIncomingRingtone = () => {
  if (ringtoneTimer) {
    clearInterval(ringtoneTimer)
    ringtoneTimer = null
  }
  vibrate(0)
}

/**
 * Outgoing ringback: the single low beep a caller hears while the other phone
 * rings. Quiet, once every 3s.
 */
export const startOutgoingRingback = () => {
  if (!isSoundEnabled()) return
  stopOutgoingRingback()
  const beep = () => {
    if (!isSoundEnabled()) {
      stopOutgoingRingback()
      return
    }
    const c = getCtx()
    if (!c) return
    tone(425, c.currentTime + 0.02, 0.9, { gain: 0.1 })
  }
  beep()
  ringbackTimer = setInterval(beep, 3000)
}

export const stopOutgoingRingback = () => {
  if (ringbackTimer) {
    clearInterval(ringbackTimer)
    ringbackTimer = null
  }
}

/** Stop every looping cue (call cleanup, logout, sound switched off). */
export const stopAllCallSounds = () => {
  stopIncomingRingtone()
  stopOutgoingRingback()
}
