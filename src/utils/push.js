// Web Push (VAPID) for the standalone JDLX Chat app.
//
// Chat identities are separate from the storefront, so subscriptions are posted
// to /api/chat/push/subscribe and stored per chat user. This keeps working
// while the app is closed because the push handler lives in public/sw.js.
import { apiFetch } from './apiFetch'

let cachedPublicKey = null

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export function isChatPushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

export function getChatPushPermission() {
  if (!isChatPushSupported()) return 'unsupported'
  return Notification.permission
}

async function getVapidPublicKey() {
  if (cachedPublicKey !== null) return cachedPublicKey
  try {
    const res = await apiFetch('/chat/push/public-key')
    const json = await res.json()
    cachedPublicKey = json?.data?.enabled ? String(json.data.public_key || '') : ''
    return cachedPublicKey
  } catch {
    return ''
  }
}

/**
 * Request permission (optionally) and register this browser for chat pushes.
 * Returns { success, error } — never throws.
 */
export async function subscribeToChatPush({ requestPermission = true } = {}) {
  if (!isChatPushSupported()) {
    return { success: false, error: 'This browser does not support notifications.' }
  }

  try {
    let permission = Notification.permission
    if (permission === 'default') {
      if (!requestPermission) {
        return { success: false, error: 'Notification permission not granted yet.' }
      }
      permission = await Notification.requestPermission()
    }
    if (permission !== 'granted') {
      return { success: false, error: 'Notification permission was not granted.' }
    }

    const publicKey = await getVapidPublicKey()
    if (!publicKey) {
      return { success: false, error: 'Push notifications are not configured on the server yet.' }
    }

    const registration = await navigator.serviceWorker.register('/sw.js')
    const existing = await registration.pushManager.getSubscription()
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    })

    const res = await apiFetch('/chat/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...subscription.toJSON(),
        device_model: (navigator.userAgent || '').slice(0, 120)
      })
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json?.success) {
      return { success: false, error: json?.message || 'Could not save the push subscription.' }
    }
    return { success: true }
  } catch (err) {
    console.warn('Chat push subscribe error:', err)
    return { success: false, error: 'Could not enable notifications.' }
  }
}

/** Remove the backend row and the browser subscription. */
export async function unsubscribeFromChatPush() {
  if (!isChatPushSupported()) return { success: false, error: 'Not supported.' }
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    const subscription = await registration?.pushManager?.getSubscription()
    if (!subscription) return { success: true }

    await apiFetch('/chat/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    }).catch(() => {})
    await subscription.unsubscribe()
    return { success: true }
  } catch (err) {
    console.warn('Chat push unsubscribe error:', err)
    return { success: false, error: 'Could not disable notifications.' }
  }
}
