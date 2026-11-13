import { API_BASE_URL } from '../config'

/**
 * Chat-side fetch wrapper. ONLY-ever authenticates with the CHAT token
 * (jdlx_chat_token) — it never reads the storefront's userToken/'token'
 * localStorage keys, so the two apps can never borrow each other's session.
 *
 * It also owns session refresh: a 401 from a chat endpoint transparently
 * exchanges the 14-day refresh token for a new 1-hour access token and retries
 * the request once. When refresh fails, `jdlx:chat-session-expired` is fired so
 * the store can hard-log-out instead of silently freezing (the previous
 * behaviour: polling swallowed 401s and the inbox stopped updating).
 */
const TOKEN_KEY = 'jdlx_chat_token'
const REFRESH_KEY = 'jdlx_chat_refresh_token'
const USER_KEY = 'jdlx_chat_user'

const AUTH_PATHS = ['/chat/auth/login', '/chat/auth/register', '/chat/auth/refresh', '/chat/auth/logout']

function readStorage(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* storage blocked */
  }
}

// Every request gets a hard deadline unless the caller opts out. Without this
// a stalled mobile connection left cold loads spinning forever (the callers
// only clear their loading flags when the promise settles). Callers that
// already manage their own timeout (sendRoomMessage passes an AbortController)
// keep full control; `timeoutMs: 0` disables the default explicitly.
export const DEFAULT_API_TIMEOUT_MS = 20000
const TOKEN_REFRESH_TIMEOUT_MS = 15000

// Single-flight: concurrent 401s share ONE refresh call, otherwise a rotating
// refresh token would race against itself and log the user out.
let refreshInFlight = null

async function refreshChatToken() {
  if (refreshInFlight) return refreshInFlight

  const refreshToken = readStorage(REFRESH_KEY)
  if (!refreshToken) {
    return { token: null, isExplicitAuthFailure: false }
  }

  refreshInFlight = (async () => {
    // A hung refresh used to block the original 401 request indefinitely.
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS)
    try {
      const res = await fetch(`${API_BASE_URL}/chat/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: controller.signal
      })

      if (res.status === 401) {
        // Refresh token is genuinely invalid, revoked, or expired on the server
        return { token: null, isExplicitAuthFailure: true }
      }

      if (!res.ok) {
        // 5xx server error, deployment restart, or temporary issue: DO NOT log the user out
        return { token: null, isExplicitAuthFailure: false }
      }

      const json = await res.json()
      const data = json?.data || {}
      if (!data.chat_token) {
        return { token: null, isExplicitAuthFailure: false }
      }

      writeStorage(TOKEN_KEY, data.chat_token)
      if (data.refresh_token) writeStorage(REFRESH_KEY, data.refresh_token)
      if (data.user) writeStorage(USER_KEY, JSON.stringify(data.user))

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jdlx:chat-token-refreshed', { detail: data }))
      }
      return { token: data.chat_token, isExplicitAuthFailure: false }
    } catch (networkError) {
      // Offline, airplane mode, WiFi handoff, or connection timeout: DO NOT log the user out!
      console.warn('Chat token refresh connection error (session preserved):', networkError)
      return { token: null, isExplicitAuthFailure: false }
    } finally {
      clearTimeout(timeoutId)
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

// Shared by non-fetch transports (e.g. XHR media uploads) so they participate
// in the same single-flight refresh rotation instead of racing apiFetch.
export async function refreshChatAccessToken() {
  const result = await refreshChatToken()
  if (!result?.token && result?.isExplicitAuthFailure && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('jdlx:chat-session-expired'))
  }
  return result
}

export async function apiFetch(endpoint, options = {}) {
  const { _chatRetried, timeoutMs, ...fetchOptions } = options

  let url
  if (endpoint.startsWith('http')) {
    url = endpoint
  } else {
    const base = /\/api(\/|$)/.test(endpoint)
      ? API_BASE_URL.replace(/\/api\/?$/, '')
      : API_BASE_URL
    url = `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
  }

  const chatToken = readStorage(TOKEN_KEY)

  // Per-call timeout when supplied, otherwise a default deadline for requests
  // that do not bring their own cancellation signal. `timeoutMs: 0` disables.
  const explicitTimeout = typeof timeoutMs === 'number'
  const effectiveTimeoutMs = explicitTimeout
    ? timeoutMs
    : (fetchOptions.signal ? 0 : DEFAULT_API_TIMEOUT_MS)

  let timeoutController = null
  let timeoutId = null
  if (Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0) {
    timeoutController = new AbortController()
    timeoutId = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs)
  }
  const signals = [fetchOptions.signal, timeoutController?.signal].filter(Boolean)
  let combinedSignal = fetchOptions.signal
  if (signals.length === 1) {
    combinedSignal = signals[0]
  } else if (signals.length > 1 && typeof AbortSignal.any === 'function') {
    combinedSignal = AbortSignal.any(signals)
  }

  const extraHeaders =
    fetchOptions.headers instanceof Headers
      ? Object.fromEntries(fetchOptions.headers.entries())
      : fetchOptions.headers

  const isFormData = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData
  const defaultHeaders = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(chatToken && !extraHeaders?.Authorization ? { 'Authorization': `Bearer ${chatToken}` } : {}),
    ...(extraHeaders || {}),
  }

  const timeoutOptions = {}
  if (combinedSignal) timeoutOptions.signal = combinedSignal

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      ...timeoutOptions,
      headers: defaultHeaders,
      credentials: 'include',
    })

    const isAuthPath = AUTH_PATHS.some((path) => endpoint.includes(path))
    if (response.status === 401 && chatToken && !_chatRetried && !isAuthPath) {
      // 1. Concurrency shortcut: check if another concurrent request already refreshed the token in storage
      const currentStoredToken = readStorage(TOKEN_KEY)
      if (currentStoredToken && currentStoredToken !== chatToken) {
        return apiFetch(endpoint, {
          ...options,
          _chatRetried: true,
          headers: { ...(extraHeaders || {}), Authorization: `Bearer ${currentStoredToken}` },
        })
      }

      // 2. Perform safe single-flight token refresh
      const refreshResult = await refreshChatToken()
      if (refreshResult?.token) {
        return apiFetch(endpoint, {
          ...options,
          _chatRetried: true,
          headers: { ...(extraHeaders || {}), Authorization: `Bearer ${refreshResult.token}` },
        })
      }

      // 3. ONLY log the user out if the server explicitly rejected the refresh token as invalid/expired.
      // Transient network drops, timeouts, and server 5xx errors will NEVER log the user out!
      if (refreshResult?.isExplicitAuthFailure) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('jdlx:chat-session-expired'))
        }
      }
    }

    return response
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
