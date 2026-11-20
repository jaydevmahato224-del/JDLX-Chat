import { Capacitor, registerPlugin } from '@capacitor/core'

// Native counterpart: android/.../CallBridgePlugin.java. No-op on the web.
const CallBridge = registerPlugin('CallBridge')

const isNative = () => typeof window !== 'undefined' && Capacitor?.isNativePlatform?.() === true

/** Keep the native decline/answer path usable while the WebView is dead. */
export async function configureNativeCalls({ token, apiBaseUrl }) {
  if (!isNative() || !token) return
  try {
    await CallBridge.configure({ token, apiBaseUrl: apiBaseUrl || '' })
  } catch (e) {
    console.warn('native call bridge configure failed:', e)
  }
}

export async function clearNativeCalls() {
  if (!isNative()) return
  try {
    await CallBridge.clear()
  } catch (e) {
    console.warn('native call bridge clear failed:', e)
  }
}

export async function canUseNativeFullScreenIntent() {
  if (!isNative()) return false
  try {
    const result = await CallBridge.canUseFullScreenIntent()
    return result?.allowed === true
  } catch {
    return false
  }
}

export async function openNativeFullScreenIntentSettings() {
  if (!isNative()) return false
  try {
    await CallBridge.openFullScreenIntentSettings()
    return true
  } catch {
    return false
  }
}
