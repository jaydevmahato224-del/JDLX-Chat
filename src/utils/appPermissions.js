import { Capacitor, registerPlugin } from '@capacitor/core'

// Native counterpart: android/.../AppPermissionsPlugin.java. No-op on Web.
const AppPermissions = registerPlugin('AppPermissions')

const isNative = () => typeof window !== 'undefined' && Capacitor?.isNativePlatform?.() === true

let startupPromise = null

const WEB_FALLBACK_STATUS = {
  contacts: 'unsupported',
  microphone: 'prompt',
  camera: 'prompt',
  notifications: 'prompt',
  fullScreenIntent: true
}

/**
 * Request all runtime Android permissions once on app open using a single shared
 * promise so other startup hooks (e.g. FCM registration) never fire a colliding
 * Android permission dialog on top of this one.
 */
export function ensureStartupPermissions({ force = false } = {}) {
  if (!isNative()) {
    return Promise.resolve({ ...WEB_FALLBACK_STATUS })
  }
  if (!force && startupPromise) {
    return startupPromise
  }

  const run = (async () => {
    try {
      const status = await AppPermissions.requestStartupPermissions({ force })
      return status || { ...WEB_FALLBACK_STATUS }
    } catch (err) {
      console.warn('[permissions] startup permission prompt failed:', err)
      return await getAppPermissionsStatus()
    }
  })()

  if (!force) {
    startupPromise = run
  }
  return run
}

/** Wait for the app-open permission dialog chain before firing follow-up native prompts. */
export async function waitForStartupPermissions() {
  if (!isNative()) return null
  try {
    return await ensureStartupPermissions()
  } catch {
    return null
  }
}

export async function getAppPermissionsStatus() {
  if (!isNative()) return { ...WEB_FALLBACK_STATUS }
  try {
    return (await AppPermissions.getStatus()) || { ...WEB_FALLBACK_STATUS }
  } catch (err) {
    console.warn('[permissions] status check failed:', err)
    return { ...WEB_FALLBACK_STATUS }
  }
}

export async function requestSingleAppPermission(alias) {
  if (!isNative()) return { ...WEB_FALLBACK_STATUS }
  try {
    return (await AppPermissions.requestPermission({ alias })) || (await getAppPermissionsStatus())
  } catch (err) {
    console.warn(`[permissions] request for ${alias} failed:`, err)
    return await getAppPermissionsStatus()
  }
}

export async function openNativeAppSettings() {
  if (!isNative()) return false
  try {
    await AppPermissions.openAppSettings()
    return true
  } catch (err) {
    console.warn('[permissions] open settings failed:', err)
    return false
  }
}
