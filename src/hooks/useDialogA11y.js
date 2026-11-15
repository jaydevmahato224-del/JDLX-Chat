import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Only the top-most dialog reacts to Escape/Tab. Without this, closing the
// in-app confirm sheet would also close the contact sheet underneath it.
const dialogStack = []
let nextDialogId = 0

/**
 * Keyboard accessibility for a modal sheet.
 *
 * - Moves focus into the dialog when it opens.
 * - Keeps Tab/Shift+Tab cycling inside it.
 * - Closes on Escape (top-most dialog only).
 * - Restores focus to the trigger when it closes.
 *
 * Attach the returned ref to the dialog panel (not the backdrop), give that
 * panel `role="dialog" aria-modal="true"` and `tabIndex={-1}`.
 */
export function useDialogA11y(open, onClose, initialFocusSelector = null) {
  const containerRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const initialFocusSelectorRef = useRef(initialFocusSelector)
  initialFocusSelectorRef.current = initialFocusSelector

  useEffect(() => {
    if (!open) return undefined
    const id = ++nextDialogId
    dialogStack.push(id)

    const container = containerRef.current
    const previouslyFocused = typeof document !== 'undefined' ? document.activeElement : null

    const getFocusable = () => {
      if (!container) return []
      return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((el) => el.getClientRects().length > 0)
    }

    const focusFirst = () => {
      const nodes = getFocusable()
      // Dialogs can name their intended entry point (a search or PIN field).
      // Otherwise the first control (usually the close button) takes focus, so
      // opening a profile sheet does not pop the mobile keyboard.
      const selector = initialFocusSelectorRef.current
      const preferred = selector
        ? Array.from(container?.querySelectorAll(selector) || []).find((el) => el.getClientRects().length > 0)
        : null
      const target = preferred || nodes[0] || container
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true })
      }
    }

    // Wait one frame so the sheet's entrance animation/mount has completed.
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(focusFirst)
      : setTimeout(focusFirst, 0)

    const handleKeyDown = (event) => {
      if (dialogStack[dialogStack.length - 1] !== id) return
      if (event.isComposing) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current?.()
        return
      }

      if (event.key !== 'Tab') return
      const nodes = getFocusable()
      if (nodes.length === 0) {
        event.preventDefault()
        container?.focus?.({ preventScroll: true })
        return
      }

      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      const inside = Boolean(container?.contains(active))

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      else clearTimeout(raf)
      document.removeEventListener('keydown', handleKeyDown, true)
      const index = dialogStack.lastIndexOf(id)
      if (index !== -1) dialogStack.splice(index, 1)
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [open])

  return containerRef
}
