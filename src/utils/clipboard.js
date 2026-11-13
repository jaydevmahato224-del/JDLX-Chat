/**
 * Clipboard helper with a legacy fallback.
 *
 * `navigator.clipboard` only exists in secure contexts (https/localhost) and is
 * missing in older Android WebViews. Calling `navigator.clipboard.writeText`
 * directly used to throw an unhandled rejection and silently do nothing there,
 * while the UI still showed a "copied" toast. This resolves to `true` only when
 * the copy actually succeeded, so callers can show honest feedback.
 */

function legacyCopy(text) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  // Off-screen but still selectable; 16px avoids the iOS focus zoom.
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.padding = '0'
  textarea.style.border = 'none'
  textarea.style.outline = 'none'
  textarea.style.boxShadow = 'none'
  textarea.style.background = 'transparent'
  textarea.style.fontSize = '16px'

  const selection = typeof document.getSelection === 'function' ? document.getSelection() : null
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  document.body.appendChild(textarea)
  let copied = false
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    document.body.removeChild(textarea)
    if (previousRange && selection) {
      try {
        selection.removeAllRanges()
        selection.addRange(previousRange)
      } catch {
        /* ignore */
      }
    }
  }
  return copied
}

/**
 * Copy `value` to the clipboard.
 * @param {string} value
 * @returns {Promise<boolean>} true only when the text was actually copied.
 */
export async function copyTextToClipboard(value) {
  const text = value == null ? '' : String(value)
  if (!text) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied / insecure context / clipboard busy: use the fallback.
  }

  return legacyCopy(text)
}
