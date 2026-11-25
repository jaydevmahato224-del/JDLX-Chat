import { create } from 'zustand'
import toast from 'react-hot-toast'
import { apiFetch } from '../utils/apiFetch'
import { sameId } from '../utils/ids'
import { supabase, setSupabaseRealtimeAuth } from '../utils/supabaseClient'
import { SUPABASE_PRIVATE_CHANNELS, isCapacitorNative } from '../config'
import { subscribeToChatPush, unsubscribeFromChatPush } from '../utils/push'
import { disableChatNativePush, enableChatNativePush } from '../utils/nativePush'
import {
  CALL_AUDIO_CONSTRAINTS,
  applyCallAudioBitrate,
  applyLowDataAudioSdp
} from '../utils/callAudioProfile'
import {
  startNativeCallAudio,
  setNativeSpeaker,
  stopNativeCallAudio,
  unlockRemoteAudio,
  stopRemoteCallAudio
} from '../utils/callAudio'
import { playSound, stopAllCallSounds, unlockSounds } from '../utils/sounds'
import {
  encryptChatMessage,
  decryptChatMessage,
  getOrCreateIdentityKeypair,
  readIdentity,
  clearIdentity,
  restoreIdentityFromJwkString,
  encryptRoomMessageV2,
  decryptRoomMessageV2,
  deriveRoomKeyV2,
  isV2Message,
  isEncryptedMessage,
  encryptIdentityBackup,
  decryptIdentityBackup,
  isEncryptedIdentityBackup
} from '../utils/chatCrypto'

const CHAT_TOKEN_KEY = 'jdlx_chat_token'
const CHAT_REFRESH_KEY = 'jdlx_chat_refresh_token'
const CHAT_USER_KEY = 'jdlx_chat_user'
const CHAT_THEME_KEY = 'jdlx_chat_theme'

// Call signaling can fail in ways that have no useful message of their own.
// A backend that is unreachable (or answers the CORS preflight with a 404
// because the /call/* routes are not deployed there) makes fetch reject with a
// bare `TypeError: Failed to fetch`, which must never reach the user as-is.
const describeCallError = (err, fallback = 'Call failed') => {
  if (!err) return fallback
  if (err.name === 'AbortError') return 'Call cancelled'
  if (err instanceof TypeError || /failed to fetch|networkerror/i.test(err.message || '')) {
    return 'Cannot reach the call server. Voice calling may not be enabled on this backend yet.'
  }
  return err.message || fallback
}

// Flask answers an unknown route with 404 "Resource not found" (and 405 for a
// wrong method); a real call-signaling error has its own message.
const isMissingCallRoute = (res, json) =>
  res.status === 405
  || (res.status === 404 && /resource not found/i.test(json?.error || json?.message || ''))

const CALL_ROUTES_MISSING_ERROR = 'Voice calling is not available on this server yet.'

// A muted conversation must stay silent even for a message that arrives while
// another chat is open: that chime is produced here, not by the chat screen.
// Mute entries live in the same localStorage map the mute UI writes
// ({ until: 'always' | timestamp }), so this needs no extra state.
const isRoomSoundMuted = (roomId) => {
  if (!roomId || typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem('jdlx_chat_muted_rooms_v2')
    if (!raw) return false
    const entry = JSON.parse(raw)?.[String(roomId)]
    if (!entry) return false
    if (entry.until === 'always') return true
    if (typeof entry.until === 'number') return Date.now() < entry.until
    return true
  } catch {
    return false
  }
}

// ICE candidates are exchanged through the backend as strings. Send the whole
// candidate init (sdpMid/sdpMLineIndex matter for video calls with several
// m-lines) instead of only `candidate.candidate`, and fall back to the old
// plain-string format when reading rows written by an older client.
const serializeIceCandidate = (candidate) => {
  if (!candidate || !candidate.candidate) return ''
  try {
    const json = typeof candidate.toJSON === 'function'
      ? candidate.toJSON()
      : {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null
        }
    return JSON.stringify(json)
  } catch {
    return candidate.candidate
  }
}

// A phone emits an ICE candidate every few hundred milliseconds. Posting each
// one separately cost several remote-DB round-trips per candidate, so two
// phones took tens of seconds to exchange candidates while the UI already said
// "active" — the call connected too late to hear anything. Buffer them and
// flush one request per burst.
const createIceBatcher = (roomId, getToken) => {
  let batch = []
  let timer = null
  let retries = 0
  let inFlight = false

  const schedule = (delay) => {
    if (timer) return
    timer = setTimeout(() => { timer = null; flush() }, delay)
  }

  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (inFlight || !batch.length) return
    inFlight = true
    const candidates = batch.splice(0)
    let retryable = true
    try {
      const res = await apiFetch(`/chat/rooms/${roomId}/call/ice-candidate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({ candidates })
      })
      if (res.ok) {
        retries = 0
        retryable = false
      } else if (res.status === 403 || res.status === 404 || res.status === 410) {
        // The call is over (or we no longer belong to it): these candidates
        // can never be used, so do not keep retrying them.
        retries = 0
        retryable = false
      }
    } catch (e) {
      // Network failure / timeout: retryable below.
      console.warn('send ice candidates error:', e)
    } finally {
      inFlight = false
    }

    if (retryable) {
      if (retries < 3) {
        retries += 1
        // Put them back at the FRONT: ICE candidate order matters.
        batch.unshift(...candidates)
        schedule(600 * retries)
        return
      }
      retries = 0
      // Never silent: a lost batch is exactly why a call stays silent.
      console.warn('dropping ice candidates after repeated failures:', candidates.length)
    }

    // Anything gathered while the request was in flight goes out next.
    if (batch.length) schedule(120)
  }

  return {
    add: (payload) => {
      if (!payload) return
      batch.push(payload)
      schedule(120)
    },
    flush
  }
}

// Remote signalling reaches the client twice: the Supabase broadcast (fast,
// fired by the backend) and the /call/state poll (fallback). Both go through
// the helpers below so the peer connection never applies the same answer or
// candidate twice. Candidates that arrive before the remote answer are parked:
// addIceCandidate() before setRemoteDescription() throws, and the candidate
// would otherwise be lost for good.
const appliedCallCandidates = new Set()
const pendingCallCandidates = []
let callAnswerApplied = false
// Every start attempt gets a generation. cleanupCallResources() bumps it, so an
// initiateCall still awaiting the mic prompt / ICE fetch can tell the user
// cancelled and must not resurrect the call when those promises resolve.
let callStartGeneration = 0
// endCall() fires its hangup request in the background. A new offer must not
// race it, or the previous row is still 'active' and the server answers 409.
let pendingEndCallRequest = null

const parseIceCandidate = (raw) => {
  if (!raw) return null
  if (typeof raw === 'object') return raw.candidate ? raw : null
  const text = String(raw).trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && parsed.candidate) return parsed
    } catch {
      /* legacy plain candidate string */
    }
  }
  return { candidate: text }
}

// iOS Home Screen web apps do not persist the getUserMedia permission. Once a
// call ends the microphone track is stopped, and the next call's
// getUserMedia() shows the "Allow microphone?" dialog all over again — even
// when the app was never closed. Keeping the granted mic track alive between
// calls (disabled, so nothing is captured or transmitted) lets the next call
// reuse it and ask for permission only once per app launch. It is released
// after a short idle window (so the phone is not left capturing for long), when
// the app goes to the background, on logout, or as soon as the browser ends it.
// One ring window for both sides: the caller gives up and the callee's modal
// stops ringing at the same moment, so a call can never look missed on one
// side while it still rings on the other. The backend retires abandoned rows
// later (90s), which is only a safety net for clients that vanished.
export const CALL_RING_TIMEOUT_MS = 60000

// Grace period for a redial: the parked mic keeps the OS permission warm, but
// a live capture keeps the microphone indicator on and drains battery, so hold
// it for seconds (enough to redial), not minutes.
const CALL_MIC_IDLE_KEEP_MS = 10 * 1000
let idleCallMicStream = null
let idleCallMicTimer = null

const releaseIdleCallMic = () => {
  if (idleCallMicTimer) { clearTimeout(idleCallMicTimer); idleCallMicTimer = null }
  if (idleCallMicStream) {
    idleCallMicStream.getTracks().forEach((t) => { try { t.stop() } catch {} })
    idleCallMicStream = null
  }
}

// Hand the parked microphone track to a new call.
const takeIdleCallMicTrack = () => {
  if (idleCallMicTimer) { clearTimeout(idleCallMicTimer); idleCallMicTimer = null }
  const stream = idleCallMicStream
  idleCallMicStream = null
  const track = stream?.getAudioTracks().find((t) => t.readyState === 'live')
  if (!track) {
    if (stream) stream.getTracks().forEach((t) => { try { t.stop() } catch {} })
    return null
  }
  stream.getTracks().forEach((t) => { if (t !== track) { try { t.stop() } catch {} } })
  track.enabled = true
  return track
}

// Park the microphone after a call instead of stopping it, so the next call in
// this app launch does not trigger the iOS permission prompt again.
const parkCallMic = (stream) => {
  const track = stream?.getAudioTracks().find((t) => t.readyState === 'live')
  if (!track) return false
  if (idleCallMicStream?.getAudioTracks().includes(track)) return true
  stream.getTracks().forEach((t) => { if (t !== track) { try { t.stop() } catch {} } })
  releaseIdleCallMic()
  // Keep the track enabled while parked: nothing is transmitted (it is not in
  // any peer connection) and WebKit resumes a live track more reliably than a
  // track that was disabled for minutes and switched back on.
  track.enabled = true
  idleCallMicStream = new MediaStream([track])
  idleCallMicTimer = setTimeout(() => { releaseIdleCallMic() }, CALL_MIC_IDLE_KEEP_MS)
  return true
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseIdleCallMic()
  })
}

// Single place both call paths get their local media from, so a warm mic track
// and the plain getUserMedia() constraints stay in sync.
const acquireCallMedia = async (wantVideo) => {
  const warmMicTrack = takeIdleCallMicTrack()
  if (warmMicTrack) {
    if (!wantVideo) return new MediaStream([warmMicTrack])
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user' }
      })
      return new MediaStream([warmMicTrack, ...videoStream.getVideoTracks()])
    } catch (e) {
      try { warmMicTrack.stop() } catch {}
      throw e
    }
  }
  return navigator.mediaDevices.getUserMedia({
    // Echo cancellation / noise suppression matter enormously on a phone
    // speaker and Android WebView honours these constraints.
    // Mono capture halves the Opus payload, which is the cheapest data saving
    // available on a weak mobile link (voice needs no stereo).
    audio: { ...CALL_AUDIO_CONSTRAINTS },
    video: wantVideo ? { facingMode: 'user' } : false
  })
}

let realtimeAuthReady = false
let realtimeAuthExpiresAt = 0
let realtimeAuthPromise = null
let realtimeAuthTimer = null
let realtimeAuthGeneration = 0
let realtimeAuthTopics = new Set()

// A private channel only joins when the backend's Realtime JWT is signed with
// the project's current key and the RLS policies are applied. When that setup
// is wrong every join fails, and retrying forever would both hammer Realtime
// and leave the chat without live updates. After two consecutive failures we
// stop asking for private tokens and use the public channels again instead of
// hot-looping reconnects.
let realtimePrivateFailures = 0
let realtimePrivateDisabled = false

// Invalidate any token request still in flight. Without the generation check
// an account switch could apply the previous account's Realtime JWT to the new
// session, leaving private room channels unauthorized.
function resetSupabaseRealtimeAuth() {
  realtimeAuthGeneration += 1
  realtimeAuthReady = false
  realtimeAuthExpiresAt = 0
  realtimeAuthPromise = null
  realtimeAuthTopics = new Set()
  if (realtimeAuthTimer) clearTimeout(realtimeAuthTimer)
  realtimeAuthTimer = null
  setSupabaseRealtimeAuth(null)
}

function resetRealtimePrivateFallback() {
  realtimePrivateFailures = 0
  realtimePrivateDisabled = false
}

// Returns true only when this failure just switched the session to public
// channels, so callers can skip their normal reconnect bookkeeping.
function notePrivateChannelFailure(isPrivateChannel) {
  if (!isPrivateChannel || realtimePrivateDisabled) return false
  realtimePrivateFailures += 1
  if (realtimePrivateFailures < 2) return false
  realtimePrivateDisabled = true
  resetSupabaseRealtimeAuth()
  console.warn(
    '[SUPABASE REALTIME] Private channels rejected twice — check SUPABASE_JWT_SECRET ' +
    '(must be the project signing key) and the RLS policies. Falling back to public channels.'
  )
  return true
}

// Fetch the private-channel JWT. Returns false when the backend has no
// SUPABASE_JWT_SECRET configured, so callers fall back to public channels.
async function ensureSupabaseRealtimeAuth(get, requiredTopic = null) {
  if (!SUPABASE_PRIVATE_CHANNELS || !supabase || realtimePrivateDisabled) return false
  const topicAllowed = !requiredTopic || realtimeAuthTopics.has(requiredTopic)
  if (realtimeAuthReady && Date.now() < realtimeAuthExpiresAt - 60000 && topicAllowed) {
    return true
  }
  if (realtimeAuthPromise) {
    const ready = await realtimeAuthPromise.catch(() => false)
    if (!ready) return false
    if (!requiredTopic || realtimeAuthTopics.has(requiredTopic)) return true
    // The cached token was issued before this room existed. Fall through and
    // fetch a token that includes the new room instead of waiting an hour.
  }

  const generation = realtimeAuthGeneration
  realtimeAuthPromise = (async () => {
    const token = get().chatToken
    if (!token) return false
    try {
      const res = await apiFetch('/chat/realtime-token', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (generation !== realtimeAuthGeneration) return false
      if (!res.ok || !json.success || !json.data?.token) return false
      if (!setSupabaseRealtimeAuth(json.data.token)) return false
      realtimeAuthReady = true
      realtimeAuthTopics = new Set(Array.isArray(json.data.topics) ? json.data.topics : [])
      const expiresIn = Number(json.data.expires_in) || 3600
      realtimeAuthExpiresAt = Date.now() + expiresIn * 1000
      // Refresh shortly before expiry so reconnects keep working.
      if (realtimeAuthTimer) clearTimeout(realtimeAuthTimer)
      realtimeAuthTimer = setTimeout(() => {
        if (generation !== realtimeAuthGeneration) return
        realtimeAuthReady = false
        ensureSupabaseRealtimeAuth(get).catch(() => {})
      }, Math.max(60000, expiresIn * 1000 - 120000))
      return true
    } catch {
      return false
    } finally {
      if (generation === realtimeAuthGeneration) realtimeAuthPromise = null
    }
  })()

  return realtimeAuthPromise
}

const getStoredChatToken = () => {
  try {
    return localStorage.getItem(CHAT_TOKEN_KEY) || null
  } catch {
    return null
  }
}

const getStoredChatRefreshToken = () => {
  try {
    return localStorage.getItem(CHAT_REFRESH_KEY) || null
  } catch {
    return null
  }
}

const getStoredChatUser = () => {
  try {
    const raw = localStorage.getItem(CHAT_USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Resolve the other participant of a 1:1 conversation. Broadcast payloads are
// never trusted for identity; handlers compare their user_id against this.
function getConversationPeerId(conv, myId) {
  if (!conv || !myId) return null
  if (conv.other_user?.id != null) return conv.other_user.id
  const userOne = conv.user_id ?? conv.user_one_id
  const userTwo = conv.user_two_id
  if (userOne == null && userTwo == null) return null
  return sameId(userOne, myId) ? userTwo : userOne
}

export const sortChatMessages = (a, b) => {
  if (!a || !b) return 0
  const isAOpt = typeof a.id === 'number' && a.id < 0
  const isBOpt = typeof b.id === 'number' && b.id < 0
  if (isAOpt && !isBOpt) return 1
  if (!isAOpt && isBOpt) return -1
  if (isAOpt && isBOpt) {
    const timeA = a.created_at ? new Date(a.created_at).getTime() : 0
    const timeB = b.created_at ? new Date(b.created_at).getTime() : 0
    if (timeA && timeB && timeA !== timeB) return timeA - timeB
    return Math.abs(a.id) - Math.abs(b.id)
  }
  const timeA = a.created_at ? new Date(a.created_at).getTime() : 0
  const timeB = b.created_at ? new Date(b.created_at).getTime() : 0
  if (timeA && timeB && Math.abs(timeA - timeB) > 1000) {
    return timeA - timeB
  }
  return a.id - b.id
}

// ── Optimistic message reconciliation ────────────────────────────────────────
// The send API does not echo a client identifier, so an optimistic bubble and
// its server row are paired on content plus a "server id floor" captured when
// the bubble was created. The important part is pairing 1:1: the previous
// text-only checks let one server row confirm every pending bubble with that
// text (two identical messages → one silently disappeared) and let a fresh
// send be mistaken for an older message with identical text.
const isOptimisticMessage = (m) => Boolean(m) && typeof m.id === 'number' && m.id < 0

const maxConfirmedMessageId = (messages) => (messages || []).reduce(
  (max, m) => (m && typeof m.id === 'number' && m.id > max ? m.id : max),
  0
)

const optimisticMatchesServer = (opt, server) => {
  if (!isOptimisticMessage(opt) || !server) return false
  if (typeof server.id !== 'number' || server.id <= 0) return false
  if (!sameId(server.user_id, opt.user_id)) return false
  const floor = Number(opt._baseMaxId)
  // Without a baseline a server row cannot be told apart from an older message
  // with identical text, so never drop the pending bubble in that case.
  if (!Number.isFinite(floor) || server.id <= floor) return false
  if (opt.media_url && server.media_url) return server.media_url === opt.media_url
  if (opt.media_url || server.media_url) return false
  return (server.message || '') === (opt.message || '')
}

// Remove only the optimistic bubbles that have their OWN server row. Each
// confirmed row can confirm at most one bubble, so duplicate texts keep the
// still-unconfirmed bubble (and its retry affordance) alive.
const unreconciledOptimistic = (confirmed, optimistic) => {
  const pool = (confirmed || []).filter((m) => m && typeof m.id === 'number' && m.id > 0)
  const claimed = new Set()
  const remaining = []
  for (const opt of optimistic || []) {
    const match = pool.find((server) => !claimed.has(server.id) && optimisticMatchesServer(opt, server))
    if (match) claimed.add(match.id)
    else remaining.push(opt)
  }
  return remaining
}

// Used by the failure path: only treat a send as confirmed when a matching
// self-message arrived AFTER the bubble was created, and when that server row
// is not already claimable by an earlier identical pending send.
const hasFreshConfirmation = (messages, optimistic, text, mediaUrl, myId) => {
  if (!optimistic) return false
  const floor = Number(optimistic._baseMaxId)
  if (!Number.isFinite(floor)) return false
  const sameContent = (m) => (
    mediaUrl ? m.media_url === mediaUrl : (m.message || '') === (text || '')
  )
  const confirmations = (messages || []).filter((m) => (
    m && typeof m.id === 'number' && m.id > 0 && m.id > floor
    && sameId(m.user_id, myId) && sameContent(m)
  ))
  if (!confirmations.length) return false
  const olderPending = (messages || []).filter((m) => (
    isOptimisticMessage(m) && m.id !== optimistic.id && sameContent(m)
    && Number(m._sentAt || 0) < Number(optimistic._sentAt || 0)
  ))
  return confirmations.length > olderPending.length
}

// Room+content keys of sends currently in flight, so a double-fired submit
// cannot post the same text twice with two different idempotency keys.
const inFlightSendKeys = new Map()

// The callee learns about a ringing call by polling /calls/incoming. A Supabase
// broadcast from the backend wakes that poll immediately, so the phone rings as
// soon as the offer row exists — the interval below is only the safety net for
// a dropped realtime socket. Polling every second (the old cadence) put one
// Turso query per open client per second behind that net, which is what made
// the DB stall under load.
const CALL_WATCH_IDLE_MS = 5000
const CALL_WATCH_HIDDEN_MS = 20000
const CALL_STATE_POLL_MS = 3000
let callWatcherWake = null
const wakeCallWatcher = () => {
  if (typeof callWatcherWake === 'function') callWatcherWake()
}
const waitForCallWatcherTick = (ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { callWatcherWake = null; resolve() }, ms)
  callWatcherWake = () => { clearTimeout(timer); callWatcherWake = null; resolve() }
})

// ICE config rarely changes, and fetching it on every call put a network
// round-trip in front of the mic prompt. Cached per session (and warmed when a
// conversation is opened) so the call button can start negotiating at once.
const CALL_ICE_CACHE_MS = 10 * 60 * 1000
let cachedCallIceServers = null
let cachedCallIceServersAt = 0
let callIceServersPromise = null

// -----------------------------------------------------------------------------
// INSTANT HYDRATION CACHE (Stale-While-Revalidate)
// Ensures conversations, friends, and active chat load in 0ms on startup / refresh
// -----------------------------------------------------------------------------
// Cache only ciphertext at rest. Decrypted previews/text must never be written
// to localStorage; they are rebuilt from the encrypted payload when needed.
const isCachedCiphertext = (value) => {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return text.startsWith('enc:v1:') || text.startsWith('enc:v2:')
}

const sanitizeCachedMessage = (m) => {
  if (!m || typeof m !== 'object') return null
  const raw = isCachedCiphertext(m.raw_message)
    ? m.raw_message
    : (isCachedCiphertext(m.message) ? m.message : null)
  if (!raw) return null
  const { message: _plaintext, ...rest } = m
  return {
    ...rest,
    raw_message: raw,
    message: '🔒 [Encrypted Message]',
    is_e2e_encrypted: true,
    _locked: true
  }
}

const sanitizeCachedConversation = (c) => {
  if (!c || typeof c !== 'object') return null
  const { last_message: _plaintextPreview, ...rest } = c
  return { ...rest, last_message: '' }
}

const getCachedConversations = (userId) => {
  if (!userId) return []
  try {
    const key = `jdlx_chat_cache_convs_${userId}`
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const sanitized = parsed.map(sanitizeCachedConversation).filter(Boolean)
    const serialized = JSON.stringify(sanitized)
    // Scrub previews cached by older builds on the first read.
    if (serialized !== raw) localStorage.setItem(key, serialized)
    return sanitized
  } catch {
    return []
  }
}

const setCachedConversations = (userId, convs) => {
  if (!userId) return
  try {
    const toCache = (convs || [])
      .map(sanitizeCachedConversation)
      .filter(Boolean)
      .slice(0, 50)
    localStorage.setItem(`jdlx_chat_cache_convs_${userId}`, JSON.stringify(toCache))
  } catch {
    /* ignore */
  }
}

const getCachedFriends = (userId) => {
  if (!userId) return []
  try {
    const raw = localStorage.getItem(`jdlx_chat_cache_friends_${userId}`)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

const setCachedFriends = (userId, friends) => {
  if (!userId) return
  try {
    localStorage.setItem(`jdlx_chat_cache_friends_${userId}`, JSON.stringify(friends || []))
  } catch {
    /* ignore */
  }
}

const getCachedActiveRoomId = (userId) => {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(`jdlx_chat_cache_active_room_${userId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const setCachedActiveRoomId = (userId, roomId) => {
  if (!userId) return
  try {
    if (roomId) localStorage.setItem(`jdlx_chat_cache_active_room_${userId}`, JSON.stringify(roomId))
    else localStorage.removeItem(`jdlx_chat_cache_active_room_${userId}`)
  } catch {
    /* ignore */
  }
}

const getCachedMessages = (userId, roomId) => {
  if (!userId || !roomId) return []
  try {
    const key = `jdlx_chat_cache_msgs_${userId}_${roomId}`
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const sanitized = parsed.map(sanitizeCachedMessage).filter(Boolean)
    const serialized = JSON.stringify(sanitized)
    // Scrub plaintext cached by older builds on the first read.
    if (serialized !== raw) localStorage.setItem(key, serialized)
    return sanitized
  } catch {
    return []
  }
}

const setCachedMessages = (userId, roomId, msgs) => {
  if (!userId || !roomId) return
  try {
    const toCache = (msgs || [])
      .map(sanitizeCachedMessage)
      .filter(Boolean)
      .slice(-50)
    if (toCache.length === 0) {
      localStorage.removeItem(`jdlx_chat_cache_msgs_${userId}_${roomId}`)
    } else {
      localStorage.setItem(`jdlx_chat_cache_msgs_${userId}_${roomId}`, JSON.stringify(toCache))
    }
  } catch {
    /* ignore */
  }
}

// One-time migration for caches written by older builds: strip every cached
// plaintext message/preview, not just the room the user happens to open first.
const scrubLegacyChatCaches = () => {
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && (key.startsWith('jdlx_chat_cache_msgs_') || key.startsWith('jdlx_chat_cache_convs_'))) {
        keys.push(key)
      }
    }
    keys.forEach((key) => {
      const raw = localStorage.getItem(key)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed) || parsed.length === 0) {
        if (key.startsWith('jdlx_chat_cache_msgs_')) localStorage.removeItem(key)
        return
      }
      const sanitized = key.startsWith('jdlx_chat_cache_msgs_')
        ? parsed.map(sanitizeCachedMessage).filter(Boolean)
        : parsed.map(sanitizeCachedConversation).filter(Boolean)
      if (sanitized.length === 0 && key.startsWith('jdlx_chat_cache_msgs_')) {
        localStorage.removeItem(key)
      } else {
        const serialized = JSON.stringify(sanitized)
        if (serialized !== raw) localStorage.setItem(key, serialized)
      }
    })
  } catch {
    /* ignore */
  }
}

scrubLegacyChatCaches()

// Remove this account's offline chat caches and local key-recovery markers.
// E2EE identity deletion is handled by clearIdentity() in chatCrypto.
const clearUserChatCaches = (userId) => {
  if (!userId) return
  const uid = String(userId)
  const exactKeys = new Set([
    `jdlx_chat_cache_convs_${uid}`,
    `jdlx_chat_cache_friends_${uid}`,
    `jdlx_chat_cache_active_room_${uid}`,
    `jdlx_chat_pubkey_synced_${uid}`,
    `jdlx_chat_recovery_pin_set_${uid}`,
    `jdlx_chat_recovery_snoozed_${uid}`,
    'jdlx_chat_contact_custom_data',
    'jdlx_chat_drafts',
    'jdlx_chat_disappearing_settings',
    'jdlx_chat_starred_messages'
  ])
  const messagePrefix = `jdlx_chat_cache_msgs_${uid}_`
  const deliveredPrefix = `jdlx_chat_delivered_${uid}_`
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && (exactKeys.has(key) || key.startsWith(messagePrefix) || key.startsWith(deliveredPrefix))) {
        keys.push(key)
      }
    }
    keys.forEach((key) => localStorage.removeItem(key))
  } catch {
    /* ignore storage errors */
  }
}

const INITIAL_CHAT_USER = getStoredChatUser()
const INITIAL_USER_ID = INITIAL_CHAT_USER?.id || null
const INITIAL_CONVERSATIONS = getCachedConversations(INITIAL_USER_ID)
const INITIAL_FRIENDS = getCachedFriends(INITIAL_USER_ID)
const INITIAL_CACHED_ROOM_ID = getCachedActiveRoomId(INITIAL_USER_ID)

const isDesktopInitial = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(min-width: 768px)').matches

let INITIAL_ACTIVE_CONV = null
let INITIAL_ACTIVE_ROOM_ID = null
let INITIAL_MESSAGES = []

if (INITIAL_CONVERSATIONS.length > 0) {
  // On phones the list screen is the entry point. Restoring a room here would
  // fetch it on mount and mark its unread messages read before the user taps.
  if (INITIAL_CACHED_ROOM_ID && isDesktopInitial) {
    INITIAL_ACTIVE_CONV = INITIAL_CONVERSATIONS.find((c) => sameId(c.id, INITIAL_CACHED_ROOM_ID)) || null
  }
  if (!INITIAL_ACTIVE_CONV && isDesktopInitial) {
    INITIAL_ACTIVE_CONV = INITIAL_CONVERSATIONS[0]
  }
  if (INITIAL_ACTIVE_CONV) {
    INITIAL_ACTIVE_ROOM_ID = INITIAL_ACTIVE_CONV.id
    const savedDelivered = getStoredDeliveredId(INITIAL_USER_ID, INITIAL_ACTIVE_ROOM_ID)
    const hasActiveMessages = Boolean(INITIAL_ACTIVE_CONV.last_message && INITIAL_ACTIVE_CONV.last_message.trim())
    INITIAL_MESSAGES = hasActiveMessages
      ? getCachedMessages(INITIAL_USER_ID, INITIAL_ACTIVE_ROOM_ID).map((m) => {
          if (savedDelivered > 0 && m && m.id <= savedDelivered) {
            return { ...m, is_delivered: 1 }
          }
          return m
        })
      : []
  }
}

function getStoredDeliveredId(uid, roomId) {
  if (!uid || !roomId) return 0
  try {
    return Number(localStorage.getItem(`jdlx_chat_delivered_${uid}_${roomId}`)) || 0
  } catch {
    return 0
  }
}

function setStoredDeliveredId(uid, roomId, deliveredId) {
  if (!uid || !roomId || !deliveredId) return
  try {
    const current = getStoredDeliveredId(uid, roomId)
    if (deliveredId > current) {
      localStorage.setItem(`jdlx_chat_delivered_${uid}_${roomId}`, String(deliveredId))
    }
  } catch {
    /* storage blocked */
  }
}

const INITIAL_DELIVERED_ID = getStoredDeliveredId(INITIAL_USER_ID, INITIAL_ACTIVE_ROOM_ID)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Safe helper to dispatch one-off Supabase user broadcast pings without leaking channels
function sendSupabaseUserAlert(targetUserId, event, payload) {
  if (!supabase || !targetUserId) return
  // On private channels a client may only write to its own topics. The backend
  // sends these alerts with a service-role token, so skip the duplicate that
  // RLS would reject anyway.
  if (SUPABASE_PRIVATE_CHANNELS && realtimeAuthReady) return
  try {
    const channelName = `chat_user_${targetUserId}`
    const existing = (typeof supabase.getChannels === 'function' ? supabase.getChannels() : [])
      .find((c) => c.topic === `realtime:${channelName}`)

    if (existing) {
      if (existing.state === 'joined') {
        existing.send({ type: 'broadcast', event, payload }).catch(() => {})
      } else {
        existing.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            existing.send({ type: 'broadcast', event, payload }).catch(() => {})
          }
        })
      }
      return
    }

    const chan = supabase.channel(channelName)
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearTimeout(timer)
      try {
        chan.unsubscribe().finally(() => {
          supabase.removeChannel(chan)
        })
      } catch {
        try { supabase.removeChannel(chan) } catch { /* ignore */ }
      }
    }
    const timer = setTimeout(cleanup, 4000)

    chan.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        chan.send({ type: 'broadcast', event, payload })
          .catch(() => {})
          .finally(() => {
            setTimeout(cleanup, 300)
          })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        cleanup()
      }
    })
  } catch (err) {
    console.warn('[SUPABASE] sendSupabaseUserAlert error:', err)
  }
}

// One conversation refresh at a time. Startup and realtime can ask for the
// same inbox simultaneously; without this they duplicate the network call and
// the crypto work for every preview.
let conversationsInFlight = null
let conversationsRefreshQueued = false
// One trailing inbox/unread refresh per burst of sends. Every send used to
// fire two extra API calls on the same small server thread pool.
let postSendRefreshTimer = null

const CHAT_THEMES = new Set(['system', 'light', 'dark'])

const getStoredChatTheme = () => {
  try {
    const stored = localStorage.getItem(CHAT_THEME_KEY)
    return CHAT_THEMES.has(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

const getSystemPrefersDark = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

const resolveChatTheme = (preference, systemPrefersDark) => {
  if (preference === 'light' || preference === 'dark') return preference
  return systemPrefersDark ? 'dark' : 'light'
}

const INITIAL_CHAT_THEME = getStoredChatTheme()
const INITIAL_SYSTEM_DARK = getSystemPrefersDark()

// Decrypt one stored message: v2 = true E2EE (ECDH identity key, server never
// sees the key), v1 = legacy server-known room secret. Anything else is plain.
async function decryptStoredMessage(m, roomId, activeConv, identity) {
  const raw = (m?.raw_message && isEncryptedMessage(m.raw_message))
    ? m.raw_message
    : (m?.message || '')
  if (!raw || typeof raw !== 'string') return { ...m, is_e2e_encrypted: false, message: raw }

  const state = useChatStore.getState()
  const currentMyId = state.chatUser?.id
  const myPubKey = state.identityPublicKey
  const convs = state.conversations || []
  const foundConv = convs.find((c) => sameId(c.id, roomId))
  const conv = (activeConv && sameId(activeConv.id, roomId)) ? activeConv : (foundConv || activeConv)

  // 1. Resolve peer public key candidates (ordered from most reliable to fallback)
  const candidateKeys = []

  // If message was sent by peer, sender_public_key is the peer key
  if (m?.sender_public_key && (!currentMyId || !sameId(m.user_id, currentMyId))) {
    candidateKeys.push(m.sender_public_key)
  }
  // If message was sent by me, recipient_public_key is the peer key
  if (m?.recipient_public_key && currentMyId && sameId(m.user_id, currentMyId)) {
    candidateKeys.push(m.recipient_public_key)
  }
  // The conversation contact's public key (the other user in this 1-on-1 chat)
  const convPeerKey = conv?.contact_public_key || conv?.other_user?.public_key || null
  if (convPeerKey) {
    candidateKeys.push(convPeerKey)
  }
  if (foundConv?.contact_public_key) {
    candidateKeys.push(foundConv.contact_public_key)
  }
  // m.contact_public_key (ONLY IF it does not match my own public key!)
  if (m?.contact_public_key && (!myPubKey || m.contact_public_key !== myPubKey)) {
    candidateKeys.push(m.contact_public_key)
  }

  // Filter out any duplicates and invalid / own keys
  const peerKeys = [...new Set(candidateKeys)].filter(
    (k) => k && typeof k === 'string' && k.trim().length > 0 && (!myPubKey || k.trim() !== myPubKey.trim())
  )

  // 2. Resolve room secret
  const roomSecret = (
    m?.e2e_secret ||
    conv?.e2e_secret ||
    conv?.room_key ||
    null
  )

  const resolvedIdentity = identity || state.identityKeypair

  if (isV2Message(raw)) {
    // Attempt v2 ECDH decryption with each candidate peer public key
    for (const pKey of peerKeys) {
      const v2Text = await decryptRoomMessageV2(raw, roomId, resolvedIdentity, pKey)
      if (v2Text && v2Text !== '🔒 [Encrypted Message]') {
        return { ...m, is_e2e_encrypted: true, message: v2Text, raw_message: raw, _locked: false }
      }
    }
    // Fallback: If v2 ECDH failed, attempt room secret decryption
    if (roomSecret) {
      const v1Candidate = raw.replace('enc:v2:', 'enc:v1:')
      const v1Text = await decryptChatMessage(v1Candidate, roomSecret, roomId)
      if (v1Text && v1Text !== '🔒 [Encrypted Message]' && !v1Text.startsWith('enc:')) {
        return { ...m, is_e2e_encrypted: true, message: v1Text, raw_message: raw, _locked: false }
      }
    }
    return { ...m, is_e2e_encrypted: true, message: '🔒 [Encrypted Message]', raw_message: raw, _locked: true }
  }

  if (raw.startsWith('enc:v1:')) {
    const v1Text = await decryptChatMessage(raw, roomSecret, roomId)
    const isLocked = v1Text === '🔒 [Encrypted Message]' || v1Text.startsWith('enc:v1:')
    return {
      ...m,
      is_e2e_encrypted: true,
      message: v1Text,
      raw_message: raw,
      _locked: isLocked
    }
  }

  return { ...m, is_e2e_encrypted: false, message: raw }
}

// Read (or create) the local identity key without waiting for the key-publish
// request. Rendering the inbox only needs the local key; publishing can finish
// in the background.
async function ensureLocalIdentity(get, set) {
  const existing = get().identityKeypair
  if (existing) return existing
  // A PIN-encrypted backup was already found; do not re-download it on every
  // poll. unlockWithRecoveryPin clears this flag after a successful restore.
  if (get().identityNeedsPassphrase) return null
  const uid = get().chatUser?.id
  if (!uid) return null
  try {
    let identity = await readIdentity(uid)
    if (!identity?.privateKey) {
      // Cross-device recovery: check if the server holds a backup.
      let backup = null
      const token = get().chatToken
      if (token) {
        try {
          const res = await apiFetch('/chat/keys/backup', {
            headers: { Authorization: `Bearer ${token}` }
          })
          const json = await res.json()
          if (res.ok && json.success) backup = json.data?.identity_backup || null
        } catch {
          /* ignore */
        }
      }

      if (isEncryptedIdentityBackup(backup)) {
        // Do not silently replace a recoverable identity with a new keypair;
        // wait for the user to enter their recovery PIN (or start fresh).
        set({ identityNeedsPassphrase: true })
        return null
      }
      if (backup) {
        // Legacy plaintext backup from an older build: keep the existing
        // cross-device restore flow working, then encourage PIN setup.
        identity = await restoreIdentityFromJwkString(uid, backup)
      }
      if (!identity?.privateKey) {
        identity = await getOrCreateIdentityKeypair(uid)
      }
    }
    if (!identity) return null
    if (!sameId(get().chatUser?.id, uid)) return null
    set({
      identityKeypair: identity,
      identityPublicKey: identity.publicKeyB64,
      identityUserId: String(uid),
      identityNeedsPassphrase: false
    })
    return identity
  } catch {
    return null
  }
}

export const useChatStore = create((set, get) => ({
  chatToken: getStoredChatToken(),
  chatRefreshToken: getStoredChatRefreshToken(),
  chatUser: getStoredChatUser(),
  chatTheme: INITIAL_CHAT_THEME,
  systemPrefersDark: INITIAL_SYSTEM_DARK,
  resolvedChatTheme: resolveChatTheme(INITIAL_CHAT_THEME, INITIAL_SYSTEM_DARK),
  officialChatLogo: '/logo192.png',
  officialChatName: 'JDLX Chat',
  activeRoom: null,
  activeRoomId: INITIAL_ACTIVE_ROOM_ID,
  activeConversation: INITIAL_ACTIVE_CONV,
  conversations: INITIAL_CONVERSATIONS,
  friends: INITIAL_FRIENDS,
  incomingRequests: [],
  outgoingRequests: [],
  pendingRequestsCount: 0,
  inviteInfo: null,
  messages: INITIAL_MESSAGES,
  messagesLoading: Boolean(INITIAL_ACTIVE_ROOM_ID && (!INITIAL_MESSAGES || INITIAL_MESSAGES.length === 0)),
  messagesHasMore: false,
  loadingOlderMessages: false,
  // True E2EE material: private key stays in IndexedDB, only the public key is
  // published to the backend.
  identityKeypair: null,
  identityPublicKey: '',
  identityUserId: null,
  identityPublished: false,
  // True when this device found a PIN-encrypted backup but has no local key.
  // Chat stays readable in locked mode until the user unlocks with the PIN.
  identityNeedsPassphrase: false,
  // Bumped by the Security tab to reopen the recovery-PIN dialog manually.
  recoveryPromptNonce: 0,
  // Realtime (long-poll) state for the open room
  peerTyping: false,
  peerOnline: false,
  // True once Supabase presence has reported the room peer; while connected,
  // presence is authoritative over the slower server heartbeat window.
  _peerPresenceKnown: false,
  peerLastReadId: 0,
  peerLastDeliveredId: INITIAL_DELIVERED_ID || 0,
  realtimeAbort: null,
  realtimeRoomId: null,
  eventsCursor: 0,
  // Long-poll for friend requests/accepts (independent of any room).
  socialRealtimeAbort: null,
  socialRealtimeRevision: '',
  // Supabase WebSocket Realtime Channels
  supabaseRoomChannel: null,
  supabaseUserChannel: null,
  _typingTimer: null,
  _lastTypingSentAt: 0,
  notifications: [],
  unreadCount: 0,
  loading: false,
  sending: false,
  conversationsLoading: Boolean(getStoredChatToken() && (!INITIAL_CONVERSATIONS || INITIAL_CONVERSATIONS.length === 0)),
  conversationsLoaded: INITIAL_CONVERSATIONS.length > 0,
  conversationsError: null,
  messagesError: null,
  _presenceVisibilityHandler: null,
  error: null,
  // ── Voice / Video call state ──
  activeCall: null,            // { roomId, callType, callerId, calleeId, state, ... }
  callLocalStream: null,       // MediaStream (mic)
  callRemoteStream: null,      // MediaStream (peer audio)
  callPeerConnection: null,    // RTCPeerConnection
  callIsMuted: false,
  callIsSpeakerOn: true,
  callTimerSeconds: 0,
  // Live RTCPeerConnection state ('connecting' until ICE + DTLS finish), so the
  // call screen can say "Connecting…" instead of pretending the call is up.
  callConnectionState: null,
  callTimerRef: null,
  // Summary shown right after a call drops (who, how long, what happened).
  callEndedInfo: null,
  // Call history sheet (GET /chat/calls/history).
  callHistory: [],
  callHistoryLoading: false,
  callHistoryError: null,
  callHistoryOpen: false,
  callAbortController: null,   // in-call poller (pollCallState)
  callWatchAbortController: null, // passive incoming-call watcher (startCallWatcher)
  callDeepLinkHandled: null,   // dedupes answer/decline deep links from native UI

  fetchChatBranding: async () => {
    try {
      // Public branding route; the login page has no session yet, so the
      // admin-only /chat/admin/settings is not an option here.
      const res = await apiFetch('/chat/branding')
      const json = await res.json()
      if (res.ok && json.data) {
        set({
          officialChatLogo: json.data.official_chat_logo || '/logo192.png',
          officialChatName: json.data.official_chat_name || 'JDLX Chat'
        })
        return json.data
      }
    } catch (e) {
      console.warn('Failed to load chat branding:', e)
    }
  },

  setChatTheme: (theme) => {
    const validTheme = CHAT_THEMES.has(theme) ? theme : 'system'
    try {
      localStorage.setItem(CHAT_THEME_KEY, validTheme)
    } catch (e) {
      console.warn('Storage blocked for chat theme:', e)
    }
    set({
      chatTheme: validTheme,
      resolvedChatTheme: resolveChatTheme(validTheme, get().systemPrefersDark)
    })
  },

  setSystemPrefersDark: (isDark) => {
    const systemPrefersDark = Boolean(isDark)
    set((state) => ({
      systemPrefersDark,
      resolvedChatTheme: resolveChatTheme(state.chatTheme, systemPrefersDark)
    }))
  },

  // Quick action: System -> the other visual mode -> the remaining visual mode
  // -> System. The full three-way choice lives in Profile & Appearance.
  toggleChatTheme: () => {
    const current = get().chatTheme
    if (current === 'system') {
      get().setChatTheme(get().resolvedChatTheme === 'dark' ? 'light' : 'dark')
    } else if (current === 'light') {
      get().setChatTheme('dark')
    } else {
      get().setChatTheme('system')
    }
  },

  setChatAuth: (token, user, room = null, refreshToken = null) => {
    try {
      if (token) localStorage.setItem(CHAT_TOKEN_KEY, token)
      else localStorage.removeItem(CHAT_TOKEN_KEY)

      if (refreshToken) localStorage.setItem(CHAT_REFRESH_KEY, refreshToken)
      else if (!token) localStorage.removeItem(CHAT_REFRESH_KEY)

      if (user) localStorage.setItem(CHAT_USER_KEY, JSON.stringify(user))
      else localStorage.removeItem(CHAT_USER_KEY)
    } catch (e) {
      console.warn('Storage blocked for chat auth:', e)
    }

    const previousUserId = get().chatUser?.id
    const userChanged = Boolean(user?.id && previousUserId && !sameId(user.id, previousUserId))

    const uid = user?.id || null
    const cachedConvs = uid ? getCachedConversations(uid) : []
    const cachedFriends = uid ? getCachedFriends(uid) : []
    const cachedRoomId = uid ? getCachedActiveRoomId(uid) : null
    let cachedActiveConv = null
    let cachedMsgs = []
    if (cachedConvs.length > 0) {
      if (cachedRoomId) {
        cachedActiveConv = cachedConvs.find((c) => sameId(c.id, cachedRoomId)) || null
      }
      if (!cachedActiveConv) cachedActiveConv = cachedConvs[0]
      if (cachedActiveConv) {
        cachedMsgs = getCachedMessages(uid, cachedActiveConv.id)
      }
    }

    if (userChanged) {
      // Drop the previous account's realtime subscriptions before applying the
      // new account's cache; otherwise old room events can still land here.
      // Also tear down any live call state so a CallScreen/mic stream from the
      // previous account never survives an account switch.
      get().stopRealtime()
      get().stopSocialRealtime()
      get().stopCallWatcher()
      get().cleanupCallResources()
      resetSupabaseRealtimeAuth()
      resetRealtimePrivateFallback()
    }

    // On an account switch, never fall back to the previous account's state. If
    // the new user has no cache yet, start empty and let the fetches fill it.
    const nextActiveConversation = userChanged
      ? cachedActiveConv
      : (cachedActiveConv || get().activeConversation)
    const nextActiveRoomId = userChanged
      ? (cachedActiveConv?.id || null)
      : (cachedActiveConv?.id || get().activeRoomId)
    const nextConversations = userChanged
      ? cachedConvs
      : (cachedConvs.length > 0 ? cachedConvs : get().conversations)
    const nextFriends = userChanged
      ? cachedFriends
      : (cachedFriends.length > 0 ? cachedFriends : get().friends)
    const nextMessages = userChanged
      ? cachedMsgs
      : (cachedMsgs.length > 0 ? cachedMsgs : get().messages)

    set({
      chatToken: token,
      chatRefreshToken: refreshToken || get().chatRefreshToken,
      chatUser: user,
      activeRoom: userChanged ? (room || null) : (room || get().activeRoom),
      activeConversation: nextActiveConversation,
      activeRoomId: nextActiveRoomId,
      conversations: nextConversations,
      conversationsLoaded: userChanged
        ? cachedConvs.length > 0
        : (cachedConvs.length > 0 || get().conversationsLoaded),
      friends: nextFriends,
      messages: nextMessages,
      messagesLoading: userChanged ? false : get().messagesLoading,
      messagesHasMore: userChanged ? false : get().messagesHasMore,
      loadingOlderMessages: userChanged ? false : get().loadingOlderMessages,
      notifications: userChanged ? [] : get().notifications,
      unreadCount: userChanged ? 0 : get().unreadCount,
      incomingRequests: userChanged ? [] : get().incomingRequests,
      outgoingRequests: userChanged ? [] : get().outgoingRequests,
      pendingRequestsCount: userChanged ? 0 : get().pendingRequestsCount,
      peerTyping: userChanged ? false : get().peerTyping,
      peerOnline: userChanged ? false : get().peerOnline,
      _peerPresenceKnown: userChanged ? false : get()._peerPresenceKnown,
      peerLastReadId: userChanged ? 0 : get().peerLastReadId,
      peerLastDeliveredId: userChanged ? 0 : get().peerLastDeliveredId,
      eventsCursor: userChanged ? 0 : get().eventsCursor,
      error: null,
      ...(userChanged
        ? { identityKeypair: null, identityPublicKey: '', identityUserId: null, identityPublished: false, identityNeedsPassphrase: false }
        : {})
    })

    // Set up/publish this device's E2EE key for the signed-in user
    if (user?.id && token) get().initE2EE(user.id)
    if (SUPABASE_PRIVATE_CHANNELS && user?.id && token) {
      get().initRealtimeAuth().catch(() => {})
    }
  },

  chatLogout: (isManual = false) => {
    const uid = get().chatUser?.id
    get().stopRealtime()
    get().stopSocialRealtime()
    // Tear down any live call: without this, the per-second call timer, the
    // RTCPeerConnection, the polling loop, the incoming-call watcher and the
    // microphone stream all survive logout (mic stays captured on a dead
    // session and the CallScreen can outlive an account switch).
    get().stopCallWatcher()
    get().cleanupCallResources()
    // Drop the mic track kept warm for the next call: a signed-out device must
    // not leave the microphone open.
    releaseIdleCallMic()
    resetSupabaseRealtimeAuth()
    resetRealtimePrivateFallback()
    // Drop this APK device's FCM token before the session is cleared, so a
    // signed-out phone cannot keep receiving the previous account's messages.
    disableChatNativePush().catch(() => {})
    const token = get().chatToken
    const refreshToken = get().chatRefreshToken
    if (isManual && uid) {
      // A user-initiated logout removes offline chat data and the local E2EE
      // private key. Automatic session expiry keeps the key so re-login can
      // still decrypt this device's existing history.
      clearUserChatCaches(uid)
      clearIdentity(uid).catch(() => {})
    }
    if (isManual && (token || refreshToken)) {
      // Server-side revocation: only when the user explicitly clicks logout,
      // bumping chat_users.min_token_iat revokes this session on the server.
      apiFetch('/chat/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {})
      }).catch(() => {})
    }
    try {
      localStorage.removeItem(CHAT_TOKEN_KEY)
      localStorage.removeItem(CHAT_REFRESH_KEY)
      localStorage.removeItem(CHAT_USER_KEY)
    } catch {
      /* ignore storage error */
    }
    set({
      chatToken: null,
      chatRefreshToken: null,
      chatUser: null,
      activeRoom: null,
      activeConversation: null,
      activeRoomId: null,
      conversations: [],
      friends: [],
      // Never leave a post-call summary or the history sheet on the login
      // screen of the next account.
      callEndedInfo: null,
      callHistoryOpen: false,
      callHistory: [],
      callHistoryFetchedAt: 0,
      incomingRequests: [],
      outgoingRequests: [],
      pendingRequestsCount: 0,
      messages: [],
      messagesLoading: false,
      messagesError: null,
      messagesHasMore: false,
      loadingOlderMessages: false,
      identityKeypair: null,
      identityPublicKey: '',
      identityUserId: null,
      identityPublished: false,
      identityNeedsPassphrase: false,
      conversationsLoading: false,
      conversationsLoaded: false,
      conversationsError: null,
      peerTyping: false,
      peerOnline: false,
      _peerPresenceKnown: false,
      peerLastReadId: 0,
      peerLastDeliveredId: 0,
      eventsCursor: 0,
      socialRealtimeRevision: '',
      notifications: [],
      unreadCount: 0,
      error: null
    })
  },

  // Refresh short-lived token using 14-day refresh token rotation
  refreshChatSession: async () => {
    const refreshToken = get().chatRefreshToken || getStoredChatRefreshToken()
    if (!refreshToken) return { success: false, error: 'No refresh token' }

    try {
      const res = await apiFetch('/chat/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      })
      const json = await res.json()
      if (res.ok && json.success && json.data?.chat_token) {
        const { chat_token, refresh_token: newRefresh, user } = json.data
        get().setChatAuth(chat_token, user || get().chatUser, null, newRefresh)
        return { success: true, token: chat_token }
      }
      return { success: false, error: json.message || 'Token refresh failed' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  },

  // Publish this device's ECDH public key. Only public key material is sent
  // here; the optional recovery backup is encrypted with the user's PIN.
  // Warm the E2EE room-key cache in the background when a conversation with a
  // published peer key is opened, so the first send is instant instead of
  // waiting on the ECDH + HKDF derivation. Mirrors the identity bootstrap used
  // by the send path; never blocks the caller (fire-and-forget at call site).
  preDeriveRoomKey: async (roomId, peerKey) => {
    if (!roomId || !peerKey) return
    let identity = get().identityKeypair
    if (!identity) {
      const uid = get().chatUser?.id
      identity = uid ? await getOrCreateIdentityKeypair(uid) : null
      if (identity) {
        set({
          identityKeypair: identity,
          identityPublicKey: identity.publicKeyB64,
          identityUserId: String(uid),
          identityNeedsPassphrase: false
        })
      }
    }
    if (!identity?.privateKey) return
    const key = await deriveRoomKeyV2(identity.privateKey, peerKey, String(roomId))
    if (key && sameId(get().activeRoomId, roomId)) {
      set({ derivedRoomKey: key })
    }
  },

  initE2EE: async (userId) => {
    const token = get().chatToken
    const uid = userId || get().chatUser?.id
    if (!token || !uid) return false
    if (get().identityUserId === String(uid) && get().identityKeypair && get().identityPublished) return true
    if (get().identityNeedsPassphrase) return false

    try {
      // ensureLocalIdentity handles the encrypted-backup case without
      // generating a throwaway key that would overwrite the recoverable one.
      const identity = await ensureLocalIdentity(get, set)
      if (!identity) return false

      set({
        identityKeypair: identity,
        identityPublicKey: identity.publicKeyB64,
        identityUserId: String(uid),
        identityNeedsPassphrase: false
      })

      // Only the public key is published here. The PIN-encrypted recovery
      // backup is uploaded separately by saveRecoveryPin().
      let alreadySynced = false
      try {
        alreadySynced = localStorage.getItem(`jdlx_chat_pubkey_synced_${uid}`) === identity.publicKeyB64
      } catch {
        /* ignore */
      }
      if (alreadySynced) {
        set({ identityPublished: true })
        return true
      }

      const res = await apiFetch('/chat/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ public_key: identity.publicKeyB64 })
      })
      if (res.ok) {
        set({ identityPublished: true })
        try {
          localStorage.setItem(`jdlx_chat_pubkey_synced_${uid}`, identity.publicKeyB64)
        } catch {
          /* ignore */
        }
      }
      return res.ok
    } catch (e) {
      console.warn('E2EE key setup error:', e)
      return false
    }
  },

  // Fetch/refresh the private-channel JWT (no-op unless the feature flag and
  // backend secret are configured). Safe to call more than once.
  initRealtimeAuth: async () => ensureSupabaseRealtimeAuth(get),

  // Encrypt this device's identity key with a recovery PIN and store only the
  // ciphertext on the server. Cross-device restore stays available, but the
  // backend cannot decrypt the backup.
  saveRecoveryPin: async (passphrase) => {
    const token = get().chatToken
    const uid = get().chatUser?.id
    const pin = typeof passphrase === 'string' ? passphrase.trim() : ''
    if (!token || !uid) return { success: false, error: 'Not signed in' }
    if (pin.length < 6) return { success: false, error: 'Recovery PIN must be at least 6 characters' }

    try {
      const identity = await ensureLocalIdentity(get, set)
      if (!identity) return { success: false, error: 'Unlock your chats before setting a recovery PIN' }

      let { jwkPrivate, jwkPublic } = identity
      if (!jwkPrivate || !jwkPublic) {
        const cryptoObj = typeof window !== 'undefined' ? (window.crypto || null) : null
        if (!cryptoObj?.subtle) return { success: false, error: 'Encryption is not supported in this browser' }
        jwkPrivate = await cryptoObj.subtle.exportKey('jwk', identity.privateKey)
        jwkPublic = await cryptoObj.subtle.exportKey('jwk', identity.publicKey)
        identity.jwkPrivate = jwkPrivate
        identity.jwkPublic = jwkPublic
      }

      const backupJwk = JSON.stringify({
        jwkPrivate,
        jwkPublic,
        publicKeyB64: identity.publicKeyB64
      })
      const encryptedBackup = await encryptIdentityBackup(backupJwk, pin)
      if (!encryptedBackup) return { success: false, error: 'Could not encrypt the recovery backup' }

      const res = await apiFetch('/chat/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          public_key: identity.publicKeyB64,
          identity_backup: encryptedBackup
        })
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        return { success: false, error: json.message || 'Could not save the recovery backup' }
      }
      try {
        localStorage.setItem(`jdlx_chat_recovery_pin_set_${uid}`, 'true')
        localStorage.removeItem(`jdlx_chat_recovery_snoozed_${uid}`)
      } catch {
        /* ignore */
      }
      set({ identityPublished: true, identityNeedsPassphrase: false })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message || 'Could not save the recovery backup' }
    }
  },

  // Reopen the recovery-PIN dialog from Settings, even after "Later".
  openRecoverySetup: () => {
    const uid = get().chatUser?.id
    try {
      if (uid) localStorage.removeItem(`jdlx_chat_recovery_snoozed_${uid}`)
    } catch {
      /* ignore */
    }
    set((state) => ({ recoveryPromptNonce: (state.recoveryPromptNonce || 0) + 1 }))
  },

  // Restore this device's identity from the PIN-encrypted server backup.
  unlockWithRecoveryPin: async (passphrase) => {
    const token = get().chatToken
    const uid = get().chatUser?.id
    if (!token || !uid) return { success: false, error: 'Not signed in' }

    try {
      const res = await apiFetch('/chat/keys/backup', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        return { success: false, error: json.message || 'Could not load the recovery backup' }
      }
      const blob = json.data?.identity_backup
      if (!isEncryptedIdentityBackup(blob)) {
        return { success: false, error: 'This account has no PIN-protected backup' }
      }
      const jwkString = await decryptIdentityBackup(blob, passphrase)
      if (!jwkString) return { success: false, error: 'Incorrect recovery PIN' }
      const identity = await restoreIdentityFromJwkString(uid, jwkString)
      if (!identity) return { success: false, error: 'Could not restore the encryption key' }

      set({
        identityKeypair: identity,
        identityPublicKey: identity.publicKeyB64,
        identityUserId: String(uid),
        identityPublished: false,
        identityNeedsPassphrase: false
      })
      try {
        localStorage.setItem(`jdlx_chat_recovery_pin_set_${uid}`, 'true')
      } catch {
        /* ignore */
      }
      get().initE2EE(uid).catch(() => {})
      // Refresh previews/messages now that this device can decrypt them.
      get().fetchConversations().catch(() => {})
      const roomId = get().activeRoomId
      if (roomId) get().fetchRoomMessages(roomId).catch(() => {})
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message || 'Could not unlock the backup' }
    }
  },

  // Explicit opt-out for a device that cannot recover the old key: generate a
  // fresh identity and publish it. Past messages encrypted to the old key stay
  // unreadable, so the UI must confirm before calling this.
  startFreshIdentity: async () => {
    const uid = get().chatUser?.id
    if (!uid) return { success: false, error: 'Not signed in' }
    try {
      // Actually discard the old local identity and caches before generating a
      // new keypair; otherwise getOrCreateIdentityKeypair returns the old key.
      clearUserChatCaches(uid)
      await clearIdentity(uid)
      const identity = await getOrCreateIdentityKeypair(uid)
      if (!identity) return { success: false, error: 'Could not create a new encryption key' }
      set({
        identityKeypair: identity,
        identityPublicKey: identity.publicKeyB64,
        identityUserId: String(uid),
        identityPublished: false,
        identityNeedsPassphrase: false
      })
      try {
        localStorage.removeItem(`jdlx_chat_recovery_pin_set_${uid}`)
      } catch {
        /* ignore */
      }
      get().initE2EE(uid).catch(() => {})
      get().fetchConversations().catch(() => {})
      const roomId = get().activeRoomId
      if (roomId) get().fetchRoomMessages(roomId).catch(() => {})
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message || 'Could not create a new encryption key' }
    }
  },

  // Phone / username login with the standalone chat identity system
  loginWithMobile: async (phone, fullName, username, email = '') => {
    set({ loading: true, error: null })
    try {
      const res = await apiFetch('/chat/auth/login-mobile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          email,
          full_name: fullName,
          username: username
        })
      })

      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Login failed')
      }

      const { chat_token, refresh_token, user, room } = json.data
      get().setChatAuth(chat_token, user, room, refresh_token)
      set({ loading: false })
      return { success: true, user }
    } catch (err) {
      set({ loading: false, error: err.message })
      return { success: false, error: err.message }
    }
  },

  // Check username availability & validate rules (no email domains)
  checkUsernameAvailability: async (username) => {
    if (!username || !username.trim()) {
      return { success: false, available: false, message: 'Username is required' }
    }
    try {
      const res = await apiFetch(`/chat/auth/check-username?username=${encodeURIComponent(username.trim())}`)
      const json = await res.json()
      return json
    } catch (e) {
      return { success: false, available: false, message: 'Could not verify username' }
    }
  },

  // Login with Username or 10-digit Mobile Number + Password
  loginWithPassword: async (identifier, password) => {
    set({ loading: true, error: null })
    try {
      const res = await apiFetch('/chat/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: (identifier || '').trim(),
          password
        })
      })

      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Login failed')
      }

      const { chat_token, refresh_token, user, room } = json.data
      get().setChatAuth(chat_token, user, room, refresh_token)
      set({ loading: false })
      return { success: true, user }
    } catch (err) {
      set({ loading: false, error: err.message })
      return { success: false, error: err.message }
    }
  },

  // Register with Full Name, Username, Phone, Password
  registerWithPassword: async ({ fullName, username, phone, password, email = '' }) => {
    set({ loading: true, error: null })
    try {
      const res = await apiFetch('/chat/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: (fullName || '').trim(),
          username: (username || '').trim(),
          phone: (phone || '').trim(),
          password,
          email: (email || '').trim()
        })
      })

      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Registration failed')
      }

      const { chat_token, refresh_token, user, room } = json.data
      get().setChatAuth(chat_token, user, room, refresh_token)
      set({ loading: false })
      return { success: true, user }
    } catch (err) {
      set({ loading: false, error: err.message })
      return { success: false, error: err.message }
    }
  },

  // Finish a Google sign-up: Google only verifies the email, so the chat
  // account (username, password, mobile, gender) is created here.
  completeGoogleSignup: async ({ ticket, fullName, username, phone, gender, password }) => {
    set({ loading: true, error: null })
    try {
      const res = await apiFetch('/chat/auth/google/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket,
          full_name: (fullName || '').trim(),
          username: (username || '').trim(),
          phone: (phone || '').trim(),
          gender,
          password
        })
      })

      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Could not complete Google sign-up')
      }

      const { chat_token, refresh_token, user, room } = json.data
      get().setChatAuth(chat_token, user, room, refresh_token)
      set({ loading: false })
      return { success: true, user }
    } catch (err) {
      set({ loading: false, error: err.message })
      return { success: false, error: err.message }
    }
  },

  // Update Profile details (name, username, bio, gender, profile_image)
  updateChatProfile: async ({ name, username, bio, gender, profile_image }) => {
    const token = get().chatToken
    set({ loading: true })
    if (!token) {
      set({ loading: false })
      return { success: false, error: 'Not authenticated' }
    }
    try {
      const res = await apiFetch('/chat/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, bio, gender, profile_image })
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Profile update failed')
      }
      const updatedUser = json.data?.user || json.data
      const currentToken = get().chatToken
      const currentRefresh = get().chatRefreshToken
      const currentRoom = get().activeRoom

      get().setChatAuth(currentToken, updatedUser, currentRoom, currentRefresh)
      set({ chatUser: updatedUser, loading: false })
      return { success: true, user: updatedUser }
    } catch (err) {
      set({ loading: false })
      return { success: false, error: err.message }
    }
  },

  // Upload Profile Avatar
  uploadProfileAvatar: async (file) => {
    const token = get().chatToken
    if (!token) return { success: false, error: 'Not authenticated' }

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('kind', 'avatar')
      const res = await apiFetch('/chat/upload', {
        method: 'POST',
        body: formData
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Avatar upload failed')
      }
      const mediaUrl = json.data?.url
      if (!mediaUrl) throw new Error('No media URL returned')

      return await get().updateChatProfile({ profile_image: mediaUrl })
    } catch (err) {
      return { success: false, error: err.message }
    }
  },

  // 1. WhatsApp-like Conversations Threads List
  fetchConversations: async () => {
    if (conversationsInFlight) {
      // A message may have arrived while the current inbox request was in
      // flight; make sure one final refresh runs after it finishes.
      conversationsRefreshQueued = true
      return conversationsInFlight
    }
    const token = get().chatToken
    if (!token) return

    conversationsInFlight = (async () => {
      set({ conversationsLoading: true, conversationsError: null })
      // Read the local E2EE key and fetch the inbox at the same time. The old
      // code waited for the key-publish POST first, so a cold open showed the
      // empty "No chats yet" screen for the whole round trip.
      const identityPromise = ensureLocalIdentity(get, set)

      try {
        const res = await apiFetch('/chat/conversations', {
          headers: { Authorization: `Bearer ${token}` }
        })
        const json = await res.json()
        if (!res.ok || !json.success) {
          set({
            conversationsLoaded: true,
            conversationsLoading: false,
            conversationsError: json?.error || 'Could not load your chats',
          })
          return
        }

        const convs = json.data || []
        const identity = await identityPromise
        // Publishing the public key is not needed to render the inbox.
        if (identity) get().initE2EE().catch(() => {})

        // Decrypt previews transparently
        const decryptedConvs = await Promise.all(
          convs.map(async (c) => {
            let preview = c.last_message
            if (isV2Message(preview)) {
              const v2Text = await decryptRoomMessageV2(preview, c.id, identity, c.contact_public_key)
              if (v2Text && v2Text !== '🔒 [Encrypted Message]') {
                preview = v2Text
              } else if (c.e2e_secret || c.room_key) {
                const v1Fallback = await decryptChatMessage(preview.replace('enc:v2:', 'enc:v1:'), c.e2e_secret || c.room_key, c.id)
                if (v1Fallback && v1Fallback !== '🔒 [Encrypted Message]' && !v1Fallback.startsWith('enc:')) {
                  preview = v1Fallback
                } else {
                  preview = '🔒 Encrypted Message'
                }
              } else {
                preview = '🔒 Encrypted Message'
              }
            } else if (preview?.startsWith('enc:v1:')) {
              preview = await decryptChatMessage(preview, c.e2e_secret || c.room_key, c.id)
            }
            return { ...c, last_message: preview }
          })
        )
        if (get().chatToken !== token) return

        // Strip stale last_message previews only when room messages have fully loaded and are confirmed empty
        const messagesConfirmedEmpty = !get().messagesLoading && !get().messagesError && get().messages.length === 0
        const activeRoomId = get().activeRoomId
        const cleanedConvs = messagesConfirmedEmpty && activeRoomId
          ? decryptedConvs.map((c) =>
              sameId(c.id, activeRoomId) && c.last_message
                ? { ...c, last_message: '', last_message_user_id: null, last_message_type: 'text', last_message_is_read: false }
                : c
            )
          : decryptedConvs

        set({ conversations: cleanedConvs, conversationsLoaded: true, conversationsLoading: false, conversationsError: null })

        // Auto-unlock: If open room currently holds any locked messages, re-decrypt them now with the fresh contact keys
        if (get().activeRoomId && get().messages.some((m) => m._locked)) {
          get().fetchRoomMessages(get().activeRoomId).catch(() => {})
        }

        const uid = get().chatUser?.id
        if (uid && decryptedConvs.length > 0) {
          setCachedConversations(uid, decryptedConvs)
        }

        // Auto-select the first conversation on desktop ONLY. On a phone the
        // list is the visible screen, and auto-selecting used to fetch the
        // room (which marks everything read) before the user opened it.
        const isDesktop = typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(min-width: 768px)').matches
        const currentActive = get().activeConversation
        if (!currentActive && decryptedConvs.length > 0 && isDesktop) {
          get().selectConversation(decryptedConvs[0])
        } else if (currentActive) {
          // Update active conversation reference
          const updated = decryptedConvs.find((c) => sameId(c.id, currentActive.id))
          if (updated) {
            // Never restore a stale last_message preview from the server when
            // the room has no messages — otherwise the "chat leak" glitch
            // reappears on every conversations poll (old preview text with an
            // empty pane).
            const messagesEmpty = get().messages.length === 0
            const next = updated.last_message && messagesEmpty
              ? {
                  ...updated,
                  last_message: '',
                  last_message_user_id: null,
                  last_message_type: 'text',
                  last_message_is_read: false
                }
              : updated
            set({ activeConversation: next })
          }
        }
      } catch (e) {
        if (get().chatToken === token) {
          set({
            conversationsLoaded: true,
            conversationsLoading: false,
            conversationsError: 'Could not load your chats. Check your connection.',
          })
        }
        console.warn('Fetch conversations error:', e)
      }
    })()

    try {
      return await conversationsInFlight
    } finally {
      conversationsInFlight = null
      if (conversationsRefreshQueued) {
        conversationsRefreshQueued = false
        get().fetchConversations()
      }
    }
  },

  // ── Group chat ──────────────────────────────────────────────────────────
  // The chat backend already owns group rooms (members, roles, read state).
  // These actions keep the inbox/live conversation in sync after each call.
  createGroup: async ({ name, memberIds = [] } = {}) => {
    const token = get().chatToken
    if (!token) return { success: false, error: 'Not authenticated' }
    const title = String(name || '').trim()
    const ids = (memberIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
    if (title.length < 2) {
      return { success: false, error: 'Group name must be at least 2 characters' }
    }
    if (!ids.length) {
      return { success: false, error: 'Add at least one friend to create a group' }
    }

    try {
      const res = await apiFetch('/chat/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: title, member_ids: ids })
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not create the group' }
      }
      const conversation = json.data?.conversation || null
      if (conversation) {
        set((state) => ({
          conversations: [
            conversation,
            ...state.conversations.filter((c) => !sameId(c.id, conversation.id))
          ]
        }))
        await get().selectConversation(conversation)
        get().fetchConversations().catch(() => {})
      }
      return { success: true, group: json.data?.group || null, conversation }
    } catch (e) {
      console.warn('Create group error:', e)
      return { success: false, error: 'Could not create the group. Check your connection.' }
    }
  },

  fetchGroupDetails: async (roomId) => {
    const token = get().chatToken
    if (!token || !roomId) return { success: false, error: 'Not authenticated' }
    try {
      const res = await apiFetch(`/chat/groups/${roomId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not load group details' }
      }
      return { success: true, group: json.data || null }
    } catch (e) {
      console.warn('Fetch group details error:', e)
      return { success: false, error: 'Could not load group details' }
    }
  },

  renameGroup: async (roomId, name) => {
    const token = get().chatToken
    const title = String(name || '').trim()
    if (!token || !roomId) return { success: false, error: 'Not authenticated' }
    if (title.length < 2) return { success: false, error: 'Group name must be at least 2 characters' }
    try {
      const res = await apiFetch(`/chat/groups/${roomId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: title })
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not rename the group' }
      }
      set((state) => ({
        conversations: state.conversations.map((c) =>
          sameId(c.id, roomId) ? { ...c, contact_name: title } : c
        ),
        activeConversation: state.activeConversation && sameId(state.activeConversation.id, roomId)
          ? { ...state.activeConversation, contact_name: title }
          : state.activeConversation
      }))
      return { success: true, group: json.data || null }
    } catch (e) {
      console.warn('Rename group error:', e)
      return { success: false, error: 'Could not rename the group' }
    }
  },

  addGroupMembers: async (roomId, memberIds = []) => {
    const token = get().chatToken
    const ids = (memberIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
    if (!token || !roomId) return { success: false, error: 'Not authenticated' }
    if (!ids.length) return { success: false, error: 'Select at least one friend to add' }
    try {
      const res = await apiFetch(`/chat/groups/${roomId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ member_ids: ids })
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not add members' }
      }
      const group = json.data || null
      if (group) get().applyGroupCount(roomId, group.member_count)
      return { success: true, group }
    } catch (e) {
      console.warn('Add group members error:', e)
      return { success: false, error: 'Could not add members' }
    }
  },

  removeGroupMember: async (roomId, memberId) => {
    const token = get().chatToken
    if (!token || !roomId || !memberId) return { success: false, error: 'Not authenticated' }
    try {
      const res = await apiFetch(`/chat/groups/${roomId}/members/${memberId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not remove the member' }
      }
      const group = json.data || null
      if (group) get().applyGroupCount(roomId, group.member_count)
      return { success: true, group }
    } catch (e) {
      console.warn('Remove group member error:', e)
      return { success: false, error: 'Could not remove the member' }
    }
  },

  applyGroupAvatar: (roomId, avatar) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        sameId(c.id, roomId) ? { ...c, contact_avatar: avatar || null } : c
      ),
      activeConversation: state.activeConversation && sameId(state.activeConversation.id, roomId)
        ? { ...state.activeConversation, contact_avatar: avatar || null }
        : state.activeConversation
    }))
  },

  uploadGroupAvatar: async (roomId, file) => {
    const token = get().chatToken
    if (!token || !roomId || !file) return { success: false, error: 'Not authenticated' }
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('kind', 'avatar')
      const uploadRes = await apiFetch('/chat/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      })
      const uploadJson = await uploadRes.json().catch(() => null)
      if (!uploadRes.ok || !uploadJson?.success || !uploadJson?.data?.url) {
        return { success: false, error: uploadJson?.message || uploadJson?.error || 'Could not upload the group picture' }
      }
      const avatar = uploadJson.data.url
      const res = await apiFetch(`/chat/groups/${roomId}/avatar`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ avatar })
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not save the group picture' }
      }
      get().applyGroupAvatar(roomId, avatar)
      get().fetchConversations().catch(() => {})
      return { success: true, group: json.data || null, avatar }
    } catch (e) {
      console.warn('Upload group avatar error:', e)
      return { success: false, error: 'Could not upload the group picture' }
    }
  },

  setGroupMemberRole: async (roomId, memberId, role) => {
    const token = get().chatToken
    if (!token || !roomId || !memberId) return { success: false, error: 'Not authenticated' }
    if (!['admin', 'member'].includes(role)) return { success: false, error: 'Invalid role' }
    try {
      const res = await apiFetch(`/chat/groups/${roomId}/members/${memberId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role })
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not update the member role' }
      }
      return { success: true, group: json.data || null }
    } catch (e) {
      console.warn('Set group member role error:', e)
      return { success: false, error: 'Could not update the member role' }
    }
  },

  applyGroupCount: (roomId, memberCount) => {
    const count = Number(memberCount)
    if (!Number.isFinite(count)) return
    const bio = `${count} member${count === 1 ? '' : 's'}`
    set((state) => ({
      conversations: state.conversations.map((c) =>
        sameId(c.id, roomId) ? { ...c, member_count: count, contact_bio: bio } : c
      ),
      activeConversation: state.activeConversation && sameId(state.activeConversation.id, roomId)
        ? { ...state.activeConversation, member_count: count, contact_bio: bio }
        : state.activeConversation
    }))
  },

  leaveGroup: async (roomId) => {
    const token = get().chatToken
    if (!token || !roomId) return { success: false, error: 'Not authenticated' }
    try {
      const res = await apiFetch(`/chat/groups/${roomId}/members/me`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        return { success: false, error: json?.message || json?.error || 'Could not leave the group' }
      }
      if (sameId(get().activeRoomId, roomId)) {
        get().stopRealtime()
        set({
          activeRoomId: null,
          activeConversation: null,
          activeRoom: null,
          messages: [],
          messagesLoading: false,
          peerTyping: false,
          peerOnline: false
        })
      }
      set((state) => ({
        conversations: state.conversations.filter((c) => !sameId(c.id, roomId))
      }))
      return { success: true }
    } catch (e) {
      console.warn('Leave group error:', e)
      return { success: false, error: 'Could not leave the group' }
    }
  },

  // 2. Select a Conversation Thread
  selectConversation: async (conv) => {
    if (!conv) return
    get().stopRealtime()
    const uid = get().chatUser?.id
    const savedDelivered = getStoredDeliveredId(uid, conv.id)
    const rawCachedMsgs = uid ? getCachedMessages(uid, conv.id) : []
    // Smart Chat Load: slice to the most recent 35 cached messages for instantaneous 0ms initial paint
    const recentCached = rawCachedMsgs.length > 35 ? rawCachedMsgs.slice(-35) : rawCachedMsgs
    const cachedMsgs = recentCached.map((m) => {
      if (savedDelivered > 0 && m && m.id <= savedDelivered) {
        return { ...m, is_delivered: 1 }
      }
      return m
    })
    if (uid) setCachedActiveRoomId(uid, conv.id)
    // Warm the ICE config while the user is reading, so a call tap does not
    // wait on it (fire-and-forget; failures fall back to STUN).
    get().fetchCallIceServers().catch(() => {})
    set((state) => ({
      activeConversation: { ...conv, unread_count: 0 },
      activeRoomId: conv.id,
      messages: cachedMsgs,
      messagesLoading: cachedMsgs.length === 0,
      messagesHasMore: rawCachedMsgs.length > 35,
      peerTyping: false,
      peerOnline: Boolean(conv.contact_online || conv.other_user?.is_online),
      _peerPresenceKnown: false,
      peerLastReadId: 0,
      peerLastDeliveredId: savedDelivered,
      // Clear any previous room's pre-derived key
      derivedRoomKey: null,
      conversations: state.conversations.map((c) => (
        sameId(c.id, conv.id) ? { ...c, unread_count: 0 } : c
      ))
    }))
    // Non-blocking fetch so UI view switches instantaneously in 0ms:
    get().startRealtime()
    get().fetchRoomMessages(conv.id).catch(() => {})
    get().fetchUnreadCount().catch(() => {})

    // PRE-DERIVE E2EE ROOM KEY in background so sends are instant
    // Only for direct chats with peer key available
    const peerKey = conv.contact_public_key
    if (peerKey) {
      get().preDeriveRoomKey(conv.id, peerKey).catch(() => {})
    }
  },

  // 3. Fetch Messages for a Specific Room
  // First open / room switch: latest page only. Later polls ask for
  // `after_id=<newest we hold>` so a 4s poll no longer re-downloads the whole
  // conversation every time.
  // Rebuild readable text from the ciphertext-only localStorage cache. Cached
  // messages are stored locked, so this restores previews/content after a
  // reload without ever writing decrypted text back to disk.
  hydrateCachedMessages: async () => {
    const uid = get().chatUser?.id
    const roomId = get().activeRoomId
    if (!uid || !roomId) return

    const activeConv = get().activeConversation
      || (get().conversations || []).find((c) => sameId(c.id, roomId))

    const snapshot = get().messages
    if (!Array.isArray(snapshot) || !snapshot.some((m) => m && m.raw_message && m._locked)) return

    const identity = await ensureLocalIdentity(get, set)
    if (!identity) return
    if (!sameId(get().chatUser?.id, uid) || !sameId(get().activeRoomId, roomId)) return

    const decrypted = await Promise.all(
      snapshot.map((m) => (
        m && m.raw_message && m._locked
          ? decryptStoredMessage(m, roomId, activeConv, identity)
          : m
      ))
    )

    // A server fetch may have replaced the list while keys were loading.
    if (get().messages !== snapshot) return
    set({ messages: decrypted })
    setCachedMessages(uid, roomId, decrypted)
  },

  fetchRoomMessages: async (roomId) => {
    const token = get().chatToken
    const targetRoomId = roomId || get().activeRoomId
    if (!token || !targetRoomId) return

    const existing = sameId(get().activeRoomId, targetRoomId) ? get().messages : []
    const hasLockedMessages = existing.some((m) => m && (m._locked || m.message === '🔒 [Encrypted Message]'))
    const confirmedIds = existing.filter((m) => m && typeof m.id === 'number' && m.id > 0).map((m) => m.id)
    const newestId = (!hasLockedMessages && confirmedIds.length) ? Math.max(...confirmedIds) : null
    // Smart Chat Load: 35 messages on initial load (fast & lightweight), 50 on incremental polling
    const SMART_LIMIT = newestId ? 50 : 35
    const query = newestId ? `?after_id=${newestId}&limit=${SMART_LIMIT}` : `?limit=${SMART_LIMIT}`

    if (existing.length === 0) {
      set({ messagesLoading: true, messagesError: null })
    } else {
      set({ messagesError: null })
    }

    // Load the key alongside the request; do not block the messages on the
    // key-publish POST.
    const identityPromise = ensureLocalIdentity(get, set)

    try {
      const res = await apiFetch(`/chat/rooms/${targetRoomId}/messages${query}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.success) {
        const rawMsgs = json.data || []
        const identity = await identityPromise
        if (identity) get().initE2EE().catch(() => {})
        const activeConv = get().activeConversation || get().conversations.find((c) => sameId(c.id, targetRoomId))
        
        // Progressive micro-batched WebCrypto decryption (prevents UI thread lockups)
        const decryptedMsgs = []
        const BATCH_SIZE = 12
        for (let i = 0; i < rawMsgs.length; i += BATCH_SIZE) {
          const chunk = rawMsgs.slice(i, i + BATCH_SIZE)
          const chunkDecrypted = await Promise.all(
            chunk.map((m) => decryptStoredMessage(m, targetRoomId, activeConv, identity))
          )
          decryptedMsgs.push(...chunkDecrypted)
          if (i + BATCH_SIZE < rawMsgs.length) {
            await new Promise((r) => setTimeout(r, 0))
          }
        }
        if (!sameId(get().activeRoomId, targetRoomId)) return

        let merged = []
        if (!newestId) {
          // This branch replaces the whole list with one server page. Anything
          // that arrived while that page was in flight (a message the user just
          // sent, or a realtime event) is not in it, so merge instead of
          // clobbering: otherwise the new bubble blinks out and only comes back
          // on the next poll.
          const knownIds = new Set(existing.map((m) => m.id))
          const fresh = get().messages
          const optimistic = fresh.filter((m) => typeof m.id === 'number' && m.id < 0)
          const arrivedDuringFetch = fresh.filter(
            (m) => typeof m.id === 'number' && m.id > 0 && !knownIds.has(m.id)
          )
          const byId = new Map()
          for (const m of [...decryptedMsgs, ...arrivedDuringFetch]) byId.set(m.id, m)
          const confirmed = [...byId.values()]
          merged = [
            ...confirmed,
            ...unreconciledOptimistic(confirmed, optimistic)
          ]
          merged.sort(sortChatMessages)
          set({ messages: merged, messagesHasMore: rawMsgs.length >= SMART_LIMIT, messagesLoading: false, messagesError: null })
        } else {
          // Re-decrypt any existing messages that were previously locked
          const redecryptedExisting = await Promise.all(
            get().messages.map(async (m) => {
              if ((m._locked || m.message === '🔒 [Encrypted Message]') && (m.raw_message || isEncryptedMessage(m.message))) {
                return await decryptStoredMessage(m, targetRoomId, activeConv, identity)
              }
              return m
            })
          )
          const serverIds = new Set(decryptedMsgs.map((m) => m.id))
          // Remove only optimistic bubbles that received their own server row.
          // Existing confirmed rows are included too: a realtime delivery can
          // land in state before this fetch, and then the incremental page no
          // longer contains the row that confirms the bubble.
          const existingConfirmed = redecryptedExisting.filter(
            (m) => m && typeof m.id === 'number' && m.id > 0
          )
          const remainingOptimistic = unreconciledOptimistic(
            [...existingConfirmed, ...decryptedMsgs],
            redecryptedExisting.filter(isOptimisticMessage)
          )
          const remainingOptimisticIds = new Set(remainingOptimistic.map((m) => m.id))
          const cleanedExisting = redecryptedExisting.filter((m) => (
            isOptimisticMessage(m) ? remainingOptimisticIds.has(m.id) : !serverIds.has(m.id)
          ))
          merged = [...cleanedExisting, ...decryptedMsgs]
          merged.sort(sortChatMessages)
          set({ messages: merged, messagesLoading: false, messagesError: null })
        }

        // Reconcile conversation preview snippet with verified confirmed messages
        set((state) => {
          if (merged.length === 0) {
            return {
              conversations: state.conversations.map((c) =>
                sameId(c.id, targetRoomId)
                  ? { ...c, last_message: '', last_message_user_id: null, last_message_type: 'text', last_message_is_read: false }
                  : c
              ),
              activeConversation: state.activeConversation && sameId(state.activeConversation.id, targetRoomId)
                ? { ...state.activeConversation, last_message: '', last_message_user_id: null, last_message_type: 'text', last_message_is_read: false }
                : state.activeConversation
            }
          }
          const latestMsg = merged[merged.length - 1]
          if (latestMsg) {
            const previewText = latestMsg.deleted ? 'This message was deleted' : latestMsg.message
            return {
              conversations: state.conversations.map((c) =>
                sameId(c.id, targetRoomId)
                  ? {
                      ...c,
                      last_message: previewText,
                      last_message_at: latestMsg.created_at || c.last_message_at,
                      last_message_type: latestMsg.deleted ? 'deleted' : (latestMsg.message_type || 'text'),
                      last_message_user_id: latestMsg.user_id,
                      last_message_is_read: Boolean(latestMsg.is_read)
                    }
                  : c
              ),
              activeConversation: state.activeConversation && sameId(state.activeConversation.id, targetRoomId)
                ? {
                    ...state.activeConversation,
                    last_message: previewText,
                    last_message_at: latestMsg.created_at || state.activeConversation.last_message_at,
                    last_message_type: latestMsg.deleted ? 'deleted' : (latestMsg.message_type || 'text'),
                    last_message_user_id: latestMsg.user_id,
                    last_message_is_read: Boolean(latestMsg.is_read)
                  }
                : state.activeConversation
            }
          }
          return {}
        })

        const uid = get().chatUser?.id
        if (uid) {
          setCachedMessages(uid, targetRoomId, merged)
        }
        const savedDelivered = uid ? getStoredDeliveredId(uid, targetRoomId) : 0
        if (savedDelivered > (get().peerLastDeliveredId || 0)) {
          set({ peerLastDeliveredId: savedDelivered })
        }
        // Send instant delivery and read receipts over Supabase WebSocket to turn peer tick into double tick.
        // Skip while the tab/window is hidden: a desktop tab in the background is not
        // actually being read, so the sender should not get blue ticks yet.
        const isPageVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
        const peerMsgs = merged.filter((m) => m && !sameId(m.user_id, uid))
        const peerId = getConversationPeerId(activeConv, uid)
        if (peerMsgs.length > 0) {
          const maxPeerMsgId = Math.max(...peerMsgs.map((m) => m.id))
          const roomChannel = get().supabaseRoomChannel
          if (maxPeerMsgId > 0) {
            // Recipient client received the messages: send delivery_receipt
            if (roomChannel) {
              roomChannel.send({
                type: 'broadcast',
                event: 'delivery_receipt',
                payload: { user_id: uid, last_delivered_id: maxPeerMsgId, room_id: targetRoomId }
              }).catch(() => {})
            }
            if (peerId) {
              sendSupabaseUserAlert(peerId, 'delivery_receipt', {
                room_id: targetRoomId,
                user_id: uid,
                last_delivered_id: maxPeerMsgId
              })
            }

            // If page is currently visible, also send read_receipt
            if (isPageVisible) {
              if (roomChannel) {
                roomChannel.send({
                  type: 'broadcast',
                  event: 'read_receipt',
                  payload: { user_id: uid, last_read_id: maxPeerMsgId, room_id: targetRoomId }
                }).catch(() => {})
              }
              if (peerId) {
                sendSupabaseUserAlert(peerId, 'read_receipt', {
                  room_id: targetRoomId,
                  user_id: uid,
                  last_read_id: maxPeerMsgId
                })
              }
            }
          }
          if (isPageVisible && token && maxPeerMsgId > 0) {
            apiFetch(`/chat/rooms/${targetRoomId}/read`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({ max_id: maxPeerMsgId })
            }).catch(() => {})
          }
        }
      } else {
        if (!sameId(get().activeRoomId, targetRoomId)) return
        const hasCached = get().messages.length > 0
        set({
          messagesLoading: false,
          messagesError: hasCached ? null : (json?.error || json?.message || 'Could not load messages. Check your connection.')
        })
      }
    } catch (e) {
      if (!sameId(get().activeRoomId, targetRoomId)) return
      const hasCached = get().messages.length > 0
      set({
        messagesLoading: false,
        messagesError: hasCached ? null : 'Could not load messages. Check your connection.',
      })
      console.warn('Fetch room messages error:', e)
    }
  },

  // 3b. Load one older page (smart scroll-up pagination).
  loadOlderMessages: async () => {
    const token = get().chatToken
    const targetRoomId = get().activeRoomId
    const targetUserId = get().chatUser?.id
    const current = get().messages
    if (!token || !targetRoomId || !current.length) return
    // Ignore repeated taps while a page is already being fetched.
    if (get().loadingOlderMessages) return

    const realMsgs = current.filter((m) => m && typeof m.id === 'number' && m.id > 0)
    if (!realMsgs.length) return
    const oldestId = Math.min(...realMsgs.map((m) => m.id))
    set({ loadingOlderMessages: true })
    const SMART_OLDER_LIMIT = 35
    try {
      const res = await apiFetch(
        `/chat/rooms/${targetRoomId}/messages?before_id=${oldestId}&limit=${SMART_OLDER_LIMIT}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const json = await res.json()
      if (!res.ok || !json.success) return

      const rawMsgs = json.data || []
      const activeConv = get().activeConversation || get().conversations.find((c) => sameId(c.id, targetRoomId))
      const identity = get().identityKeypair || await ensureLocalIdentity(get, set)
      
      // Progressive micro-batched decryption
      const decrypted = []
      const BATCH_SIZE = 12
      for (let i = 0; i < rawMsgs.length; i += BATCH_SIZE) {
        const chunk = rawMsgs.slice(i, i + BATCH_SIZE)
        const chunkDecrypted = await Promise.all(
          chunk.map((m) => decryptStoredMessage(m, targetRoomId, activeConv, identity))
        )
        decrypted.push(...chunkDecrypted)
        if (i + BATCH_SIZE < rawMsgs.length) {
          await new Promise((r) => setTimeout(r, 0))
        }
      }

      // The room or account may have changed while the page was in flight.
      // Never merge another room's history into the current conversation.
      if (String(get().activeRoomId) !== String(targetRoomId)) return
      if (!sameId(get().chatUser?.id, targetUserId)) return

      // Merge against the freshest list, not the snapshot taken before the
      // request, so messages received during the fetch are preserved.
      const mergedById = new Map()
      for (const msg of [...decrypted, ...get().messages]) {
        if (!msg) continue
        mergedById.set(msg.id, msg)
      }
      const merged = Array.from(mergedById.values()).sort(sortChatMessages)
      set({ messages: merged, messagesHasMore: rawMsgs.length >= SMART_OLDER_LIMIT })
    } catch (e) {
      console.warn('Load older messages error:', e)
    } finally {
      set({ loadingOlderMessages: false })
    }
  },

  // 3c. Realtime: Supabase WebSocket (<50ms instant delivery) + long-poll safety net
  startRealtime: () => {
    const token = get().chatToken
    const roomId = get().activeRoomId
    if (!token || !roomId) return
    if (get().realtimeAbort && sameId(get().realtimeRoomId, roomId)) return

    get().stopRealtime()
    const controller = new AbortController()
    set({
      realtimeAbort: controller,
      realtimeRoomId: roomId,
      peerTyping: false,
      peerOnline: false,
      _peerPresenceKnown: false,
      peerLastReadId: 0,
      peerLastDeliveredId: getStoredDeliveredId(get().chatUser?.id, roomId),
      eventsCursor: 0
    })

    // 1. Supabase WebSocket channel for instant (<50ms) message, typing, and read receipt delivery
    const myId = get().chatUser?.id
    if (supabase) {
      const setupRoomChannel = async () => {
        // Wait for the private-channel JWT before joining. Creating the channel
        // first used to lock it into public mode until a later reconnect.
        const privateReady = SUPABASE_PRIVATE_CHANNELS
          ? await ensureSupabaseRealtimeAuth(get, `chat_room_${roomId}`)
          : false
        if (controller.signal.aborted || !sameId(get().realtimeRoomId, roomId)) return
        try {
        const channelName = `chat_room_${roomId}`
        // Clean up any stale or lingering channel with same name
        const existing = (typeof supabase.getChannels === 'function' ? supabase.getChannels() : [])
          .find((c) => c.topic === `realtime:${channelName}`)
        if (existing) {
          try {
            existing.unsubscribe()
            supabase.removeChannel(existing)
          } catch { /* ignore */ }
        }

        const channelConfig = { presence: { key: `user_${myId || 'anon'}` } }
        if (privateReady) channelConfig.private = true
        const channel = supabase.channel(channelName, { config: channelConfig })
        channel
          .on('broadcast', { event: 'new_message' }, async ({ payload }) => {
            // Supabase broadcasts are unauthenticated hints, never content.
            // Anyone who knows a room id can publish here, so ignore the
            // payload and fetch the authoritative message through the API.
            if (!payload || !payload.id) return
            await get().fetchRoomMessages(roomId).catch(() => {})
            // Room-switch guard: fetchRoomMessages is async; if the user
            // switched rooms while it ran, get().messages belongs to the other
            // room and receipts computed below would carry foreign ids.
            if (!sameId(get().realtimeRoomId, roomId)) return

            const currentMyId = get().chatUser?.id
            const peerMsgs = get().messages.filter(
              (m) => m && m.id > 0 && !sameId(m.user_id, currentMyId)
            )
            const maxPeerMsgId = peerMsgs.length
              ? Math.max(...peerMsgs.map((m) => Number(m.id) || 0))
              : 0

            // Broadcast delivery receipt as soon as peer message arrives on recipient device
            if (currentMyId && maxPeerMsgId > 0) {
              channel.send({
                type: 'broadcast',
                event: 'delivery_receipt',
                payload: { user_id: currentMyId, last_delivered_id: maxPeerMsgId, room_id: roomId }
              }).catch(() => {})

              const peerId = getConversationPeerId(get().activeConversation, currentMyId)
              if (peerId) {
                sendSupabaseUserAlert(peerId, 'delivery_receipt', {
                  room_id: roomId,
                  user_id: currentMyId,
                  last_delivered_id: maxPeerMsgId
                })
              }
            }

            // Read receipts are derived from fetched messages, never from a spoofable broadcast id
            const pageVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
            if (currentMyId && maxPeerMsgId > 0 && pageVisible) {
              channel.send({
                type: 'broadcast',
                event: 'read_receipt',
                payload: { user_id: currentMyId, last_read_id: maxPeerMsgId, room_id: roomId }
              }).catch(() => {})

              const peerId = getConversationPeerId(get().activeConversation, currentMyId)
              if (peerId) {
                sendSupabaseUserAlert(peerId, 'read_receipt', {
                  room_id: roomId,
                  user_id: currentMyId,
                  last_read_id: maxPeerMsgId
                })
              }
            }
            get().fetchConversations().catch(() => {})
            get().fetchUnreadCount().catch(() => {})
          })
          .on('broadcast', { event: 'delivery_receipt' }, ({ payload }) => {
            const currentMyId = get().chatUser?.id
            const lastDeliveredId = Number(payload?.last_delivered_id)
            if (!payload || !Number.isFinite(lastDeliveredId) || lastDeliveredId <= 0) return
            if (currentMyId && sameId(payload.user_id, currentMyId)) return

            if (currentMyId && roomId) {
              setStoredDeliveredId(currentMyId, roomId, lastDeliveredId)
            }

            set((state) => ({
              peerLastDeliveredId: Math.max(state.peerLastDeliveredId || 0, lastDeliveredId),
              messages: state.messages.map((m) =>
                m.id <= lastDeliveredId ? { ...m, is_delivered: 1 } : m
              )
            }))
          })
          .on('broadcast', { event: 'typing' }, ({ payload }) => {
            const currentMyId = get().chatUser?.id
            const peerId = getConversationPeerId(get().activeConversation, currentMyId)
            if (!payload || !peerId) return
            if (!sameId(payload.user_id, peerId)) return
            set({ peerTyping: Boolean(payload.is_typing) })
            clearTimeout(get()._typingTimer)
            if (payload.is_typing) {
              const timer = setTimeout(() => set({ peerTyping: false }), 4000)
              set({ _typingTimer: timer })
            }
          })
          .on('broadcast', { event: 'read_receipt' }, ({ payload }) => {
            const currentMyId = get().chatUser?.id
            const lastReadId = Number(payload?.last_read_id)
            if (!payload || !Number.isFinite(lastReadId) || lastReadId <= 0) return
            if (currentMyId && sameId(payload.user_id, currentMyId)) return

            const knownIds = get().messages
              .map((m) => Number(m.id))
              .filter((id) => Number.isFinite(id) && id > 0)
            const maxKnownId = knownIds.length ? Math.max(...knownIds) : 0
            if (!maxKnownId || lastReadId > maxKnownId) return

            if (currentMyId && roomId) {
              setStoredDeliveredId(currentMyId, roomId, lastReadId)
            }

            set((state) => ({
              peerLastReadId: Math.max(state.peerLastReadId || 0, lastReadId),
              peerLastDeliveredId: Math.max(state.peerLastDeliveredId || 0, lastReadId),
              messages: state.messages.map((m) =>
                m.id <= lastReadId ? { ...m, is_read: 1, is_delivered: 1 } : m
              )
            }))
          })
          .on('broadcast', { event: 'reaction' }, ({ payload }) => {
            const target = get().messages.find(
              (m) => sameId(m.id, payload?.message_id)
            )
            if (!target || !payload?.reactions) return
            const currentMyId = get().chatUser?.id
            const peerId = getConversationPeerId(get().activeConversation, currentMyId)
            const sender = String(payload.user_id)
            if (!peerId) return
            if (sender !== String(currentMyId) && sender !== String(peerId)) return
            set((state) => ({
              messages: state.messages.map((m) =>
                sameId(m.id, target.id) ? { ...m, reactions: payload.reactions } : m
              )
            }))
          })
          .on('broadcast', { event: 'message_deleted' }, ({ payload }) => {
            const target = get().messages.find(
              (m) => sameId(m.id, payload?.message_id)
            )
            if (!target) return
            const currentMyId = get().chatUser?.id
            const peerId = getConversationPeerId(get().activeConversation, currentMyId)
            const sender = String(payload.user_id)
            if (!peerId) return
            if (sender !== String(currentMyId) && sender !== String(peerId)) return
            set((state) => ({
              messages: state.messages.map((m) =>
                sameId(m.id, target.id)
                  ? { ...m, message: '', media_url: null, message_type: 'deleted', deleted: 1 }
                  : m
              )
            }))
          })
          .on('presence', { event: 'sync' }, () => {
            const presenceState = channel.presenceState()
            const activeConv = get().activeConversation
            const currentMyId = get().chatUser?.id
            const convUserId = activeConv?.user_id || activeConv?.user_one_id
            const otherId = activeConv?.other_user?.id || (
              sameId(convUserId, currentMyId)
                ? activeConv?.user_two_id
                : convUserId
            )
            if (!otherId) return
            const peerPresences = presenceState?.[`user_${otherId}`]
            const isPeerInRoom = Array.isArray(peerPresences)
              ? peerPresences.length > 0
              : Boolean(peerPresences)
            set({
              _peerPresenceKnown: isPeerInRoom,
              peerOnline: isPeerInRoom || Boolean(activeConv?.contact_online || activeConv?.other_user?.is_online || get().peerOnline)
            })
          })
          .on('presence', { event: 'leave' }, ({ key }) => {
            const activeConv = get().activeConversation
            const currentMyId = get().chatUser?.id
            const convUserId = activeConv?.user_id || activeConv?.user_one_id
            const otherId = activeConv?.other_user?.id || (
              sameId(convUserId, currentMyId)
                ? activeConv?.user_two_id
                : convUserId
            )
            if (otherId && key === `user_${otherId}`) {
              set({ _peerPresenceKnown: false, peerOnline: Boolean(activeConv?.contact_online || activeConv?.other_user?.is_online) })
            }
          })
          .subscribe((status) => {
            if (status === 'SUBSCRIBED' && myId) {
              realtimePrivateFailures = 0
              if (typeof document === 'undefined' || document.visibilityState === 'visible') {
                channel.track({ user_id: myId, online_at: Date.now() }).catch(() => {})
              }
              // Immediately announce delivery receipt for any existing peer messages
              const peerMsgs = get().messages.filter(
                (m) => m && m.id > 0 && !sameId(m.user_id, myId)
              )
              const maxPeerMsgId = peerMsgs.length
                ? Math.max(...peerMsgs.map((m) => Number(m.id) || 0))
                : 0
              if (maxPeerMsgId > 0) {
                channel.send({
                  type: 'broadcast',
                  event: 'delivery_receipt',
                  payload: { user_id: myId, last_delivered_id: maxPeerMsgId, room_id: roomId }
                }).catch(() => {})

                const isPageVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
                if (isPageVisible) {
                  channel.send({
                    type: 'broadcast',
                    event: 'read_receipt',
                    payload: { user_id: myId, last_read_id: maxPeerMsgId, room_id: roomId }
                  }).catch(() => {})
                }
              }
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              // A 'CLOSED' status is also reported for our own teardown (room
              // switch, logout, or the fallback restart below). Reconnecting on
              // it resurrected sessions that had already been stopped and kept
              // aborting the long-poll, so messages stopped appearing.
              notePrivateChannelFailure(privateReady)
              console.warn(`[SUPABASE REALTIME] Room channel status: ${status}, auto-reconnecting...`)
              setTimeout(() => {
                if (!controller.signal.aborted && sameId(get().activeRoomId, roomId)) {
                  // startRealtime is guarded by realtimeAbort; clear the old
                  // session first so token/RLS reconnects actually happen.
                  get().stopRealtime()
                  get().startRealtime()
                }
              }, 1200)
            }
          })

        // Presence must mirror real availability. Without untracking, a hidden
        // tab kept broadcasting "online" for as long as the socket stayed open.
        const previousVisibilityHandler = get()._presenceVisibilityHandler
        if (previousVisibilityHandler && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', previousVisibilityHandler)
        }
        const handlePresenceVisibility = () => {
          if (!myId) return
          try {
            if (document.visibilityState === 'hidden') {
              channel.untrack().catch(() => {})
            } else {
              channel.track({ user_id: myId, online_at: Date.now() }).catch(() => {})
            }
          } catch { /* ignore */ }
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', handlePresenceVisibility)
        }
        set({ supabaseRoomChannel: channel, _presenceVisibilityHandler: handlePresenceVisibility })
        } catch (err) {
          console.warn('[SUPABASE REALTIME] Room channel init error:', err)
        }
      }
      setupRoomChannel().catch((err) => {
        console.warn('[SUPABASE REALTIME] Room channel setup error:', err)
      })
    }

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const msgs = get().messages
          const realMsgs = msgs.filter((m) => m && typeof m.id === 'number' && m.id > 0)
          const afterId = realMsgs.length ? Math.max(...realMsgs.map((m) => m.id)) : 0
          // Typing, read receipts and edit/delete updates are deliberately not
          // polled: the extra DB reads every 0.75s per open chat were starving
          // the server threads. They arrive over the Supabase broadcast channel.
          const res = await apiFetch(
            `/chat/rooms/${roomId}/events?after_message_id=${afterId}` +
            `&timeout=3&online=${get().peerOnline ? 1 : 0}`,
            { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, timeoutMs: 8000 }
          )
          if (controller.signal.aborted) return

          const json = await res.json().catch(() => null)
          if (!res.ok || !json?.success) {
            await wait(1500)
            continue
          }

          const data = json.data || {}
          // This loop runs every ~3.3s for the whole session. Writing the same
          // values back into the store still notified every subscriber (full
          // chat screen + message list re-render). Only emit a patch when a
          // value actually changed; returning the current state is a no-op in
          // zustand and skips notifying listeners entirely.
          // After a presence leave, the server's 90-second last_seen window
          // can still report "online"; do not resurrect a false presence.
          const nextPeerOnline = Boolean(
            (get()._peerPresenceKnown && get().peerOnline) ||
            data.peer_online ||
            get().activeConversation?.contact_online ||
            get().activeConversation?.other_user?.is_online
          )
          set((state) => {
            if (state.peerOnline === nextPeerOnline) return state
            return { peerOnline: nextPeerOnline }
          })

          const incoming = Array.isArray(data.messages) ? data.messages : []
          if (incoming.length) {
            // Room-switch guard: everything below awaits (identity load +
            // WebCrypto decrypt passes over up to ~50 messages) and then writes
            // BOTH the live messages list and this room's cache. If the user
            // switched rooms while those awaits ran, get().messages is the
            // OTHER room's list — merging here would pollute it and corrupt
            // this room's cache, so abort this cycle instead.
            if (controller.signal.aborted || !sameId(get().activeRoomId, roomId)) return
            const identity = get().identityKeypair || await ensureLocalIdentity(get, set)
            let activeConv = (get().activeConversation && sameId(get().activeConversation.id, roomId))
              ? get().activeConversation
              : (get().conversations.find((c) => sameId(c.id, roomId)) || get().activeConversation)
            const myPubKey = get().identityPublicKey
            // Only sync contact_public_key if activeConv is missing it AND key is not my own public key
            if (activeConv && !activeConv.contact_public_key && incoming[0]?.contact_public_key && incoming[0].contact_public_key !== myPubKey) {
              activeConv = { ...activeConv, contact_public_key: incoming[0].contact_public_key }
              set({ activeConversation: activeConv })
            }
            const decrypted = await Promise.all(
              incoming.map((m) => decryptStoredMessage(m, roomId, activeConv, identity))
            )
            // Second guard: decryption is the long await — re-verify before
            // touching the (possibly new room's) live state.
            if (controller.signal.aborted || !sameId(get().activeRoomId, roomId)) return
            // Also attempt to re-decrypt any previously locked messages in existing state
            const redecryptedExisting = await Promise.all(
              get().messages.map(async (m) => {
                if (m._locked && (m.raw_message || isEncryptedMessage(m.message))) {
                  return await decryptStoredMessage(m, roomId, activeConv, identity)
                }
                return m
              })
            )
            // Replace-by-id so edits, deletions and reaction updates apply.
            const byId = new Map(redecryptedExisting.map((m) => [m.id, m]))
            decrypted.forEach((m) => byId.set(m.id, m))
            const merged = [...byId.values()].sort(sortChatMessages)
            set({ messages: merged })
            const uid = get().chatUser?.id
            if (uid) {
              setCachedMessages(uid, roomId, merged)
            }
            get().fetchConversations()
          }
          // Brief pause before next cycle releases connection pool and worker slots
          await wait(350)
        } catch (err) {
          if (controller.signal.aborted) return
          await wait(2000)
        }
      }
    }
    run()
  },

  stopRealtime: () => {
    clearTimeout(get()._typingTimer)
    const presenceVisibilityHandler = get()._presenceVisibilityHandler
    if (presenceVisibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', presenceVisibilityHandler)
    }
    const sbChannel = get().supabaseRoomChannel
    if (sbChannel && supabase) {
      try {
        sbChannel.unsubscribe()
        supabase.removeChannel(sbChannel)
      } catch {
        /* ignore */
      }
    }
    const controller = get().realtimeAbort
    if (controller) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    set({
      realtimeAbort: null,
      realtimeRoomId: null,
      peerTyping: false,
      _peerPresenceKnown: false,
      supabaseRoomChannel: null,
      _presenceVisibilityHandler: null
    })
  },

  sendTyping: (roomId) => {
    const token = get().chatToken
    const target = roomId || get().activeRoomId
    if (!token || !target) return
    const now = Date.now()
    if (now - (get()._lastTypingSentAt || 0) < 2000) return
    set({ _lastTypingSentAt: now })

    // Instant Supabase WebSocket broadcast (<10ms)
    const roomChannel = get().supabaseRoomChannel
    if (roomChannel) {
      roomChannel.send({
        type: 'broadcast',
        event: 'typing',
        payload: { user_id: get().chatUser?.id, is_typing: true }
      }).catch(() => {})
    }

    // No backend fallback: nothing polls chat_typing any more (the long-poll
    // no longer reads it), so writing it every 2s was pure DB load.
  },

  // 3d. Safety controls: block/unblock + report
  blockUser: async (userId) => {
    const token = get().chatToken
    if (!token || !userId) return false

    // Optimistic instant UI update (0ms)
    const prevActive = get().activeConversation
    const prevConversations = get().conversations
    set({
      activeConversation: prevActive && sameId(prevActive.other_user?.id, userId)
        ? { ...prevActive, blocked_by_me: true }
        : prevActive,
      conversations: prevConversations.map((c) =>
        sameId(c.other_user?.id, userId) ? { ...c, blocked_by_me: true } : c
      )
    })

    try {
      const res = await apiFetch(`/chat/users/${userId}/block`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        set({ activeConversation: prevActive, conversations: prevConversations })
        return false
      }
      return true
    } catch (e) {
      set({ activeConversation: prevActive, conversations: prevConversations })
      console.warn('Block user error:', e)
      return false
    }
  },

  unblockUser: async (userId) => {
    const token = get().chatToken
    if (!token || !userId) return false

    // Optimistic instant UI update (0ms)
    const prevActive = get().activeConversation
    const prevConversations = get().conversations
    set({
      activeConversation: prevActive && sameId(prevActive.other_user?.id, userId)
        ? { ...prevActive, blocked_by_me: false }
        : prevActive,
      conversations: prevConversations.map((c) =>
        sameId(c.other_user?.id, userId) ? { ...c, blocked_by_me: false } : c
      )
    })

    try {
      const res = await apiFetch(`/chat/users/${userId}/block`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        set({ activeConversation: prevActive, conversations: prevConversations })
        return false
      }
      return true
    } catch (e) {
      set({ activeConversation: prevActive, conversations: prevConversations })
      console.warn('Unblock user error:', e)
      return false
    }
  },

  reportUser: async ({ userId, roomId = null, reason = 'other', details = '' }) => {
    const token = get().chatToken
    if (!token || !userId) return false
    try {
      const res = await apiFetch('/chat/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          reported_user_id: userId,
          room_id: roomId,
          reason,
          details
        })
      })
      return res.ok
    } catch (e) {
      console.warn('Report user error:', e)
      return false
    }
  },

  // 3e. Message actions: edit, delete (me/everyone), reactions
  editMessage: async (messageId, text) => {
    const token = get().chatToken
    const targetRoomId = get().activeRoomId
    const trimmed = (text || '').trim()
    if (!token || !messageId || !targetRoomId || !trimmed) return false

    try {
      const activeConv = get().activeConversation || get().conversations.find((c) => sameId(c.id, targetRoomId))
      let identity = get().identityKeypair || await ensureLocalIdentity(get, set)
      const peerKey = activeConv?.contact_public_key
      // Re-encrypt before upload: the server never receives edit plaintext.
      const payload = (peerKey && identity?.privateKey)
        ? await encryptRoomMessageV2(trimmed, targetRoomId, identity, peerKey)
        : await encryptChatMessage(trimmed, activeConv?.e2e_secret || activeConv?.room_key || null, targetRoomId)

      const res = await apiFetch(`/chat/messages/${messageId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ message: payload })
      })
      const json = await res.json()
      if (!res.ok || !json.success) return false

      const updatedMessages = get().messages.map((m) => sameId(m.id, messageId)
        ? { ...m, message: trimmed, edited_at: new Date().toISOString() }
        : m)
      set({ messages: updatedMessages })
      const uid = get().chatUser?.id
      const roomId = get().activeRoomId
      if (uid && roomId) setCachedMessages(uid, roomId, updatedMessages)
      get().fetchConversations()
      return true
    } catch (e) {
      console.warn('Edit message error:', e)
      return false
    }
  },

  deleteMessage: async (messageId, scope = 'me') => {
    const token = get().chatToken
    if (!token || !messageId) return false

    // Apply the delete right away so the bubble reacts to the tap instead of
    // waiting a network round-trip. If the server rejects it, put the message
    // back exactly as it was.
    const before = (() => {
      const target = get().messages.find((m) => sameId(m.id, messageId))
      return target ? { ...target } : null
    })()
    const applyMessages = (updated) => {
      set({ messages: updated })
      const uid = get().chatUser?.id
      const roomId = get().activeRoomId
      if (uid && roomId) setCachedMessages(uid, roomId, updated)
    }
    applyMessages(
      scope === 'me'
        ? get().messages.filter((m) => !sameId(m.id, messageId))
        : get().messages.map((m) => sameId(m.id, messageId)
          ? { ...m, message: '', media_url: null, message_type: 'deleted', deleted: 1 }
          : m)
    )
    const revert = () => {
      if (!before) return
      const uid = get().chatUser?.id
      const targetRoom = before.room_id || get().activeRoomId
      const stillActive = sameId(get().activeRoomId, targetRoom)
      if (stillActive) {
        const current = get().messages.some((m) => sameId(m.id, messageId))
          ? get().messages.map((m) => (sameId(m.id, messageId) ? before : m))
          : [...get().messages, before].sort(sortChatMessages)
        set({ messages: current })
        if (uid) setCachedMessages(uid, targetRoom, current)
        return
      }
      // User switched rooms while the request was in flight: revert inside the
      // deleted message's own room cache instead of clobbering the now-active
      // room's live list. Skip when the room has no cache to rebuild from.
      if (uid) {
        const cached = getCachedMessages(uid, targetRoom)
        if (cached.length > 0) {
          const current = cached.some((m) => sameId(m.id, messageId))
            ? cached.map((m) => (sameId(m.id, messageId) ? before : m))
            : [...cached, before].sort(sortChatMessages)
          setCachedMessages(uid, targetRoom, current)
        }
      }
    }

    try {
      const res = await apiFetch(`/chat/messages/${messageId}?scope=${scope}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        revert()
        return false
      }

      get().fetchConversations()

      // Instant Supabase WebSocket broadcast for deletions. The receiver
      // validates the payload against my id / the conversation peer id, so
      // user_id must ride along or the tombstone is silently dropped.
      if (scope === 'everyone') {
        const roomChannel = get().supabaseRoomChannel
        if (roomChannel) {
          roomChannel.send({
            type: 'broadcast',
            event: 'message_deleted',
            payload: { message_id: messageId, user_id: get().chatUser?.id }
          }).catch(() => {})
        }
      }

      return true
    } catch (e) {
      revert()
      console.warn('Delete message error:', e)
      return false
    }
  },

  toggleReaction: async (messageId, emoji) => {
    const token = get().chatToken
    const myId = get().chatUser?.id
    if (!token || !messageId || !emoji) return false

    // 1. OPTIMISTIC UPDATE: calculate and apply reaction locally with 0ms delay!
    const prevMessages = get().messages
    const reactionRoomId = get().activeRoomId
    const targetMsg = prevMessages.find((m) => sameId(m.id, messageId))
    if (!targetMsg) return false

    const existingReactions = Array.isArray(targetMsg.reactions) ? [...targetMsg.reactions] : []
    const existingIdx = existingReactions.findIndex((r) => r.emoji === emoji)
    let optimisticReactions = []

    if (existingIdx >= 0) {
      const current = existingReactions[existingIdx]
      if (current.mine) {
        // Toggle OFF (user unreacts)
        const newCount = (current.count || 1) - 1
        if (newCount > 0) {
          optimisticReactions = existingReactions.map((r, i) =>
            i === existingIdx ? { ...r, count: newCount, mine: false } : r
          )
        } else {
          optimisticReactions = existingReactions.filter((_, i) => i !== existingIdx)
        }
      } else {
        // Toggle ON (mine was false)
        optimisticReactions = existingReactions.map((r, i) =>
          i === existingIdx ? { ...r, count: (r.count || 0) + 1, mine: true } : r
        )
      }
    } else {
      // Add brand new reaction
      optimisticReactions = [...existingReactions, { emoji, count: 1, mine: true }]
    }

    // Apply INSTANTLY to local state
    set({
      messages: prevMessages.map((m) =>
        sameId(m.id, messageId) ? { ...m, reactions: optimisticReactions } : m
      )
    })

    // Instant Supabase WebSocket broadcast (include user_id so peer updates in real-time)
    const roomChannel = get().supabaseRoomChannel
    if (roomChannel) {
      roomChannel.send({
        type: 'broadcast',
        event: 'reaction',
        payload: { message_id: messageId, reactions: optimisticReactions, user_id: myId }
      }).catch(() => {})
    }

    // 2. Background HTTP sync with backend
    try {
      const res = await apiFetch(`/chat/messages/${messageId}/reaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ emoji })
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        // Revert on error — only while the same room is still on screen;
        // prevMessages is a snapshot of that room, never of the current one.
        if (sameId(get().activeRoomId, reactionRoomId)) {
          set({ messages: prevMessages })
        }
        return false
      }
      const serverReactions = json.data?.reactions || optimisticReactions
      set({
        messages: get().messages.map((m) =>
          sameId(m.id, messageId) ? { ...m, reactions: serverReactions } : m
        )
      })
      return true
    } catch (e) {
      // Revert on network failure (same room guard as above)
      if (sameId(get().activeRoomId, reactionRoomId)) {
        set({ messages: prevMessages })
      }
      console.warn('Reaction error:', e)
      return false
    }
  },

  addOptimisticMediaMessage: (optimisticMsg) => {
    set((state) => {
      if (!sameId(state.activeRoomId, optimisticMsg.room_id)) return state
      return {
        messages: [...state.messages, {
          _clientId: `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          _sentAt: Date.now(),
          _baseMaxId: maxConfirmedMessageId(state.messages),
          ...optimisticMsg
        }]
      }
    })
  },

  updateMessageUploadState: (tempId, updates) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        sameId(m.id, tempId) ? { ...m, ...updates } : m
      )
    }))
  },

  removeOptimisticMessage: (tempId) => {
    set((state) => ({
      messages: state.messages.filter((m) => !sameId(m.id, tempId))
    }))
  },

  // 4. Send Message in Current or Specific Room
  sendRoomMessage: async (roomId, text, mediaUrl = null, messageType = 'text', replyToId = null, existingTempId = null, existingClientMessageId = null) => {
    const token = get().chatToken
    const targetRoomId = roomId || get().activeRoomId
    if (!token || !targetRoomId) return { success: false, error: 'No active chat room' }

    // One send per room+content at a time. A double-fired submit (Enter plus
    // form submit, or a double tap) used to create a second bubble with its own
    // idempotency key, and the backend could only store it as a second message.
    const sendKey = `${targetRoomId}|${messageType}|${mediaUrl || ''}|${text || ''}`
    let ownsSendKey = false
    if (!existingTempId) {
      const now = Date.now()
      for (const [key, at] of inFlightSendKeys) {
        if (now - at > 60000) inFlightSendKeys.delete(key)
      }
      if (inFlightSendKeys.has(sendKey)) return { success: true, deduped: true }
      inFlightSendKeys.set(sendKey, now)
      ownsSendKey = true

      // A failed bubble whose text the user submits again is a retry, not a new
      // message: reuse its idempotency key so the backend can dedupe a send that
      // actually committed before the timeout.
      const failedDuplicate = get().messages.find((m) => (
        isOptimisticMessage(m) && m._failed
        && sameId(m.room_id, targetRoomId)
        && (m.media_url || '') === (mediaUrl || '')
        && (m.message || '') === (text || '')
      ))
      if (failedDuplicate) {
        inFlightSendKeys.delete(sendKey)
        ownsSendKey = false
        return get().sendRoomMessage(
          roomId, text, mediaUrl, messageType, replyToId,
          failedDuplicate.id, failedDuplicate._clientId
        )
      }
    }

    // Show the bubble immediately. The network + encryption still finish in
    // the background; on failure the optimistic bubble stays with a retry indicator.
    const tempId = existingTempId || (-Date.now() - Math.floor(Math.random() * 100000))
    // Stable idempotency key: retries (including after a 35s timeout) reuse the
    // same key, so the backend returns the already-saved message instead of
    // creating duplicate bubbles.
    const existingBubble = existingTempId
      ? get().messages.find((m) => sameId(m.id, existingTempId))
      : null
    // The retry path passes the id it already used. Without that, a retry whose
    // bubble had been reconciled away generated a fresh key, so a send that had
    // actually committed was stored a second time (two rows 18s apart in
    // production) and the user saw the same text twice.
    const clientMessageId = existingClientMessageId
      || existingBubble?._clientId
      || `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    if (!existingTempId) {
      const optimisticMessage = {
        id: tempId,
        _clientId: clientMessageId,
        _sentAt: Date.now(),
        _baseMaxId: maxConfirmedMessageId(get().messages),
        room_id: targetRoomId,
        user_id: get().chatUser?.id,
        sender_type: 'user',
        sender_name: get().chatUser?.name || 'You',
        username: get().chatUser?.username,
        message: text,
        media_url: mediaUrl,
        message_type: messageType,
        created_at: new Date().toISOString(),
        is_read: 0,
        _pending: true,
        _failed: false
      }
      set((state) => ({
        sending: false,
        messages: sameId(state.activeRoomId, targetRoomId)
          ? [...state.messages, optimisticMessage]
          : state.messages
      }))
    } else {
      set((state) => ({
        sending: false,
        messages: state.messages.map((m) =>
          sameId(m.id, tempId) ? { ...m, _pending: true, _uploading: false, _uploadProgress: 100, _failed: false, media_url: mediaUrl } : m
        )
      }))
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 35000)

    try {
      const activeConv = (
        (sameId(get().activeRoomId, targetRoomId) ? get().activeConversation : null) ||
        get().conversations.find((c) => sameId(c.id, targetRoomId)) ||
        get().activeConversation
      )
      const e2eSecret = activeConv?.e2e_secret || activeConv?.room_key || null

      // Do NOT block the send on a server backup fetch. Use the local identity
      // if present; otherwise generate a fresh keypair locally (no network call).
      // Publishing the public key to the server happens in the background below.
      let identity = get().identityKeypair
      if (!identity) {
        const uid = get().chatUser?.id
        identity = uid ? await getOrCreateIdentityKeypair(uid) : null
        if (identity) {
          set({
            identityKeypair: identity,
            identityPublicKey: identity.publicKeyB64,
            identityUserId: String(uid),
            identityNeedsPassphrase: false
          })
        }
      }
      if (identity) get().initE2EE().catch(() => {})
      const peerKey = activeConv?.contact_public_key

      // Mark sending while the network request is in flight so the UI reflects reality.
      set({ sending: true })

      // True E2EE when the peer published a key: only the two devices can
      // derive this room key. Legacy/support rooms keep v1 (or stay plaintext).
      let payloadMessage = text
      if (text && typeof text === 'string') {
        payloadMessage = (peerKey && identity?.privateKey)
          ? await encryptRoomMessageV2(text, targetRoomId, identity, peerKey)
          : await encryptChatMessage(text, e2eSecret, targetRoomId)
      }

      const res = await apiFetch(`/chat/rooms/${targetRoomId}/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          message: payloadMessage,
          media_url: mediaUrl,
          message_type: messageType,
          reply_to_id: replyToId || null,
          client_message_id: clientMessageId
        })
      })
      clearTimeout(timeoutId)

      // A non-JSON error body (Railway 502 HTML, proxy page) must not mask the
      // HTTP status: keep the status in the thrown error so the failed bubble
      // can show what actually happened.
      const json = await res.json().catch(() => null)
      if (res.ok && json?.success) {
        const rawMsgs = json.data || []
        const decryptedMsgs = await Promise.all(
          rawMsgs.map((m) => decryptStoredMessage(
            m, targetRoomId, activeConv, identity
          ))
        )
        // The API now returns only the newly created message: replace the
        // optimistic bubble with the server copy.
        // Room-switch guard: while the request was in flight the user may have
        // switched conversations, so the live messages array can belong to a
        // DIFFERENT room. Never merge this room's message into that list, and
        // never write the other room's list into this room's cache — build the
        // target room's list from its own live view (still active) or its own
        // cache, and only publish to the live view while still on screen.
        const uid = get().chatUser?.id
        const stillActive = sameId(get().activeRoomId, targetRoomId)
        const current = (stillActive
          ? get().messages
          : (uid ? getCachedMessages(uid, targetRoomId) : [])
        ).filter((m) => !sameId(m.id, tempId))
        const seen = new Set(current.map((m) => m.id))
        const merged = [...current, ...decryptedMsgs.filter((m) => !seen.has(m.id))]
        merged.sort(sortChatMessages)
        set((state) => ({
          sending: false,
          messages: sameId(state.activeRoomId, targetRoomId) ? merged : state.messages
        }))
        if (uid) {
          setCachedMessages(uid, targetRoomId, merged)
        }
        // Sent-message cue: the bubble is already on screen, this just confirms
        // the server accepted it.
        playSound('send')
        clearTimeout(postSendRefreshTimer)
        postSendRefreshTimer = setTimeout(() => {
          postSendRefreshTimer = null
          get().fetchConversations().catch(() => {})
          get().fetchUnreadCount().catch(() => {})
        }, 1000)

        // 1. Instant WebSocket broadcast to active room (<30ms delivery)
        const rawCreated = rawMsgs[0]
        const roomChannel = get().supabaseRoomChannel
        // Only fan out on the live room channel while this room is still the
        // one on screen — the channel object tracks the ACTIVE room, so after
        // a switch it would broadcast this message into the wrong room.
        if (roomChannel && rawCreated && stillActive) {
          const broadcastMsg = {
            ...rawCreated,
            sender_public_key: identity?.publicKeyB64 || get().identityPublicKey,
            recipient_public_key: peerKey || activeConv?.contact_public_key || null
          }
          roomChannel.send({
            type: 'broadcast',
            event: 'new_message',
            payload: broadcastMsg
          }).catch((e) => console.warn('[SUPABASE] Broadcast message error:', e))
        }

        // 2. Instant notification ping to recipient's personal user channel (safe helper, no leaks)
        const currentMyId = get().chatUser?.id
        const convUserId = activeConv?.user_id || activeConv?.user_one_id
        const otherUserId = activeConv?.other_user?.id || (
          sameId(convUserId, currentMyId)
            ? activeConv?.user_two_id
            : convUserId
        )
        if (otherUserId) {
          sendSupabaseUserAlert(otherUserId, 'incoming_chat', {
            room_id: targetRoomId,
            sender_id: currentMyId,
            message_id: rawCreated?.id
          })
        }

        return { success: true }
      } else {
        // Some proxies/servers return objects in `message`/`error`; passing one
        // to Error() rendered the useless "[object Object]". Only string text is
        // shown, with the server's diagnostic detail kept for the console.
        const serverMessage = [json?.message, json?.error].find(
          (value) => typeof value === 'string' && value.trim()
        )
        const sendError = new Error(
          serverMessage || `Send failed (HTTP ${res.status})`
        )
        sendError.httpStatus = res.status
        sendError.serverDetail = typeof json?.detail === 'string' ? json.detail : null
        throw sendError
      }
    } catch (err) {
      clearTimeout(timeoutId)
      const isTimeout = err?.name === 'AbortError'
      const failReason = isTimeout
        ? 'Timed out after 35s'
        : (err?.httpStatus ? `HTTP ${err.httpStatus}: ${err.message}` : (err?.message || 'Network error'))
      console.warn('[chat] message send failed', {
        roomId: targetRoomId,
        reason: failReason,
        detail: err?.serverDetail || undefined
      })

      // Check if message was ALREADY confirmed via realtime broadcast or inbox sync while HTTP was in flight!
      const currentMsgs = get().messages
      const pendingBubble = currentMsgs.find((m) => sameId(m.id, tempId))
      const alreadyConfirmed = hasFreshConfirmation(
        currentMsgs, pendingBubble, text, mediaUrl, get().chatUser?.id
      )
      if (alreadyConfirmed) {
        set((state) => ({
          sending: false,
          messages: state.messages.filter((m) => !sameId(m.id, tempId))
        }))
        return { success: true }
      }

      // One automatic retry for a timeout/network failure, reusing the same
      // idempotency key. A request stalled on one worker/DB stream is often
      // served instantly by another, and the backend dedupes on the client key
      // so a message that did commit can never be duplicated.
      if (!existingTempId && !err?.httpStatus) {
        console.warn('[chat] retrying message send once after transport failure')
        return get().sendRoomMessage(
          targetRoomId, text, mediaUrl, messageType, replyToId, tempId, clientMessageId
        )
      }

      set((state) => ({
        sending: false,
        messages: state.messages.map((m) =>
          sameId(m.id, tempId)
            ? { ...m, _pending: false, _failed: true, _failReason: failReason }
            : m
        )
      }))
      // Audible failure cue: the bubble shows a retry icon, but a send that
      // fails while the user looks elsewhere needs a sound too.
      playSound('error')
      return { success: false, error: isTimeout ? 'Message sending timed out. Please check connection and try again.' : (err?.message || 'Failed to send message') }
    } finally {
      if (ownsSendKey) inFlightSendKeys.delete(sendKey)
      set({ sending: false })
    }
  },

  // 5. Open Direct 1-to-1 Chat with any User
  openDirectChat: async (targetUserId) => {
    const token = get().chatToken
    if (!token || !targetUserId) return { success: false }

    // Instant local shortcut: if direct conversation already exists in memory, switch to it immediately!
    const existing = get().conversations.find((c) =>
      sameId(c.other_user?.id, targetUserId) ||
      sameId(c.user_two_id, targetUserId) ||
      (c.room_type === 'direct' && sameId(c.other_user_id, targetUserId))
    )
    if (existing) {
      get().selectConversation(existing)
      return { success: true, conversation: existing }
    }

    if (sameId(get()._openingDirectChatId, targetUserId)) return { success: false, inFlight: true }
    set({ _openingDirectChatId: targetUserId })

    try {
      const res = await apiFetch(`/chat/direct-chat/${targetUserId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (res.ok && json.success && json.data?.conversation) {
        const conv = json.data.conversation
        set((state) => {
          const exists = state.conversations.some((c) => sameId(c.id, conv.id))
          const newConvs = exists
            ? state.conversations.map((c) => (sameId(c.id, conv.id) ? conv : c))
            : [conv, ...state.conversations]
          return {
            conversations: newConvs,
            activeConversation: conv,
            activeRoomId: conv.id,
            messages: [],
            messagesLoading: true,
            messagesHasMore: false
          }
        })
        get().startRealtime()
        await get().fetchRoomMessages(conv.id)
        get().fetchConversations()
        return { success: true, conversation: conv }
      }
      return { success: false, error: json.message || 'Could not open chat' }
    } catch (err) {
      return { success: false, error: err.message }
    } finally {
      set({ _openingDirectChatId: null })
    }
  },

  // 6. Friends & Connection Management
  fetchFriendsAndRequests: async () => {
    const token = get().chatToken
    if (!token) return

    try {
      const res = await apiFetch('/chat/friends', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (res.ok && json.success) {
        const friendsList = json.data.friends || []
        set({
          friends: friendsList,
          incomingRequests: json.data.incoming_requests || [],
          outgoingRequests: json.data.outgoing_requests || [],
          pendingRequestsCount: json.data.pending_count || 0
        })
        const uid = get().chatUser?.id
        if (uid && friendsList.length > 0) {
          setCachedFriends(uid, friendsList)
        }
      }
    } catch (e) {
      console.warn('Fetch friends error:', e)
    }
  },

  // Realtime friends/requests. Holds one long-poll open and updates the lists
  // the moment the server-side revision changes, instead of waiting for the
  // 30-second fallback refresh in ChatConversation.
  startSocialRealtime: () => {
    const token = get().chatToken
    if (!token) return
    if (get().socialRealtimeAbort) return

    const controller = new AbortController()
    set({ socialRealtimeAbort: controller })

    // Supabase Realtime User Channel for instant background alerts (<50ms)
    const myId = get().chatUser?.id
    if (supabase && myId && !get().supabaseUserChannel) {
      const setupUserChannel = async () => {
        // Join only after the Realtime JWT is installed; private channels
        // cannot be upgraded after they have been created as public.
        const privateReady = SUPABASE_PRIVATE_CHANNELS
          ? await ensureSupabaseRealtimeAuth(get, `chat_user_${myId}`)
          : false
        if (controller.signal.aborted || get().supabaseUserChannel) return
        try {
        const channelName = `chat_user_${myId}`
        const existing = (typeof supabase.getChannels === 'function' ? supabase.getChannels() : [])
          .find((c) => c.topic === `realtime:${channelName}`)
        if (existing) {
          try {
            existing.unsubscribe()
            supabase.removeChannel(existing)
          } catch { /* ignore */ }
        }

        const userChannel = supabase.channel(
          channelName,
          privateReady ? { config: { private: true } } : undefined
        )
        userChannel
          .on('broadcast', { event: 'incoming_call' }, () => {
            // Backend hint only: the watcher re-reads /calls/incoming, so the
            // payload can never inject a fake call.
            wakeCallWatcher()
          })
          .on('broadcast', { event: 'call_answered' }, (ev) => {
            const payload = ev?.payload || {}
            const call = get().activeCall
            const myId = get().chatUser?.id
            // Only the caller applies the peer's answer; the callee already set
            // that SDP as its own local description.
            if (!call || !myId || String(call.callerId) !== String(myId)) return
            if (payload.room_id && String(payload.room_id) !== String(call.roomId)) return
            set((s) => ({
              activeCall: s.activeCall ? { ...s.activeCall, state: 'active' } : s.activeCall
            }))
            get().startCallTimer()
            get().applyCallAnswer(payload.answer_sdp)
          })
          .on('broadcast', { event: 'call_ice' }, (ev) => {
            const payload = ev?.payload || {}
            const call = get().activeCall
            if (!call || !payload.candidates) return
            if (payload.room_id && String(payload.room_id) !== String(call.roomId)) return
            // A candidate that belongs to an older call in the same room must
            // not be added to the new peer connection.
            if (payload.call_id && call.callId && String(payload.call_id) !== String(call.callId)) return
            get().applyCallIceCandidates(payload.candidates)
          })
          .on('broadcast', { event: 'incoming_chat' }, (ev) => {
            get().fetchConversations()
            get().fetchUnreadCount()
            const senderId = ev.payload?.sender_id
            const msgId = Number(ev.payload?.message_id) || 0
            const roomId = ev.payload?.room_id
            if (senderId && msgId > 0) {
              sendSupabaseUserAlert(senderId, 'delivery_receipt', {
                room_id: roomId,
                user_id: myId,
                last_delivered_id: msgId
              })
            }
            if (roomId && String(get().activeRoomId) === String(roomId)) {
              get().fetchRoomMessages(roomId)
            } else if (!isRoomSoundMuted(roomId)) {
              // Message for a room that is not on screen: the open-room chime
              // cannot fire, so cue it here — softer when the app is backgrounded.
              playSound(
                typeof document !== 'undefined' && document.visibilityState === 'visible'
                  ? 'receive'
                  : 'notification'
              )
            }
          })
          .on('broadcast', { event: 'delivery_receipt' }, ({ payload }) => {
            const lastDeliveredId = Number(payload?.last_delivered_id)
            const roomId = payload?.room_id
            if (!payload || !lastDeliveredId) return
            const uid = get().chatUser?.id
            if (uid && roomId) {
              setStoredDeliveredId(uid, roomId, lastDeliveredId)
            }
            set((state) => {
              const patch = {}
              if (sameId(state.activeRoomId, roomId)) {
                patch.peerLastDeliveredId = Math.max(state.peerLastDeliveredId || 0, lastDeliveredId)
                patch.messages = state.messages.map((m) =>
                  m.id <= lastDeliveredId ? { ...m, is_delivered: 1 } : m
                )
              }
              patch.conversations = state.conversations.map((c) =>
                sameId(c.id, roomId) ? { ...c, last_msg_is_delivered: 1 } : c
              )
              return patch
            })
          })
          .on('broadcast', { event: 'read_receipt' }, ({ payload }) => {
            const lastReadId = Number(payload?.last_read_id)
            const roomId = payload?.room_id
            if (!payload || !lastReadId) return
            const uid = get().chatUser?.id
            if (uid && roomId) {
              setStoredDeliveredId(uid, roomId, lastReadId)
            }
            set((state) => {
              const patch = {}
              if (sameId(state.activeRoomId, roomId)) {
                patch.peerLastReadId = Math.max(state.peerLastReadId || 0, lastReadId)
                patch.peerLastDeliveredId = Math.max(state.peerLastDeliveredId || 0, lastReadId)
                patch.messages = state.messages.map((m) =>
                  m.id <= lastReadId ? { ...m, is_read: 1, is_delivered: 1 } : m
                )
              }
              patch.conversations = state.conversations.map((c) =>
                sameId(c.id, roomId) ? { ...c, last_msg_is_read: 1, last_message_is_read: true } : c
              )
              return patch
            })
          })
          .on('broadcast', { event: 'friend_event' }, () => {
            // New friend request / accepted request: a soft notification cue,
            // the same one the app uses for background alerts.
            playSound('notification')
            get().fetchFriendsAndRequests()
            get().fetchConversations()
          })
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              realtimePrivateFailures = 0
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              // Same as the room channel: 'CLOSED' is our own teardown, not a
              // transport failure, so it must not schedule a reconnect.
              notePrivateChannelFailure(privateReady)
              console.warn(`[SUPABASE REALTIME] User channel status: ${status}, auto-reconnecting...`)
              setTimeout(() => {
                if (!controller.signal.aborted && get().chatToken) {
                  get().stopSocialRealtime()
                  get().startSocialRealtime()
                }
              }, 1500)
            }
          })
        set({ supabaseUserChannel: userChannel })
        } catch (e) {
          console.warn('[SUPABASE REALTIME] User channel error:', e)
        }
      }
      setupUserChannel().catch((e) => {
        console.warn('[SUPABASE REALTIME] User channel setup error:', e)
      })
    }

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await apiFetch(
            `/chat/social/events?since=${encodeURIComponent(get().socialRealtimeRevision || '')}&timeout=3`,
            { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, timeoutMs: 8000 }
          )
          if (controller.signal.aborted) return

          const json = await res.json().catch(() => null)
          if (!res.ok || !json?.success) {
            await wait(1500)
            continue
          }

          const data = json.data || {}
          const previousRevision = get().socialRealtimeRevision
          set({
            friends: data.friends || [],
            incomingRequests: data.incoming_requests || [],
            outgoingRequests: data.outgoing_requests || [],
            pendingRequestsCount: data.pending_count || 0,
            socialRealtimeRevision: data.revision || previousRevision
          })

          // New incoming message or friendship status changed: sync inbox & active chat in real-time
          if (previousRevision && data.revision && data.revision !== previousRevision) {
            get().fetchConversations()
            get().fetchUnreadCount()
            if (get().activeRoomId) {
              get().fetchRoomMessages(get().activeRoomId)
            }
          }
          await wait(500)
        } catch (err) {
          if (controller.signal.aborted) return
          await wait(2000)
        }
      }
    }
    run()
  },

  stopSocialRealtime: () => {
    const userChannel = get().supabaseUserChannel
    if (userChannel && supabase) {
      try {
        userChannel.unsubscribe()
        supabase.removeChannel(userChannel)
      } catch {
        /* ignore */
      }
    }
    const controller = get().socialRealtimeAbort
    if (controller) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    set({ socialRealtimeAbort: null, supabaseUserChannel: null })
  },

  sendFriendRequest: async (targetUserId, username = null) => {
    const token = get().chatToken
    if (!token) return { success: false, error: 'Not authenticated' }

    try {
      const res = await apiFetch('/chat/friends/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          target_user_id: targetUserId,
          username: username
        })
      })
      const json = await res.json()
      if (res.ok && json.success) {
        if (targetUserId) {
          sendSupabaseUserAlert(targetUserId, 'friend_event', {
            from_user_id: get().chatUser?.id,
            action: 'request'
          })
        }
        get().fetchFriendsAndRequests()
        return { success: true, message: json.message }
      }
      return { success: false, error: json.message || 'Failed to send request' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  },

  respondFriendRequest: async (requestId, action) => {
    const token = get().chatToken
    if (!token) return { success: false }

    try {
      const res = await apiFetch('/chat/friends/respond', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ request_id: requestId, action })
      })
      const json = await res.json()
      if (res.ok && json.success) {
        const targetFriendId = json.data?.friend_id
        if (targetFriendId) {
          sendSupabaseUserAlert(targetFriendId, 'friend_event', {
            from_user_id: get().chatUser?.id,
            action
          })
        }
        get().fetchFriendsAndRequests()
        get().fetchConversations()
        return { success: true, data: json.data }
      }
      return { success: false, error: json.message }
    } catch (err) {
      return { success: false, error: err.message }
    }
  },

  // 7. Invite details
  fetchInviteInfo: async () => {
    const token = get().chatToken
    if (!token) return null

    try {
      const res = await apiFetch('/chat/invite-info', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (res.ok && json.success) {
        set({ inviteInfo: json.data })
        return json.data
      }
      return null
    } catch {
      return null
    }
  },

  // Global User Search
  searchUsers: async (query) => {
    const token = get().chatToken
    if (!token || !query?.trim()) return []

    try {
      const res = await apiFetch(`/chat/users/search?q=${encodeURIComponent(query.trim())}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (res.ok && json.success) {
        return json.data || []
      }
      return []
    } catch {
      return []
    }
  },

  // Backward-compatible fallback message fetching
  fetchMessages: async () => {
    const currentRoomId = get().activeRoomId
    if (currentRoomId) {
      await get().fetchRoomMessages(currentRoomId)
    } else {
      const token = get().chatToken
      if (!token) return
      try {
        const res = await apiFetch('/chat/messages', {
          headers: { Authorization: `Bearer ${token}` }
        })
        const json = await res.json()
        if (res.ok && json.success) {
          set({ messages: json.data || [] })
        }
      } catch (e) {
        console.warn('Fetch fallback messages error:', e)
      }
    }
  },

  sendMessage: async (text, mediaUrl = null, messageType = 'text') => {
    const currentRoomId = get().activeRoomId
    if (currentRoomId) {
      return get().sendRoomMessage(currentRoomId, text, mediaUrl, messageType)
    }

    const token = get().chatToken
    if (!token) return { success: false, error: 'Not authenticated' }

    set({ sending: true })
    try {
      const res = await apiFetch('/chat/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          message: text,
          media_url: mediaUrl,
          message_type: messageType
        })
      })

      const json = await res.json()
      if (res.ok && json.success) {
        set({ messages: json.data || [], sending: false })
        get().fetchConversations()
        get().fetchUnreadCount()
        return { success: true }
      } else {
        throw new Error(json.message || 'Failed to send message')
      }
    } catch (err) {
      set({ sending: false })
      return { success: false, error: err.message }
    }
  },

  // Web Push (VAPID) on browsers, FCM on the packaged Android app. The WebView
  // has no Push API, so routing the APK through VAPID used to fail with
  // "Push notifications are not configured on the server yet."
  enablePushNotifications: async ({ silent = false } = {}) => {
    if (!get().chatToken) return { success: false, error: 'Not authenticated' }
    if (isCapacitorNative()) return enableChatNativePush()
    return subscribeToChatPush({ requestPermission: !silent })
  },

  disablePushNotifications: async () => {
    if (!get().chatToken) return { success: false, error: 'Not authenticated' }
    if (isCapacitorNative()) {
      const disabled = await disableChatNativePush()
      return disabled
        ? { success: true }
        : { success: false, error: 'Could not disable device notifications.' }
    }
    return unsubscribeFromChatPush()
  },

  // Notifications
  fetchNotifications: async () => {
    const token = get().chatToken
    if (!token) return

    try {
      const res = await apiFetch('/chat/notifications', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (res.ok && json.success) {
        set({ notifications: json.data || [] })
      }
    } catch (e) {
      console.warn('Fetch chat notifications error:', e)
    }
  },

  fetchUnreadCount: async () => {
    const token = get().chatToken
    if (!token) return

    try {
      const res = await apiFetch('/chat/unread-count', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (res.ok && json.success) {
        set({ unreadCount: json.data.total_unread || 0 })
      }
    } catch {
      /* ignore */
    }
  },

  markNotificationRead: async (notifId) => {
    const token = get().chatToken
    if (!token || !notifId) return

    // Optimistically mark as read
    set((state) => ({
      notifications: state.notifications.map((n) =>
        sameId(n.id, notifId) ? { ...n, is_read: 1 } : n
      ),
      unreadCount: Math.max(0, state.unreadCount - 1)
    }))

    try {
      await apiFetch(`/chat/notifications/${notifId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      get().fetchUnreadCount()
    } catch (e) {
      console.warn('markNotificationRead error:', e)
    }
  },

  markAllNotificationsRead: async () => {
    const token = get().chatToken
    if (!token) return

    // Optimistically mark all as read
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, is_read: 1 })),
      unreadCount: 0
    }))

    try {
      await apiFetch('/chat/notifications/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      get().fetchUnreadCount()
    } catch (e) {
      console.warn('markAllNotificationsRead error:', e)
    }
  },

  deleteNotification: async (notifId) => {
    const token = get().chatToken
    if (!token || !notifId) return

    const target = get().notifications.find((n) => sameId(n.id, notifId))
    const wasUnread = target && !target.is_read

    // Optimistically remove
    set((state) => ({
      notifications: state.notifications.filter((n) => !sameId(n.id, notifId)),
      unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount
    }))

    try {
      await apiFetch(`/chat/notifications/${notifId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      get().fetchUnreadCount()
    } catch (e) {
      console.warn('deleteNotification error:', e)
    }
  },

  // ── Voice / Video call actions ──
  // Public STUN servers only (no TURN configured); works on the same network /
  // most NATs. Relayed candidates require a TURN server in production.
  _callStunServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],

  // STUN only connects peers that can reach each other directly. The backend
  // adds a TURN relay when configured, which is what makes calls work on
  // mobile carrier NAT (the APK especially). Fetched per call so rotated
  // credentials are honoured; falls back to public STUN on any failure.
  fetchCallIceServers: async () => {
    const token = get().chatToken
    if (!token) return get()._callStunServers
    if (cachedCallIceServers && Date.now() - cachedCallIceServersAt < CALL_ICE_CACHE_MS) {
      return cachedCallIceServers
    }
    if (callIceServersPromise) return callIceServersPromise
    callIceServersPromise = (async () => {
      try {
        const res = await apiFetch('/chat/ice-servers', {
          headers: { Authorization: `Bearer ${token}` }
        })
        const json = await res.json().catch(() => null)
        const servers = json?.data?.ice_servers
        if (res.ok && Array.isArray(servers) && servers.length) {
          cachedCallIceServers = servers
          cachedCallIceServersAt = Date.now()
          return servers
        }
      } catch (e) {
        console.warn('fetch ICE servers error:', e)
      } finally {
        callIceServersPromise = null
      }
      return get()._callStunServers
    })()
    return callIceServersPromise
  },

  startCallTimer: () => {
    const state = get()
    if (state.callTimerRef) return
    const ref = setInterval(() => {
      set((s) => ({ callTimerSeconds: (s.callTimerSeconds || 0) + 1 }))
    }, 1000)
    set({ callTimerRef: ref })
  },

  stopCallTimer: () => {
    const { callTimerRef } = get()
    if (callTimerRef) clearInterval(callTimerRef)
    set({ callTimerRef: null, callTimerSeconds: 0 })
  },

  cleanupCallResources: () => {
    const state = get()
    // Invalidate any initiateCall still in flight (mic prompt, ICE fetch,
    // offer POST) so a cancel cannot be undone by a late resolution.
    callStartGeneration += 1
    stopNativeCallAudio()
    stopRemoteCallAudio()
    stopAllCallSounds()
    get().stopCallTimer()
    appliedCallCandidates.clear()
    pendingCallCandidates.length = 0
    callAnswerApplied = false
    if (state.callAbortController) {
      try { state.callAbortController.abort() } catch {}
      set({ callAbortController: null })
    }
    if (state.callPeerConnection) {
      try { state.callPeerConnection.close() } catch {}
      set({ callPeerConnection: null })
    }
    if (state.callLocalStream) {
      // Park the mic track for the next call (iOS Home Screen web apps prompt
      // again for every fresh getUserMedia); camera tracks are always dropped.
      if (!parkCallMic(state.callLocalStream)) {
        state.callLocalStream.getTracks().forEach((t) => { try { t.stop() } catch {} })
      }
      set({ callLocalStream: null })
    }
    if (state.callRemoteStream) {
      state.callRemoteStream.getTracks().forEach((t) => t.stop())
      set({ callRemoteStream: null })
    }
    set({
      activeCall: null,
      callIsMuted: false,
      callIsSpeakerOn: true,
      callConnectionState: null,
      callDeepLinkHandled: null
    })
  },

  // Builds the post-call summary BEFORE the call is torn down (the timer and
  // activeCall are gone afterwards). `outcome` is what the end screen says:
  // completed | no_answer | missed | declined | cancelled | failed.
  finishCallWithSummary: (outcome) => {
    const { activeCall, callTimerSeconds, chatUser, conversations } = get()
    if (!activeCall) return
    const outgoing = String(activeCall.callerId) === String(chatUser?.id)
    const conv = (conversations || []).find((c) => String(c.id) === String(activeCall.roomId))
    const wasActive = activeCall.state === 'active'
    set({
      callEndedInfo: {
        roomId: activeCall.roomId,
        callType: activeCall.callType || 'voice',
        peerName: activeCall.peerName || conv?.contact_name || 'Unknown',
        peerAvatar: activeCall.peerAvatar || conv?.contact_avatar || null,
        direction: outgoing ? 'outgoing' : 'incoming',
        outcome: wasActive ? 'completed' : outcome,
        durationSeconds: wasActive ? (callTimerSeconds || 0) : 0,
        at: Date.now()
      }
    })
  },

  dismissCallEnded: () => set({ callEndedInfo: null }),

  openCallHistory: () => {
    set({ callHistoryOpen: true })
    return get().fetchCallHistory()
  },

  closeCallHistory: () => set({ callHistoryOpen: false }),

  fetchCallHistory: async ({ force = false } = {}) => {
    const { chatToken } = get()
    if (!chatToken) return []
    const now = Date.now()
    const cachedAt = get().callHistoryFetchedAt || 0
    if (!force && cachedAt && now - cachedAt < 30000) return get().callHistory
    set({ callHistoryLoading: true, callHistoryError: null })
    try {
      const res = await apiFetch('/chat/calls/history?limit=50', {
        headers: { Authorization: `Bearer ${chatToken}` }
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.message || 'Could not load call history')
      const calls = Array.isArray(json.data?.calls) ? json.data.calls : []
      set({ callHistory: calls, callHistoryFetchedAt: Date.now(), callHistoryLoading: false })
      return calls
    } catch (e) {
      console.warn('call history error:', e)
      set({ callHistoryLoading: false, callHistoryError: 'Could not load call history. Check your connection.' })
      return []
    }
  },

  endCall: async () => {
    const { activeCall, chatToken } = get()
    if (!activeCall) return
    const outgoing = String(activeCall.callerId) === String(get().chatUser?.id)
    get().finishCallWithSummary(outgoing ? 'cancelled' : 'declined')
    const roomId = activeCall.roomId
    // Tear the call down IMMEDIATELY: /call/end has taken 57-64s on a stalled
    // DB, and awaiting it kept the screen, mic and remote audio live for that
    // whole wait after the user had already hung up. cleanupCallResources()
    // also silences the ringtone/ringback and aborts the state poller.
    get().cleanupCallResources()
    if (!chatToken || !roomId) return
    // The peer still needs the row ended, so the request goes out
    // fire-and-forget with its own deadline; nothing in the UI waits for it.
    pendingEndCallRequest = apiFetch(`/chat/rooms/${roomId}/call/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${chatToken}` },
      timeoutMs: 10000
    }).catch((e) => console.warn('end call signal error:', e))
  },

  toggleMute: () => {
    const { callIsMuted, callLocalStream } = get()
    const next = !callIsMuted
    if (callLocalStream) {
      callLocalStream.getAudioTracks().forEach((t) => { t.enabled = !next })
    }
    set({ callIsMuted: next })
  },

  toggleSpeaker: () => {
    const next = !get().callIsSpeakerOn
    set({ callIsSpeakerOn: next })
    // Web cannot route output; the APK plugin switches speaker/earpiece.
    setNativeSpeaker(next)
  },

  // Chrome >= M100 emits `a=extmap-allow-mixed`, which Firefox's SDP parser
  // cannot read — it rejects the WHOLE remote description with
  // "Failed to parse SessionDescription ... Invalid SDP line". The line is
  // optional to interpret, so strip it before applying a remote description.
  // Firefox's parser also rejects SPACE-separated values inside `a=ssrc`
  // lines, so `a=ssrc:<id> msid:<stream> <track>` (Chrome's style) fails with
  // the same "Invalid SDP line" error. Track association is already covered
  // by the media-level `a=msid` line, so drop those redundant lines.
  // (Cross-browser calls: e.g. a Chrome caller -> Firefox callee.)
  sanitizeRemoteSdp: (sdp) => {
    if (typeof sdp !== 'string' || !sdp.trim()) return sdp
    const cleaned = sdp
      .replace(/a=extmap-allow-mixed\r\n/g, '')
      .replace(/a=extmap-allow-mixed\n/g, '')
      .replace(/a=ssrc:\d+ msid:[^\r\n]*(\r?\n|$)/g, '')
    // The stored SDP lost its final CRLF (the backend stripped it, and older
    // rows are still trimmed). Chrome rejects the WHOLE description when the
    // last line has no line terminator — "Failed to parse SessionDescription
    // ... Invalid SDP line" — so the caller could never apply the answer and
    // every call sat on "Connecting…". Re-terminate the last line.
    return /\n$/.test(cleaned) ? cleaned : cleaned + '\r\n'
  },

  // Apply the caller's remote answer exactly once (broadcast and poll both call
  // this). Candidates parked while the answer was missing are released here.
  applyCallAnswer: async (answerSdp) => {
    const pc = get().callPeerConnection
    if (!pc || !answerSdp || callAnswerApplied) return false
    callAnswerApplied = true
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: get().sanitizeRemoteSdp(answerSdp) })
    } catch (e) {
      callAnswerApplied = false
      console.warn('set remote answer error:', e)
      return false
    }
    for (const init of pendingCallCandidates.splice(0)) {
      try { await pc.addIceCandidate(init) } catch { /* stale candidate */ }
    }
    return true
  },

  // Apply ICE candidates from either path, skipping duplicates by value. Before
  // the remote answer is set they are parked instead of dropped.
  applyCallIceCandidates: async (list) => {
    if (!Array.isArray(list) || !list.length) return 0
    const pc = get().callPeerConnection
    if (!pc) return 0
    let applied = 0
    for (const raw of list) {
      const init = parseIceCandidate(raw)
      if (!init) continue
      if (!pc.remoteDescription) {
        const key = JSON.stringify(init)
        if (!pendingCallCandidates.some((c) => JSON.stringify(c) === key)) {
          pendingCallCandidates.push(init)
        }
        continue
      }
      const key = typeof raw === 'string' ? raw : JSON.stringify(init)
      if (appliedCallCandidates.has(key)) continue
      appliedCallCandidates.add(key)
      try {
        await pc.addIceCandidate(init)
        applied += 1
      } catch (e) {
        // Own or stale candidates are rejected harmlessly.
      }
    }
    return applied
  },

  // Create an RTCPeerConnection with ICE + track handling wired to the store.
  createCallPeerConnection: (onTrack, onIceCandidate, onStateChange, iceServers) => {
    const pc = new RTCPeerConnection({
      iceServers: Array.isArray(iceServers) && iceServers.length ? iceServers : get()._callStunServers
    })
    pc.onicecandidate = (ev) => {
      if (ev.candidate) onIceCandidate(ev.candidate)
    }
    pc.ontrack = (ev) => {
      // ev.streams[0] is the peer's MediaStream and ev.track the new track.
      // This used to destructure ev.streams into a variable named `track` and
      // wrap that MediaStream in `new MediaStream([stream])`, which throws —
      // so no remote track ever reached callRemoteStream and calls stayed
      // silent (and video calls never showed the peer).
      const remoteTrack = ev.track
      if (!remoteTrack) return
      let rs = get().callRemoteStream
      if (!rs) {
        rs = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream()
        set({ callRemoteStream: rs })
      }
      if (!rs.getTracks().some((t) => t.id === remoteTrack.id)) {
        rs.addTrack(remoteTrack)
      }
      if (typeof onTrack === 'function') onTrack(remoteTrack)
    }
    pc.onconnectionstatechange = () => onStateChange(pc.connectionState)
    return pc
  },

  // Initiate an outgoing voice/video call from the active room.
  initiateCall: async (roomId, callType = 'voice') => {
    const { chatToken, chatUser, activeRoomId } = get()
    if (!chatToken || !chatUser) return { success: false, error: 'Not signed in' }
    if (!roomId) roomId = activeRoomId
    if (!roomId) return { success: false, error: 'No room' }
    // One call at a time. Without this guard a second initiateCall replaced the
    // peer connection and local stream without cleaning the first one up,
    // leaving two live calls (and the old row active on the server). Tapping
    // call again in the same room is a no-op instead of a restart.
    const existingCall = get().activeCall
    if (existingCall) {
      if (sameId(existingCall.roomId, roomId)) return { success: true }
      return { success: false, error: 'You are already in a call' }
    }
    // Unlock the audio context inside this tap, otherwise the ringback and the
    // connect tone are blocked by the autoplay policy.
    unlockSounds()
    // Starting a call must also silence any ringtone still playing.
    stopAllCallSounds()
    // Generation for THIS attempt; cleanupCallResources() bumps it on cancel.
    const startGeneration = ++callStartGeneration

    const roomConversation = get().conversations.find((c) => sameId(c.id, roomId))
    const peerName = roomConversation?.contact_name || roomConversation?.other_user?.name || null
    const peerAvatar = roomConversation?.contact_avatar || roomConversation?.other_user?.profile_image || null

    // Show the call screen on the tap itself. The mic prompt, the ICE fetch and
    // the offer round-trips used to run first, so the button looked dead for
    // 2-3 seconds before anything appeared. cleanupCallResources() clears this
    // state on every failure path.
    set({
      activeCall: {
        roomId,
        callType,
        callerId: chatUser.id,
        calleeId: null,
        state: 'ringing',
        startedAt: Date.now(),
        peerName,
        peerAvatar,
        _connecting: true
      }
    })

    // Unlock the remote-audio sink inside this tap; the peer's track arrives
    // later, when a first play() would be rejected by the iOS autoplay policy.
    unlockRemoteAudio()

    // getUserMedia must run inside the tap's user activation on iOS, so start
    // the ICE fetch and then ask for the mic without awaiting the network call
    // first (the await used to consume the gesture before the prompt).
    const iceServersPromise = get().fetchCallIceServers()

    let localStream
    try {
      localStream = await acquireCallMedia(callType === 'video')
    } catch (e) {
      iceServersPromise.catch(() => {})
      console.warn('Microphone access denied:', e)
      // The ringing screen is shown optimistically before the permission
      // prompt, so a denied mic used to leave "Calling…" on screen forever —
      // and the call watcher skips polling while a call exists, so incoming
      // calls stopped ringing too. Tear the optimistic call down.
      get().cleanupCallResources()
      return { success: false, error: 'Microphone access denied' }
    }
    const iceServers = await iceServersPromise
    // The user may have tapped end while the permission prompt / ICE fetch was
    // still pending. Continuing used to set the call up again and POST an
    // offer, ringing the peer after the caller had already cancelled.
    if (startGeneration !== callStartGeneration) {
      localStream.getTracks().forEach((t) => { try { t.stop() } catch {} })
      return { success: false, error: 'Call cancelled' }
    }
    set({ callLocalStream: localStream, callIsMuted: false })
    startNativeCallAudio({ video: callType === 'video', speaker: get().callIsSpeakerOn })

    // ICE gathering starts as soon as setLocalDescription() runs, which is
    // BEFORE the offer row exists on the backend. Those early candidates used
    // to be POSTed into a 404 ("No active call") and were lost, so the callee
    // never learned how to reach the caller and the call never connected.
    // Buffer them and flush once the offer has been stored.
    const pendingIceCandidates = []
    let callReady = false
    const iceBatcher = createIceBatcher(roomId, () => get().chatToken || chatToken)
    const postIceCandidate = (candidatePayload) => {
      if (!candidatePayload) return
      if (!callReady) {
        pendingIceCandidates.push(candidatePayload)
        return
      }
      iceBatcher.add(candidatePayload)
    }

    const pc = get().createCallPeerConnection(
      (track) => {
        const rs = get().callRemoteStream
        if (!rs || !rs.getAudioTracks().length) {
          set({ callRemoteStream: new MediaStream([track]) })
        }
      },
      (candidate) => {
        const payload = serializeIceCandidate(candidate)
        if (!payload) return
        if (!callReady) {
          pendingIceCandidates.push(payload)
          return
        }
        postIceCandidate(payload)
      },
      (state) => {
        set({ callConnectionState: state })
        if (state === 'failed' || state === 'closed') get().cleanupCallResources()
      },
      iceServers
    )
    set({ callPeerConnection: pc })
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream))

    // Negotiation can throw (no usable codec, SDP rejected by the browser).
    // That failure happened outside every try, so it escaped with the call
    // screen still on "Calling…" and the mic live. Clean up like every other
    // start failure instead.
    let offerSdp
    try {
      const offer = await pc.createOffer()
      // Low-data voice profile: mono Opus with a hard bitrate ceiling.
      offerSdp = applyLowDataAudioSdp(offer.sdp)
      await pc.setLocalDescription({ type: offer.type, sdp: offerSdp })
      await applyCallAudioBitrate(pc)
    } catch (e) {
      get().cleanupCallResources()
      return { success: false, error: describeCallError(e, 'Could not start the call') }
    }

    // Let a just-tapped hangup land first: its row is still 'active' until the
    // request completes, and the server would reject this offer with 409.
    if (pendingEndCallRequest) {
      const ended = pendingEndCallRequest
      pendingEndCallRequest = null
      try {
        await Promise.race([ended, new Promise((r) => setTimeout(r, 3000))])
      } catch {}
    }

    if (startGeneration !== callStartGeneration) {
      try { pc.onconnectionstatechange = null; pc.close() } catch {}
      localStream.getTracks().forEach((t) => { try { t.stop() } catch {} })
      return { success: false, error: 'Call cancelled' }
    }

    const abort = new AbortController()
    set({ callAbortController: abort })
    try {
      const res = await apiFetch(`/chat/rooms/${roomId}/call/offer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${chatToken}`
        },
        body: JSON.stringify({ call_type: callType, offer_sdp: offerSdp }),
        signal: abort.signal
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        get().cleanupCallResources()
        return {
          success: false,
          error: isMissingCallRoute(res, json)
            ? CALL_ROUTES_MISSING_ERROR
            : (json.error || 'Call offer failed')
        }
      }
      // Cancelled while the offer was in flight: the row now exists, so remove
      // it — otherwise the peer keeps ringing and the room stays blocked. Skip
      // the end when a newer call already took over.
      if (startGeneration !== callStartGeneration) {
        if (!get().activeCall) {
          apiFetch(`/chat/rooms/${roomId}/call/end`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${chatToken}` }
          }).catch(() => {})
        }
        try { pc.onconnectionstatechange = null; pc.close() } catch {}
        localStream.getTracks().forEach((t) => { try { t.stop() } catch {} })
        return { success: false, error: 'Call cancelled' }
      }
      // The call row now exists: release the candidates gathered while the
      // offer request was in flight.
      callReady = true
      pendingIceCandidates.splice(0).forEach(iceBatcher.add)
      iceBatcher.flush()

      set({
        activeCall: {
          roomId,
          callId: json.data?.call_id || null,
          callType,
          callerId: chatUser.id,
          calleeId: null,
          state: 'ringing',
          startedAt: Date.now(),
          peerName,
          peerAvatar,
          _connecting: false
        }
      })
      // The timer starts when the call is actually answered (pollCallState), so
      // the displayed duration excludes the ringing period.
      get().pollCallState(roomId, true)
      return { success: true }
    } catch (e) {
      get().cleanupCallResources()
      return { success: false, error: describeCallError(e, 'Call failed') }
    }
  },

  // Answer an incoming call (callee side).
  answerCall: async () => {
    const { chatToken, chatUser, activeCall, activeRoomId } = get()
    if (!chatToken || !chatUser) return { success: false, error: 'Not signed in' }
    // The ringing call knows its own room; activeRoomId may be null or a
    // different conversation now that incoming calls are detected globally.
    const roomId = activeCall?.roomId || activeRoomId
    if (!roomId) return { success: false, error: 'No room' }
    const isVideo = activeCall?.callType === 'video'
    // Unlock playback from the answer tap so the remote audio is audible.
    unlockRemoteAudio()
    // Same gesture unlocks the ringtone/connect tones.
    unlockSounds()
    // Answering silences the incoming ringtone immediately.
    stopAllCallSounds()
    // Ask for the mic straight from the answer tap (iOS user activation), then
    // reuse the warm track from a previous call when there is one.
    const iceServersPromise = get().fetchCallIceServers()

    let localStream
    try {
      localStream = await acquireCallMedia(isVideo)
    } catch (e) {
      iceServersPromise.catch(() => {})
      return { success: false, error: isVideo ? 'Camera or microphone access denied' : 'Microphone access denied' }
    }
    const iceServers = await iceServersPromise
    // Respect a mute chosen while the call was still ringing: the mute button
    // is available in the incoming-call modal, and resetting it here turned
    // the microphone on the moment the user answered.
    const stayMuted = get().callIsMuted
    set({ callLocalStream: localStream, callIsMuted: stayMuted })
    if (stayMuted) {
      localStream.getAudioTracks().forEach((t) => { t.enabled = false })
    }
    startNativeCallAudio({ video: isVideo, speaker: get().callIsSpeakerOn })

    try {
      const answerIceBatcher = createIceBatcher(roomId, () => get().chatToken || chatToken)
      const pc = get().createCallPeerConnection(
        (track) => {
          const rs = get().callRemoteStream
          if (!rs || !rs.getAudioTracks().length) {
            set({ callRemoteStream: new MediaStream([track]) })
          }
        },
        (candidate) => {
          const payload = serializeIceCandidate(candidate)
          if (!payload) return
          answerIceBatcher.add(payload)
        },
        (state) => {
          set({ callConnectionState: state })
          if (state === 'failed' || state === 'closed') get().cleanupCallResources()
        },
        iceServers
      )
      set({ callPeerConnection: pc })
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream))

      // Prefer the offer captured by the call watcher; if it is missing (the
      // state update may have raced the accept click), fetch it from the
      // backend so the answer is never silently skipped.
      let offerSdp = activeCall?.offerSdp
      if (!offerSdp) {
        try {
          const res = await apiFetch(`/chat/rooms/${roomId}/call/state`, {
            headers: { Authorization: `Bearer ${chatToken}` }
          })
          const json = await res.json()
          offerSdp = json?.data?.offer_sdp || null
        } catch (e) {
          console.warn('fetch call offer fallback error:', e)
        }
      }
      if (!offerSdp) {
        get().cleanupCallResources()
        return { success: false, error: 'Call offer not available' }
      }

      await pc.setRemoteDescription({ type: 'offer', sdp: get().sanitizeRemoteSdp(offerSdp) })
      const answer = await pc.createAnswer()
      const answerSdp = applyLowDataAudioSdp(answer.sdp)
      await pc.setLocalDescription({ type: answer.type, sdp: answerSdp })
      await applyCallAudioBitrate(pc)
      const res = await apiFetch(`/chat/rooms/${roomId}/call/answer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${chatToken}`
        },
        body: JSON.stringify({ answer_sdp: answerSdp })
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        get().cleanupCallResources()
        return {
          success: false,
          error: isMissingCallRoute(res, json)
            ? CALL_ROUTES_MISSING_ERROR
            : (json.error || 'Call answer failed')
        }
      }

      set({
        activeCall: {
          ...(activeCall || {}),
          roomId,
          state: 'active',
          calleeId: chatUser.id
        }
      })
      get().startCallTimer()
      get().pollCallState(roomId, false)
      return { success: true }
    } catch (e) {
      console.warn('answer call error:', e)
      get().cleanupCallResources()
      return { success: false, error: describeCallError(e, 'Call answer failed') }
    }
  },

  // Long-poll the call state so the callee learns of the offer and both peers
  // stay in sync (answer / end / ICE candidates). The remote answer and ICE
  // candidates are applied exactly ONCE each — the backend returns the full
  // history on every poll, and re-applying them spams RTCPeerConnection with
  // duplicate setRemoteDescription/addIceCandidate calls.
  pollCallState: async (roomId, isCaller) => {
    const { chatToken } = get()
    if (!chatToken) return
    const abort = new AbortController()
    set({ callAbortController: abort })
    const ringingSince = Date.now()

    while (!abort.signal.aborted) {
      try {
        const res = await apiFetch(`/chat/rooms/${roomId}/call/state`, {
          headers: { Authorization: `Bearer ${chatToken}` },
          signal: abort.signal
        })
        const json = await res.json()
        if (!res.ok || !json.success) break
        const call = json.data || {}
        const state = call.state || 'idle'

        // Only surface a fresh incoming call; after answering, the callee's
        // own activeCall (state 'active') must never be reset back to ringing.
        if (state === 'ringing' && !isCaller && !get().activeCall) {
          set({
            activeCall: {
              roomId,
              callId: call.call_id,
              callType: call.call_type || 'voice',
              callerId: call.caller_id,
              calleeId: call.callee_id || null,
              state: 'ringing',
              offerSdp: call.offer_sdp || null,
              startedAt: call.started_at ? new Date(call.started_at).getTime() : Date.now()
            }
          })
        } else if (state === 'ringing' && isCaller) {
          // No-answer guard: never ring forever, otherwise the stale 'ringing'
          // row keeps blocking new offers ("A call is already in progress").
          if (Date.now() - ringingSince > CALL_RING_TIMEOUT_MS) {
            toast('No answer')
            await get().endCall()
            break
          }
        } else if (state === 'active') {
          // The poll can outlive a call that was already cleared (cleanup
          // raced this response). Spreading a null activeCall would build a
          // roomless call: a "Call" screen whose end button posts to
          // /rooms/undefined. Nothing to update — stop the loop.
          if (!get().activeCall) break
          set((s) => ({
            activeCall: { ...s.activeCall, state: 'active', calleeId: call.callee_id || s.activeCall?.calleeId }
          }))
          // Start the duration at answer time, not at offer time.
          get().startCallTimer()
          // Only the CALLER applies the remote answer: the callee already set
          // this SDP as its LOCAL description when it answered. The backend
          // broadcasts the answer too, so this is only the fallback path.
          if (call.answer_sdp && isCaller) {
            await get().applyCallAnswer(call.answer_sdp)
          }
          // Candidates arrive by broadcast AND in this poll; the helper dedupes.
          await get().applyCallIceCandidates(call.candidates)
        } else if (state === 'ended' || state === 'idle') {
          // The row is closed: show the summary (completed / no answer / missed)
          // before the call screen disappears.
          const current = get().activeCall
          const outgoing = String(current?.callerId) === String(get().chatUser?.id)
          get().finishCallWithSummary(outgoing ? 'no_answer' : 'missed')
          get().cleanupCallResources()
          break
        }

        await new Promise((r) => setTimeout(r, CALL_STATE_POLL_MS))
      } catch (e) {
        if (e.name === 'AbortError') break
        console.warn('poll call state error:', e)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  },

  stopPollCallState: () => {
    const { callAbortController } = get()
    if (callAbortController) {
      try { callAbortController.abort() } catch {}
      set({ callAbortController: null })
    }
  },

  // Native full-screen call screen / notification action lands here through
  // jdlxchat://call/<id>?action=answer|decline. The app may have been killed,
  // so fetch the ringing offer fresh instead of relying on in-memory state.
  handleCallDeepLink: async (callId, action = 'answer') => {
    const token = get().chatToken
    if (!token) return { success: false, error: 'Not signed in' }

    const actionKey = `${callId || 'latest'}:${action}`
    if (get().callDeepLinkHandled === actionKey) return { success: true }
    if (get().activeCall?.state === 'active' || get().activeCall?.state === 'connecting') {
      return { success: true }
    }
    set({ callDeepLinkHandled: actionKey })

    try {
      const res = await apiFetch('/chat/calls/incoming', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      const call = json?.data
      if (!res.ok || !json.success || call?.state !== 'ringing') {
        set({ callDeepLinkHandled: null })
        return { success: false, error: 'This call is no longer ringing.' }
      }
      if (callId && String(call.call_id) !== String(callId)) {
        set({ callDeepLinkHandled: null })
        return { success: false, error: 'This call is no longer available.' }
      }

      set({
        activeCall: {
          roomId: call.room_id,
          callId: call.call_id,
          callType: call.call_type || 'voice',
          callerId: call.caller_id,
          calleeId: call.callee_id || get().chatUser?.id || null,
          state: 'ringing',
          offerSdp: call.offer_sdp || null,
          startedAt: call.started_at ? new Date(call.started_at).getTime() : Date.now(),
          peerName: call.caller_name || call.caller_username || 'Incoming call',
          peerAvatar: call.caller_avatar || null
        }
      })

      if (action === 'decline') {
        try {
          await apiFetch(`/chat/rooms/${call.room_id}/call/end`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          })
        } catch (e) {
          console.warn('decline call deep link error:', e)
        }
        get().cleanupCallResources()
        return { success: true }
      }

      // Call notification tapped (PWA / native): only surface the ringing
      // modal. Answering needs a user gesture for the mic/camera permission.
      if (action === 'ring' || action === 'open') {
        return { success: true }
      }

      const result = await get().answerCall()
      if (!result?.success) set({ callDeepLinkHandled: null })
      return result
    } catch (e) {
      console.warn('call deep link error:', e)
      set({ callDeepLinkHandled: null })
      return { success: false, error: 'Could not open the call.' }
    }
  },

  // Passive watcher for the OPEN room: lets the callee learn about an incoming
  // call without being the one who started polling (the caller's poller only
  // exists after initiateCall runs). Cheap GET poll — the endpoint has no rate
  // limit — and it pauses itself automatically while a call is in progress,
  // resuming (and watching for the NEXT call) once that call ends.
  startCallWatcher: async () => {
    const prev = get().callWatchAbortController
    if (prev) {
      try { prev.abort() } catch {}
    }
    if (get().activeCall) return
    const abort = new AbortController()
    set({ callWatchAbortController: abort })

    // Consecutive failed polls, used to back off instead of hammering a sick
    // backend. Reset on the first good response.
    let watchFailures = 0

    while (!abort.signal.aborted) {
      const currentCall = get().activeCall
      // Skip polling only while an outgoing ring or an active call is running
      // (their own poller is in charge). A ringing INCOMING call keeps polling
      // so a caller hang-up dismisses the modal instead of ringing for 45s.
      const isIncomingRing = currentCall
        && currentCall.state === 'ringing'
        && currentCall.callerId !== get().chatUser?.id
      if (currentCall && !isIncomingRing) {
        await waitForCallWatcherTick(1000)
        continue
      }
      if (!get().chatToken) break
      // Do not hammer the backend while the tab/app is in the background.
      if (typeof document !== 'undefined' && document.hidden) {
        await new Promise((r) => setTimeout(r, CALL_WATCH_HIDDEN_MS))
        continue
      }
      try {
        // Global lookup: a ringing call from ANY chat must surface, not just
        // one whose conversation happens to be open.
        const res = await apiFetch('/chat/calls/incoming', {
          headers: { Authorization: `Bearer ${get().chatToken}` },
          signal: abort.signal,
          // A stalled poll (production saw 62s) used to hang the watcher for
          // good: no poll, no ring, no recovery until reload. Give it a
          // deadline so the loop can retry; the caller's abort still stops it.
          timeoutMs: 10000
        })
        // Auth is the ONLY fatal answer: a dead/expired token cannot be fixed
        // by polling again. Everything else (500, 502, 429, a proxy error page
        // that is not even JSON) is transient — breaking on it used to kill
        // incoming calls for the rest of the session after one bad response.
        if (res.status === 401 || res.status === 403) break
        const json = await res.json().catch(() => null)
        if (!res.ok || !json || !json.success) {
          watchFailures += 1
          const backoff = Math.min(CALL_WATCH_IDLE_MS * 2 ** watchFailures, 30000)
          console.warn('call watcher transient failure:', res.status, 'retrying in', backoff)
          await waitForCallWatcherTick(backoff)
          continue
        }
        watchFailures = 0
        const call = json.data || {}
        if (
          call.state === 'ringing'
          && call.caller_id !== get().chatUser?.id
          && !get().activeCall
        ) {
          set({
            activeCall: {
              roomId: call.room_id,
              callId: call.call_id,
              callType: call.call_type || 'voice',
              callerId: call.caller_id,
              calleeId: call.callee_id || get().chatUser?.id || null,
              state: 'ringing',
              offerSdp: call.offer_sdp || null,
              startedAt: call.started_at ? new Date(call.started_at).getTime() : Date.now(),
              peerName: call.caller_name || call.caller_username || 'Incoming call',
              peerAvatar: call.caller_avatar || null
            }
          })
        } else if (
          get().activeCall?.state === 'ringing'
          && get().activeCall?.callerId !== get().chatUser?.id
          && call.state !== 'ringing'
        ) {
          // The caller hung up (or the offer expired) before we answered.
          get().finishCallWithSummary('missed')
          get().cleanupCallResources()
        }
        await waitForCallWatcherTick(CALL_WATCH_IDLE_MS)
      } catch (e) {
        // Only OUR abort stops the watcher. A timeout abort also surfaces as
        // AbortError, and breaking on it would end incoming calls for the rest
        // of the session after one slow poll.
        if (abort.signal.aborted) break
        console.warn('call watcher error:', e)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    if (get().callWatchAbortController === abort) set({ callWatchAbortController: null })
  },

  stopCallWatcher: () => {
    const { callWatchAbortController } = get()
    if (callWatchAbortController) {
      try { callWatchAbortController.abort() } catch {}
      set({ callWatchAbortController: null })
    }
  },

  // Clears ONLY the conversation the user is actually looking at. There is no
  // legacy /chat/clear fallback any more: that endpoint could resolve a DM
  // room from user_id and delete the history for both participants.
  clearChatHistory: async (targetRoomId) => {
    const token = get().chatToken
    // Resolve the room once: explicit id from the caller, or the conversation
    // currently open (the profile-drawer "Clear Messages" button calls this
    // without an id). Room scope mirrors the backend endpoint:
    // POST /chat/rooms/<room_id>/clear.
    const roomId = targetRoomId || get().activeRoomId
    if (!roomId) return false
    try {
      const res = await apiFetch(`/chat/rooms/${roomId}/clear`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) return false

      if (sameId(get().activeRoomId, roomId)) {
        set({ messages: [], messagesHasMore: false })
      }
      const uid = get().chatUser?.id
      if (uid && roomId) setCachedMessages(uid, roomId, [])
      set((state) => ({
        conversations: state.conversations.map((c) =>
          sameId(c.id, roomId)
            ? { ...c, last_message: '', last_message_user_id: null, last_message_type: 'text', last_message_is_read: false }
            : c
        ),
        activeConversation: state.activeConversation && sameId(state.activeConversation.id, roomId)
          ? { ...state.activeConversation, last_message: '', last_message_user_id: null, last_message_type: 'text', last_message_is_read: false }
          : state.activeConversation
      }))
      get().fetchConversations()
      get().fetchNotifications()
      get().fetchUnreadCount()
      return true
    } catch (e) {
      console.warn('Clear chat error:', e)
      return false
    }
  }
}))

// Transport-level session sync: apiFetch auto-refreshes an expired access token
// (rotating the refresh token) and signals a hard logout when refresh fails, so
// the in-memory session never goes stale and the UI never freezes silently.
if (typeof window !== 'undefined') {
  window.addEventListener('jdlx:chat-token-refreshed', (event) => {
    const data = event.detail || {}
    if (!data.chat_token) return
    useChatStore.setState((state) => ({
      chatToken: data.chat_token,
      chatRefreshToken: data.refresh_token || state.chatRefreshToken,
      chatUser: data.user || state.chatUser
    }))
  })

  window.addEventListener('jdlx:chat-session-expired', () => {
    useChatStore.getState().chatLogout()
  })
}
