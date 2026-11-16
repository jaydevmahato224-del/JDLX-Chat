import { registerPlugin, Capacitor } from '@capacitor/core'
import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'

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
let focusWatchdogTimer = null
let lastCaptureEventAt = 0
let lastToastTime = 0

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

function scheduleBlankRelease(delayMs = 1100) {
  // A held ('blur') blank is only released by focus returning — never by a timer.
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

export function dismissShield() {
  isCaptureTriggered = false
  isWindowBlurred = false
  if (captureDismissTimer) clearTimeout(captureDismissTimer)
  notifySubscribers()
}

/**
 * Pauses blur shield temporarily (e.g. when opening native OS file picker to upload avatar/media)
 */
export function pauseBlurShield(durationMs = 5000) {
  isBlurPaused = true
  // Make sure a held blank shield never traps the user during file picking.
  releaseBlank()
  if (blurPauseTimer) clearTimeout(blurPauseTimer)
  blurPauseTimer = setTimeout(() => {
    isBlurPaused = false
  }, durationMs)
}

function updateNativeProtection(enable) {
  if (!Capacitor.isNativePlatform() || !ScreenProtectionNative) return
  if (enable && !isNativeProtectionActive) {
    isNativeProtectionActive = true
    ScreenProtectionNative.enable().catch(() => {})
  } else if (!enable && isNativeProtectionActive) {
    isNativeProtectionActive = false
    ScreenProtectionNative.disable().catch(() => {})
  }
}

function notifyScreenshotBlocked() {
  const now = Date.now()
  if (now - lastToastTime < 2500) return
  lastToastTime = now
  toast('🔒 Screenshot Blocked: Capture content is replaced with a blank protected page.', {
    id: 'screenshot-blocked-toast',
    icon: '🛡️',
    duration: 3500,
    style: {
      background: '#18181b',
      color: '#facc15',
      border: '1px solid rgba(250, 204, 21, 0.4)',
      fontWeight: '700',
      fontSize: '12.5px',
      boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(250, 204, 21, 0.2)',
    }
  })
}

/**
 * Notify the app UI (chat feed) that a screenshot / screen capture attempt
 * was detected, so a centered alert message can be shown in the feed.
 */
function emitCaptureAttempt(source) {
  const now = Date.now()
  if (now - lastCaptureEventAt < 1200) return
  lastCaptureEventAt = now
  try {
    window.dispatchEvent(new CustomEvent('jdlx_capture_attempt', { detail: { source, at: now } }))
  } catch {}
}

/**
 * Central capture response. Blank FIRST (so the captured frame is blank),
 * then surface the toast / shield / feed alert.
 *
 * holdKind:
 *   - undefined/null → auto-release the blank shortly after (instant captures)
 *   - 'blur'         → hold until focus/visibility returns (unfocused captures)
 *   - 'key'          → hold while a region-select drag capture is in progress
 */
function triggerCaptureProtection(source = 'unknown', holdKind = null) {
  // 1) Blank the page synchronously before the OS grabs the frame.
  activateBlank(holdKind || undefined)

  try { console.info('[JDLX Security] Capture attempt blocked:', source) } catch {}

  // 2) Mark shield state for the React overlay.
  isCaptureTriggered = true
  notifyScreenshotBlocked()
  notifySubscribers()

  // 3) In-feed centered alert for chat / profile capture attempts.
  emitCaptureAttempt(source)

  // 4) Overwrite clipboard if OS or user shortcut copied the screen.
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText('🔒 JDLX Chat: Screenshots and captures of protected chats and profiles are restricted for privacy.').catch(() => {})
    }
  } catch {}

  // 5) Release the blank page:
  //    - instant captures release automatically after the grab,
  //    - blur/tab-hold keeps it until focus returns,
  //    - key-hold keeps it through the whole region-select drag (with a cap).
  if (!holdKind) {
    scheduleBlankRelease(1100)
  } else {
    // A held blank must outlive any earlier auto-release timer.
    if (blankReleaseTimer) {
      clearTimeout(blankReleaseTimer)
      blankReleaseTimer = null
    }
    if (holdKind === 'key') {
      // Region-select drag: hold through the whole drag (capped), release on
      // mouseup / next non-capture keydown / watchdog restore.
      clearKeyHoldRelease()
      keyHoldReleaseTimer = setTimeout(() => {
        keyHoldReleaseTimer = null
        blankHoldKind = null
        document.documentElement.classList.remove('jdlx-blank-capture')
      }, 10000)
    } else {
      // 'blur' hold: cancel any pending key-hold cap; release happens on focus.
      clearKeyHoldRelease()
    }
  }

  if (captureDismissTimer) clearTimeout(captureDismissTimer)
  captureDismissTimer = setTimeout(() => {
    isCaptureTriggered = false
    notifySubscribers()
  }, 3500)
}

function isPrintScreenEvent(e) {
  return (
    e.key === 'PrintScreen' ||
    e.key === 'Snapshot' ||
    e.key === 'F13' || // external PC keyboards map PrintScreen to F13 on macOS
    e.code === 'PrintScreen' ||
    e.keyCode === 44 ||
    e.which === 44
  )
}

function handleKeyDown(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return

  // PrintScreen key variations across OSes (Windows, Linux, macOS)
  const isPrintScreen = isPrintScreenEvent(e)

  // Instant capture shortcuts (whole-screen / window grab):
  // Win+Shift+S / Cmd+Shift+S / Cmd+Shift+3 / Alt+PrintScreen / Ctrl+PrintScreen
  const isInstantCaptureShortcut =
    ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's' || e.key === '3')) ||
    (e.altKey && isPrintScreen) ||
    ((e.metaKey || e.ctrlKey) && isPrintScreen)

  // Region / panel capture shortcuts (capture happens during/after a mouse
  // drag, e.g. Cmd+Shift+4 on macOS or Cmd+Shift+5 snipping panel):
  const isRegionCaptureShortcut =
    (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '4' || e.key === '5')

  // Browser Print / Save to PDF
  const isPrintShortcut = (e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')

  // Any keydown that is clearly not part of a capture flow ends a held
  // region-capture blank (user is back to normal interaction).
  if (blankHoldKind === 'key' && !isPrintScreen && !isInstantCaptureShortcut && !isRegionCaptureShortcut && !isPrintShortcut) {
    releaseBlank()
  }

  // Inspect / DevTools shortcut
  const isDevToolsShortcut =
    e.key === 'F12' ||
    ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'C' || e.key === 'c' || e.key === 'J' || e.key === 'j'))

  if (isPrintScreen || isInstantCaptureShortcut || isRegionCaptureShortcut || isPrintShortcut) {
    // Blank synchronously NOW — OS grabs the frame on key-up / during the
    // drag, after our class is applied, so the captured image is a blank
    // protected page.
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
  } else if (isDevToolsShortcut) {
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch {}
    emitCaptureAttempt('devtools')
    notifyScreenshotBlocked()
    isCaptureTriggered = true
    notifySubscribers()
    if (captureDismissTimer) clearTimeout(captureDismissTimer)
    captureDismissTimer = setTimeout(() => {
      isCaptureTriggered = false
      notifySubscribers()
    }, 3500)
  }
}

// Region-select captures end with a mouse release (e.g. Cmd+Shift+4 drag).
// The OS swallows events during the drag, but any mouseup that does reach us
// signals the capture flow is over — release the held blank shortly after.
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
  // OS clipboard capture lands on key-up while the blank page is showing.
  triggerCaptureProtection('printscreen')
}

function handleWindowBlur() {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0 || isBlurPaused) return
  isWindowBlurred = true
  document.documentElement.classList.add('jdlx-window-blurred')
  // Snipping tools capture while this window is unfocused — hold the blank
  // page until focus returns so the captured frame is blank.
  triggerCaptureProtection('window_blur', 'blur')
}

function handleWindowFocus() {
  isWindowBlurred = false
  isCaptureTriggered = false
  releaseBlank()
  document.documentElement.classList.remove('jdlx-window-blurred')
  notifySubscribers()
}

function handleVisibilityChange() {
  if (document.hidden) {
    if (!isScreenSecurityEnabled() || activeReasons.size === 0 || isBlurPaused) return
    isWindowBlurred = true
    document.documentElement.classList.add('jdlx-window-blurred')
    triggerCaptureProtection('visibility_hidden', 'blur')
  } else {
    isWindowBlurred = false
    releaseBlank()
    document.documentElement.classList.remove('jdlx-window-blurred')
    notifySubscribers()
  }
}

function handleMouseLeave(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0 || isBlurPaused) return
  // If mouse moves completely outside the viewport (e.g. to OS panel, external snipping tool, or secondary monitor)
  if (!e.relatedTarget && !e.toElement) {
    isWindowBlurred = true
    document.documentElement.classList.add('jdlx-window-blurred')
    // Lighter response than window blur: blank briefly + feed alert, without
    // holding the page hostage while the mouse is merely outside.
    activateBlank()
    emitCaptureAttempt('mouse_out')
    notifyScreenshotBlocked()
    notifySubscribers()
    scheduleBlankRelease(1800)
  }
}

function handleMouseEnter() {
  if (document.hasFocus() && !isCaptureTriggered) {
    // Never cancel a keyboard-triggered blank (PrintScreen may still be
    // waiting for its key-up capture); only restore plain mouse-out blanks.
    releaseBlank()
  }
  if (isWindowBlurred && document.hasFocus() && !isCaptureTriggered) {
    isWindowBlurred = false
    document.documentElement.classList.remove('jdlx-window-blurred')
    notifySubscribers()
  }
}

function handleCopy(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return
  try {
    e.preventDefault()
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', '🔒 JDLX Chat: Screenshots and copying protected chats are restricted for privacy.')
    }
  } catch {}
  notifyScreenshotBlocked()
}

function handleBeforePrint() {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return
  emitCaptureAttempt('print')
  notifyScreenshotBlocked()
}

// ── FOCUS WATCHDOG ──
// Some capture paths (screenshot panels, VM switchers, certain snipping
// tools) steal focus without a reliable `blur` event reaching the page. A
// light poll on document.hasFocus() guarantees the blank shield engages for
// ANY unfocused state while protection is active, and restores on focus.
function runFocusWatchdog() {
  if (!isWebListenersAttached || isBlurPaused) return
  if (typeof document !== 'undefined' && !document.hasFocus()) {
    if (!isWindowBlurred || !document.documentElement.classList.contains('jdlx-blank-capture')) {
      handleWindowBlur()
    } else {
      // Re-assert the held blank every tick so nothing can release it while
      // the window is unfocused.
      activateBlank('blur')
    }
  } else if (isWindowBlurred && !isCaptureTriggered) {
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
  document.documentElement.addEventListener('mouseleave', handleMouseLeave)
  document.documentElement.addEventListener('mouseenter', handleMouseEnter)
  document.addEventListener('copy', handleCopy, true)
  window.addEventListener('beforeprint', handleBeforePrint)
  // Pre-create the blank shield overlay so the first capture attempt is instant.
  ensureBlankOverlay()
  if (!focusWatchdogTimer) {
    focusWatchdogTimer = setInterval(runFocusWatchdog, 250)
  }
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
  document.documentElement.removeEventListener('mouseleave', handleMouseLeave)
  document.documentElement.removeEventListener('mouseenter', handleMouseEnter)
  document.removeEventListener('copy', handleCopy, true)
  window.removeEventListener('beforeprint', handleBeforePrint)
  if (focusWatchdogTimer) {
    clearInterval(focusWatchdogTimer)
    focusWatchdogTimer = null
  }
  document.documentElement.classList.remove('jdlx-window-blurred')
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
    toast('🔒 Saving images or right-clicking is disabled for privacy.', {
      id: 'media-protect-toast',
      icon: '🛡️',
      duration: 2500,
      style: {
        background: '#18181b',
        color: '#facc15',
        border: '1px solid rgba(250, 204, 21, 0.4)',
        fontSize: '12px',
        fontWeight: '600'
      }
    })
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
