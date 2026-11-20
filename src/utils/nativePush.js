/**
 * Native (FCM) push for the packaged JDLX Chat Android app.
 *
 * The WebView has no Push API, so the web VAPID flow cannot run there. The app
 * registers with FCM through @capacitor/push-notifications and posts the device
 * token to /chat/push/device, scoped to the chat identity (never the storefront).
 * notifications/notification_service.py sends FCM messages with channel "chat".
 */
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import toast from 'react-hot-toast'
import { apiFetch } from './apiFetch'
import { isCapacitorNative } from '../config'

const TOKEN_KEY = 'jdlx_chat_device_push_token'
let started = false
let listeners = []
// Invalidates an in-flight init when the user logs out before registration ends.
let initGeneration = 0

async function clearNativePushListeners() {
  const current = listeners
  listeners = []
  await Promise.all(current.map(async (handle) => {
    try {
      await handle?.remove?.()
    } catch {
      /* listener already gone */
    }
  }))
}

function cacheToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable — the token is still reported this session */
  }
}

function readCachedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

async function reportToken(token) {
  if (!token) return false
  try {
    const res = await apiFetch('/chat/push/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        device_type: Capacitor.getPlatform(),
        device_model: (navigator.userAgent || '').slice(0, 120)
      }),
      timeoutMs: 15000
    })
    return res.ok
  } catch {
    return false
  }
}

/** Re-report a cached token after login/account switch. No-op on the web. */
export async function syncChatPushToken() {
  if (!isCapacitorNative()) return false
  return reportToken(readCachedToken())
}

/** Remove this device from the signed-out chat account's push targets. */
export async function disableChatNativePush() {
  if (!isCapacitorNative()) return false
  // Allow the next login to register with FCM again, and drop this session's
  // listeners so re-registration cannot create duplicate handlers.
  initGeneration += 1
  started = false
  await clearNativePushListeners()
  const token = readCachedToken()
  if (!token) return true
  try {
    const res = await apiFetch('/chat/push/device', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      timeoutMs: 15000
    })
    if (res.ok) {
      // A rapid re-login may have cached a fresh token while this DELETE was in
      // flight; only clear the token that belonged to the signed-out session.
      try {
        if (readCachedToken() === token) localStorage.removeItem(TOKEN_KEY)
      } catch {
        /* ignore */
      }
    }
    return res.ok
  } catch {
    return false
  }
}

/**
 * Explicit "Enable" action from settings.
 *
 * The web push/VAPID flow cannot work in the Android WebView, so the APK must
 * request the OS notification permission and register with FCM instead. This
 * is what the settings button calls on native; it never touches VAPID.
 */
export async function enableChatNativePush() {
  if (!isCapacitorNative()) {
    return { success: false, error: 'Device notifications are only available in the app.' }
  }
  try {
    let permission = (await PushNotifications.checkPermissions()).receive
    if (permission === 'prompt' || permission === 'prompt-with-rationale') {
      permission = (await PushNotifications.requestPermissions()).receive
    }
    if (permission !== 'granted') {
      return {
        success: false,
        error: 'Notification permission denied. Allow notifications for JDLX Chat in Android settings.'
      }
    }
    await initChatNativePush()
    return { success: true }
  } catch (err) {
    console.warn('[chat push] could not enable native notifications:', err)
    return { success: false, error: 'Could not enable device notifications.' }
  }
}

/** Ask for notification permission and register this device with FCM once. */
export async function initChatNativePush() {
  if (started || !isCapacitorNative()) return
  const generation = ++initGeneration
  started = true

  try {
    let permission = (await PushNotifications.checkPermissions()).receive
    if (permission === 'prompt' || permission === 'prompt-with-rationale') {
      permission = (await PushNotifications.requestPermissions()).receive
    }
    if (permission !== 'granted') {
      // Allow a later retry if the user grants permission in settings.
      if (generation === initGeneration) started = false
      return
    }
    if (generation !== initGeneration) return

    listeners = [
      await PushNotifications.addListener('registration', ({ value }) => {
        cacheToken(value)
        reportToken(value)
      }),
      await PushNotifications.addListener('registrationError', (err) => {
        console.warn('[chat push] FCM registration failed:', err)
      }),
      await PushNotifications.addListener('pushNotificationReceived', (notification) => {
        const title = notification?.title || 'JDLX Chat'
        const body = notification?.body || ''
        if (body) toast(`${title}: ${body}`, { duration: 5000 })
      }),
      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const url = action?.notification?.data?.url
        if (typeof url === 'string' && url) {
          window.dispatchEvent(new CustomEvent('jdlx:chat-push-nav', { detail: { url } }))
        }
      })
    ]

    if (generation !== initGeneration) {
      await clearNativePushListeners()
      return
    }

    if (Capacitor.getPlatform() === 'android') {
      try {
        await PushNotifications.createChannel({
          id: 'chat',
          name: 'Chat messages',
          description: 'New messages and friend requests',
          importance: 5, // IMPORTANCE_HIGH
          visibility: 1, // VISIBILITY_PUBLIC
          vibration: true
        })
      } catch (err) {
        console.warn('[chat push] could not create notification channel:', err)
      }
    }

    if (generation !== initGeneration) {
      await clearNativePushListeners()
      return
    }
    await PushNotifications.register()
  } catch (err) {
    if (generation === initGeneration) {
      started = false
      await clearNativePushListeners()
    }
    console.warn('[chat push] native push unavailable:', err)
  }
}
