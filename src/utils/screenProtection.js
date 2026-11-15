import { registerPlugin, Capacitor } from '@capacitor/core'
import { useEffect } from 'react'
import toast from 'react-hot-toast'

// Native Capacitor plugin reference for hardware FLAG_SECURE
let ScreenProtectionNative = null
try {
  ScreenProtectionNative = registerPlugin('ScreenProtection')
} catch (e) {
  // Fallback gracefully on Web / browser
}

const STORAGE_KEY = 'jdlx_chat_screen_security'

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
 * Sets Screenshot Protection preference and synchronizes active protection.
 */
export function setScreenSecurityEnabled(enabled) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, String(Boolean(enabled)))
  } catch {}
  syncProtection()
  window.dispatchEvent(new CustomEvent('jdlx_screen_security_changed', { detail: { enabled: Boolean(enabled) } }))
}

// Active protection registry (tracks components requiring protection: 'chat', 'profile', 'contact_profile', 'avatar_lightbox')
const activeReasons = new Set()

let isNativeProtectionActive = false
let isWebListenersAttached = false

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
  if (now - lastToastTime < 3000) return
  lastToastTime = now
  toast('🔒 Screenshot Protected: Screen capture is restricted to protect privacy.', {
    id: 'screenshot-blocked-toast',
    icon: '🛡️',
    duration: 3500,
    style: {
      background: '#18181b',
      color: '#facc15',
      border: '1px solid rgba(250, 204, 21, 0.4)',
      fontWeight: '600',
      fontSize: '12px',
    }
  })
}

function handleKeyDown(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return

  // PrintScreen key
  const isPrintScreen = e.key === 'PrintScreen' || e.code === 'PrintScreen' || e.keyCode === 44
  // Snipping tool / OS screenshot shortcuts
  const isCaptureShortcut =
    ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's' || e.key === '3' || e.key === '4'))

  if (isPrintScreen || isCaptureShortcut) {
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch {}

    // Overwrite clipboard if OS tried to copy the screen contents
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText('🔒 JDLX Chat: Screenshots of protected chats and profiles are restricted.')
      }
    } catch {}

    notifyScreenshotBlocked()

    // Temporary black flash suppression to defeat screen grabbers
    document.documentElement.classList.add('jdlx-capture-suppressed')
    setTimeout(() => {
      document.documentElement.classList.remove('jdlx-capture-suppressed')
    }, 700)
  }
}

function handleKeyUp(e) {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return
  if (e.key === 'PrintScreen' || e.code === 'PrintScreen' || e.keyCode === 44) {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText('🔒 JDLX Chat: Screenshots of protected chats and profiles are restricted.')
      }
    } catch {}
    notifyScreenshotBlocked()
  }
}

function handleWindowBlur() {
  if (!isScreenSecurityEnabled() || activeReasons.size === 0) return
  document.documentElement.classList.add('jdlx-window-blurred')
}

function handleWindowFocus() {
  document.documentElement.classList.remove('jdlx-window-blurred')
}

function attachWebListeners() {
  if (typeof window === 'undefined' || isWebListenersAttached) return
  isWebListenersAttached = true
  window.addEventListener('keydown', handleKeyDown, true)
  window.addEventListener('keyup', handleKeyUp, true)
  window.addEventListener('blur', handleWindowBlur)
  window.addEventListener('focus', handleWindowFocus)
}

function detachWebListeners() {
  if (typeof window === 'undefined' || !isWebListenersAttached) return
  isWebListenersAttached = false
  window.removeEventListener('keydown', handleKeyDown, true)
  window.removeEventListener('keyup', handleKeyUp, true)
  window.removeEventListener('blur', handleWindowBlur)
  window.removeEventListener('focus', handleWindowFocus)
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
  }
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
