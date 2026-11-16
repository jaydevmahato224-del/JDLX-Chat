import { registerPlugin, Capacitor } from '@capacitor/core'
import { useState, useEffect } from 'react'

// Native Capacitor plugin reference for hardware FLAG_SECURE on Android
let ScreenProtectionNative = null
try {
  ScreenProtectionNative = registerPlugin('ScreenProtection')
} catch (e) {
  // Graceful fallback on Web / browser
}

const STORAGE_KEY = 'jdlx_chat_screen_security'
const STEALTH_STORAGE_KEY = 'jdlx_chat_stealth_mode'

/**
 * Returns whether Screenshot Protection / Screen Security is enabled in settings.
 * Defaults to true for maximum privacy and safety.
 */
export function isScreenSecurityEnabled() {
  if (typeof window === 'undefined') return true
  try {
    const val = localStorage.getItem(STORAGE_KEY)
    return val === null ? true : val === 'true'
  } catch {
    return true
  }
}

/**
 * Returns whether Stealth Mode (Anti-Screenshot Mask) is enabled.
 * When enabled on desktop, messages have a frosted veil that reveals on hover.
 */
export function isStealthModeEnabled() {
  if (typeof window === 'undefined') return false
  try {
    const val = localStorage.getItem(STEALTH_STORAGE_KEY)
    return val === 'true'
  } catch {
    return false
  }
}

/**
 * Sets Stealth Mode preference.
 */
export function setStealthModeEnabled(enabled) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STEALTH_STORAGE_KEY, String(Boolean(enabled)))
  } catch {}
  if (enabled) {
    document.documentElement.classList.add('jdlx-stealth-active')
  } else {
    document.documentElement.classList.remove('jdlx-stealth-active')
  }
  notifySubscribers()
  window.dispatchEvent(new CustomEvent('jdlx_stealth_mode_changed', { detail: { enabled: Boolean(enabled) } }))
}

export function toggleStealthMode() {
  const current = isStealthModeEnabled()
  setStealthModeEnabled(!current)
  return !current
}

/**
 * Sets Screenshot Protection preference and synchronizes active protection.
 */
export function setScreenSecurityEnabled(enabled) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, String(Boolean(enabled)))
  } catch {}
  syncProtection()
  notifySubscribers()
  window.dispatchEvent(new CustomEvent('jdlx_screen_security_changed', { detail: { enabled: Boolean(enabled) } }))
}

// Active protection registry (tracks components requiring protection: 'chat_app', 'chat', 'profile', 'contact_profile', 'avatar_lightbox')
const activeReasons = new Set(['chat_app'])

let isNativeProtectionActive = false
let isWebListenersAttached = false
let isCaptureTriggered = false
let isWindowBlurred = false
let isBlurPaused = false
let blurPauseTimer = null
let captureDismissTimer = null
let blankReleaseTimer = null
let blankHoldKind = null // 'blur' = held until focus returns, 'key' = held during region-select capture, null = auto-release
let keyHoldReleaseTimer = null
let nativeCaptureListenerAdded = false

/**
 * Native Android (APK): the ScreenProtectionPlugin fires 'screenCapture'
 * (Android 14+ ScreenCaptureCallback) the moment the user presses the system
 * screenshot gesture. FLAG_SECURE has already made the captured frame black.
 */
function attachNativeCaptureListener() {
  if (!ScreenProtectionNative || nativeCaptureListenerAdded) return
  try {
    nativeCaptureListenerAdded = true
    ScreenProtectionNative.addListener('screenCapture', () => {
      triggerCaptureProtection('android_system_capture')
    })
  } catch {}
}

// ── BLANK CAPTURE SHIELD ─────────────────────────────────────────────
// The core guarantee: when a capture signal is detected, the whole page is
// blanked SYNCHRONOUSLY (class on <html>) BEFORE the OS actually grabs the
// frame (PrintScreen copies on key-up, snipping tools capture while the
// window is unfocused, region captures happen during the drag). Every
// captured frame therefore shows a blank page carrying only the
// "Protected by JDLX Security System" notice.
const BLANK_OVERLAY_ID = 'jdlx-blank-overlay'

function ensureBlankOverlay() {
  if (typeof document === 'undefined' || !document.body) return
  if (document.getElementById(BLANK_OVERLAY_ID)) return
  const el = document.createElement('div')
  el.id = BLANK_OVERLAY_ID
  el.setAttribute('aria-hidden', 'true')
  const card = document.createElement('div')
  card.className = 'jdlx-blank-card'

  const icon = document.createElement('div')
  icon.className = 'jdlx-blank-icon'
  icon.textContent = '🛡️'

  const title = document.createElement('p')
  title.className = 'jdlx-blank-title'
  title.textContent = 'Protected by JDLX Security System'

  const sub = document.createElement('p')
  sub.className = 'jdlx-blank-sub'
  sub.textContent = 'Screenshots & screen capture are restricted on this page'

  card.appendChild(icon)
  card.appendChild(title)
  card.appendChild(sub)
  el.appendChild(card)
  document.body.appendChild(el)
}

function activateBlank(kind) {
  if (typeof document === 'undefined') return
  ensureBlankOverlay()
  document.documentElement.classList.add('jdlx-blank-capture')
  if (kind) blankHoldKind = kind
}

function clearKeyHoldRelease() {
  if (keyHoldReleaseTimer) {
    clearTimeout(keyHoldReleaseTimer)
    keyHoldReleaseTimer = null
  }
}

function releaseBlank() {
  blankHoldKind = null
  clearKeyHoldRelease()
  if (blankReleaseTimer) {
    clearTimeout(blankReleaseTimer)
    blankReleaseTimer = null
  }
  if (typeof document === 'undefined') return
  document.documentElement.classList.remove('jdlx-blank-capture')
}

function scheduleBlankRelease(delayMs = 1200) {
  if (blankHoldKind === 'blur') return
  if (blankReleaseTimer) clearTimeout(blankReleaseTimer)
  blankReleaseTimer = setTimeout(() => {
    blankReleaseTimer = null
    blankHoldKind = null
    document.documentElement.classList.remove('jdlx-blank-capture')
  }, delayMs)
}

// Reactive subscriber system for React hooks
const subscribers = new Set()
function notifySubscribers() {
  const state = getShieldState()
  subscribers.forEach((cb) => {
    try { cb(state) } catch {}
  })
}

export function getShieldState() {
  const enabled = isScreenSecurityEnabled()
  const stealthMode = isStealthModeEnabled()
  const isProtected = enabled && activeReasons.size > 0
  const showShield = isProtected && (isCaptureTriggered || (isWindowBlurred && !isBlurPaused))
  return {
    enabled,
    stealthMode,
    isProtected,
    showShield,
    isCaptureTriggered,
    isWindowBlurred,
    blankActive: typeof document !== 'undefined' && document.documentElement.classList.contains('jdlx-blank-capture'),
    activeReasons: Array.from(activeReasons)
  }
}

/**
 * Dismisses privacy shield overlay and blank capture overlay on user click or resume.
 */
export function dismissShield() {
  isCaptureTriggered = false
  isWindowBlurred = false
  if (captureDismissTimer) clearTimeout(captureDismissTimer)
  releaseBlank()
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('jdlx-window-blurred')
  }
  notifySubscribers()
}

/**
 * Pauses blur shield temporarily (e.g. when opening native OS file picker to upload avatar/media)
 */
export function pauseBlurShield(durationMs = 5000) {
  isBlurPaused = true
  releaseBlank()
  if (blurPauseTimer) clearTimeout(blurPauseTimer)
  blurPauseTimer = setTimeout(() => {
    isBlurPaused = false
  }, durationMs)
}

function updateNativeProtection(enable) {
  if (!Capacitor.isNativePlatform() || !ScreenProtectionNative) return
  try {
    if (enable && !isNativeProtectionActive) {
      isNativeProtectionActive = true
      ScreenProtectionNative.enable().catch(() => {})
    } else if (!enable && isNativeProtectionActive) {
      isNativeProtectionActive = false
      ScreenProtectionNative.disable().catch(() => {})
    }
  } catch {}
}

/**
 * Central capture response. Blanks FIRST (so the captured frame is blank with
 * "Protected by JDLX Security System" / "JDLX Privacy Shield Active").
 */
function triggerCaptureProtection(source = 'unknown', holdKind = null) {
  // 1) Blank page synchronously before OS grabs the frame
  activateBlank(holdKind || undefined)

  try { console.info('[JDLX Security] Screen capture blocked:', source) } catch {}

  // 2) Mark shield state for the React Privacy Shield page
  isCaptureTriggered = true
  notifySubscribers()

  // 3) Overwrite clipboard if OS or user shortcut copied the screen
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText('🔒 JDLX Chat: Screenshots and captures of protected chats and profiles are restricted for privacy.').catch(() => {})
    }
  } catch {}

  // 4) Release blank page when appropriate
  if (!holdKind) {
    scheduleBlankRelease(1200)
  } else {
    if (blankReleaseTimer) {
      clearTimeout(blankReleaseTimer)
      blankReleaseTimer = null
    }
    if (holdKind === 'key') {
      clearKeyHoldRelease()
      keyHoldReleaseTimer = setTimeout(() => {
        keyHoldReleaseTimer = null
        blankHoldKind = null
        document.documentElement.classList.remove('jdlx-blank-capture')
      }, 10000)
    } else {
      clearKeyHoldRelease()
    }
  }

  if (captureDismissTimer) clearTimeout(captureDismissTimer)
  captureDismissTimer = setTimeout(() => {
    isCaptureTriggered = false
    notifySubscribers()
  }, 4000)
}

function isPrintScreenEvent(e) {
  return (
    e.key === 'PrintScreen' ||
    e.key === 'Snapshot' ||
    e.key === 'F13' ||
    e.code === 'PrintScreen' ||
    e.keyCode === 44 ||
    e.which === 44
  )
}

function handleKeyDown(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return

  const isPrintScreen = isPrintScreenEvent(e)

  const isInstantCaptureShortcut =
    ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's' || e.key === '3')) ||
    (e.altKey && isPrintScreen) ||
    ((e.metaKey || e.ctrlKey) && isPrintScreen)

  const isRegionCaptureShortcut =
    (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '4' || e.key === '5')

  const isPrintShortcut = (e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')

  if (blankHoldKind === 'key' && !isPrintScreen && !isInstantCaptureShortcut && !isRegionCaptureShortcut && !isPrintShortcut) {
    releaseBlank()
  }

  if (isPrintScreen || isInstantCaptureShortcut || isRegionCaptureShortcut || isPrintShortcut) {
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch {}
    const source = isPrintScreen
      ? 'printscreen'
      : isPrintShortcut
        ? 'print'
        : isRegionCaptureShortcut
          ? 'region_capture'
          : 'capture_shortcut'
    triggerCaptureProtection(source, isRegionCaptureShortcut ? 'key' : null)
  }
}

function handleMouseUp() {
  if (blankHoldKind !== 'key' || isBlurPaused) return
  clearKeyHoldRelease()
  keyHoldReleaseTimer = setTimeout(() => {
    keyHoldReleaseTimer = null
    blankHoldKind = null
    document.documentElement.classList.remove('jdlx-blank-capture')
  }, 450)
}

function handleKeyUp(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return
  if (!isPrintScreenEvent(e)) return
  try {
    e.preventDefault()
    e.stopPropagation()
  } catch {}
  triggerCaptureProtection('printscreen')
}

function handleWindowBlur() {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0 || isBlurPaused) return
  isWindowBlurred = true
  document.documentElement.classList.add('jdlx-window-blurred')
  triggerCaptureProtection('window_blur', 'blur')
}

function handleWindowFocus() {
  isWindowBlurred = false
  isCaptureTriggered = false
  releaseBlank()
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('jdlx-window-blurred')
  }
  notifySubscribers()
}

function handleVisibilityChange() {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    if (!isScreenSecurityEnabled() || activeReasons.size === 0 || isBlurPaused) return
    isWindowBlurred = true
    document.documentElement.classList.add('jdlx-window-blurred')
    triggerCaptureProtection('visibility_hidden', 'blur')
  } else {
    handleWindowFocus()
  }
}

function attachWebListeners() {
  if (typeof window === 'undefined' || isWebListenersAttached) return
  isWebListenersAttached = true
  window.addEventListener('keydown', handleKeyDown, true)
  window.addEventListener('keyup', handleKeyUp, true)
  window.addEventListener('blur', handleWindowBlur)
  window.addEventListener('focus', handleWindowFocus)
  window.addEventListener('mouseup', handleMouseUp, true)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  ensureBlankOverlay()
}

function detachWebListeners() {
  if (typeof window === 'undefined' || !isWebListenersAttached) return
  isWebListenersAttached = false
  window.removeEventListener('keydown', handleKeyDown, true)
  window.removeEventListener('keyup', handleKeyUp, true)
  window.removeEventListener('blur', handleWindowBlur)
  window.removeEventListener('focus', handleWindowFocus)
  window.removeEventListener('mouseup', handleMouseUp, true)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('jdlx-window-blurred')
  }
  releaseBlank()
}

/**
 * Synchronize the current protection state across Native Android (FLAG_SECURE) and Web.
 */
export function syncProtection() {
  if (typeof window === 'undefined') return
  const enabled = isScreenSecurityEnabled()
  const shouldProtect = enabled && activeReasons.size > 0

  if (shouldProtect) {
    document.documentElement.classList.add('jdlx-screen-protected-window')
    updateNativeProtection(true)
    attachWebListeners()
    attachNativeCaptureListener()
  } else {
    document.documentElement.classList.remove('jdlx-screen-protected-window')
    document.documentElement.classList.remove('jdlx-window-blurred')
    releaseBlank()
    updateNativeProtection(false)
    detachWebListeners()
    isCaptureTriggered = false
    isWindowBlurred = false
  }

  notifySubscribers()
}

/**
 * Acquire screenshot protection for a given reason (e.g., 'chat', 'profile', 'avatar_lightbox').
 * Returns a cleanup function that releases the protection.
 */
export function protectScreen(reason) {
  if (!reason) return () => {}
  activeReasons.add(reason)
  syncProtection()
  return () => {
    unprotectScreen(reason)
  }
}

/**
 * Release screenshot protection for a given reason.
 */
export function unprotectScreen(reason) {
  if (!reason) return
  activeReasons.delete(reason)
  syncProtection()
}

/**
 * Returns a list of currently active reasons.
 */
export function getActiveProtectionReasons() {
  return Array.from(activeReasons)
}

/**
 * React hook to subscribe to the live screenshot shield state.
 */
export function useScreenProtectionState() {
  const [state, setState] = useState(() => getShieldState())

  useEffect(() => {
    const handler = (nextState) => setState({ ...nextState })
    subscribers.add(handler)
    handler(getShieldState())
    return () => {
      subscribers.delete(handler)
    }
  }, [])

  return state
}

/**
 * React hook to automatically acquire and release protection with component lifecycle.
 */
export function useScreenProtection(reason, isActive = true) {
  useEffect(() => {
    if (!isActive || !reason) return
    const cleanup = protectScreen(reason)
    return () => {
      cleanup()
    }
  }, [reason, isActive])
}

/**
 * Common event handlers to prevent context menu and dragging on protected media/avatars.
 */
export const protectedMediaProps = {
  onContextMenu: (e) => {
    e.preventDefault()
    e.stopPropagation()
    return false
  },
  onDragStart: (e) => {
    e.preventDefault()
    e.stopPropagation()
    return false
  },
  draggable: false,
}

// Auto-initialize protection on load if enabled
if (typeof window !== 'undefined') {
  syncProtection()
  if (isStealthModeEnabled()) {
    document.documentElement.classList.add('jdlx-stealth-active')
  }
}
