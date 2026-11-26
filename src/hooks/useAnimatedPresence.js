import { useEffect, useRef, useState } from 'react'

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Keep conditionally rendered panels/modals mounted briefly after closing so CSS
 * exit animations can finish, while immediately exposing `isClosing` on the
 * frame the open condition turns falsy and preserving the last truthy snapshot.
 */
export function useAnimatedPresence(value, exitDurationMs = 200) {
  const isOpen = Boolean(value)
  const snapshotRef = useRef(value || null)
  if (isOpen) {
    snapshotRef.current = value
  }

  const [mounted, setMounted] = useState(isOpen)
  const timerRef = useRef(null)

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (isOpen) {
      setMounted(true)
      return undefined
    }

    if (!mounted) return undefined

    const delay = prefersReducedMotion() ? 0 : exitDurationMs
    if (delay <= 0) {
      setMounted(false)
      snapshotRef.current = null
      return undefined
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setMounted(false)
      snapshotRef.current = null
    }, delay)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [isOpen, exitDurationMs, mounted])

  return {
    mounted: isOpen || mounted,
    isClosing: !isOpen && mounted,
    data: isOpen ? value : snapshotRef.current
  }
}

export const backdropMotionClass = (isClosing) =>
  isClosing ? 'animate-backdrop-exit pointer-events-none' : 'animate-backdrop-enter'

export const sheetModalMotionClass = (isClosing, breakpoint = 'sm') => {
  if (breakpoint === 'md') {
    return isClosing
      ? 'animate-sheet-exit-down md:animate-modal-exit'
      : 'animate-sheet-spring-up md:animate-modal-enter'
  }
  return isClosing
    ? 'animate-sheet-exit-down sm:animate-modal-exit'
    : 'animate-sheet-spring-up sm:animate-modal-enter'
}

export const drawerMotionClass = (isClosing, breakpoint = 'sm') => {
  if (breakpoint === 'md') {
    return isClosing
      ? 'animate-sheet-exit-down md:animate-drawer-exit-right'
      : 'animate-sheet-spring-up md:animate-drawer-spring-right'
  }
  return isClosing
    ? 'animate-sheet-exit-down sm:animate-drawer-exit-right'
    : 'animate-sheet-spring-up sm:animate-drawer-spring-right'
}

export const modalMotionClass = (isClosing) =>
  isClosing ? 'animate-modal-exit' : 'animate-modal-enter'

export const popoverMotionClass = (isClosing) =>
  isClosing ? 'animate-popover-exit pointer-events-none' : 'animate-popover-spring'
