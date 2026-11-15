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

let lastToastTime = 0
function notifyScreenshotBlocked() {
  const now = Date.now()
  if (now - lastToastTime < 2500) return
  lastToastTime = now
  toast('🔒 Screenshot Protected: Screen capture and copying are restricted.', {
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

function triggerCaptureProtection() {
  isCaptureTriggered = true
  notifyScreenshotBlocked()
  notifySubscribers()

  // Overwrite clipboard if OS or user shortcut copied the screen
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText('🔒 JDLX Chat: Screenshots and captures of protected chats and profiles are restricted for privacy.').catch(() => {})
    }
  } catch {}

  if (captureDismissTimer) clearTimeout(captureDismissTimer)
  captureDismissTimer = setTimeout(() => {
    isCaptureTriggered = false
    notifySubscribers()
  }, 3500)
}

function handleKeyDown(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return

  // PrintScreen key variations across OSes (Windows, Linux, macOS)
  const isPrintScreen = 
    e.key === 'PrintScreen' || 
    e.key === 'Snapshot' || 
    e.code === 'PrintScreen' || 
    e.keyCode === 44 || 
    e.which === 44

  // Snipping tool / OS screenshot shortcuts:
  // Win+Shift+S / Cmd+Shift+S / Cmd+Shift+3 / Cmd+Shift+4 / Cmd+Shift+5 / Ctrl+Shift+S / Alt+PrintScreen / Ctrl+PrintScreen
  const isCaptureShortcut =
    ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's' || e.key === '3' || e.key === '4' || e.key === '5')) ||
    (e.altKey && isPrintScreen) ||
    ((e.metaKey || e.ctrlKey) && isPrintScreen)

  // Browser Print / Save to PDF
  const isPrintShortcut = (e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')

  // Inspect / DevTools shortcut
  const isDevToolsShortcut = 
    e.key === 'F12' || 
    ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'C' || e.key === 'c' || e.key === 'J' || e.key === 'j'))

  if (isPrintScreen || isCaptureShortcut || isPrintShortcut || isDevToolsShortcut) {
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch {}
    triggerCaptureProtection()
  }
}

function handleKeyUp(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return
  const isPrintScreen = 
    e.key === 'PrintScreen' || 
    e.key === 'Snapshot' || 
    e.code === 'PrintScreen' || 
    e.keyCode === 44 || 
    e.which === 44

  if (isPrintScreen) {
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch {}
    triggerCaptureProtection()
  }
}

function handleWindowBlur() {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0 || isBlurPaused) return
  isWindowBlurred = true
  document.documentElement.classList.add('jdlx-window-blurred')
  notifySubscribers()
}

function handleWindowFocus() {
  isWindowBlurred = false
  isCaptureTriggered = false
  document.documentElement.classList.remove('jdlx-window-blurred')
  notifySubscribers()
}

function handleVisibilityChange() {
  if (document.hidden) {
    if (!isScreenSecurityEnabled() || activeReasons.size === 0 || isBlurPaused) return
    isWindowBlurred = true
    document.documentElement.classList.add('jdlx-window-blurred')
    notifySubscribers()
  } else {
    isWindowBlurred = false
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
    notifySubscribers()
  }
}

function handleMouseEnter() {
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

function attachWebListeners() {
  if (typeof window === 'undefined' || isWebListenersAttached) return
  isWebListenersAttached = true
  window.addEventListener('keydown', handleKeyDown, true)
  window.addEventListener('keyup', handleKeyUp, true)
  window.addEventListener('blur', handleWindowBlur)
  window.addEventListener('focus', handleWindowFocus)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  document.documentElement.addEventListener('mouseleave', handleMouseLeave)
  document.documentElement.addEventListener('mouseenter', handleMouseEnter)
  document.addEventListener('copy', handleCopy, true)
}

function detachWebListeners() {
  if (typeof window === 'undefined' || !isWebListenersAttached) return
  isWebListenersAttached = false
  window.removeEventListener('keydown', handleKeyDown, true)
  window.removeEventListener('keyup', handleKeyUp, true)
  window.removeEventListener('blur', handleWindowBlur)
  window.removeEventListener('focus', handleWindowFocus)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  document.documentElement.removeEventListener('mouseleave', handleMouseLeave)
  document.documentElement.removeEventListener('mouseenter', handleMouseEnter)
  document.removeEventListener('copy', handleCopy, true)
  document.documentElement.classList.remove('jdlx-window-blurred')
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
