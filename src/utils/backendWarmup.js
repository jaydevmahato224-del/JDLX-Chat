import { API_BASE_URL } from '../config'

// Free hosts (Render and friends) sleep a service after ~15 minutes without
// traffic, and the first request afterwards pays a 30-60s cold start. For call
// signaling that is fatal: the caller sits on "Calling…" and cancels before the
// offer is ever stored. A cheap health ping on app start (and after the tab has
// been idle for a while) means the backend is already awake when the user taps
// Call. Calls themselves are peer-to-peer, so this is only about signaling.

const WARMUP_TIMEOUT_MS = 60000
const WARMUP_REFRESH_MS = 10 * 60 * 1000

let lastWarmUpAt = 0
let inFlight = null

export function warmUpBackend() {
  if (typeof window === 'undefined') return Promise.resolve(false)
  if (!/^https?:/i.test(API_BASE_URL)) return Promise.resolve(false)
  if (inFlight) return inFlight
  if (lastWarmUpAt && Date.now() - lastWarmUpAt < WARMUP_REFRESH_MS) {
    return Promise.resolve(true)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS)
  inFlight = fetch(`${API_BASE_URL}/health`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    signal: controller.signal
  })
    .then((res) => {
      if (res.ok) lastWarmUpAt = Date.now()
      return res.ok
    })
    .catch(() => false)
    .finally(() => {
      clearTimeout(timer)
      inFlight = null
    })
  return inFlight
}

// Sleep only bites after a long idle period, so a tab that comes back into
// view (or the network comes back) should wake the backend again.
export function installBackendWarmUp() {
  warmUpBackend()
  if (typeof document === 'undefined') return () => {}

  const wake = () => {
    if (document.visibilityState === 'visible') warmUpBackend()
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
  return () => {
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('online', wake)
  }
}
