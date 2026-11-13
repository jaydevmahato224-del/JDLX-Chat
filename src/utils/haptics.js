/**
 * Lightweight, safe universal haptic feedback helper for mobile touch interactions
 * Uses navigator.vibrate when supported on mobile devices (Android Chrome, PWA, etc.)
 */
export function triggerHaptic(type = 'light') {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    switch (type) {
      case 'light':
        navigator.vibrate(12)
        break
      case 'medium':
        navigator.vibrate(22)
        break
      case 'heavy':
        // Crisp dual-pulse tactile feedback for Tap-and-Hold
        navigator.vibrate([25, 30, 45])
        break
      case 'double':
        navigator.vibrate([15, 35, 15])
        break
      case 'pop':
        navigator.vibrate([20, 25, 35])
        break
      case 'success':
        navigator.vibrate([12, 40, 20])
        break
      case 'error':
        navigator.vibrate([30, 45, 30])
        break
      default:
        navigator.vibrate(15)
    }
  } catch {}
}
