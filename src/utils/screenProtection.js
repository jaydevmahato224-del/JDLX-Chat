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
  return {
    enabled,
    stealthMode,
    isProtected,
    showShield: false,
    isCaptureTriggered: false,
    isWindowBlurred: false,
    blankActive: false,
    activeReasons: Array.from(activeReasons)
  }
}

export function dismissShield() {
  notifySubscribers()
}

/**
 * Safe no-op pauseBlurShield for file pickers / media uploads
 */
export function pauseBlurShield(_durationMs = 5000) {
  // Safe no-op to ensure media pickers continue without interruption
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
  } else {
    document.documentElement.classList.remove('jdlx-screen-protected-window')
    document.documentElement.classList.remove('jdlx-window-blurred')
    document.documentElement.classList.remove('jdlx-blank-capture')
    updateNativeProtection(false)
  }

  // Clean up any blank overlay or classes
  try {
    const el = document.getElementById('jdlx-blank-overlay')
    if (el) el.remove()
    document.documentElement.classList.remove('jdlx-blank-capture')
    document.documentElement.classList.remove('jdlx-window-blurred')
  } catch {}

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
