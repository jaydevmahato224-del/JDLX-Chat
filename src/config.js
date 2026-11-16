// Official Chat — API configuration.
// The chat frontend is deployed on its OWN origin (e.g. chat.jdlxmobile.in).
// The backend lives on Render; chat identity (chat_users) and chat data are
// fully separate from the JDLX storefront. Chat has NO links back to the store.
const DEFAULT_PROD_BACKEND_URL = 'https://jdlx-chat.onrender.com/api'
const DEFAULT_PROD_BACKEND_ORIGIN = 'https://jdlx-chat.onrender.com'

// The standalone chat service (jdlx-chat.onrender.com) is the default backend.
// VITE_CHAT_API_BASE_URL / VITE_API_BASE_URL still override it, so a build can
// be pointed at another host without a code change.
const CONFIGURED_CHAT_API_URL = (
  import.meta.env.VITE_CHAT_API_BASE_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  ''
).trim().replace(/\/+$/, '')

const PROD_BACKEND_URL = CONFIGURED_CHAT_API_URL || DEFAULT_PROD_BACKEND_URL
const PROD_BACKEND_ORIGIN = (() => {
  try {
    return new URL(PROD_BACKEND_URL).origin
  } catch {
    return DEFAULT_PROD_BACKEND_ORIGIN
  }
})()

// Capacitor Android app: the WebView origin is https://localhost, which is not
// a dev machine. Always talk to the deployed backend there.
export function isCapacitorNative() {
  return typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.())
}

function getDefaultApiBaseUrl() {
  if (typeof window === 'undefined') return PROD_BACKEND_URL
  if (isCapacitorNative()) return PROD_BACKEND_URL

  const hostname = window.location.hostname
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'

  // Local dev: chat dev server talks to the local Flask backend.
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//${hostname}:5001/api`
  }

  // Any hosted domain (Cloudflare pages.dev/workers.dev, vercel.app, jdlxmobile.in, custom domains) uses production backend
  return PROD_BACKEND_URL
}

// Safety net for local dev: when the page itself is a localhost dev page and
// the configured API URL is the production default (e.g. .env was reverted by
// a build script or git checkout), prefer the local backend so local testing
// never silently targets production.
function isLocalDevPage() {
  if (typeof window === 'undefined') return false
  const hostname = window.location.hostname
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

export const API_BASE_URL = (
  isLocalDevPage() && CONFIGURED_CHAT_API_URL === DEFAULT_PROD_BACKEND_URL
    ? getDefaultApiBaseUrl()
    : (CONFIGURED_CHAT_API_URL || getDefaultApiBaseUrl())
).replace(/\/+$/, '')

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

// Opt-in: requires SUPABASE_JWT_SECRET on the backend and the RLS policies in
// supabase/realtime_rls.sql. Off by default so existing deployments keep the
// public-channel fallback until the Supabase project is configured.
export const SUPABASE_PRIVATE_CHANNELS = (
  String(import.meta.env.VITE_SUPABASE_PRIVATE_CHANNELS || '').toLowerCase() === 'true'
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
