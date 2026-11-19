// Official Chat — API configuration.
// The chat frontend is deployed on its OWN origin (e.g. chat.jdlxmobile.in).
// The backend lives on Railway; chat identity (chat_users) and chat data are
// fully separate from the JDLX storefront. Chat has NO links back to the store.
const DEFAULT_PROD_BACKEND_URL = 'https://jdlx-chat-production.up.railway.app/api'
const DEFAULT_PROD_BACKEND_ORIGIN = 'https://jdlx-chat-production.up.railway.app'

const CONFIGURED_CHAT_API_URL = (
  import.meta.env.VITE_CHAT_API_BASE_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  ''
).trim().replace(/\/+$/, '')

export function isCapacitorNative() {
  return typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.())
}

// The standalone chat service (jdlx-chat-production.up.railway.app) is the
// default backend.
// VITE_CHAT_API_BASE_URL in .env overrides it for dev or custom deployments.
export const API_BASE_URL = (
  CONFIGURED_CHAT_API_URL || DEFAULT_PROD_BACKEND_URL
).replace(/\/+$/, '')

const PROD_BACKEND_URL = API_BASE_URL
const PROD_BACKEND_ORIGIN = (() => {
  try {
    return new URL(API_BASE_URL).origin
  } catch {
    return DEFAULT_PROD_BACKEND_ORIGIN
  }
})()

// Bare backend origin (for /static media etc.)
function getBackendOrigin() {
  if (API_BASE_URL.startsWith('http')) {
    try {
      return new URL(API_BASE_URL).origin
    } catch {
      return PROD_BACKEND_ORIGIN
    }
  }
  return PROD_BACKEND_ORIGIN
}

export const BACKEND_ORIGIN = getBackendOrigin()

export const SUPABASE_URL = (
  import.meta.env.VITE_SUPABASE_URL ||
  'https://fpsvgonupwevbnhbiqoh.supabase.co'
).trim().replace(/\/+$/, '')

export const SUPABASE_ANON_KEY = (
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'sb_publishable_3WwQgzqA7iTFcu4sry90LQ_xYc43CqG'
).trim()

// Private Supabase Realtime channels: messages are published only to
// per-user/participant-scoped topics instead of public ones. Requires the
// backend to hold SUPABASE_JWT_SECRET (the project signing key) so it can
// mint per-user Realtime JWTs and publish privately. Enabled by default now
// that production is configured — when the token endpoint is unavailable or
// rejects, the store automatically falls back to public channels after two
// failed joins, so unconfigured deployments keep working.
export const SUPABASE_PRIVATE_CHANNELS = (
  String(import.meta.env.VITE_SUPABASE_PRIVATE_CHANNELS || 'true').toLowerCase() !== 'false'
)

export function isUsingProdBackend() {
  return API_BASE_URL === PROD_BACKEND_URL
}

/**
 * Resolve a stored media path ("/static/uploads/x.png") to an absolute URL.
 * Absolute http(s) URLs pass through untouched.
 */
export function resolveMediaUrl(value) {
  if (!value || typeof value !== 'string') return ''
  if (/^(https?|blob|data):/i.test(value)) return value
  const base = value.startsWith('/') ? '' : '/'
  return `${BACKEND_ORIGIN}${base}${value}`
}

/**
 * Cloud-image retry proxy: retries a failed cloud-hosted image once through
 * the backend's DB-backed media backup.
 */
export function mediaProxyUrl(value) {
  if (!value || typeof value !== 'string') return ''
  if (!/^https?:\/\//i.test(value)) return ''
  const base = value.split('?')[0].split('/').filter(Boolean).pop() || ''
  if (!base || !base.includes('.')) return ''
  return `${API_BASE_URL}/media-proxy/${base}`
}
