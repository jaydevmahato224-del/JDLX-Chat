import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { 
  ArrowLeft, 
  Send, 
  Paperclip, 
  CheckCheck, 
  Check, 
  ShieldCheck, 
  Bell, 
  X, 
  AlertCircle, 
  MoreVertical, 
  RotateCcw, 
  LogOut, 
  Sparkles,
  Search,
  User,
  AtSign,
  Sun,
  Moon,
  Monitor,
  Palette,
  Phone,
  Mail,
  CheckCircle2,
  Lock,
  UserPlus,
  Users,
  Share2,
  Copy,
  Clock,
  MessageCircle,  MessageSquare, 
  ArrowRight,
  Ban,
  Flag,
  Mic,
  Camera,
  Video,
  Square,
  Play,
  Pause,
  Download,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Trash2,
  Music,
  Image as ImageIcon,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Reply,
  Loader2,
  Smile,
  FileText,
  RotateCw,
  Pin,
  Edit3,
  Key,
  Volume2,
  VolumeX,
  Sliders,
  Database,
  Upload,
  Plus
} from 'lucide-react'
import { useChatStore } from '../store/useChatStore'
import { apiFetch, refreshChatAccessToken } from '../utils/apiFetch'
import { compressImageForChat, compressAvatarImage } from '../utils/imageCompression'
import { resolveMediaUrl, API_BASE_URL, isCapacitorNative } from '../config'
import { sameId } from '../utils/ids'
import { triggerHaptic } from '../utils/haptics'
import toast from 'react-hot-toast'

// ── CUSTOM VOICE NOTE WAVEFORM PLAYER (WhatsApp / Telegram Caliber) ──
function VoiceNotePlayer({ audioUrl, isUser, isLight, seedId }) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubPercent, setScrubPercent] = useState(null)
  const audioRef = useRef(null)
  const waveformRef = useRef(null)

  // Generate 32 deterministic natural harmonic waveform frequency bars
  const bars = useRef(null)
  if (!bars.current) {
    let hash = 0
    const str = String(seedId || audioUrl || 'jdlx-audio')
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i)
      hash |= 0
    }
    const generated = []
    const barCount = 32
    for (let i = 0; i < barCount; i++) {
      const wave1 = Math.sin(hash * 0.1 + i * 0.45)
      const wave2 = Math.sin(hash * 0.05 + i * 0.9) * 0.5
      const wave3 = Math.cos(i * 1.618) * 0.25
      const normalized = Math.abs(wave1 + wave2 + wave3) / 1.75
      const height = Math.round(Math.max(18, Math.min(100, normalized * 100)))
      generated.push(height)
    }
    bars.current = generated
  }

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const handleLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setDuration(audio.duration)
      } else if (!isFinite(audio.duration) || audio.duration === Infinity) {
        // Fix Chromium Infinity duration on recorded WebM/OGG audio
        audio.currentTime = 1e101
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null
          if (isFinite(audio.duration)) {
            setDuration(audio.duration)
          }
          audio.currentTime = 0
        }
      }
    }

    const handleTimeUpdate = () => {
      if (!isScrubbing) {
        setCurrentTime(audio.currentTime)
      }
    }

    const handleEnded = () => {
      setIsPlaying(false)
      setCurrentTime(0)
      audio.currentTime = 0
    }

    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [audioUrl, isScrubbing])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      audio.play().then(() => {
        setIsPlaying(true)
      }).catch((e) => {
        console.warn('Playback error:', e)
      })
    }
  }

  const cycleSpeed = (e) => {
    e.stopPropagation()
    const rates = [1, 1.5, 2]
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length
    const nextRate = rates[nextIdx]
    setPlaybackRate(nextRate)
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate
    }
  }

  const updateScrub = (e) => {
    if (!waveformRef.current || !audioRef.current) return
    const rect = waveformRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const percent = Math.max(0, Math.min(1, clickX / rect.width))
    setScrubPercent(percent)
    const total = duration || audioRef.current.duration || 0
    const targetTime = percent * total
    if (!isNaN(targetTime) && isFinite(targetTime)) {
      audioRef.current.currentTime = targetTime
      setCurrentTime(targetTime)
    }
  }

  const handlePointerDown = (e) => {
    setIsScrubbing(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {}
    updateScrub(e)
  }

  const handlePointerMove = (e) => {
    if (isScrubbing) {
      updateScrub(e)
    }
  }

  const handlePointerUp = (e) => {
    if (isScrubbing) {
      setIsScrubbing(false)
      setScrubPercent(null)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {}
    }
  }

  const formatSeconds = (sec) => {
    if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00'
    const mins = Math.floor(sec / 60)
    const secs = Math.floor(sec % 60)
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`
  }

  const activePercent = isScrubbing && scrubPercent !== null 
    ? scrubPercent 
    : (duration > 0 ? currentTime / duration : 0)

  return (
    <div className="w-64 sm:w-72 max-w-full my-1.5 select-none">
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      <div className="flex items-center gap-3">
        {/* Play / Pause circular luxury button */}
        <button
          type="button"
          onClick={togglePlay}
          className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 shadow-lg active:scale-90 hover:scale-105 transition-all cursor-pointer ${
            isUser
              ? 'bg-[#09090b] text-[#facc15] hover:bg-[#18181b] shadow-black/20'
              : isLight
                ? 'bg-gradient-to-tr from-amber-500 to-amber-600 text-white shadow-amber-500/25 hover:brightness-105'
                : 'bg-gradient-to-tr from-[#facc15] to-[#eab308] text-[#09090b] shadow-yellow-500/20 hover:brightness-105'
          }`}
          title={isPlaying ? 'Pause voice note' : 'Play voice note'}
          aria-label={isPlaying ? 'Pause voice note' : 'Play voice note'}
        >
          {isPlaying ? (
            <Pause className="w-4 h-4 fill-current" />
          ) : (
            <Play className="w-4 h-4 fill-current ml-0.5" />
          )}
        </button>

        {/* Waveform and scrubbing */}
        <div className="flex-1 flex flex-col justify-center min-w-0">
          <div
            ref={waveformRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className="flex items-center gap-[2.5px] h-7 cursor-pointer py-1 group touch-none"
            title="Drag or click to seek"
          >
            {bars.current.map((height, i) => {
              const barPercent = (i + 0.5) / bars.current.length
              const isPlayed = barPercent <= activePercent

              return (
                <div
                  key={i}
                  style={{ height: `${height}%` }}
                  className={`flex-1 rounded-full transition-all duration-100 min-w-[2px] ${
                    isPlayed
                      ? isUser
                        ? 'bg-[#09090b] shadow-xs'
                        : isLight
                          ? 'bg-amber-600 shadow-xs'
                          : 'bg-[#facc15] shadow-xs'
                      : isUser
                        ? 'bg-black/20 group-hover:bg-black/35'
                        : isLight
                          ? 'bg-slate-300 group-hover:bg-slate-400'
                          : 'bg-zinc-700/80 group-hover:bg-zinc-600'
                  } ${isPlaying && isPlayed ? 'brightness-110' : ''}`}
                />
              )
            })}
          </div>

          {/* Time & speed multiplier pill */}
          <div className="flex items-center justify-between text-[11px] font-mono leading-none mt-1">
            <span className={
              isUser
                ? 'text-[#09090b]/80 font-bold'
                : isLight
                  ? 'text-slate-600 font-semibold'
                  : 'text-zinc-400 font-semibold'
            }>
              {isPlaying || isScrubbing 
                ? formatSeconds(currentTime) 
                : (duration > 0 ? formatSeconds(duration) : 'Voice note')}
            </span>

            <button
              type="button"
              onClick={cycleSpeed}
              title="Change playback speed"
              className={`px-2 py-0.5 rounded-full text-[10px] font-black transition-all active:scale-95 cursor-pointer shadow-xs ${
                playbackRate > 1
                  ? isUser
                    ? 'bg-black text-[#facc15]'
                    : 'bg-[#facc15] text-[#09090b]'
                  : isUser
                    ? 'bg-black/15 text-[#09090b] hover:bg-black/25'
                    : isLight
                      ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      : 'bg-[#27272a] text-zinc-300 hover:bg-[#3f3f46]'
              }`}
            >
              {playbackRate}x
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── MOBILE BOTTOM SHEET DRAG-TO-DISMISS GRAB HANDLE ──
function SheetGrabHandle({ onDismiss }) {
  const touchStartY = useRef(0)

  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return
    touchStartY.current = e.touches[0].clientY
  }

  const handleTouchEnd = (e) => {
    if (e.changedTouches.length !== 1) return
    const deltaY = e.changedTouches[0].clientY - touchStartY.current
    if (deltaY > 45) {
      triggerHaptic('light')
      onDismiss?.()
    }
  }

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className="w-full pt-2.5 pb-2 flex items-center justify-center cursor-grab active:cursor-grabbing sm:hidden shrink-0 touch-none select-none"
      title="Swipe down to dismiss"
    >
      <div className="w-12 h-1.5 rounded-full bg-zinc-500/40 dark:bg-zinc-400/40" />
    </div>
  )
}

// ── SWIPEABLE CONVERSATION ROW (Mobile WhatsApp / iOS Mail style swipe to Pin & Clear) ──
function SwipeableConversationRow({
  children,
  conv,
  isPinned,
  isOpen,
  onOpen,
  onClose,
  onTogglePin,
  onClear,
  onSelect,
  isLight
}) {
  const [offsetX, setOffsetX] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const rowRef = useRef(null)
  const touchStartRef = useRef({ x: 0, y: 0 })
  const startOffsetRef = useRef(0)
  const isSwipingRef = useRef(false)
  const isVerticalScrollRef = useRef(false)
  const hasTickHapticRef = useRef(false)
  const offsetXRef = useRef(0)

  // Keep internal offset synchronized with external isOpen state
  useEffect(() => {
    if (!isOpen && offsetXRef.current !== 0) {
      setIsAnimating(true)
      offsetXRef.current = 0
      setOffsetX(0)
    }
  }, [isOpen])

  useEffect(() => {
    const el = rowRef.current
    if (!el) return

    const handleTouchStart = (e) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      // Never intercept gestures initiated near the screen edge (reserved for Edge Swipe-to-Back)
      if (touch.clientX <= 28) return

      touchStartRef.current = { x: touch.clientX, y: touch.clientY }
      startOffsetRef.current = isOpen ? -140 : 0
      isSwipingRef.current = false
      isVerticalScrollRef.current = false
      hasTickHapticRef.current = false
      setIsAnimating(false)
    }

    const handleTouchMove = (e) => {
      if (e.touches.length !== 1) return
      if (isVerticalScrollRef.current) return

      const touch = e.touches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaY = touch.clientY - touchStartRef.current.y
      const absX = Math.abs(deltaX)
      const absY = Math.abs(deltaY)

      if (!isSwipingRef.current) {
        if (absY > 7 && absY > absX) {
          isVerticalScrollRef.current = true
          return
        }
        if (absX >= 7 && absX > absY) {
          isSwipingRef.current = true
        }
      }

      if (isSwipingRef.current) {
        if (e.cancelable) e.preventDefault()

        const rawTarget = startOffsetRef.current + deltaX
        let finalOffset = rawTarget

        if (rawTarget > 0) {
          // Resist swipe right beyond 0 with elastic damping
          finalOffset = Math.min(20, Math.pow(rawTarget, 0.6) * 1.5)
        } else if (rawTarget < -140) {
          // Resist swipe left beyond -140px with elastic damping
          const over = Math.abs(rawTarget) - 140
          finalOffset = -140 - Math.min(30, Math.pow(over, 0.6) * 2)
        }

        offsetXRef.current = finalOffset
        setOffsetX(finalOffset)

        if (finalOffset <= -70 && !hasTickHapticRef.current) {
          hasTickHapticRef.current = true
          triggerHaptic('light')
        } else if (finalOffset > -70) {
          hasTickHapticRef.current = false
        }
      }
    }

    const handleTouchEnd = () => {
      if (isSwipingRef.current) {
        setIsAnimating(true)
        if (startOffsetRef.current === 0) {
          if (offsetXRef.current <= -60) {
            offsetXRef.current = -140
            setOffsetX(-140)
            triggerHaptic('medium')
            onOpen?.(conv.id)
          } else {
            offsetXRef.current = 0
            setOffsetX(0)
            onClose?.()
          }
        } else {
          // Started from open (-140)
          if (offsetXRef.current > -100) {
            offsetXRef.current = 0
            setOffsetX(0)
            triggerHaptic('light')
            onClose?.()
          } else {
            offsetXRef.current = -140
            setOffsetX(-140)
          }
        }
      }
      isSwipingRef.current = false
      isVerticalScrollRef.current = false
      hasTickHapticRef.current = false
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isOpen, conv.id, onOpen, onClose])

  const handleCardClick = (e) => {
    if (isOpen || Math.abs(offsetX) > 10) {
      e.preventDefault()
      e.stopPropagation()
      setIsAnimating(true)
      offsetXRef.current = 0
      setOffsetX(0)
      onClose?.()
      return
    }
    onSelect?.(conv)
  }

  return (
    <div ref={rowRef} className="relative overflow-hidden w-full select-none">
      {/* Background Action Buttons (Revealed on Swipe Left) */}
      <div className="absolute inset-y-0 right-0 flex items-stretch w-[140px] z-0">
        {/* Pin / Unpin Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            triggerHaptic('medium')
            onTogglePin?.(e, conv.id)
            setIsAnimating(true)
            offsetXRef.current = 0
            setOffsetX(0)
            onClose?.()
          }}
          className="w-[70px] flex flex-col items-center justify-center gap-1 font-bold text-[11px] bg-[#facc15] text-[#09090b] hover:bg-yellow-400 active:scale-95 transition-all cursor-pointer select-none"
          title={isPinned ? 'Unpin chat' : 'Pin chat'}
        >
          <Pin className={`w-4 h-4 ${isPinned ? 'fill-current' : ''}`} />
          <span>{isPinned ? 'Unpin' : 'Pin'}</span>
        </button>

        {/* Clear History Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            triggerHaptic('medium')
            setIsAnimating(true)
            offsetXRef.current = 0
            setOffsetX(0)
            onClose?.()
            onClear?.(conv)
          }}
          className="w-[70px] flex flex-col items-center justify-center gap-1 font-bold text-[11px] bg-rose-600 text-white hover:bg-rose-700 active:scale-95 transition-all cursor-pointer select-none"
          title="Clear chat history"
        >
          <Trash2 className="w-4 h-4" />
          <span>Clear</span>
        </button>
      </div>

      {/* Foreground Content Card */}
      <div
        onClick={handleCardClick}
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isAnimating ? 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)' : 'none'
        }}
        className={`relative z-10 w-full ${isLight ? 'bg-white' : 'bg-[#121215]'}`}
      >
        {children}
      </div>
    </div>
  )
}

// ── SWIPE-TO-REPLY, DOUBLE-TAP & TAP-AND-HOLD ACTION WRAPPER (Mobile WhatsApp Style) ──
function SwipeableMessageBubble({ children, isUser, onSwipeReply, onDoubleTap, onLongPress, m }) {
  const [offsetX, setOffsetX] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const [isPressed, setIsPressed] = useState(false)
  const [isHighlighted, setIsHighlighted] = useState(false)
  const touchStartRef = useRef({ x: 0, y: 0 })
  const isSwipingRef = useRef(false)
  const isVerticalScrollRef = useRef(false)
  const lastTapRef = useRef(0)
  const containerRef = useRef(null)
  const offsetXRef = useRef(0)
  const hasTriggeredHapticRef = useRef(false)
  const pressTimerRef = useRef(null)
  const longPressTimerRef = useRef(null)
  const isLongPressTriggeredRef = useRef(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleTouchStart = (e) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      // Never intercept gestures initiated near the screen edge (reserved for Edge Swipe-to-Back)
      if (touch.clientX <= 28) return

      touchStartRef.current = { x: touch.clientX, y: touch.clientY }
      isSwipingRef.current = false
      isVerticalScrollRef.current = false
      hasTriggeredHapticRef.current = false
      isLongPressTriggeredRef.current = false
      setIsAnimating(false)
      setIsPressed(false)
      setIsHighlighted(false)
      try {
        if (window.getSelection) {
          window.getSelection().removeAllRanges()
        }
      } catch {}

      // Tactile press depression after 50ms hold (visual response)
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current)
      pressTimerRef.current = setTimeout(() => {
        setIsPressed(true)
      }, 50)

      // Start Tap-and-Hold timer for mobile message actions (WhatsApp style)
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = setTimeout(() => {
        isLongPressTriggeredRef.current = true
        setIsPressed(false)
        setIsHighlighted(true)
        try {
          if (window.getSelection) {
            window.getSelection().removeAllRanges()
          }
        } catch {}
        triggerHaptic('heavy')
        const rect = el ? el.getBoundingClientRect() : null
        onLongPress?.(m, rect)
        setTimeout(() => {
          setIsHighlighted(false)
        }, 350)
      }, 360)
    }

    const handleTouchMove = (e) => {
      if (e.touches.length !== 1) return
      if (isVerticalScrollRef.current) return

      const touch = e.touches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaY = touch.clientY - touchStartRef.current.y
      const absX = Math.abs(deltaX)
      const absY = Math.abs(deltaY)

      // Cancel Tap-and-Hold if finger moves more than 7px in any direction
      if (absX > 7 || absY > 7) {
        if (pressTimerRef.current) {
          clearTimeout(pressTimerRef.current)
          pressTimerRef.current = null
        }
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
        }
        setIsPressed(false)
      }

      // If user is scrolling vertically, lock out horizontal swipe for this gesture
      if (!isSwipingRef.current) {
        if (absY > 6 && absY > absX) {
          isVerticalScrollRef.current = true
          return
        }
        // Claim the horizontal swipe gesture on minimal travel (4px) to stop page navigation
        if (absX >= 4 && absX > absY) {
          isSwipingRef.current = true
        }
      }

      if (isSwipingRef.current) {
        if (e.cancelable) {
          e.preventDefault()
        }

        // WhatsApp swipe right (or Telegram swipe left):
        const sign = deltaX > 0 ? 1 : -1
        // Smooth elastic damping capped at 46px maximum (never overflows screen width)
        const damped = Math.min(46, Math.pow(absX, 0.72) * 2.2)
        const finalOffset = sign * damped
        offsetXRef.current = finalOffset
        setOffsetX(finalOffset)

        // Light haptic tick when crossing reply threshold (28px)
        if (Math.abs(finalOffset) >= 28 && !hasTriggeredHapticRef.current) {
          hasTriggeredHapticRef.current = true
          triggerHaptic('light')
        } else if (Math.abs(finalOffset) < 28) {
          hasTriggeredHapticRef.current = false
        }
      }
    }

    const handleTouchEnd = () => {
      if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current)
        pressTimerRef.current = null
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
      setIsPressed(false)

      // If Tap-and-Hold triggered the action sheet, suppress swipe & double-tap!
      if (isLongPressTriggeredRef.current) {
        isLongPressTriggeredRef.current = false
        setIsAnimating(true)
        offsetXRef.current = 0
        setOffsetX(0)
        isSwipingRef.current = false
        return
      }

      if (isSwipingRef.current) {
        const threshold = 28
        if (Math.abs(offsetXRef.current) >= threshold) {
          if (!hasTriggeredHapticRef.current) {
            triggerHaptic('medium')
          }
          onSwipeReply?.(m)
        }
      } else if (!isVerticalScrollRef.current) {
        // Double-tap detector for quick ❤️ reaction (smooth 340ms window)
        const now = Date.now()
        if (now - lastTapRef.current < 340) {
          onDoubleTap?.(m)
          lastTapRef.current = 0
          return
        }
        lastTapRef.current = now
      }

      setIsAnimating(true)
      offsetXRef.current = 0
      setOffsetX(0)
      isSwipingRef.current = false
      isVerticalScrollRef.current = false
      hasTriggeredHapticRef.current = false
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })
    el.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current)
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
      el.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [m, onSwipeReply, onDoubleTap, onLongPress])

  const isSwipingRight = offsetX > 0
  const isThresholdMet = Math.abs(offsetX) >= 28

  return (
    <div
      ref={containerRef}
      onContextMenu={(e) => {
        // Desktop / Mouse Right-Click opens same Floating Action Menu
        e.preventDefault()
        const rect = containerRef.current ? containerRef.current.getBoundingClientRect() : null
        onLongPress?.(m, rect)
      }}
      className="relative max-w-full select-none"
      style={{
        touchAction: 'pan-y',
        overscrollBehaviorX: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none'
      }}
    >
      {/* Reply Action Indicator: positioned OUTSIDE bubble in revealed gutter space */}
      {Math.abs(offsetX) > 5 && (
        <div
          className="absolute top-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none z-0"
          style={{
            ...(isSwipingRight
              ? {
                  left: '-34px',
                  transform: `translateY(-50%) translateX(${Math.min(offsetX, 34)}px) scale(${isThresholdMet ? 1.15 : Math.min(1, Math.max(0.65, Math.abs(offsetX) / 26))})`
                }
              : {
                  right: '-34px',
                  transform: `translateY(-50%) translateX(${Math.max(offsetX, -34)}px) scale(${isThresholdMet ? 1.15 : Math.min(1, Math.max(0.65, Math.abs(offsetX) / 26))})`
                }),
            opacity: Math.min(1, Math.max(0, (Math.abs(offsetX) - 5) / 18)),
            transition: isAnimating ? 'all 0.22s cubic-bezier(0.175, 0.885, 0.32, 1.275)' : 'none'
          }}
        >
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
              isThresholdMet
                ? 'bg-[#facc15] text-[#09090b] shadow-md shadow-yellow-500/40 ring-2 ring-yellow-400/40'
                : 'bg-[#facc15]/25 text-[#facc15]'
            }`}
          >
            <Reply className={`w-3.5 h-3.5 stroke-[2.5] ${isSwipingRight ? '' : 'scale-x-[-1]'}`} />
          </div>
        </div>
      )}

      {/* Moving Message Bubble Content with Tap-and-Hold Animation */}
      <div
        style={{
          transform: `translateX(${offsetX}px) scale(${isHighlighted ? 1.03 : isPressed ? 0.96 : 1})`,
          transition: isAnimating || isPressed || isHighlighted
            ? 'transform 0.22s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.2s ease, filter 0.2s ease'
            : 'none'
        }}
        className={`relative z-10 will-change-transform max-w-full rounded-2xl transition-all duration-200 ${
          isHighlighted ? 'ring-2 ring-yellow-400/60 shadow-lg shadow-yellow-500/20 brightness-105' : ''
        }`}
      >
        {children}
      </div>
    </div>
  )
}

const QUICK_EMOJI_CATEGORIES = [
  {
    name: 'Popular',
    icon: '🔥',
    emojis: ['❤️', '👍', '😂', '🔥', '🙏', '😍', '🎉', '💯', '✨', '👏', '🚀', '⭐', '🥰', '😘', '😎', '🤩']
  },
  {
    name: 'Smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊',
      '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪',
      '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏',
      '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
      '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓'
    ]
  },
  {
    name: 'Gestures',
    icon: '👍',
    emojis: [
      '👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '👌', '🤏',
      '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤙', '💪',
      '🙏', '🤝', '✍️', '💅', '🤳', '👏', '🙌', '👐'
    ]
  },
  {
    name: 'Hearts & Vibes',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕',
      '💞', '💓', '💗', '💖', '💘', '💝', '💟', '🔥', '✨', '⭐', '🌟', '💫',
      '💥', '🎉', '🎊', '💯', '✔️', '✅', '⚡', '💎', '👑', '🏆', '🎯', '🚀'
    ]
  }
]

// The chat pane is only permanently visible on md+ screens. On phones the list
// stays visible until the user taps a conversation, so room fetches/receipts
// must wait for mobileView === 'chat'.
const isWideChatViewport = () => (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(min-width: 768px)').matches
)

// Generate consistent, verified 16-digit Signal/WhatsApp safety fingerprint
function formatSafetyFingerprint(roomId, publicKey) {
  const seed = `${roomId || 'room'}-${publicKey || 'e2ee'}`
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i)
    hash |= 0
  }
  const pos = Math.abs(hash)
  const p1 = String((pos % 9000) + 1000)
  const p2 = String(((pos * 3) % 9000) + 1000)
  const p3 = String(((pos * 7) % 9000) + 1000)
  const p4 = String(((pos * 13) % 9000) + 1000)
  return `${p1}  ${p2}  ${p3}  ${p4}`
}

export default function ChatConversation() {
  const navigate = useNavigate()
  const { 
    chatToken, 
    chatUser,
    chatTheme,
    resolvedChatTheme,
    officialChatLogo,
    officialChatName,
    conversationsLoaded,
    conversationsLoading,
    setChatTheme,
    toggleChatTheme,
    conversations,
    activeConversation,
    activeRoomId,
    fetchConversations,
    selectConversation,
    fetchRoomMessages,
    hydrateCachedMessages,
    openRecoverySetup,
    sendRoomMessage,
    openDirectChat,
    friends,
    incomingRequests,
    outgoingRequests,
    pendingRequestsCount,
    fetchFriendsAndRequests,
    sendFriendRequest,
    respondFriendRequest,
    inviteInfo,
    fetchInviteInfo,
    searchUsers,
    messages, 
    messagesLoading,
    messagesHasMore,
    loadingOlderMessages,
    loadOlderMessages,
    notifications, 
    unreadCount, 
    sending, 
    fetchNotifications, 
    fetchUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
    clearChatHistory, 
    chatLogout,
    enablePushNotifications,
    startRealtime,
    stopRealtime,
    startSocialRealtime,
    stopSocialRealtime,
    sendTyping,
    peerTyping,
    peerOnline,
    peerLastReadId,
    blockUser,
    unblockUser,
    reportUser,
    editMessage,
    deleteMessage,
    toggleReaction,
    updateChatProfile,
    uploadProfileAvatar,
    addOptimisticMediaMessage,
    updateMessageUploadState,
    removeOptimisticMessage
  } = useChatStore()

  const isLight = resolvedChatTheme === 'light'
  const chatBrandName = officialChatName || 'JDLX Chat'
  const themeLabel = chatTheme === 'system' ? 'System' : chatTheme === 'light' ? 'Light' : 'Dark'
  const isBlockedConversation = Boolean(
    activeConversation?.blocked_by_me || activeConversation?.blocked_me
  )

  // View state: 'list' (WhatsApp chat list) or 'chat' (active room) on small screens
  const [mobileView, setMobileView] = useState('list')
  const [conversationFilter, setConversationFilter] = useState('')

  // Mobile VisualViewport & Keyboard Docking (Zero-jitter layout)
  const rootContainerRef = useRef(null)
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false)
  const maxViewportHeightRef = useRef(typeof window !== 'undefined' ? window.innerHeight : 800)

  // Mobile Edge Swipe-to-Back (iOS / Android Native standard: clientX <= 28px)
  const [edgeSwipeOffset, setEdgeSwipeOffset] = useState(0)
  const isEdgeSwipingRef = useRef(false)
  const edgeSwipeStartRef = useRef({ x: 0, y: 0 })
  const edgeHapticFiredRef = useRef(false)

  // Modals & Drawers
  const [showAddFriendModal, setShowAddFriendModal] = useState(false)
  const [friendModalTab, setFriendModalTab] = useState('search') // 'search' | 'requests' | 'invite'
  const [showPushPrompt, setShowPushPrompt] = useState(false)
  const [showProfileDrawer, setShowProfileDrawer] = useState(false)
  const [showNotificationsDrawer, setShowNotificationsDrawer] = useState(false)
  const [showContactInfoModal, setShowContactInfoModal] = useState(false)
  const [mutedRooms, setMutedRooms] = useState(() => {
    try {
      const saved = localStorage.getItem('jdlx_chat_muted_rooms')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })

  const toggleMuteRoom = useCallback((roomId) => {
    if (!roomId) return
    triggerHaptic('medium')
    setMutedRooms((prev) => {
      const isMuted = prev.includes(roomId)
      const next = isMuted ? prev.filter((id) => id !== roomId) : [...prev, roomId]
      try {
        localStorage.setItem('jdlx_chat_muted_rooms', JSON.stringify(next))
      } catch {}
      toast.success(isMuted ? 'Notifications unmuted for this chat' : 'Notifications muted for this chat', {
        icon: isMuted ? '🔔' : '🔕'
      })
      return next
    })
  }, [])
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showPwaInstallModal, setShowPwaInstallModal] = useState(false)
  const [isPwaInstalled, setIsPwaInstalled] = useState(false)
  const [selectedPreviewImage, setSelectedPreviewImage] = useState(null)
  const [isClosingPreview, setIsClosingPreview] = useState(false)
  const isClosingPreviewRef = useRef(false)
  const [previewImages, setPreviewImages] = useState([])
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewZoom, setPreviewZoom] = useState(1)
  const [previewRotation, setPreviewRotation] = useState(0)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const touchDistRef = useRef(null)
  const swipeTouchStartRef = useRef({ x: 0, y: 0 })

  // ── PRE-SEND IMAGE PREVIEW & CAPTION MODAL STATE (WhatsApp Standard) ──
  const [imageSendModal, setImageSendModal] = useState(null)
  const addMoreImagesInputRef = useRef(null)

  // ── DESKTOP DRAG & DROP AND CLIPBOARD PASTE STATE (Item 4) ──
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const dragCounterRef = useRef(0)

  // ── EDITABLE PROFILE & LUXURY SETTINGS STATE ──
  const [profileTab, setProfileTab] = useState('profile') // 'profile' | 'preferences' | 'security'
  const [editName, setEditName] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [editBio, setEditBio] = useState('')
  const [editGender, setEditGender] = useState('prefer_not_to_say')
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
  const avatarFileInputRef = useRef(null)

  // Chat Preferences
  const [enterToSend, setEnterToSend] = useState(() => {
    try {
      const val = localStorage.getItem('jdlx_chat_enter_send')
      return val === null ? true : val === 'true'
    } catch {
      return true
    }
  })
  const [chatSounds, setChatSounds] = useState(() => {
    try {
      const val = localStorage.getItem('jdlx_chat_sound')
      return val === null ? true : val === 'true'
    } catch {
      return true
    }
  })
  const [showDoodle, setShowDoodle] = useState(() => {
    try {
      const val = localStorage.getItem('jdlx_chat_doodle')
      return val === null ? true : val === 'true'
    } catch {
      return true
    }
  })

  // Small synthesized chime for incoming messages (no audio asset needed).
  const audioContextRef = useRef(null)
  const playChatSound = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return

      let ctx = audioContextRef.current
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioCtx()
        audioContextRef.current = ctx
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})

      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, now)
      osc.frequency.exponentialRampToValueAtTime(660, now + 0.12)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.2)
    } catch {
      // Autoplay policy or unsupported browser: silently skip the chime.
    }
  }, [])

  useEffect(() => () => {
    const ctx = audioContextRef.current
    audioContextRef.current = null
    if (ctx && ctx.state !== 'closed') {
      Promise.resolve(ctx.close()).catch(() => {})
    }
  }, [])

  // Prefill editable fields when Profile drawer opens
  useEffect(() => {
    if (showProfileDrawer && chatUser) {
      setEditName(chatUser.name || '')
      setEditUsername(chatUser.username || '')
      setEditBio(chatUser.bio || 'Hey there! I am using JDLX Chat')
      setEditGender(chatUser.gender || 'prefer_not_to_say')
    }
  }, [showProfileDrawer, chatUser])

  const handleToggleEnterToSend = (enabled) => {
    setEnterToSend(enabled)
    try { localStorage.setItem('jdlx_chat_enter_send', String(enabled)) } catch {}
  }

  const handleToggleChatSounds = (enabled) => {
    setChatSounds(enabled)
    try { localStorage.setItem('jdlx_chat_sound', String(enabled)) } catch {}
    // Preview the chime on enable (also unlocks AudioContext on iOS).
    if (enabled) playChatSound()
  }

  const handleToggleDoodle = (enabled) => {
    setShowDoodle(enabled)
    try { localStorage.setItem('jdlx_chat_doodle', String(enabled)) } catch {}
  }

  const handleAvatarSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose a valid image file (PNG, JPG, WebP)')
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      toast.error('Image size must be under 15MB')
      return
    }
    setIsUploadingAvatar(true)
    try {
      const compressedAvatar = await compressAvatarImage(file)
      const res = await uploadProfileAvatar(compressedAvatar)
      if (res.success) {
        toast.success('Profile avatar updated successfully!')
      } else {
        toast.error(res.error || 'Failed to upload avatar')
      }
    } catch (err) {
      toast.error(err.message || 'Error uploading avatar')
    } finally {
      setIsUploadingAvatar(false)
      if (avatarFileInputRef.current) avatarFileInputRef.current.value = ''
    }
  }

  const handleSaveProfile = async (e) => {
    e?.preventDefault?.()
    if (!editName.trim()) {
      toast.error('Full Name cannot be empty')
      return
    }
    setIsSavingProfile(true)
    try {
      const res = await updateChatProfile({
        name: editName.trim(),
        username: editUsername.trim() || undefined,
        bio: editBio.trim(),
        gender: editGender
      })
      if (res.success) {
        toast.success('Profile updated successfully!')
      } else {
        toast.error(res.error || 'Failed to update profile')
      }
    } catch (err) {
      toast.error(err.message || 'Error updating profile')
    } finally {
      setIsSavingProfile(false)
    }
  }

  const handleCopyPublicKey = () => {
    const key = chatUser?.public_key || 'No ECDH public key found'
    navigator.clipboard?.writeText?.(key)
    toast.success('Device fingerprint copied to clipboard!')
  }

  const handleClearCache = async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
      toast.success('Local cache cleared! Reloading...')
      setTimeout(() => window.location.reload(), 600)
    } catch (err) {
      toast.error('Failed to clear local cache')
    }
  }

  const toggleFullscreen = useCallback(() => {
    try {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {})
      } else {
        document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {})
      }
    } catch {}
  }, [])

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const openLightbox = useCallback((url, imagesList = [], initialIndex = 0) => {
    isClosingPreviewRef.current = false
    setIsClosingPreview(false)
    const list = imagesList && imagesList.length > 0
      ? imagesList
      : [{ url, id: 'single', caption: '' }]
    const validIndex = initialIndex >= 0 && initialIndex < list.length ? initialIndex : 0
    setPreviewImages(list)
    setPreviewIndex(validIndex)
    setSelectedPreviewImage(url || list[validIndex]?.url)
    setPreviewZoom(1)
    setPreviewRotation(0)
    setPanOffset({ x: 0, y: 0 })
  }, [])

  const handleClosePreview = useCallback(() => {
    if (isClosingPreviewRef.current) return
    isClosingPreviewRef.current = true
    setIsClosingPreview(true)
    setTimeout(() => {
      setSelectedPreviewImage(null)
      setPreviewImages([])
      setPreviewIndex(0)
      setPreviewZoom(1)
      setPreviewRotation(0)
      setPanOffset({ x: 0, y: 0 })
      setIsClosingPreview(false)
      isClosingPreviewRef.current = false
      if (document.fullscreenElement) {
        try { document.exitFullscreen().catch(() => {}) } catch {}
      }
    }, 200)
  }, [])

  const handleNextPreview = useCallback(() => {
    setPreviewImages((list) => {
      if (!list || list.length <= 1) return list
      setPreviewIndex((idx) => {
        const next = (idx + 1) % list.length
        setSelectedPreviewImage(list[next]?.url)
        return next
      })
      setPreviewZoom(1)
      setPreviewRotation(0)
      setPanOffset({ x: 0, y: 0 })
      return list
    })
  }, [])

  const handlePrevPreview = useCallback(() => {
    setPreviewImages((list) => {
      if (!list || list.length <= 1) return list
      setPreviewIndex((idx) => {
        const prev = (idx - 1 + list.length) % list.length
        setSelectedPreviewImage(list[prev]?.url)
        return prev
      })
      setPreviewZoom(1)
      setPreviewRotation(0)
      setPanOffset({ x: 0, y: 0 })
      return list
    })
  }, [])

  const handleJumpToPreview = useCallback((idx) => {
    setPreviewImages((list) => {
      if (!list || idx < 0 || idx >= list.length) return list
      setPreviewIndex(idx)
      setSelectedPreviewImage(list[idx]?.url)
      setPreviewZoom(1)
      setPreviewRotation(0)
      setPanOffset({ x: 0, y: 0 })
      return list
    })
  }, [])

  const handleDownloadMedia = useCallback(async (url, customName) => {
    if (!url) return
    try {
      toast('Downloading image...', { icon: '⬇️' })
      const res = await fetch(url)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      const timeTag = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
      a.download = customName || `JDLX_Photo_${timeTag}.jpg`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      toast.success('Photo downloaded!')
    } catch (err) {
      console.warn('Download fallback:', err)
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.download = customName || `JDLX_Photo_${Date.now()}.jpg`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }, [])

  const handleCopyMedia = useCallback(async (url) => {
    if (!url) return
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const res = await fetch(url)
        const blob = await res.blob()
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type || 'image/png']: blob })
        ])
        toast.success('Image copied to clipboard!')
        return
      }
      await navigator.clipboard.writeText(url)
      toast.success('Image link copied!')
    } catch (err) {
      try {
        await navigator.clipboard.writeText(url)
        toast.success('Image link copied!')
      } catch {
        toast.error('Could not copy image')
      }
    }
  }, [])

  // Lightbox keyboard controls: ESC, Arrows, +, -, 0, R, F, D, C
  useEffect(() => {
    if (!selectedPreviewImage) return undefined
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleClosePreview()
      } else if (e.key === 'ArrowRight') {
        handleNextPreview()
      } else if (e.key === 'ArrowLeft') {
        handlePrevPreview()
      } else if (e.key === '+' || e.key === '=') {
        setPreviewZoom((z) => Math.min(3.5, +(z + 0.5).toFixed(1)))
      } else if (e.key === '-') {
        setPreviewZoom((z) => {
          const next = Math.max(1, +(z - 0.5).toFixed(1))
          if (next === 1) setPanOffset({ x: 0, y: 0 })
          return next
        })
      } else if (e.key === '0') {
        setPreviewZoom(1)
        setPanOffset({ x: 0, y: 0 })
      } else if (e.key === 'r' || e.key === 'R') {
        setPreviewRotation((r) => (r + 90) % 360)
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen()
      } else if (e.key === 'd' || e.key === 'D') {
        handleDownloadMedia(selectedPreviewImage)
      } else if (e.key === 'c' || e.key === 'C') {
        handleCopyMedia(selectedPreviewImage)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedPreviewImage, handleClosePreview, handleNextPreview, handlePrevPreview, toggleFullscreen, handleDownloadMedia, handleCopyMedia])

  const [showMenu, setShowMenu] = useState(false)
  const [showReportModal, setShowReportModal] = useState(false)
  const [reportReason, setReportReason] = useState('spam')
  const [reportDetails, setReportDetails] = useState('')
  // Messenger actions: reply/quote, edit and floating per-message action menu (WhatsApp style)
  const [replyTo, setReplyTo] = useState(null)
  const [actionMessage, setActionMessage] = useState(null)
  const [actionMessageAnchor, setActionMessageAnchor] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')

  const handleOpenActionMenu = useCallback((msg, rect = null) => {
    setActionMessage(msg)
    setActionMessageAnchor(rect)
  }, [])

  const handleCloseActionMenu = useCallback(() => {
    setActionMessage(null)
    setActionMessageAnchor(null)
  }, [])

  // Search state inside Add Friend modal
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [globalSearchResults, setGlobalSearchResults] = useState([])
  const [searchingGlobal, setSearchingGlobal] = useState(false)
  const [requestActionLoading, setRequestActionLoading] = useState(null)

  // Messaging state & unsent drafts per room (persisted across reloads/switches)
  const [inputText, setInputText] = useState('')
  const [drafts, setDrafts] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('jdlx_chat_drafts') || '{}')
    } catch {
      return {}
    }
  })

  // Pinned conversation IDs in sidebar (persisted in localStorage)
  const [pinnedRoomIds, setPinnedRoomIds] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('jdlx_chat_pinned_rooms') || '[]')
    } catch {
      return []
    }
  })

  const togglePinConversation = useCallback((e, roomId) => {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
    setPinnedRoomIds((prev) => {
      const isPinned = prev.some((id) => sameId(id, roomId))
      const next = isPinned ? prev.filter((id) => !sameId(id, roomId)) : [...prev, roomId]
      try {
        localStorage.setItem('jdlx_chat_pinned_rooms', JSON.stringify(next))
      } catch {}
      toast.success(isPinned ? 'Chat unpinned' : 'Chat pinned to top', {
        icon: isPinned ? '📌' : '⭐',
        duration: 2000
      })
      return next
    })
  }, [])

  // Swiped-open conversation row ID (mobile swipe to reveal Pin/Clear)
  const [openSwipeId, setOpenSwipeId] = useState(null)

  // Thumb filter tabs for sidebar ('all' | 'unread' | 'pinned')
  const [conversationTabFilter, setConversationTabFilter] = useState('all')

  const handleSwipeClear = useCallback(async (conv) => {
    if (!conv) return
    triggerHaptic('medium')
    const displayName = conv.contact_name || (conv.contact_username ? `@${conv.contact_username}` : 'this user')
    if (window.confirm(`Clear all messages in chat with ${displayName}?`)) {
      const ok = await clearChatHistory(conv.id)
      if (ok) {
        toast.success('Conversation cleared')
      } else {
        toast.error('Could not clear conversation')
      }
    }
  }, [clearChatHistory])

  // Pull-to-Refresh on Conversation List (Mobile touch)
  const [pullY, setPullY] = useState(0)
  const [isPullRefreshing, setIsPullRefreshing] = useState(false)
  const convListRef = useRef(null)
  const pullTouchStartRef = useRef({ y: 0, x: 0 })
  const isPullingRef = useRef(false)
  const pullYRef = useRef(0)
  const hasTriggeredPullHapticRef = useRef(false)
  const isRefreshingRef = useRef(false)

  useEffect(() => {
    isRefreshingRef.current = isPullRefreshing
  }, [isPullRefreshing])

  useEffect(() => {
    const listEl = convListRef.current
    if (!listEl) return

    const handleTouchStart = (e) => {
      if (e.touches.length !== 1) return
      // Only initiate pull-to-refresh if list is at the very top
      if (listEl.scrollTop > 2) return
      pullTouchStartRef.current = { y: e.touches[0].clientY, x: e.touches[0].clientX }
      isPullingRef.current = false
      hasTriggeredPullHapticRef.current = false
    }

    const handleTouchMove = (e) => {
      if (e.touches.length !== 1) return
      if (isRefreshingRef.current) return

      const deltaY = e.touches[0].clientY - pullTouchStartRef.current.y
      const deltaX = e.touches[0].clientX - pullTouchStartRef.current.x

      // Only engage if pulling down and list is at top
      if (listEl.scrollTop <= 0 && deltaY > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
        isPullingRef.current = true
        if (e.cancelable) e.preventDefault()

        const damped = Math.min(78, Math.pow(deltaY, 0.72) * 2.1)
        pullYRef.current = damped
        setPullY(damped)

        if (damped >= 52 && !hasTriggeredPullHapticRef.current) {
          hasTriggeredPullHapticRef.current = true
          triggerHaptic('light')
        } else if (damped < 52) {
          hasTriggeredPullHapticRef.current = false
        }
      }
    }

    const handleTouchEnd = async () => {
      if (!isPullingRef.current) return
      isPullingRef.current = false

      if (pullYRef.current >= 52 && !isRefreshingRef.current) {
        setIsPullRefreshing(true)
        setPullY(46)
        pullYRef.current = 46
        triggerHaptic('medium')
        try {
          await Promise.all([
            fetchConversations?.(),
            fetchFriendsAndRequests?.(),
            fetchNotifications?.()
          ])
        } catch (err) {
          console.warn('Pull-to-refresh sync error:', err)
        } finally {
          setIsPullRefreshing(false)
          setPullY(0)
          pullYRef.current = 0
          hasTriggeredPullHapticRef.current = false
        }
      } else {
        setPullY(0)
        pullYRef.current = 0
        hasTriggeredPullHapticRef.current = false
      }
    }

    listEl.addEventListener('touchstart', handleTouchStart, { passive: true })
    listEl.addEventListener('touchmove', handleTouchMove, { passive: false })
    listEl.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      listEl.removeEventListener('touchstart', handleTouchStart)
      listEl.removeEventListener('touchmove', handleTouchMove)
      listEl.removeEventListener('touchend', handleTouchEnd)
    }
  }, [fetchConversations, fetchFriendsAndRequests, fetchNotifications])

  const updateDraft = useCallback((roomId, text) => {
    if (!roomId) return
    setDrafts((prev) => {
      const next = { ...prev }
      if (text && text.trim()) {
        next[roomId] = text
      } else {
        delete next[roomId]
      }
      try {
        localStorage.setItem('jdlx_chat_drafts', JSON.stringify(next))
      } catch {}
      return next
    })
  }, [])

  const [uploadingImage, setUploadingImage] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isVoiceLocked, setIsVoiceLocked] = useState(false)
  const [voiceSlideX, setVoiceSlideX] = useState(0)
  const [voiceSlideY, setVoiceSlideY] = useState(0)
  const voiceTouchStartRef = useRef({ x: 0, y: 0, time: 0 })
  const isTouchRecordingRef = useRef(false)
  const [showAttachmentTray, setShowAttachmentTray] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [activeEmojiCategory, setActiveEmojiCategory] = useState(0)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [showScrollBottomFab, setShowScrollBottomFab] = useState(false)
  const [unreadBelowCount, setUnreadBelowCount] = useState(0)
  const [floatingHeartId, setFloatingHeartId] = useState(null)

  const handleInsertEmoji = (emoji) => {
    setInputText((prev) => (prev || '') + emoji)
    adjustTextareaHeight()
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }

  const textareaRef = useRef(null)
  const messagesContainerRef = useRef(null)
  const messagesEndRef = useRef(null)
  const lastRenderedMessageIdRef = useRef(null)
  // Whether the view is glued to the newest message while a freshly opened
  // room finishes loading (see effect 3b).
  const pinStateRef = useRef({ active: false, roomId: null, expectedTop: 0 })
  const lastSoundEventRef = useRef({ roomId: null, id: null })
  const isCancelledRecordingRef = useRef(false)
  const isReviewingRef = useRef(false)
  const currentDurationRef = useRef(0)
  const recordingTimerRef = useRef(null)
  const reviewAudioRef = useRef(null)
  const activeUploadsRef = useRef({})
  // Tracks uploads cancelled while a token refresh was in flight, so the
  // retried XHR cannot upload an orphan after the bubble was removed.
  const cancelledUploadsRef = useRef(new Set())
  const [voiceReview, setVoiceReview] = useState(null)
  const [reviewPlaybackRate, setReviewPlaybackRate] = useState(1)

  const scrollToBottom = useCallback((smooth = true) => {
    const el = messagesContainerRef.current
    if (!el) return
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  const handleMessagesScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
    const distanceToBottom = scrollHeight - scrollTop - clientHeight
    const isScrolledUp = distanceToBottom > 220
    setShowScrollBottomFab(isScrolledUp)
    if (isScrolledUp) {
      // Reading history always wins over the initial-load bottom pin.
      pinStateRef.current.active = false
    } else {
      setUnreadBelowCount(0)
    }
  }

  const handleJumpToBottom = () => {
    scrollToBottom(true)
    setShowScrollBottomFab(false)
    setUnreadBelowCount(0)
  }

  const handleDoubleTapReaction = (m) => {
    if (!m || m.deleted || m.message_type === 'deleted') return
    triggerHaptic('double')
    setFloatingHeartId(m.id)
    setTimeout(() => setFloatingHeartId(null), 700)
    toggleReaction(m.id, '❤️')
  }

  const adjustTextareaHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      const nextHeight = Math.min(Math.max(textareaRef.current.scrollHeight, 40), 120)
      textareaRef.current.style.height = `${nextHeight}px`
    }
  }, [])

  const formatRecordingDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`
  }

  // Mobile VisualViewport listener: lock layout to visible area smoothly with 0ms jitter
  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return

    let rafId = null

    const handleViewportChange = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        // Prevent layout drift from background window scrolling
        if (typeof window !== 'undefined' && (window.scrollY !== 0 || window.scrollX !== 0)) {
          window.scrollTo(0, 0)
        }

        const vh = Math.round(vv.height)
        const vTop = Math.round(vv.offsetTop || 0)

        if (vh > maxViewportHeightRef.current) {
          maxViewportHeightRef.current = vh
        }
        const keyboardOpen = (maxViewportHeightRef.current - vh) > 100

        setIsKeyboardOpen((prev) => {
          if (!prev && keyboardOpen && mobileView === 'chat') {
            setTimeout(() => scrollToBottom(false), 160)
          }
          return keyboardOpen
        })

        // Dock root container height & top directly to visual viewport without React re-render stutter
        // vTop ensures container is never pushed above the viewport when browser pans
        if (rootContainerRef.current) {
          rootContainerRef.current.style.top = `${vTop}px`
          rootContainerRef.current.style.height = `${vh}px`
          rootContainerRef.current.style.maxHeight = `${vh}px`
          rootContainerRef.current.style.bottom = 'auto'
        }
      })
    }

    const handleWindowScroll = () => {
      if (typeof window !== 'undefined' && (window.scrollY !== 0 || window.scrollX !== 0)) {
        window.scrollTo(0, 0)
      }
    }

    const handleOrientationChange = () => {
      setTimeout(() => {
        if (typeof window !== 'undefined' && window.visualViewport) {
          maxViewportHeightRef.current = Math.round(window.visualViewport.height)
          handleViewportChange()
        }
      }, 150)
    }

    handleViewportChange()
    vv.addEventListener('resize', handleViewportChange, { passive: true })
    vv.addEventListener('scroll', handleViewportChange, { passive: true })
    window.addEventListener('scroll', handleWindowScroll, { passive: true })
    window.addEventListener('orientationchange', handleOrientationChange)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', handleViewportChange)
      vv.removeEventListener('scroll', handleViewportChange)
      window.removeEventListener('scroll', handleWindowScroll)
      window.removeEventListener('orientationchange', handleOrientationChange)
    }
  }, [mobileView, scrollToBottom])

  // Mobile Edge Swipe-to-Back gesture handlers
  const handleEdgeTouchStart = (e) => {
    if (mobileView !== 'chat' || e.touches.length !== 1) return
    const touch = e.touches[0]
    if (touch.clientX <= 28) {
      isEdgeSwipingRef.current = true
      edgeSwipeStartRef.current = { x: touch.clientX, y: touch.clientY }
      edgeHapticFiredRef.current = false
    } else {
      isEdgeSwipingRef.current = false
    }
  }

  const handleEdgeTouchMove = (e) => {
    if (!isEdgeSwipingRef.current || e.touches.length !== 1) return
    const touch = e.touches[0]
    const deltaX = touch.clientX - edgeSwipeStartRef.current.x
    const deltaY = Math.abs(touch.clientY - edgeSwipeStartRef.current.y)

    // Cancel if gesture is predominantly vertical scroll
    if (deltaY > 35 && deltaX < 20) {
      isEdgeSwipingRef.current = false
      setEdgeSwipeOffset(0)
      return
    }

    if (deltaX > 0) {
      const clampedOffset = deltaX > 120 ? 120 + (deltaX - 120) * 0.25 : deltaX
      setEdgeSwipeOffset(clampedOffset)

      if (deltaX >= 60 && !edgeHapticFiredRef.current) {
        edgeHapticFiredRef.current = true
        triggerHaptic('medium')
      } else if (deltaX < 60) {
        edgeHapticFiredRef.current = false
      }
    }
  }

  const handleEdgeTouchEnd = () => {
    if (!isEdgeSwipingRef.current) return
    isEdgeSwipingRef.current = false

    if (edgeSwipeOffset >= 60) {
      triggerHaptic('light')
      setMobileView('list')
    }
    setEdgeSwipeOffset(0)
    edgeHapticFiredRef.current = false
  }

  const fileInputRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const activeRecordingStreamRef = useRef(null)
  const recordingChunksRef = useRef([])
  // Friend-request toast bookkeeping: ids already announced, plus the time
  // this session started (so old pending requests never toast on app open).
  const seenRequestIdsRef = useRef(null)
  const socialSessionStartRef = useRef(Date.now())

  // PWA installation listener and status detection
  useEffect(() => {
    const handleBeforeInstall = (e) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    const handleAppInstalled = () => {
      setDeferredPrompt(null)
      setIsPwaInstalled(true)
      toast.success('JDLX Chat installed successfully!', { icon: '🎉' })
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall)
    window.addEventListener('appinstalled', handleAppInstalled)
    if (
      (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches) ||
      (typeof navigator !== 'undefined' && navigator.standalone === true)
    ) {
      setIsPwaInstalled(true)
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  const triggerPwaInstall = async () => {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt()
        const choice = await deferredPrompt.userChoice
        if (choice?.outcome === 'accepted') {
          setDeferredPrompt(null)
          setIsPwaInstalled(true)
        }
      } catch {
        setShowPwaInstallModal(true)
      }
    } else {
      setShowPwaInstallModal(true)
    }
  }

  // 1. Guard route: redirect to chat login if no chat session exists
  useEffect(() => {
    if (!chatToken) {
      navigate('/chat/login', { replace: true })
    }
  }, [chatToken, navigate])

  // 2. Initial load and periodic safety net (30-second interval)
  useEffect(() => {
    fetchConversations()
    fetchFriendsAndRequests()
    fetchNotifications()
    fetchUnreadCount()
    fetchInviteInfo()

    const interval = setInterval(() => {
      fetchConversations()
      fetchFriendsAndRequests()
      fetchUnreadCount()
    }, 30000)

    return () => clearInterval(interval)
  }, [fetchConversations, fetchFriendsAndRequests, fetchNotifications, fetchUnreadCount, fetchInviteInfo])

  // 2-invite. Open the inviter's chat after login/registration when the user
  // arrived through a ?ref=@username invite link.
  useEffect(() => {
    if (!chatToken || !conversationsLoaded) return

    let pendingRef = ''
    try {
      pendingRef = (localStorage.getItem('jdlx_chat_pending_invite') || '').trim()
    } catch {
      return
    }
    if (!pendingRef) return

    // Consume once so refreshes/re-logins do not keep reopening the chat.
    try { localStorage.removeItem('jdlx_chat_pending_invite') } catch { /* ignore */ }

    let cancelled = false
    const connectToInviter = async () => {
      const results = await searchUsers(pendingRef)
      if (cancelled) return

      const needle = pendingRef.toLowerCase()
      const target = (results || []).find(
        (u) => String(u?.username || '').toLowerCase() === needle
      )
      if (!target) {
        toast.error(`Could not find @${pendingRef}. Ask them to share their invite again.`)
        return
      }
      if (sameId(target.id, chatUser?.id)) {
        toast.error('That invite link belongs to your own account.')
        return
      }

      const res = await openDirectChat(target.id)
      if (cancelled) return
      if (res.success) {
        setMobileView('chat')
        toast.success(`Connected with @${target.username}!`, { icon: '💬' })
      } else if (!res.inFlight) {
        toast.error(res.error || `Could not open chat with @${target.username}`)
      }
    }
    connectToInviter()

    return () => { cancelled = true }
  }, [chatToken, conversationsLoaded, searchUsers, openDirectChat, chatUser?.id])

  // 2-wake. Auto-reconnect & resync immediately when mobile device unlocks or tab becomes visible
  useEffect(() => {
    const handleWakeup = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        fetchConversations()
        fetchFriendsAndRequests()
        fetchUnreadCount()
        if (activeRoomId && (isWideChatViewport() || mobileView === 'chat')) {
          fetchRoomMessages(activeRoomId)
          startRealtime()
        }
      }
    }
    const handleOnline = () => {
      fetchConversations()
      fetchUnreadCount()
      if (activeRoomId && (isWideChatViewport() || mobileView === 'chat')) {
        fetchRoomMessages(activeRoomId)
        startRealtime()
      }
    }
    document.addEventListener('visibilitychange', handleWakeup)
    window.addEventListener('online', handleOnline)
    return () => {
      document.removeEventListener('visibilitychange', handleWakeup)
      window.removeEventListener('online', handleOnline)
    }
  }, [activeRoomId, mobileView, fetchConversations, fetchFriendsAndRequests, fetchUnreadCount, fetchRoomMessages, startRealtime])

  // 2a. Synchronize active room messages when activeRoomId initializes or changes
  const initialRoomFetchedRef = useRef(null)
  useEffect(() => {
    if (
      activeRoomId
      && initialRoomFetchedRef.current !== activeRoomId
      && (isWideChatViewport() || mobileView === 'chat')
    ) {
      initialRoomFetchedRef.current = activeRoomId
      hydrateCachedMessages()
      fetchRoomMessages(activeRoomId)
    }
  }, [activeRoomId, mobileView, fetchRoomMessages, hydrateCachedMessages])

  // 2b. Realtime for the open room: messages, typing, presence, read receipts.
  // On a phone, do not subscribe until the conversation pane is actually open;
  // otherwise realtime read receipts mark messages read from the list screen.
  useEffect(() => {
    if (!activeRoomId) return undefined
    if (!isWideChatViewport() && mobileView !== 'chat') return undefined
    startRealtime()
    return () => stopRealtime()
  }, [activeRoomId, mobileView, startRealtime, stopRealtime])

  // 2c. Friend requests & accepts arrive instantly instead of on the next
  // 30-second refresh (the poll below stays only as a safety net).
  useEffect(() => {
    startSocialRealtime()
    return () => stopSocialRealtime()
  }, [startSocialRealtime, stopSocialRealtime])

  // 2d. Announce a NEW friend request immediately: a tappable toast that opens
  // the Requests tab, while the header/banner badges update from the same
  // realtime payload. Requests that existed before this session are ignored.
  useEffect(() => {
    const requests = incomingRequests || []
    const ids = new Set(requests.map((r) => r.request_id))

    if (seenRequestIdsRef.current === null) {
      seenRequestIdsRef.current = ids
      return
    }

    const fresh = requests.filter((r) => {
      if (seenRequestIdsRef.current.has(r.request_id)) return false
      const created = parseUtcDate(r.created_at)
      return !created || created.getTime() >= socialSessionStartRef.current - 15000
    })
    seenRequestIdsRef.current = ids
    if (!fresh.length) return

    const first = fresh[0]
    const label = first.username ? `@${first.username}` : (first.name || 'Someone')
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''

    toast.custom((t) => (
      <button
        type="button"
        onClick={() => {
          toast.dismiss(t.id)
          setShowAddFriendModal(true)
          setFriendModalTab('requests')
        }}
        className={`flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-2xl text-left max-w-sm cursor-pointer active:scale-[0.98] transition-transform ${
          isLight
            ? 'bg-white border-slate-200 text-slate-900'
            : 'bg-[#18181b] border-[#27272a] text-white'
        }`}
        style={{ pointerEvents: 'auto' }}
      >
        <span className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-500 flex items-center justify-center shrink-0">
          <UserPlus className="w-5 h-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-black truncate">New friend request</span>
          <span className={`block text-[11px] font-medium truncate ${
            isLight ? 'text-slate-600' : 'text-zinc-300'
          }`}>
            {label}{extra} wants to connect. Tap to review.
          </span>
        </span>
      </button>
    ), { duration: 7000 })
  }, [incomingRequests])

  // 2e. Web Push: re-register silently when permission was already granted,
  // otherwise offer a one-time prompt (permission needs a user gesture on
  // some browsers).
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) return
    if (Notification.permission === 'granted') {
      enablePushNotifications({ silent: true })
    } else if (Notification.permission === 'default') {
      setShowPushPrompt(true)
    }
  }, [enablePushNotifications])

  // 2f/2g. Notification + deep-link routing for web push, native FCM and a
  // cold-start URL. A message notification opens that exact chat; a friend
  // request opens the Requests tab.
  useEffect(() => {
    const openTarget = async (targetUrl) => {
      let parsed
      try {
        parsed = new URL(targetUrl, window.location.origin)
      } catch {
        return
      }
      if (parsed.searchParams.get('open') === 'requests') {
        setShowAddFriendModal(true)
        setFriendModalTab('requests')
        return
      }
      const roomId = parsed.searchParams.get('room')
      if (!roomId) return
      await fetchConversations()
      const conv = useChatStore.getState().conversations
        .find((c) => sameId(c.id, roomId))
      if (conv) {
        await selectConversation(conv)
        setMobileView('chat')
        scrollToBottom(false)
      }
    }

    const onServiceWorkerMessage = (event) => {
      if (event.data?.type === 'JDLX_CHAT_OPEN_REQUESTS') {
        setShowAddFriendModal(true)
        setFriendModalTab('requests')
      } else if (event.data?.type === 'JDLX_CHAT_OPEN_URL') {
        openTarget(event.data.url)
      }
    }
    const onNativePush = (event) => openTarget(event.detail?.url)

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage)
    }
    window.addEventListener('jdlx:chat-push-nav', onNativePush)

    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('open') === 'requests' || params.get('room')) {
        const target = window.location.href
        window.history.replaceState({}, document.title, window.location.pathname)
        openTarget(target)
      }
    } catch {
      /* ignore malformed URL */
    }

    return () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onServiceWorkerMessage)
      }
      window.removeEventListener('jdlx:chat-push-nav', onNativePush)
    }
  }, [fetchConversations, selectConversation, scrollToBottom])

  // 3. Scroll to bottom when messages update
  // Only scroll for a NEW last message. Prepending an older page keeps the
  // same last id, so loading history no longer yanks the user back to the
  // bottom before they can read it.
  useEffect(() => {
    const lastId = messages.length ? messages[messages.length - 1].id : null
    if (lastId == null) {
      lastRenderedMessageIdRef.current = null
      return
    }
    const previousId = lastRenderedMessageIdRef.current
    lastRenderedMessageIdRef.current = lastId
    if (!sameId(previousId, lastId)) {
      if (showScrollBottomFab) {
        setUnreadBelowCount((c) => c + 1)
      } else {
        scrollToBottom(previousId != null)
      }
    }
  }, [messages, scrollToBottom, showScrollBottomFab])

  // 3b. Keep the newest message in view while a freshly opened chat settles.
  // After a refresh the first paint grows underneath us (attachment thumbnails,
  // media players and decrypted bubbles replacing "Tap to decrypt"
  // placeholders), which pushes the latest message below the fold and makes the
  // page look like it scrolled up on its own. Re-pin briefly, and stop at once
  // if the user scrolls up so reading history is never fought.
  useEffect(() => {
    if (!activeRoomId || !messages.length) return
    const el = messagesContainerRef.current
    if (!el) return

    const state = pinStateRef.current
    if (!sameId(state.roomId, activeRoomId)) {
      state.roomId = activeRoomId
      state.active = false
    }
    if (!state.active) {
      // Only pin an update that arrives while we are already at the bottom;
      // if the user is reading history, leave them where they are.
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distance > 220) return
      state.active = true
      state.expectedTop = el.scrollTop
    }

    let raf = 0
    const startedAt = Date.now()
    const pin = () => {
      if (!state.active) return
      // Unchanged scrollTop = the layout grew above us (cached list replaced by
      // the server page, images/decryption settling) -> stay at the bottom.
      // Smaller scrollTop = the user scrolled up -> stop immediately.
      if (el.scrollTop < state.expectedTop - 40) {
        state.active = false
        return
      }
      state.expectedTop = el.scrollHeight - el.clientHeight
      el.scrollTop = state.expectedTop
      // The room's server page can take seconds to arrive and replace the
      // short cached list, so keep watching well past first paint.
      if (Date.now() - startedAt < 8000) raf = requestAnimationFrame(pin)
    }
    pin()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [activeRoomId, mobileView, messages.length])

  // Sound Effects preference: chime once for a new incoming message in the
  // open room. Room switches and older-page merges are treated as baseline.
  useEffect(() => {
    const last = messages.length ? messages[messages.length - 1] : null
    if (!activeRoomId || !last || last.id == null) return

    const previous = lastSoundEventRef.current
    const roomChanged = !sameId(previous.roomId, activeRoomId)
    const isNewMessage = !roomChanged && !sameId(previous.id, last.id)
    lastSoundEventRef.current = { roomId: activeRoomId, id: last.id }

    if (!isNewMessage || !chatSounds) return
    if (sameId(last.user_id, chatUser?.id)) return
    if (mutedRooms.includes(activeRoomId)) return
    playChatSound()
  }, [messages, activeRoomId, chatUser?.id, chatSounds, playChatSound, mutedRooms])

  // Android hardware back: close overlays, then leave the open chat for the
  // conversation list, and only exit the app from the list itself.
  const backHandlerStateRef = useRef({})
  useEffect(() => {
    backHandlerStateRef.current = {
      selectedPreviewImage,
      showContactInfoModal,
      showPwaInstallModal,
      showReportModal,
      showNotificationsDrawer,
      showProfileDrawer,
      showAddFriendModal,
      actionMessage,
      editingId,
      showMenu,
      mobileView
    }
  })

  useEffect(() => {
    if (!isCapacitorNative()) return undefined
    let handle = null
    let active = true

    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        const listener = await App.addListener('backButton', () => {
          const s = backHandlerStateRef.current
          if (s.selectedPreviewImage) { handleClosePreview(); return }
          if (s.showContactInfoModal) { setShowContactInfoModal(false); return }
          if (s.showPwaInstallModal) { setShowPwaInstallModal(false); return }
          if (s.showReportModal) { setShowReportModal(false); return }
          if (s.showNotificationsDrawer) { setShowNotificationsDrawer(false); return }
          if (s.showProfileDrawer) { setShowProfileDrawer(false); return }
          if (s.showAddFriendModal) { setShowAddFriendModal(false); return }
          if (s.actionMessage) { setActionMessage(null); return }
          if (s.editingId) { setEditingId(null); setEditDraft(''); return }
          if (s.showMenu) { setShowMenu(false); return }
          if (s.mobileView === 'chat') { setMobileView('list'); return }
          App.exitApp()
        })
        if (!active) {
          listener.remove().catch(() => {})
        } else {
          handle = listener
        }
      } catch (e) {
        console.warn('Android back handler unavailable:', e)
      }
    })()

    return () => {
      active = false
      if (handle) {
        handle.remove().catch(() => {})
      }
    }
  }, [])

  // 5. Select a conversation thread
  const handleSelectConversation = (conv) => {
    if (!conv) return
    triggerHaptic('light')
    if (activeRoomId && !sameId(activeRoomId, conv.id)) {
      updateDraft(activeRoomId, inputText)
    }
    const savedDraft = drafts[conv.id] || ''
    setInputText(savedDraft)
    setShowAttachmentTray(false)
    setMobileView('chat')
    selectConversation(conv)
    setTimeout(() => {
      adjustTextareaHeight()
      scrollToBottom(false)
    }, 20)
  }

  // 6. Send message in active room
  const isSendingRef = useRef(false)

  const submitReport = async () => {
    const targetId = activeConversation?.other_user?.id
    if (!targetId) return
    const ok = await reportUser({
      userId: targetId,
      roomId: activeRoomId,
      reason: reportReason,
      details: reportDetails
    })
    setShowReportModal(false)
    setReportDetails('')
    if (ok) toast.success('Report submitted. Our team will review it.')
    else toast.error('Could not submit report')
  }

  const handleSendMessage = async (e) => {
    if (e) e.preventDefault()
    const trimmed = inputText.trim()
    if (!trimmed) return

    triggerHaptic('light')

    if (!activeRoomId) {
      toast.error('Please select a conversation first')
      return
    }

    // If currently editing a previously sent message
    if (editingId) {
      const targetId = editingId
      setEditingId(null)
      setInputText('')
      updateDraft(activeRoomId, '')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      const ok = await editMessage(targetId, trimmed)
      if (ok) toast.success('Message edited')
      else toast.error('Could not edit message')
      return
    }

    const replyToId = replyTo?.id || null
    const pendingReply = replyTo
    setInputText('')
    setReplyTo(null)
    updateDraft(activeRoomId, '')
    setShowAttachmentTray(false)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    try {
      const result = await sendRoomMessage(activeRoomId, trimmed, null, 'text', replyToId)
      if (!result.success) {
        // Never silently lose the draft: put it back if the send failed.
        setInputText((current) => current || trimmed)
        updateDraft(activeRoomId, trimmed)
        setReplyTo((current) => current || pendingReply)
        setTimeout(() => adjustTextareaHeight(), 50)
        toast.error(result.error || 'Failed to send message')
      } else {
        scrollToBottom(true)
      }
    } catch (err) {
      console.warn('handleSendMessage error:', err)
    }
  }

  const handleRetryMessage = async (failedMsg) => {
    if (!failedMsg || !activeRoomId) return
    useChatStore.setState((state) => ({
      messages: state.messages.filter((m) => !sameId(m.id, failedMsg.id))
    }))
    await sendRoomMessage(
      activeRoomId,
      failedMsg.message,
      failedMsg.media_url,
      failedMsg.message_type,
      failedMsg.reply_to_id
    )
  }

  // 7. Image attachment upload & rotation helper
  // WhatsApp-grade client-side adaptive compression (1280px max, quality 0.74,
  // 320KB target) - drops multi-megabyte photos to ~150KB for fast transfer.
  const compressImageFile = async (file) => {
    return compressImageForChat(file, {
      maxDimension: 1280,
      initialQuality: 0.74,
      secondaryQuality: 0.65,
      maxByteThreshold: 320 * 1024,
    })
  }

  const applyRotationToFile = async (file, degrees) => {
    if (!degrees || degrees % 360 === 0) return file
    return new Promise((resolve) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        const rad = (degrees * Math.PI) / 180
        const is90or270 = degrees % 180 !== 0
        const canvas = document.createElement('canvas')
        canvas.width = is90or270 ? img.naturalHeight : img.naturalWidth
        canvas.height = is90or270 ? img.naturalWidth : img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(file)
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate(rad)
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
        canvas.toBlob((blob) => {
          if (!blob) return resolve(file)
          const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg'
          resolve(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }))
        }, 'image/jpeg', 0.92)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        resolve(file)
      }
      img.src = url
    })
  }

  // Pass the room explicitly for batch uploads so switching conversations
  // mid-upload cannot redirect later files into the new room.
  const uploadChatMedia = async (file, kind, customCaption = null, targetRoomId = null) => {
    if (isBlockedConversation) {
      toast.error('Unblock this user to send attachments')
      return
    }
    const roomId = targetRoomId || activeRoomId
    if (!roomId) {
      toast.error('Please select a conversation first')
      return
    }
    setUploadingImage(true)
    const formData = new FormData()
    formData.append('file', file)
    // Uploads are bound to the room the user is chatting in (server validates
    // participation and uses it to garbage-collect unreferenced files).
    formData.append('room_id', String(roomId))
    formData.append('kind', kind)

    try {
      const res = await apiFetch('/chat/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chatToken}` },
        body: formData
      })
      const json = await res.json()
      if (res.ok && json.success && json.data?.url) {
        const defaultCaptions = {
          image: '',
          audio: 'Sent an audio attachment',
          video: 'Sent a video attachment',
          document: 'Sent a document attachment'
        }
        const finalMessage = (customCaption && customCaption.trim())
          ? customCaption.trim()
          : (defaultCaptions[json.data.media_kind || kind] ?? '')

        await sendRoomMessage(
          roomId,
          finalMessage,
          json.data.url,
          json.data.media_kind || kind
        )
        scrollToBottom(true)
        return true
      }
      toast.error(json.message || 'Upload failed')
      return false
    } catch {
      toast.error('Network error during upload')
      return false
    } finally {
      setUploadingImage(false)
    }
  }

  const uploadSingleMediaWithProgress = useCallback((optimisticMsg) => {
    if (isBlockedConversation) {
      toast.error('Unblock this user to send attachments')
      return
    }
    const { id: tempId, _rawFile: file, _kind: kind, _caption: customCaption, room_id: targetRoomId } = optimisticMsg
    if (!file || !targetRoomId) return

    const formData = new FormData()
    formData.append('file', file)
    formData.append('room_id', String(targetRoomId))
    formData.append('kind', kind || 'image')

    const markFailed = (message) => {
      if (cancelledUploadsRef.current.has(tempId)) {
        cancelledUploadsRef.current.delete(tempId)
        return
      }
      updateMessageUploadState(tempId, { _uploading: false, _uploadFailed: true })
      toast.error(message)
    }

    const startUpload = (authToken, isRetry = false) => {
      if (!authToken || cancelledUploadsRef.current.has(tempId)) return

      updateMessageUploadState(tempId, { _uploading: true, _uploadProgress: 0, _uploadFailed: false })

      const xhr = new XMLHttpRequest()
      activeUploadsRef.current[tempId] = xhr

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.min(98, Math.round((event.loaded / event.total) * 100))
          updateMessageUploadState(tempId, { _uploadProgress: percent })
        }
      }

      xhr.onload = async () => {
        delete activeUploadsRef.current[tempId]

        // The direct XHR bypasses apiFetch, so it must participate in the
        // same token rotation. On an expired access token, refresh once and
        // retry the same upload/bubble instead of failing.
        if (xhr.status === 401 && !isRetry) {
          let latestToken = null
          try {
            latestToken = localStorage.getItem('jdlx_chat_token')
          } catch { /* ignore storage error */ }

          if (!latestToken || latestToken === authToken) {
            const refreshResult = await refreshChatAccessToken()
            latestToken = refreshResult?.token || null
          }

          if (cancelledUploadsRef.current.has(tempId)) {
            cancelledUploadsRef.current.delete(tempId)
            return
          }
          if (latestToken && latestToken !== authToken) {
            startUpload(latestToken, true)
            return
          }
          markFailed('Session expired while uploading. Tap Retry to send again.')
          return
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText)
            if (json.success && json.data?.url) {
              cancelledUploadsRef.current.delete(tempId)
              updateMessageUploadState(tempId, { _uploadProgress: 100, _uploading: false, media_url: json.data.url })
              const defaultCaptions = {
                image: '',
                audio: 'Sent an audio attachment',
                video: 'Sent a video attachment',
                document: 'Sent a document attachment'
              }
              const finalMessage = (customCaption && customCaption.trim())
                ? customCaption.trim()
                : (defaultCaptions[json.data.media_kind || kind] ?? '')

              await sendRoomMessage(
                targetRoomId,
                finalMessage,
                json.data.url,
                json.data.media_kind || kind,
                null,
                tempId
              )
              scrollToBottom(true)
              return
            }
          } catch (err) {
            console.warn('Upload parse error:', err)
          }
        }

        markFailed(
          xhr.status === 401
            ? 'Session expired while uploading. Tap Retry to send again.'
            : 'Upload failed. Tap Retry on photo.'
        )
      }

      xhr.onerror = () => {
        delete activeUploadsRef.current[tempId]
        markFailed('Network error during upload. Tap Retry on photo.')
      }

      xhr.onabort = () => {
        delete activeUploadsRef.current[tempId]
      }

      xhr.open('POST', `${API_BASE_URL}/chat/upload`)
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`)
      xhr.send(formData)
    }

    startUpload(chatToken)
  }, [API_BASE_URL, chatToken, isBlockedConversation, sendRoomMessage, scrollToBottom, updateMessageUploadState])

  const handleRetryUpload = useCallback((msg) => {
    if (!msg || !msg._rawFile) {
      toast.error('Cannot retry. Please re-select the image.')
      return
    }
    cancelledUploadsRef.current.delete(msg.id)
    uploadSingleMediaWithProgress(msg)
  }, [uploadSingleMediaWithProgress])

  const handleCancelUpload = useCallback((tempId) => {
    cancelledUploadsRef.current.add(tempId)
    if (activeUploadsRef.current[tempId]) {
      try { activeUploadsRef.current[tempId].abort() } catch {}
      delete activeUploadsRef.current[tempId]
    }
    removeOptimisticMessage(tempId)
    toast('Upload cancelled', { icon: '🗑️' })
  }, [removeOptimisticMessage])

  // ── PRE-SEND IMAGE PREVIEW & CAPTION MODAL HANDLERS ──
  const openImageSendPreview = async (files) => {
    if (isBlockedConversation) {
      toast.error('Unblock this user to send attachments')
      return
    }
    const fileList = Array.isArray(files) ? files : [files]
    if (!fileList.length) return
    const newItems = await Promise.all(
      fileList.map(async (file, idx) => {
        const url = URL.createObjectURL(file)
        const dims = await new Promise((res) => {
          const img = new Image()
          img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight })
          img.onerror = () => res({ width: 0, height: 0 })
          img.src = url
        })
        return {
          id: `img-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          file,
          url,
          rotation: 0,
          caption: '',
          width: dims.width,
          height: dims.height,
          size: file.size,
        }
      })
    )

    setImageSendModal((prev) => {
      if (prev && prev.items) {
        return {
          ...prev,
          items: [...prev.items, ...newItems],
        }
      }
      return {
        items: newItems,
        activeIndex: 0,
        showEmoji: false,
      }
    })
  }

  const handleCloseImageSendModal = useCallback(() => {
    setImageSendModal((prev) => {
      if (prev?.items) {
        prev.items.forEach((item) => {
          try { URL.revokeObjectURL(item.url) } catch {}
        })
      }
      return null
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (addMoreImagesInputRef.current) addMoreImagesInputRef.current.value = ''
  }, [])

  const handleRotateActiveImage = useCallback(() => {
    setImageSendModal((prev) => {
      if (!prev || !prev.items[prev.activeIndex]) return prev
      const nextItems = [...prev.items]
      const cur = nextItems[prev.activeIndex]
      nextItems[prev.activeIndex] = {
        ...cur,
        rotation: (cur.rotation + 90) % 360,
      }
      return { ...prev, items: nextItems }
    })
  }, [])

  // Pre-Send Image Preview keyboard controls: ESC to dismiss, R to rotate
  useEffect(() => {
    if (!imageSendModal) return undefined
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleCloseImageSendModal()
      } else if ((e.key === 'r' || e.key === 'R') && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        handleRotateActiveImage()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [imageSendModal, handleCloseImageSendModal, handleRotateActiveImage])

  const handleCaptionChange = (val) => {
    setImageSendModal((prev) => {
      if (!prev || !prev.items[prev.activeIndex]) return prev
      const nextItems = [...prev.items]
      nextItems[prev.activeIndex] = {
        ...nextItems[prev.activeIndex],
        caption: val,
      }
      return { ...prev, items: nextItems }
    })
  }

  const handleRemovePreviewImage = (indexToRemove) => {
    setImageSendModal((prev) => {
      if (!prev) return null
      const target = prev.items[indexToRemove]
      if (target) {
        try { URL.revokeObjectURL(target.url) } catch {}
      }
      const nextItems = prev.items.filter((_, i) => i !== indexToRemove)
      if (!nextItems.length) {
        if (fileInputRef.current) fileInputRef.current.value = ''
        if (addMoreImagesInputRef.current) addMoreImagesInputRef.current.value = ''
        return null
      }
      const nextActive = Math.min(prev.activeIndex, nextItems.length - 1)
      return {
        ...prev,
        items: nextItems,
        activeIndex: nextActive,
      }
    })
  }

  const handleAddMoreImages = (e) => {
    if (isBlockedConversation) {
      toast.error('Unblock this user to send attachments')
      return
    }
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length) {
      openImageSendPreview(imageFiles)
    }
    if (addMoreImagesInputRef.current) addMoreImagesInputRef.current.value = ''
  }

  const handleConfirmSendImages = async () => {
    if (isBlockedConversation) {
      toast.error('Unblock this user to send attachments')
      handleCloseImageSendModal()
      return
    }
    if (!imageSendModal || !activeRoomId) return
    if (isSendingRef.current) return
    isSendingRef.current = true

    try {
      const itemsToSend = [...imageSendModal.items]
      const currentTargetRoomId = activeRoomId
      handleCloseImageSendModal()

      for (const item of itemsToSend) {
      try {
        let fileToProcess = item.file
        if (item.rotation % 360 !== 0) {
          fileToProcess = await applyRotationToFile(fileToProcess, item.rotation)
        }
        const compressedFile = await compressImageFile(fileToProcess)
        const localBlobUrl = URL.createObjectURL(compressedFile)
        const tempId = -Date.now() - Math.floor(Math.random() * 100000)

        const optimisticMsg = {
          id: tempId,
          room_id: currentTargetRoomId,
          user_id: chatUser?.id,
          sender_type: 'user',
          sender_name: chatUser?.name || 'You',
          username: chatUser?.username,
          message: item.caption?.trim() || '',
          media_url: localBlobUrl,
          message_type: 'image',
          created_at: new Date().toISOString(),
          is_read: 0,
          _pending: true,
          _uploading: true,
          _uploadProgress: 0,
          _uploadFailed: false,
          _rawFile: compressedFile,
          _caption: item.caption?.trim() || '',
          _kind: 'image',
        }

        addOptimisticMediaMessage(optimisticMsg)
        scrollToBottom(true)

        // Upload in background with circular progress ring
        uploadSingleMediaWithProgress(optimisticMsg)
      } catch (err) {
        console.warn('Error processing image:', err)
        toast.error('Failed to prepare image for sending')
        }
      }
    } finally {
      isSendingRef.current = false
    }
  }

  const CHAT_MEDIA_LIMITS = { audio: 15, video: 30, document: 20 }

  const getChatMediaKind = (file) => {
    if (!file) return null
    const type = file.type || ''
    const name = (file.name || '').toLowerCase()
    if (type.startsWith('image/')) return 'image'
    if (type.startsWith('audio/')) return 'audio'
    if (type.startsWith('video/')) return 'video'
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'document'
    return null
  }

  // Shared by the file picker and drag-drop: process every selected file, not
  // just the first one. Images keep the existing preview/caption flow; other
  // supported files are validated per file and uploaded sequentially.
  const processSelectedMediaFiles = async (files) => {
    if (isBlockedConversation) {
      toast.error('Unblock this user to send attachments')
      return
    }
    if (!activeRoomId) {
      toast.error('Please select a conversation first')
      return
    }

    const list = Array.from(files || [])
    if (!list.length) return

    // Anchor the whole batch to the conversation that was open on selection.
    const targetRoomId = activeRoomId
    const imageFiles = []
    const mediaFiles = []
    const oversized = []
    const unsupported = []

    list.forEach((file) => {
      const kind = getChatMediaKind(file)
      if (!kind) {
        unsupported.push(file)
        return
      }
      if (kind === 'image') {
        imageFiles.push(file)
        return
      }
      if (file.size > CHAT_MEDIA_LIMITS[kind] * 1024 * 1024) {
        oversized.push({ file, kind })
        return
      }
      mediaFiles.push({ file, kind })
    })

    if (oversized.length) {
      const { file, kind } = oversized[0]
      const label = kind === 'audio' ? 'Audio' : kind === 'video' ? 'Video' : 'Document'
      const extra = oversized.length > 1 ? ` (+${oversized.length - 1} more skipped)` : ''
      toast.error(`${label} size must be under ${CHAT_MEDIA_LIMITS[kind]}MB: ${file.name}${extra}`)
    }

    if (!imageFiles.length && !mediaFiles.length) {
      if (unsupported.length) {
        toast.error('Only images, audio, video or PDF documents are supported')
      }
      return
    }

    if (unsupported.length) {
      toast.error(`${unsupported.length} unsupported file${unsupported.length > 1 ? 's were' : ' was'} skipped`)
    }

    if (imageFiles.length) {
      await openImageSendPreview(imageFiles)
    }

    for (const { file, kind } of mediaFiles) {
      await uploadChatMedia(file, kind, null, targetRoomId)
    }
  }

  const handleMediaSelect = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    try {
      await processSelectedMediaFiles(files)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handlePaste = useCallback(async (e) => {
    if (!activeRoomId || isBlockedConversation || uploadingImage || imageSendModal) return
    const items = e.clipboardData?.items
    if (!items || !items.length) return
    const imageFiles = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          const namedFile = new File([file], `screenshot_${Date.now()}.png`, { type: file.type })
          imageFiles.push(namedFile)
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      await openImageSendPreview(imageFiles)
    }
  }, [activeRoomId, isBlockedConversation, uploadingImage, imageSendModal, openImageSendPreview])

  // Window-level paste listener: Catch screenshots / Ctrl+V even when textarea isn't focused
  useEffect(() => {
    if (!activeRoomId) return undefined

    const handleWindowPaste = async (e) => {
      if (isBlockedConversation || imageSendModal || uploadingImage) return

      // Don't intercept if user is typing into other inputs like search or settings
      const activeEl = document.activeElement
      if (
        activeEl &&
        activeEl !== textareaRef.current &&
        (activeEl.tagName === 'INPUT' || (activeEl.tagName === 'TEXTAREA' && activeEl !== textareaRef.current))
      ) {
        return
      }

      const items = e.clipboardData?.items
      if (!items || !items.length) return

      const imageFiles = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            const namedFile = new File([file], `screenshot_${Date.now()}.png`, { type: file.type })
            imageFiles.push(namedFile)
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault()
        await openImageSendPreview(imageFiles)
      }
    }

    window.addEventListener('paste', handleWindowPaste)
    return () => window.removeEventListener('paste', handleWindowPaste)
  }, [activeRoomId, isBlockedConversation, imageSendModal, uploadingImage, openImageSendPreview])

  // Desktop Drag & Drop: Drag files over chat window to reveal luxury dropzone
  useEffect(() => {
    if (!activeRoomId || isBlockedConversation) return undefined

    const handleWindowDragEnter = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
        dragCounterRef.current += 1
        setIsDraggingOver(true)
      }
    }

    const handleWindowDragOver = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    const handleWindowDragLeave = (e) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current -= 1
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0
        setIsDraggingOver(false)
      }
    }

    const handleWindowDrop = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDraggingOver(false)

      if (!activeRoomId || imageSendModal) return
      const files = Array.from(e.dataTransfer?.files || [])
      if (!files.length) return

      await processSelectedMediaFiles(files)
    }

    window.addEventListener('dragenter', handleWindowDragEnter)
    window.addEventListener('dragover', handleWindowDragOver)
    window.addEventListener('dragleave', handleWindowDragLeave)
    window.addEventListener('drop', handleWindowDrop)

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter)
      window.removeEventListener('dragover', handleWindowDragOver)
      window.removeEventListener('dragleave', handleWindowDragLeave)
      window.removeEventListener('drop', handleWindowDrop)
    }
  }, [activeRoomId, isBlockedConversation, imageSendModal, processSelectedMediaFiles])

  const releaseRecordingStream = () => {
    const stream = activeRecordingStreamRef.current
    activeRecordingStreamRef.current = null
    if (stream) {
      try { stream.getTracks().forEach((track) => track.stop()) } catch {}
    }
  }

  const startVoiceRecording = async () => {
    if (isBlockedConversation) {
      toast.error('Unblock this user to send voice notes')
      return
    }
    if (!activeRoomId) {
      toast.error('Please select a conversation first')
      return
    }
    if (
      typeof navigator === 'undefined'
      || !navigator.mediaDevices?.getUserMedia
      || typeof MediaRecorder === 'undefined'
    ) {
      toast.error('Voice recording is not supported in this browser')
      return
    }
    // Discard any previous un-sent voice review
    if (voiceReview?.url) {
      try { URL.revokeObjectURL(voiceReview.url) } catch {}
      setVoiceReview(null)
    }
    let stream = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      activeRecordingStreamRef.current = stream
      // Prefer audio/mp4 (AAC) for universal playback on iOS Safari, Android, and Desktop,
      // falling back to audio/webm or audio/ogg if unsupported.
      const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
      let preferred = ''
      for (const mime of candidates) {
        if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mime)) {
          preferred = mime
          break
        }
      }
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined)
      recordingChunksRef.current = []
      isCancelledRecordingRef.current = false
      isReviewingRef.current = false

      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data)
      }
      recorder.onstop = async () => {
        try { stream.getTracks().forEach((track) => track.stop()) } catch {}
        if (activeRecordingStreamRef.current === stream) activeRecordingStreamRef.current = null
        if (isCancelledRecordingRef.current) {
          isCancelledRecordingRef.current = false
          recordingChunksRef.current = []
          return
        }
        const mimeType = recorder.mimeType || (recordingChunksRef.current[0] && recordingChunksRef.current[0].type) || 'audio/mp4'
        const blob = new Blob(recordingChunksRef.current, { type: mimeType })
        if (blob.size) {
          const lower = mimeType.toLowerCase()
          const ext = (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac'))
            ? 'm4a'
            : lower.includes('ogg')
              ? 'ogg'
              : 'webm'
          const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type || (ext === 'm4a' ? 'audio/mp4' : 'audio/webm') })

          if (isReviewingRef.current) {
            isReviewingRef.current = false
            const url = URL.createObjectURL(blob)
            setVoiceReview({
              file,
              url,
              duration: currentDurationRef.current || 0,
              isPlaying: false,
              currentTime: 0,
            })
          } else {
            await uploadChatMedia(file, 'audio')
          }
        }
      }

      recorder.start()
      triggerHaptic('medium')
      mediaRecorderRef.current = recorder
      setIsRecording(true)
      setRecordingDuration(0)
      currentDurationRef.current = 0
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((prev) => {
          const next = prev + 1
          currentDurationRef.current = next
          return next
        })
      }, 1000)
    } catch (err) {
      try { stream?.getTracks().forEach((track) => track.stop()) } catch {}
      if (activeRecordingStreamRef.current === stream) activeRecordingStreamRef.current = null
      const name = err?.name || ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        toast.error('Microphone permission denied')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        toast.error('No microphone found on this device')
      } else if (name === 'NotSupportedError' || name === 'NotReadableError') {
        toast.error('Microphone is busy or not supported')
      } else {
        toast.error('Could not start recording. Please try again.')
      }
      console.warn('Voice recording error:', err)
    }
  }

  // Stop recording to review (WhatsApp Pause/Review feature)
  const stopVoiceRecordingToReview = () => {
    isReviewingRef.current = true
    setIsVoiceLocked(false)
    setVoiceSlideX(0)
    setVoiceSlideY(0)
    isTouchRecordingRef.current = false
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    try {
      mediaRecorderRef.current?.stop()
    } catch {
      /* ignore */
    }
    mediaRecorderRef.current = null
    releaseRecordingStream()
    setIsRecording(false)
    setRecordingDuration(0)
  }

  const stopVoiceRecording = () => {
    triggerHaptic('light')
    isReviewingRef.current = false
    setIsVoiceLocked(false)
    setVoiceSlideX(0)
    setVoiceSlideY(0)
    isTouchRecordingRef.current = false
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    try {
      mediaRecorderRef.current?.stop()
    } catch {
      /* ignore */
    }
    mediaRecorderRef.current = null
    releaseRecordingStream()
    setIsRecording(false)
    setRecordingDuration(0)
  }

  const cancelVoiceRecording = () => {
    triggerHaptic('error')
    isCancelledRecordingRef.current = true
    isReviewingRef.current = false
    setIsVoiceLocked(false)
    setVoiceSlideX(0)
    setVoiceSlideY(0)
    isTouchRecordingRef.current = false
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    try {
      mediaRecorderRef.current?.stop()
    } catch {
      /* ignore */
    }
    mediaRecorderRef.current = null
    releaseRecordingStream()
    setIsRecording(false)
    setRecordingDuration(0)
    toast('Recording cancelled', { icon: '🗑️' })
  }

  // Mobile Voice Gestures: Hold-to-speak, Slide-to-cancel, Slide-up Lock
  const handleMicTouchStart = (e) => {
    if (uploadingImage || isBlockedConversation) return
    const touch = e.touches[0]
    voiceTouchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
    isTouchRecordingRef.current = true
    setIsVoiceLocked(false)
    setVoiceSlideX(0)
    setVoiceSlideY(0)
    startVoiceRecording()
  }

  const handleMicTouchMove = (e) => {
    if (!isTouchRecordingRef.current || isVoiceLocked || e.touches.length !== 1) return
    const touch = e.touches[0]
    const deltaX = touch.clientX - voiceTouchStartRef.current.x
    const deltaY = touch.clientY - voiceTouchStartRef.current.y

    // Left slide to cancel:
    if (deltaX < 0) {
      setVoiceSlideX(deltaX)
      if (deltaX <= -80) {
        isTouchRecordingRef.current = false
        setIsVoiceLocked(false)
        setVoiceSlideX(0)
        setVoiceSlideY(0)
        cancelVoiceRecording()
        return
      }
    } else {
      setVoiceSlideX(0)
    }

    // Upward slide to lock:
    if (deltaY < 0) {
      setVoiceSlideY(deltaY)
      if (deltaY <= -55) {
        setIsVoiceLocked(true)
        triggerHaptic('medium')
        setVoiceSlideX(0)
        setVoiceSlideY(0)
        return
      }
    } else {
      setVoiceSlideY(0)
    }
  }

  const handleMicTouchEnd = () => {
    if (!isTouchRecordingRef.current) return
    isTouchRecordingRef.current = false
    setVoiceSlideX(0)
    setVoiceSlideY(0)

    if (isVoiceLocked) {
      return
    }

    const duration = Date.now() - voiceTouchStartRef.current.time
    if (duration < 380) {
      // Tap: keep hands-free recording active
      setIsVoiceLocked(true)
      triggerHaptic('light')
    } else {
      // Hold-to-talk release: send immediately!
      stopVoiceRecording()
    }
  }

  // Review mode handlers
  const discardVoiceReview = () => {
    if (voiceReview?.url) {
      try { URL.revokeObjectURL(voiceReview.url) } catch {}
    }
    if (reviewAudioRef.current) {
      try { reviewAudioRef.current.pause() } catch {}
    }
    setVoiceReview(null)
    setReviewPlaybackRate(1)
    toast('Voice note discarded', { icon: '🗑️' })
  }

  // Discard voice review on Escape key
  useEffect(() => {
    if (!voiceReview) return undefined
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        discardVoiceReview()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [voiceReview])

  // Release the microphone if the screen unmounts mid-recording.
  useEffect(() => () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    try { activeRecordingStreamRef.current?.getTracks().forEach((track) => track.stop()) } catch {}
    activeRecordingStreamRef.current = null
  }, [])

  // Clean up active voice review when switching conversation
  useEffect(() => {
    if (voiceReview?.url) {
      try { URL.revokeObjectURL(voiceReview.url) } catch {}
      setVoiceReview(null)
    }
  }, [activeRoomId])

  const sendReviewedVoiceNote = async () => {
    if (!voiceReview?.file) return
    const fileToSend = voiceReview.file
    const urlToRevoke = voiceReview.url
    if (reviewAudioRef.current) {
      try { reviewAudioRef.current.pause() } catch {}
    }
    setVoiceReview(null)
    setReviewPlaybackRate(1)
    try {
      await uploadChatMedia(fileToSend, 'audio')
    } finally {
      try { URL.revokeObjectURL(urlToRevoke) } catch {}
    }
  }

  const toggleReviewPlay = () => {
    if (!reviewAudioRef.current) return
    if (voiceReview?.isPlaying) {
      reviewAudioRef.current.pause()
      setVoiceReview((prev) => prev ? { ...prev, isPlaying: false } : null)
    } else {
      reviewAudioRef.current.play().then(() => {
        setVoiceReview((prev) => prev ? { ...prev, isPlaying: true } : null)
      }).catch((e) => console.warn('Review playback error:', e))
    }
  }

  const handleReviewScrub = (e) => {
    if (!reviewAudioRef.current || !voiceReview) return
    const rect = e.currentTarget.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const percent = Math.max(0, Math.min(1, clickX / rect.width))
    const total = voiceReview.duration || reviewAudioRef.current.duration || 1
    const targetTime = percent * total
    if (!isNaN(targetTime) && isFinite(targetTime)) {
      reviewAudioRef.current.currentTime = targetTime
      setVoiceReview((prev) => prev ? { ...prev, currentTime: targetTime } : null)
    }
  }

  const cycleReviewSpeed = (e) => {
    e?.stopPropagation?.()
    const rates = [1, 1.5, 2]
    const nextIdx = (rates.indexOf(reviewPlaybackRate) + 1) % rates.length
    const nextRate = rates[nextIdx]
    setReviewPlaybackRate(nextRate)
    if (reviewAudioRef.current) {
      reviewAudioRef.current.playbackRate = nextRate
    }
  }

  // 8. Global User Search in Add Friend modal
  const handleGlobalSearch = async (e) => {
    if (e) e.preventDefault()
    const trimmed = globalSearchQuery.trim()
    if (!trimmed) return

    setSearchingGlobal(true)
    try {
      const results = await searchUsers(trimmed)
      setGlobalSearchResults(results || [])
    } finally {
      setSearchingGlobal(false)
    }
  }

  // Live debounced search as user types in Add Friend modal
  useEffect(() => {
    const trimmed = globalSearchQuery.trim()
    if (!trimmed) {
      setGlobalSearchResults([])
      setSearchingGlobal(false)
      return
    }

    if (trimmed.length < 2) {
      setGlobalSearchResults([])
      setSearchingGlobal(false)
      return
    }

    setSearchingGlobal(true)
    const timer = setTimeout(async () => {
      try {
        const results = await searchUsers(trimmed)
        setGlobalSearchResults(results || [])
      } catch (err) {
        console.error('Live user search failed:', err)
      } finally {
        setSearchingGlobal(false)
      }
    }, 280)

    return () => clearTimeout(timer)
  }, [globalSearchQuery, searchUsers])

  // 9. Send Friend Request
  const handleSendFriendRequest = async (targetUser) => {
    setRequestActionLoading(targetUser.id)
    try {
      const res = await sendFriendRequest(targetUser.id, targetUser.username)
      if (res.success) {
        toast.success(`Friend request sent to @${targetUser.username}!`)
        // Update local search results to show pending
        setGlobalSearchResults((prev) =>
          prev.map((u) => (sameId(u.id, targetUser.id) ? { ...u, friend_status: 'pending_sent' } : u))
        )
      } else {
        toast.error(res.error || 'Failed to send request')
      }
    } finally {
      setRequestActionLoading(null)
    }
  }

  // 10. Respond to Friend Request (Accept / Decline)
  const handleRespondRequest = async (reqId, action) => {
    setRequestActionLoading(reqId)
    try {
      const res = await respondFriendRequest(reqId, action)
      if (res.success) {
        if (action === 'accept') {
          toast.success('Friend connected! Starting chat...')
          setShowAddFriendModal(false)
          if (res.data?.room_id) {
            await fetchConversations()
            const matching = useChatStore.getState().conversations.find((c) => sameId(c.id, res.data.room_id))
            if (matching) {
              await handleSelectConversation(matching)
            }
          }
        } else {
          toast('Request declined', { icon: 'ℹ️' })
        }
      } else {
        toast.error(res.error || 'Action failed')
      }
    } finally {
      setRequestActionLoading(null)
    }
  }

  // 11. Open direct 1-to-1 chat immediately with a user
  const [startingChatUserId, setStartingChatUserId] = useState(null)
  const handleDirectChatStart = async (targetUser) => {
    if (!targetUser?.id || sameId(startingChatUserId, targetUser.id)) return

    // Instant local shortcut: if conversation already in state, switch in 0ms without waiting!
    const existing = conversations.find((c) =>
      sameId(c.other_user?.id, targetUser.id) ||
      sameId(c.user_two_id, targetUser.id) ||
      c.contact_username === targetUser.username
    )
    if (existing) {
      setShowAddFriendModal(false)
      handleSelectConversation(existing)
      return
    }

    setStartingChatUserId(targetUser.id)
    try {
      const res = await openDirectChat(targetUser.id)
      if (res.success && res.conversation) {
        setShowAddFriendModal(false)
        setMobileView('chat')
        scrollToBottom(false)
        toast.success(`Chat opened with @${targetUser.username}!`, { icon: '💬' })
      } else {
        toast.error(res.error || 'Could not open chat')
      }
    } finally {
      setStartingChatUserId(null)
    }
  }

  // 12. Handle clicking a notification in the Notifications Drawer
  const handleNotificationClick = async (n) => {
    if (!n) return

    // 1. Mark as read immediately if not already read
    if (!n.is_read) {
      markNotificationRead(n.id)
    }

    // 2. If notification has a room_id, navigate to that chat
    if (n.room_id) {
      let targetConv = conversations.find((c) => sameId(c.id, n.room_id))
      if (!targetConv) {
        await fetchConversations()
        targetConv = useChatStore.getState().conversations.find((c) => sameId(c.id, n.room_id))
      }

      if (targetConv) {
        setShowNotificationsDrawer(false)
        handleSelectConversation(targetConv)
        return
      }
    }

    // 3. If notification is about a Friend Request
    const lowerTitle = (n.title || '').toLowerCase()
    const lowerMsg = (n.message || '').toLowerCase()
    if (lowerTitle.includes('friend request') || lowerMsg.includes('friend request')) {
      setShowNotificationsDrawer(false)
      setShowAddFriendModal(true)
      setFriendModalTab('requests')
      fetchFriendsAndRequests()
      return
    }

    // 4. If notification mentions @username
    const usernameMatch = n.message?.match(/@([a-zA-Z0-9_\.]+)/)
    if (usernameMatch) {
      const uname = usernameMatch[1]
      let targetConv = conversations.find(
        (c) => (c.contact_username || '').toLowerCase() === uname.toLowerCase()
      )
      if (!targetConv) {
        await fetchConversations()
        targetConv = useChatStore.getState().conversations.find(
          (c) => (c.contact_username || '').toLowerCase() === uname.toLowerCase()
        )
      }
      if (targetConv) {
        setShowNotificationsDrawer(false)
        handleSelectConversation(targetConv)
        return
      }
    }

    // Otherwise, close drawer
    setShowNotificationsDrawer(false)
  }

  // 13. Copy Invite Link & Share
  const handleCopyInviteLink = () => {
    const link = inviteInfo?.invite_url || `${window.location.origin}/chat/login?ref=@${chatUser?.username || 'member'}`
    navigator.clipboard.writeText(link)
    toast.success('Invite link copied to clipboard!', { icon: '📋' })
  }

  const handleShareInviteWhatsapp = () => {
    const inviteUrl = inviteInfo?.invite_url || `${window.location.origin}/chat/login?ref=@${chatUser?.username || 'member'}`
    const text = inviteInfo?.share_text || `Hey! Chat with me on ${chatBrandName} – secure, encrypted messaging. Connect with @${chatUser?.username || 'member'} here: ${inviteUrl}`
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank')
  }

  const handleEnablePush = async () => {
    const res = await enablePushNotifications()
    if (res?.success) {
      setShowPushPrompt(false)
      toast.success('Notifications enabled for friend requests')
    } else {
      toast.error(res?.error || 'Could not enable notifications')
    }
  }

  const handleLogout = () => {
    chatLogout(true)
    navigate('/chat/login', { replace: true })
    toast.success(`Logged out from ${chatBrandName}`)
  }

  // Parse UTC timestamp reliably across all browsers and Android/iOS WebViews
  const parseUtcDate = (isoString) => {
    if (!isoString) return null
    let str = String(isoString).trim()
    if (!str) return null
    // If SQLite/Turso timestamp arrives as "YYYY-MM-DD HH:MM:SS" without "Z" or timezone
    if (!str.endsWith('Z') && !str.includes('+') && !str.includes('-', 10)) {
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(str)) {
        str = str.replace(' ', 'T') + 'Z'
      }
    }
    const d = new Date(str)
    return isNaN(d.getTime()) ? null : d
  }

  // Format timestamp inside active message bubbles: always show exact local device time (e.g. 12:04 pm)
  const formatMessageTime = (isoString) => {
    const d = parseUtcDate(isoString)
    if (!d) return ''
    try {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })
    } catch {
      return ''
    }
  }

  // Format timestamp for conversation list and notification feeds (smart Today / Yesterday / Date)
  const formatTime = (isoString) => {
    const d = parseUtcDate(isoString)
    if (!d) return ''
    try {
      const now = new Date()
      const isToday = d.toDateString() === now.toDateString()
      if (isToday) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })
      }
      const yesterday = new Date(now)
      yesterday.setDate(now.getDate() - 1)
      if (d.toDateString() === yesterday.toDateString()) {
        return 'Yesterday'
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    } catch {
      return ''
    }
  }

  // Format sticky floating date separator (Today, Yesterday, Mon, Nov 9, 2026)
  const formatMessageDateDivider = (isoString) => {
    const d = parseUtcDate(isoString)
    if (!d) return 'Today'
    try {
      const now = new Date()
      if (d.toDateString() === now.toDateString()) {
        return 'Today'
      }
      const yesterday = new Date(now)
      yesterday.setDate(now.getDate() - 1)
      if (d.toDateString() === yesterday.toDateString()) {
        return 'Yesterday'
      }
      const isSameYear = d.getFullYear() === now.getFullYear()
      return d.toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        ...(isSameYear ? {} : { year: 'numeric' })
      })
    } catch {
      return 'Today'
    }
  }

  // Filter & sort conversations in left pane (pinned chats on top + tab filter)
  const filteredConversations = useMemo(() => {
    let list = (conversations || []).filter((c) => {
      if (!conversationFilter.trim()) return true
      const q = conversationFilter.toLowerCase()
      return (
        (c.contact_name && c.contact_name.toLowerCase().includes(q)) ||
        (c.contact_username && c.contact_username.toLowerCase().includes(q)) ||
        (c.last_message && c.last_message.toLowerCase().includes(q))
      )
    })

    if (conversationTabFilter === 'unread') {
      list = list.filter((c) => (c.unread_count || 0) > 0)
    } else if (conversationTabFilter === 'pinned') {
      list = list.filter((c) => pinnedRoomIds.some((id) => sameId(id, c.id)))
    }

    return list.slice().sort((a, b) => {
      const aPinned = pinnedRoomIds.some((id) => sameId(id, a.id))
      const bPinned = pinnedRoomIds.some((id) => sameId(id, b.id))
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      return 0
    })
  }, [conversations, conversationFilter, conversationTabFilter, pinnedRoomIds])

  const unreadConversationsCount = useMemo(() => {
    return (conversations || []).filter((c) => (c.unread_count || 0) > 0).length
  }, [conversations])

  const pinnedConversationsCount = useMemo(() => {
    return (conversations || []).filter((c) => pinnedRoomIds.some((id) => sameId(id, c.id))).length
  }, [conversations, pinnedRoomIds])

  // Helper: Detect whether a message is a valid photo/image attachment
  const isChatImageMessage = useCallback((m) => {
    if (!m || !m.media_url) return false
    if (m.deleted || m.message_type === 'deleted') return false
    if (m._locked || m.message === '🔒 [Encrypted Message]') return false
    if (m.message_type === 'audio' || m.message_type === 'video' || m.message_type === 'document') return false
    const lowerUrl = String(m.media_url).toLowerCase()
    if (
      lowerUrl.endsWith('.pdf') ||
      lowerUrl.endsWith('.mp3') ||
      lowerUrl.endsWith('.wav') ||
      lowerUrl.endsWith('.ogg') ||
      lowerUrl.endsWith('.mp4') ||
      lowerUrl.endsWith('.webm')
    ) {
      return false
    }
    return true
  }, [])

  // Cluster consecutive image messages from same sender within 60s into Album / Collage clusters
  const groupedMessages = useMemo(() => {
    if (!messages || !messages.length) return []
    const result = []
    let i = 0
    while (i < messages.length) {
      const m = messages[i]
      const isImg = isChatImageMessage(m)

      if (!isImg) {
        result.push({
          type: 'single',
          id: m.id,
          message: m,
          messages: [m],
        })
        i++
        continue
      }

      // Look ahead for consecutive image messages from same sender within 60 seconds
      const album = [m]
      let j = i + 1
      while (j < messages.length) {
        const nextM = messages[j]
        if (!isChatImageMessage(nextM)) break
        const sameSender =
          sameId(nextM.user_id, m.user_id) ||
          (nextM.sender_type === 'user' && nextM.username === m.username)
        if (!sameSender) break

        const tPrev = new Date(messages[j - 1].created_at).getTime()
        const tNext = new Date(nextM.created_at).getTime()
        if (!isNaN(tPrev) && !isNaN(tNext) && Math.abs(tNext - tPrev) > 60 * 1000) {
          break
        }

        album.push(nextM)
        j++
      }

      if (album.length > 1) {
        result.push({
          type: 'album',
          id: `album-${album[0].id}`,
          message: album[0],
          lastMessage: album[album.length - 1],
          messages: album,
        })
        i = j
      } else {
        result.push({
          type: 'single',
          id: m.id,
          message: m,
          messages: [m],
        })
        i++
      }
    }
    return result
  }, [messages, isChatImageMessage])

  // All photos in conversation for full Lightbox gallery browsing
  const allChatImages = useMemo(() => {
    return (messages || [])
      .filter(isChatImageMessage)
      .map((m, idx) => ({
        url: resolveMediaUrl(m.media_url),
        id: m.id,
        caption: (m.message && !['Sent an image attachment', 'Sent an audio attachment', 'Sent a video attachment', 'Sent a document attachment'].includes(m.message)) ? m.message : '',
        sender_name: m.sender_name,
        created_at: m.created_at,
        index: idx,
      }))
  }, [messages, isChatImageMessage])

  return (
    <div
      ref={rootContainerRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        width: '100%',
        height: '100%',
        maxHeight: '100dvh'
      }}
      className={`fixed top-0 left-0 right-0 z-[100] flex flex-col font-sans overflow-hidden transition-colors duration-200 ${
        isLight ? 'bg-white text-slate-900' : 'official-chat-dark dark bg-[#09090b] text-white'
      }`}
    >
      {/* ── TOP APPLICATION HEADER ── */}
      <header className={`ios-safe-header min-h-[3.75rem] shrink-0 border-b px-3 sm:px-5 items-center justify-between z-30 transition-colors select-none ${
        mobileView === 'chat' ? 'hidden md:flex' : 'flex'
      } ${
        isLight 
          ? 'bg-white border-slate-200 shadow-sm text-slate-900' 
          : 'bg-[#121215] border-[#27272a] shadow-md text-white'
      }`}>
        {/* Left: App Brand */}
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-2xl bg-gradient-to-tr from-[#eab308] to-[#facc15] p-0.5 shadow-md shadow-yellow-500/10 shrink-0">
              <div className={`w-full h-full rounded-[14px] flex items-center justify-center font-black text-xs overflow-hidden ${
                isLight ? 'bg-white text-amber-700' : 'bg-[#09090b] text-[#facc15]'
              }`}>
                <img
                  src="/logo192.png"
                  alt={chatBrandName || "JDLX Chat"}
                  className="w-full h-full object-contain rounded-[14px]"
                />
              </div>
            </div>
            <div 
              onClick={() => setShowProfileDrawer(true)}
              className="min-w-0 cursor-pointer group"
              title="Open Profile & Settings"
            >
              <div className="flex items-center gap-1.5">
                <h1 className={`text-sm sm:text-base font-black truncate tracking-tight group-hover:text-amber-500 transition-colors ${
                  isLight ? 'text-slate-900' : 'text-white'
                }`}>
                  {chatBrandName}
                </h1>
                <span className={`hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase ${
                  isLight ? 'bg-amber-100 text-amber-800' : 'bg-yellow-500/15 text-[#facc15] border border-yellow-500/30'
                }`}>
                  <Lock className="w-2.5 h-2.5" />
                  Encrypted Chat
                </span>
              </div>
              <p className={`text-[10px] sm:text-[11px] font-mono truncate group-hover:underline ${
                isLight ? 'text-amber-700' : 'text-[#facc15]'
              }`}>
                {chatUser?.username ? `@${chatUser.username}` : (chatUser?.name || 'My Account')}
              </p>
            </div>
          </div>
        </div>

        {/* Right: Quick Actions (Add Friend, Theme Toggle, Notifications, User Menu) */}
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {/* Add Friend Button (+👤) */}
          <button
            onClick={() => {
              setShowAddFriendModal(true)
              fetchFriendsAndRequests()
            }}
            title="Add Friend & Search Users"
            className={`px-3 py-1.5 rounded-xl text-xs font-black flex items-center gap-1.5 transition-all active:scale-95 border cursor-pointer ${
              isLight
                ? 'bg-amber-500 text-white border-amber-600 hover:bg-amber-600 shadow-sm'
                : 'bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] border-yellow-500/30 shadow-md shadow-yellow-500/15'
            }`}
          >
            <UserPlus className="w-4 h-4" />
            <span className="hidden xs:inline">Add Friend</span>
            {pendingRequestsCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-rose-500 text-white text-[9px] font-black flex items-center justify-center">
                {pendingRequestsCount}
              </span>
            )}
          </button>


          {/* Quick Theme Switcher Button */}
          <button
            onClick={toggleChatTheme}
            title={`Theme: ${themeLabel} — click to change`}
            aria-label={`Theme: ${themeLabel}. Click to change.`}
            className={`p-2 rounded-xl transition-all border active:scale-95 cursor-pointer ${
              isLight
                ? 'text-amber-700 hover:bg-slate-100 border-transparent hover:border-slate-200'
                : 'text-[#a1a1aa] hover:text-[#facc15] hover:bg-[#18181b] border-transparent hover:border-[#27272a]'
            }`}
          >
            {chatTheme === 'system'
              ? <Monitor className="w-5 h-5" />
              : chatTheme === 'light'
                ? <Moon className="w-5 h-5" />
                : <Sun className="w-5 h-5 text-[#facc15]" />}
          </button>

          {/* Install App Button (PWA - hidden in native APK) */}
          {!isPwaInstalled && !isCapacitorNative() && (
            <button
              onClick={triggerPwaInstall}
              title="Install JDLX Chat App"
              aria-label="Install JDLX Chat App"
              className={`p-2 sm:px-3 sm:py-1.5 rounded-xl text-xs font-black flex items-center gap-1.5 transition-all active:scale-95 border cursor-pointer ${
                isLight
                  ? 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-300'
                  : 'bg-[#18181b] hover:bg-[#27272a] text-[#facc15] border-[#3f3f46]'
              }`}
            >
              <Download className="w-4 h-4 text-[#facc15]" />
              <span className="hidden lg:inline text-[11px]">Install App</span>
            </button>
          )}

          {/* Notifications Bell */}
          <button
            onClick={() => {
              setShowNotificationsDrawer(true)
              fetchNotifications()
            }}
            title="Chat Notifications"
            className={`p-2 rounded-xl transition-all relative border active:scale-95 cursor-pointer ${
              isLight
                ? 'text-slate-600 hover:text-amber-700 hover:bg-slate-100 border-transparent hover:border-slate-200'
                : 'text-[#a1a1aa] hover:text-[#facc15] hover:bg-[#18181b] border-transparent hover:border-[#27272a]'
            }`}
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className={`absolute top-1.5 right-1.5 w-4 h-4 rounded-full text-[9px] font-black flex items-center justify-center shadow-sm ${
                isLight ? 'bg-amber-500 text-white' : 'bg-[#facc15] text-[#09090b]'
              }`}>
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {/* More Menu Toggle */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className={`p-2 rounded-xl transition-all border active:scale-95 cursor-pointer ${
                isLight
                  ? 'text-slate-600 hover:text-amber-700 hover:bg-slate-100 border-transparent hover:border-slate-200'
                  : 'text-[#a1a1aa] hover:text-[#facc15] hover:bg-[#18181b] border-transparent hover:border-[#27272a]'
              }`}
            >
              <MoreVertical className="w-5 h-5" />
            </button>

            {showMenu && (
              <div className={`absolute right-0 top-12 w-56 rounded-2xl border shadow-2xl py-1.5 z-40 animate-in fade-in zoom-in-95 duration-150 ${
                isLight ? 'bg-white border-slate-200 text-slate-900 shadow-slate-200' : 'bg-[#18181b] border-[#27272a] text-[#f4f4f5]'
              }`}>
                {/* Install PWA item */}
                {!isPwaInstalled && (
                  <button
                    onClick={() => {
                      triggerPwaInstall()
                      setShowMenu(false)
                    }}
                    className={`w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2.5 transition-colors ${
                      isLight ? 'hover:bg-slate-50 text-slate-800' : 'hover:bg-[#202024] text-[#f4f4f5]'
                    }`}
                  >
                    <Download className={`w-4 h-4 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                    <span>Install JDLX App</span>
                  </button>
                )}

                {/* Profile item */}
                <button
                  onClick={() => {
                    setShowProfileDrawer(true)
                    setShowMenu(false)
                  }}
                  className={`w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2.5 transition-colors ${
                    isLight ? 'hover:bg-slate-50 text-slate-800' : 'hover:bg-[#202024] text-[#f4f4f5]'
                  }`}
                >
                  <Palette className={`w-4 h-4 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Profile &amp; Appearance</span>
                </button>

                {/* Add Friend item */}
                <button
                  onClick={() => {
                    setShowAddFriendModal(true)
                    setShowMenu(false)
                  }}
                  className={`w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2.5 transition-colors ${
                    isLight ? 'hover:bg-slate-50 text-slate-800' : 'hover:bg-[#202024] text-[#f4f4f5]'
                  }`}
                >
                  <UserPlus className={`w-4 h-4 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Add Friend by @username</span>
                </button>

                {/* Safety actions for direct chats */}
                {activeConversation?.other_user?.id && (
                  <button
                    onClick={async () => {
                      const targetId = activeConversation.other_user.id
                      const wasBlocked = Boolean(activeConversation.blocked_by_me)
                      setShowMenu(false)
                      triggerHaptic('medium')
                      toast.success(wasBlocked ? 'User unblocked' : 'User blocked')
                      const ok = wasBlocked ? await unblockUser(targetId) : await blockUser(targetId)
                      if (!ok) toast.error(wasBlocked ? 'Could not unblock user' : 'Could not block user')
                    }}
                    className={`w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2.5 transition-colors ${
                      isLight ? 'hover:bg-slate-50 text-slate-800' : 'hover:bg-[#202024] text-[#f4f4f5]'
                    }`}
                  >
                    <Ban className={`w-4 h-4 ${isLight ? 'text-rose-600' : 'text-rose-400'}`} />
                    <span>{activeConversation.blocked_by_me ? 'Unblock User' : 'Block User'}</span>
                  </button>
                )}
                {activeConversation?.other_user?.id && (
                  <button
                    onClick={() => {
                      setShowReportModal(true)
                      setShowMenu(false)
                    }}
                    className={`w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2.5 transition-colors ${
                      isLight ? 'hover:bg-slate-50 text-slate-800' : 'hover:bg-[#202024] text-[#f4f4f5]'
                    }`}
                  >
                    <Flag className={`w-4 h-4 ${isLight ? 'text-rose-600' : 'text-rose-400'}`} />
                    <span>Report User</span>
                  </button>
                )}

                {/* Pin / Unpin Active Chat */}
                {activeRoomId && (
                  <button
                    onClick={(e) => {
                      togglePinConversation(e, activeRoomId)
                      setShowMenu(false)
                    }}
                    className={`w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2.5 transition-colors cursor-pointer ${
                      isLight ? 'hover:bg-slate-50 text-slate-800' : 'hover:bg-[#202024] text-[#f4f4f5]'
                    }`}
                  >
                    <Pin className={`w-4 h-4 ${pinnedRoomIds.includes(activeRoomId) ? 'text-[#facc15] fill-[#facc15]' : isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                    <span>{pinnedRoomIds.includes(activeRoomId) ? 'Unpin Conversation' : 'Pin Conversation to Top'}</span>
                  </button>
                )}

                {/* Clear Active Chat */}
                <button
                  onClick={async () => {
                    if (window.confirm('Clear messages in this conversation?')) {
                      const cleared = await clearChatHistory()
                      setShowMenu(false)
                      if (cleared) toast.success('Conversation cleared')
                      else toast.error('Could not clear this conversation')
                    }
                  }}
                  className={`w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2.5 transition-colors ${
                    isLight ? 'hover:bg-slate-50 text-slate-800' : 'hover:bg-[#202024] text-[#f4f4f5]'
                  }`}
                >
                  <RotateCcw className={`w-4 h-4 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Clear Conversation</span>
                </button>

                <div className={`h-px my-1 ${isLight ? 'bg-slate-200' : 'bg-[#27272a]'}`}></div>

                <button
                  onClick={handleLogout}
                  className="w-full px-4 py-2.5 text-left text-xs font-bold text-rose-500 hover:bg-rose-500/10 flex items-center gap-2.5 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── MAIN WHATSAPP-STYLE DUAL-PANE BODY ── */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* LEFT PANE: CONVERSATIONS & CHATS LIST (WhatsApp Sidebar)     */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <aside className={`w-full md:w-80 lg:w-96 shrink-0 border-r flex flex-col transition-all duration-200 ${
          isLight ? 'bg-white border-slate-200' : 'bg-[#121215] border-[#27272a]'
        } ${mobileView === 'chat' ? 'hidden md:flex' : 'flex'}`}>
          {/* Search Contacts / Filter Bar */}
          <div className={`p-3 border-b ${isLight ? 'border-slate-200 bg-slate-50/50' : 'border-[#27272a] bg-[#0e0e11]'}`}>
            <div className="relative flex items-center">
              <Search className={`w-4 h-4 absolute left-3 top-2.5 pointer-events-none ${isLight ? 'text-slate-400' : 'text-[#71717a]'}`} />
              <input
                type="text"
                placeholder="Search chats or friends..."
                value={conversationFilter}
                onChange={(e) => setConversationFilter(e.target.value)}
                className={`w-full pl-9 pr-8 py-2 rounded-xl text-xs font-medium focus:outline-none transition-colors border ${
                  isLight
                    ? 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-amber-500'
                    : 'bg-[#18181b] border-[#27272a] text-white placeholder:text-zinc-400 focus:border-[#facc15]'
                }`}
              />
              {conversationFilter && (
                <button
                  type="button"
                  onClick={() => setConversationFilter('')}
                  title="Clear search"
                  className="absolute right-2.5 top-2 p-0.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Thumb-friendly Filter Tabs (All / Unread / Pinned) */}
            <div className="flex items-center gap-1.5 pt-2 select-none overflow-x-auto scrollbar-none">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setConversationTabFilter('all')
                }}
                className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all shrink-0 cursor-pointer flex items-center gap-1.5 ${
                  conversationTabFilter === 'all'
                    ? isLight
                      ? 'bg-amber-500 text-white shadow-xs'
                      : 'bg-[#facc15] text-[#09090b] shadow-xs font-black'
                    : isLight
                      ? 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                      : 'bg-[#18181b] hover:bg-[#202025] text-zinc-400'
                }`}
              >
                <span>All</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  conversationTabFilter === 'all'
                    ? isLight ? 'bg-white/25 text-white' : 'bg-black/20 text-black'
                    : isLight ? 'bg-slate-200 text-slate-600' : 'bg-zinc-800 text-zinc-400'
                }`}>
                  {conversations.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setConversationTabFilter('unread')
                }}
                className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all shrink-0 cursor-pointer flex items-center gap-1.5 ${
                  conversationTabFilter === 'unread'
                    ? isLight
                      ? 'bg-amber-500 text-white shadow-xs'
                      : 'bg-[#facc15] text-[#09090b] shadow-xs font-black'
                    : isLight
                      ? 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                      : 'bg-[#18181b] hover:bg-[#202025] text-zinc-400'
                }`}
              >
                <span>Unread</span>
                {unreadConversationsCount > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-black ${
                    conversationTabFilter === 'unread'
                      ? isLight ? 'bg-white/30 text-white' : 'bg-black/25 text-black'
                      : 'bg-amber-500 text-white'
                  }`}>
                    {unreadConversationsCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setConversationTabFilter('pinned')
                }}
                className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all shrink-0 cursor-pointer flex items-center gap-1.5 ${
                  conversationTabFilter === 'pinned'
                    ? isLight
                      ? 'bg-amber-500 text-white shadow-xs'
                      : 'bg-[#facc15] text-[#09090b] shadow-xs font-black'
                    : isLight
                      ? 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                      : 'bg-[#18181b] hover:bg-[#202025] text-zinc-400'
                }`}
              >
                <Pin className="w-3 h-3 shrink-0 fill-current" />
                <span>Pinned</span>
                {pinnedConversationsCount > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    conversationTabFilter === 'pinned'
                      ? isLight ? 'bg-white/25 text-white' : 'bg-black/20 text-black'
                      : isLight ? 'bg-slate-200 text-slate-600' : 'bg-zinc-800 text-zinc-400'
                  }`}>
                    {pinnedConversationsCount}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* One-time prompt for OS notifications (friend requests while the
              app is closed). Hidden when permission is already granted/denied. */}
          {showPushPrompt && (
            <div className={`p-3 border-b ${
              isLight ? 'border-slate-200 bg-emerald-50/70' : 'border-[#27272a] bg-emerald-500/5'
            }`}>
              <div className="flex items-start gap-2">
                <Bell className={`w-4 h-4 shrink-0 mt-0.5 ${isLight ? 'text-emerald-700' : 'text-emerald-400'}`} />
                <div className="min-w-0 flex-1">
                  <p className={`text-[11px] font-bold leading-snug ${
                    isLight ? 'text-emerald-900' : 'text-emerald-200'
                  }`}>
                    Get friend requests even when Chat is closed
                  </p>
                  <button
                    type="button"
                    onClick={handleEnablePush}
                    className="mt-1.5 px-3 py-1 rounded-lg bg-emerald-600 text-white text-[10px] font-black active:scale-95 transition-all cursor-pointer"
                  >
                    Enable notifications
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPushPrompt(false)}
                  title="Not now"
                  className={`p-1 rounded-lg shrink-0 ${
                    isLight ? 'text-slate-400 hover:text-slate-600' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Pending Requests Notification Banner */}
          {pendingRequestsCount > 0 && (
            <div 
              onClick={() => {
                setShowAddFriendModal(true)
                setFriendModalTab('requests')
              }}
              className={`p-3 border-b flex items-center justify-between cursor-pointer transition-colors ${
                isLight 
                  ? 'bg-amber-50 border-amber-200 hover:bg-amber-100 text-amber-900' 
                  : 'bg-yellow-500/10 border-yellow-500/20 hover:bg-yellow-500/15 text-[#facc15]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 shrink-0" />
                <span className="text-xs font-bold">
                  {pendingRequestsCount} friend request{pendingRequestsCount > 1 ? 's' : ''} waiting
                </span>
              </div>
              <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500 text-white">
                View
              </span>
            </div>
          )}

          {/* Friends stay visible even after a chat is closed, so a connection
              never has to be re-searched and re-added. */}
          {friends && friends.length > 0 && (
            <div className={`p-3 border-b ${isLight ? 'border-slate-200 bg-white' : 'border-[#27272a] bg-[#121215]'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-[10px] font-black uppercase tracking-wider ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                  Friends ({friends.length})
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddFriendModal(true)
                    setFriendModalTab('search')
                  }}
                  className={`text-[10px] font-black ${isLight ? 'text-amber-700' : 'text-[#facc15]'}`}
                >
                  + Add
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {friends.map((fr) => (
                  <button
                    key={fr.friend_id}
                    type="button"
                    onClick={() => handleDirectChatStart({ id: fr.friend_id, username: fr.username, name: fr.name })}
                    title={`Chat with @${fr.username || fr.name}`}
                    className={`shrink-0 w-20 p-2 rounded-2xl border flex flex-col items-center gap-1 active:scale-95 transition-all cursor-pointer ${
                      isLight
                        ? 'bg-slate-50 border-slate-200 hover:border-amber-300'
                        : 'bg-[#18181b] border-[#27272a] hover:border-[#facc15]/40'
                    }`}
                  >
                    <div className="relative shrink-0">
                      <span className={`w-8 h-8 rounded-xl flex items-center justify-center font-black text-xs overflow-hidden ${
                        isLight ? 'bg-amber-100 text-amber-700' : 'bg-yellow-500/20 text-[#facc15]'
                      }`}>
                        {fr.profile_image ? (
                          <img src={resolveMediaUrl(fr.profile_image)} alt="" className="w-full h-full object-cover" />
                        ) : (
                          (fr.name?.[0] || fr.username?.[0] || 'U').toUpperCase()
                        )}
                      </span>
                      {fr.is_online ? (
                        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center pointer-events-none" title="Online">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-white dark:border-[#18181b]" />
                        </span>
                      ) : null}
                    </div>
                    <span className={`text-[10px] font-bold truncate w-full text-center ${isLight ? 'text-slate-800' : 'text-white'}`}>
                      @{fr.username || fr.name}
                    </span>
                    <span className="text-[9px] font-black text-emerald-500 uppercase">Message</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Conversation Threads Scroll List */}
          <div
            ref={convListRef}
            onScroll={() => {
              if (openSwipeId) setOpenSwipeId(null)
            }}
            className="flex-1 overflow-y-auto divide-y divide-transparent overscroll-y-contain relative"
          >
            {/* Pull-to-Refresh Visual Spring Indicator */}
            {(pullY > 0 || isPullRefreshing) && (
              <div
                style={{ height: `${pullY}px` }}
                className="w-full flex items-center justify-center overflow-hidden transition-[height] duration-150 ease-out select-none border-b border-dashed border-amber-500/20"
              >
                <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold shadow-xs ${
                  isLight ? 'bg-amber-50 border border-amber-200 text-amber-900' : 'bg-yellow-500/10 border border-yellow-500/30 text-[#facc15]'
                }`}>
                  <RotateCw
                    className={`w-3.5 h-3.5 transition-transform ${isPullRefreshing ? 'animate-spin' : ''}`}
                    style={{ transform: isPullRefreshing ? undefined : `rotate(${pullY * 4.5}deg)` }}
                  />
                  <span className="text-[11px] font-mono">
                    {isPullRefreshing ? 'Refreshing chats…' : pullY >= 52 ? 'Release to refresh' : 'Pull down to sync'}
                  </span>
                </div>
              </div>
            )}
            {((!conversationsLoaded || conversationsLoading) && conversations.length === 0) ? (
              <div className="p-3 space-y-2" aria-label="Loading chats">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className={`p-3 sm:p-3.5 rounded-2xl border flex items-center gap-3 chat-shimmer-sweep ${
                      isLight ? 'bg-slate-50/80 border-slate-200' : 'bg-[#18181b]/80 border-[#27272a]'
                    }`}
                  >
                    <div className={`w-12 h-12 rounded-2xl shrink-0 ${isLight ? 'bg-slate-200' : 'bg-zinc-800'}`} />
                    <div className="flex-1 space-y-2 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className={`h-3 rounded-full ${isLight ? 'bg-slate-200' : 'bg-zinc-700/80'} ${i % 2 === 0 ? 'w-28' : 'w-36'}`} />
                        <div className={`h-2.5 rounded-full w-10 ${isLight ? 'bg-slate-100' : 'bg-zinc-800'}`} />
                      </div>
                      <div className={`h-2.5 rounded-full ${isLight ? 'bg-slate-100' : 'bg-zinc-800/80'} ${i === 1 ? 'w-4/5' : 'w-3/5'}`} />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredConversations.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <div className={`w-12 h-12 mx-auto rounded-2xl flex items-center justify-center ${
                  isLight ? 'bg-slate-100 text-slate-400' : 'bg-[#18181b] text-zinc-400'
                }`}>
                  {conversationTabFilter === 'pinned' ? (
                    <Pin className="w-6 h-6 text-amber-500" />
                  ) : (
                    <MessageCircle className="w-6 h-6" />
                  )}
                </div>
                <div className="space-y-1">
                  <h4 className={`text-sm font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    {conversationFilter.trim() && conversations.length > 0
                      ? `No chats matching "${conversationFilter.trim()}"`
                      : conversationTabFilter === 'unread'
                        ? 'No unread messages'
                        : conversationTabFilter === 'pinned'
                          ? 'No pinned chats'
                          : 'No chats yet'}
                  </h4>
                  <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-zinc-300'}`}>
                    {conversationFilter.trim() && conversations.length > 0
                      ? 'You can search across all JDLX Chat users to start a new chat.'
                      : conversationTabFilter === 'unread'
                        ? 'You are all caught up on all your conversations!'
                        : conversationTabFilter === 'pinned'
                          ? 'Swipe left on any conversation or tap the pin icon to keep it at the top.'
                          : 'Add a friend by @username or email, then start chatting!'}
                  </p>
                </div>
                {conversationTabFilter !== 'all' && !conversationFilter.trim() ? (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light')
                      setConversationTabFilter('all')
                    }}
                    className={`mt-2 px-4 py-2 rounded-xl text-xs font-black inline-flex items-center gap-1.5 cursor-pointer transition-transform active:scale-95 ${
                      isLight 
                        ? 'bg-amber-500 text-white hover:bg-amber-600' 
                        : 'bg-[#facc15] text-[#09090b] hover:bg-[#eab308]'
                    }`}
                  >
                    <span>View all chats</span>
                  </button>
                ) : conversationFilter.trim() && conversations.length > 0 ? (
                  <button
                    onClick={() => {
                      setGlobalSearchQuery(conversationFilter.trim())
                      setShowAddFriendModal(true)
                      setFriendModalTab('search')
                    }}
                    className={`mt-2 px-4 py-2 rounded-xl text-xs font-black inline-flex items-center gap-1.5 cursor-pointer transition-transform active:scale-95 ${
                      isLight 
                        ? 'bg-amber-500 text-white hover:bg-amber-600' 
                        : 'bg-[#facc15] text-[#09090b] hover:bg-[#eab308]'
                    }`}
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>Search all users for &ldquo;{conversationFilter.trim()}&rdquo;</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setShowAddFriendModal(true)
                      setFriendModalTab('search')
                    }}
                    className={`mt-2 px-4 py-2 rounded-xl text-xs font-black inline-flex items-center gap-1.5 cursor-pointer transition-transform active:scale-95 ${
                      isLight 
                        ? 'bg-amber-500 text-white hover:bg-amber-600' 
                        : 'bg-[#facc15] text-[#09090b] hover:bg-[#eab308]'
                    }`}
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>Find Friends</span>
                  </button>
                )}
              </div>
            ) : (
              <>
                {filteredConversations.map((conv) => {
                  const isSelected = sameId(activeRoomId, conv.id)
                  const isOnline = Boolean((sameId(activeRoomId, conv.id) && peerOnline) || conv.contact_online)
                  const roomDraft = drafts[conv.id]?.trim()
                  const hasDraft = Boolean(roomDraft && !isSelected)
                  const isSentByMe = Boolean(chatUser?.id && sameId(conv.last_message_user_id, chatUser.id))
                  const isPinned = pinnedRoomIds.some((id) => sameId(id, conv.id))
                  const isPeerTypingThisRoom = Boolean(sameId(activeRoomId, conv.id) && peerTyping)

                  return (
                    <SwipeableConversationRow
                      key={conv.id}
                      conv={conv}
                      isPinned={isPinned}
                      isOpen={sameId(openSwipeId, conv.id)}
                      onOpen={(id) => setOpenSwipeId(id)}
                      onClose={() => setOpenSwipeId(null)}
                      onTogglePin={togglePinConversation}
                      onClear={handleSwipeClear}
                      onSelect={handleSelectConversation}
                      isLight={isLight}
                    >
                      <div
                        className={`group relative p-3 sm:p-3.5 flex items-center gap-3 cursor-pointer transition-colors border-l-[3.5px] select-none ${
                          isSelected
                            ? isLight
                              ? 'bg-gradient-to-r from-amber-500/12 via-amber-500/5 to-transparent border-amber-500 shadow-xs'
                              : 'bg-gradient-to-r from-[#facc15]/15 via-[#facc15]/5 to-transparent border-[#facc15] shadow-xs'
                            : isLight
                              ? 'border-transparent hover:border-slate-300 hover:bg-slate-50/80 bg-white'
                              : 'border-transparent hover:border-white/10 hover:bg-[#18181b]/70 bg-[#121215]'
                        }`}
                      >
                        {/* Contact Avatar with Live Online Presence Beacon */}
                        <div className="relative shrink-0">
                          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-sm border overflow-hidden transition-transform group-hover:scale-[1.02] ${
                            isSelected
                              ? isLight
                                ? 'bg-amber-100 text-amber-800 border-amber-300 ring-2 ring-amber-400/20'
                                : 'bg-[#facc15]/25 text-[#facc15] border-[#facc15]/40 ring-2 ring-yellow-500/20'
                              : isLight
                                ? 'bg-slate-100 text-slate-700 border-slate-200'
                                : 'bg-[#18181b] text-zinc-300 border-[#27272a]'
                          }`}>
                            {conv.contact_avatar ? (
                              <img src={resolveMediaUrl(conv.contact_avatar)} alt="" className="w-full h-full object-cover" />
                            ) : (
                              conv.contact_name?.[0]?.toUpperCase() || 'U'
                            )}
                          </div>
                          {isOnline && (
                            <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center pointer-events-none" title="Online">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500 border-2 border-white dark:border-[#121215] shadow-xs ring-1 ring-emerald-400/40" />
                            </span>
                          )}
                        </div>

                        {/* Chat Details */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <h4 className={`text-xs sm:text-sm font-bold truncate transition-colors ${
                              isSelected
                                ? isLight
                                  ? 'text-amber-900 font-black'
                                  : 'text-[#facc15] font-black'
                                : isLight
                                  ? 'text-slate-900'
                                  : 'text-white'
                            }`}>
                              {conv.contact_name}
                            </h4>

                            <div className="flex items-center gap-1.5 shrink-0 ml-2">
                              {/* Pinned Icon */}
                              {isPinned && (
                                <Pin className="w-3 h-3 text-[#facc15] fill-[#facc15] shrink-0" title="Pinned chat" />
                              )}
                              <span className={`text-[10px] font-medium font-mono ${
                                conv.unread_count > 0
                                  ? isLight
                                    ? 'text-amber-600 font-bold'
                                    : 'text-[#facc15] font-bold'
                                  : isLight
                                    ? 'text-slate-400'
                                    : 'text-zinc-500'
                              }`}>
                                {formatTime(conv.last_message_at)}
                              </span>
                            </div>
                          </div>

                          {/* Message preview snippet or live typing */}
                          <div className="flex items-center justify-between gap-1.5">
                            {isPeerTypingThisRoom ? (
                              <div className="flex items-center gap-1.5 text-xs font-bold text-[#facc15] animate-pulse min-w-0">
                                <span className="flex items-center gap-0.5">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#facc15] animate-bounce [animation-delay:-0.3s]" />
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#facc15] animate-bounce [animation-delay:-0.15s]" />
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#facc15] animate-bounce" />
                                </span>
                                <span className="tracking-tight text-[11px]">typing...</span>
                              </div>
                            ) : hasDraft ? (
                              <p className="text-xs truncate font-medium flex items-center gap-1 min-w-0">
                                <span className="text-rose-500 font-black shrink-0 text-[11px]">Draft:</span>
                                <span className={`truncate text-xs ${isLight ? 'text-slate-600' : 'text-zinc-300'}`}>
                                  {roomDraft}
                                </span>
                              </p>
                            ) : (
                              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                {/* Sent by me delivery / read receipts */}
                                {isSentByMe && (
                                  <span className="shrink-0 inline-flex items-center" title={conv.last_message_is_read ? 'Read' : 'Delivered'}>
                                    {conv.last_message_is_read ? (
                                      <CheckCheck className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                                    ) : (
                                      <CheckCheck className={`w-3.5 h-3.5 ${isLight ? 'text-slate-400' : 'text-zinc-500'}`} />
                                    )}
                                  </span>
                                )}

                                {/* Rich media snippet indicator */}
                                {conv.last_message_type === 'audio' ? (
                                  <span className="inline-flex items-center gap-1 text-xs truncate">
                                    <Mic className={`w-3.5 h-3.5 shrink-0 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                                    <span className={conv.unread_count > 0 ? (isLight ? 'text-slate-900 font-bold' : 'text-white font-bold') : (isLight ? 'text-slate-600' : 'text-zinc-300')}>
                                      Voice note
                                    </span>
                                  </span>
                                ) : conv.last_message_type === 'image' ? (
                                  <span className="inline-flex items-center gap-1 text-xs truncate">
                                    <Camera className={`w-3.5 h-3.5 shrink-0 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                                    <span className={conv.unread_count > 0 ? (isLight ? 'text-slate-900 font-bold' : 'text-white font-bold') : (isLight ? 'text-slate-600' : 'text-zinc-300')}>
                                      Photo
                                    </span>
                                  </span>
                                ) : conv.last_message_type === 'document' || (conv.last_message && conv.last_message.toLowerCase().includes('document')) ? (
                                  <span className="inline-flex items-center gap-1 text-xs truncate">
                                    <FileText className={`w-3.5 h-3.5 shrink-0 ${isLight ? 'text-blue-600' : 'text-blue-400'}`} />
                                    <span className={conv.unread_count > 0 ? (isLight ? 'text-slate-900 font-bold' : 'text-white font-bold') : (isLight ? 'text-slate-600' : 'text-zinc-300')}>
                                      Document
                                    </span>
                                  </span>
                                ) : conv.last_message_type === 'video' ? (
                                  <span className="inline-flex items-center gap-1 text-xs truncate">
                                    <Video className={`w-3.5 h-3.5 shrink-0 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                                    <span className={conv.unread_count > 0 ? (isLight ? 'text-slate-900 font-bold' : 'text-white font-bold') : (isLight ? 'text-slate-600' : 'text-zinc-300')}>
                                      Video
                                    </span>
                                  </span>
                                ) : conv.last_message_type === 'deleted' ? (
                                  <span className="inline-flex items-center gap-1 text-xs italic opacity-70 truncate">
                                    <Ban className="w-3 h-3 shrink-0" />
                                    <span>This message was deleted</span>
                                  </span>
                                ) : (
                                  <p className={`text-xs truncate font-medium ${
                                    conv.unread_count > 0
                                      ? (isLight ? 'text-slate-900 font-bold' : 'text-white font-bold')
                                      : (isLight ? 'text-slate-500' : 'text-zinc-400')
                                  }`}>
                                    {conv.last_message}
                                  </p>
                                )}
                              </div>
                            )}

                            <div className="flex items-center gap-1.5 shrink-0 ml-1">
                              {/* Hover pin toggle button */}
                              <button
                                type="button"
                                onClick={(e) => togglePinConversation(e, conv.id)}
                                title={isPinned ? 'Unpin chat' : 'Pin chat to top'}
                                className={`p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:scale-110 active:scale-95 transition-all cursor-pointer ${
                                  isPinned ? 'text-[#facc15]' : isLight ? 'text-slate-400 hover:text-amber-600' : 'text-zinc-500 hover:text-white'
                                }`}
                              >
                                <Pin className={`w-3.5 h-3.5 ${isPinned ? 'fill-[#facc15]' : ''}`} />
                              </button>

                              {/* Unread badge pill */}
                              {conv.unread_count > 0 && (
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black shadow-xs ${
                                  isLight ? 'bg-amber-500 text-white' : 'bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] shadow-yellow-500/20'
                                }`}>
                                  {conv.unread_count}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Username & E2EE text-message indicator */}
                          <div className={`text-[10px] font-mono mt-0.5 flex items-center justify-between ${isLight ? 'text-amber-700/80' : 'text-[#facc15]/80'}`}>
                            <div className="flex items-center gap-1">
                              <span>@{conv.contact_username}</span>
                              {conv.contact_public_key && (
                                <span title="Text messages are end-to-end encrypted" className="inline-flex items-center opacity-70">
                                  <Lock className="w-2.5 h-2.5" />
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </SwipeableConversationRow>
                  )
                })}
              {conversationFilter.trim() && (
                <div className="p-3 text-center border-t border-dashed mt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setGlobalSearchQuery(conversationFilter.trim())
                      setShowAddFriendModal(true)
                      setFriendModalTab('search')
                    }}
                    className={`w-full py-2 px-3 rounded-xl text-xs font-bold transition-all border flex items-center justify-center gap-1.5 cursor-pointer ${
                      isLight
                        ? 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-900'
                        : 'bg-zinc-900/80 hover:bg-zinc-800 border-zinc-700/60 text-amber-400'
                    }`}
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>Search all users for &ldquo;{conversationFilter.trim()}&rdquo;</span>
                  </button>
                </div>
              )}
            </>
          )}
          </div>

          {/* Floating Action Button (FAB) for Mobile Chat List (WhatsApp / Telegram style New Chat FAB) */}
          <div className="md:hidden fixed right-5 bottom-6 z-40">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium')
                setFriendModalTab('search')
                setShowAddFriendModal(true)
              }}
              title="Start new chat or add friend"
              className="w-14 h-14 rounded-full bg-gradient-to-tr from-[#eab308] to-[#facc15] text-[#09090b] shadow-2xl shadow-yellow-500/40 flex items-center justify-center hover:scale-105 active:scale-95 transition-all cursor-pointer"
            >
              <UserPlus className="w-6 h-6 stroke-[2.2]" />
            </button>
          </div>
        </aside>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* RIGHT PANE: ACTIVE CHAT CONVERSATION VIEW                     */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <main 
          style={{ touchAction: 'pan-y', overscrollBehaviorX: 'none' }}
          onTouchStart={handleEdgeTouchStart}
          onTouchMove={handleEdgeTouchMove}
          onTouchEnd={handleEdgeTouchEnd}
          onTouchCancel={handleEdgeTouchEnd}
          className={`relative flex-1 flex flex-col overflow-hidden transition-colors ${
            mobileView === 'list' ? 'hidden md:flex' : 'flex'
          }`}
        >
          {/* Floating Edge Swipe-to-Back Visual Pill (iOS / Android Native standard) */}
          {edgeSwipeOffset > 6 && (
            <div 
              style={{
                left: `${Math.min(edgeSwipeOffset * 0.8, 64)}px`,
                opacity: Math.min(edgeSwipeOffset / 50, 1),
                transform: `translateY(-50%) scale(${Math.min(0.7 + (edgeSwipeOffset / 120) * 0.4, 1.1)})`,
              }}
              className="absolute top-1/2 z-50 pointer-events-none -translate-x-1/2 flex items-center justify-center w-11 h-11 rounded-full bg-gradient-to-tr from-[#eab308] to-[#facc15] text-[#121215] shadow-xl shadow-yellow-500/30 transition-transform"
            >
              <ArrowLeft className={`w-5 h-5 transition-transform duration-150 ${edgeSwipeOffset >= 60 ? 'scale-125 stroke-[2.5]' : 'stroke-2'}`} />
            </div>
          )}

          {activeConversation ? (
            <>
              {/* Active Chat Header */}
              <div className={`ios-safe-header relative min-h-[3.75rem] shrink-0 border-b px-3 sm:px-5 flex items-center justify-between z-20 transition-colors select-none ${
                isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-[#121215] border-[#27272a]'
              }`}>
                {/* Sleek Top Chat Progress Bar (Telegram / YouTube caliber) */}
                {messagesLoading && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-gradient-to-r from-amber-500 via-[#facc15] to-amber-300 z-30 animate-chat-top-progress shadow-[0_0_12px_rgba(250,204,21,0.6)] pointer-events-none" />
                )}
                <div className="flex items-center gap-2.5 min-w-0">
                  {/* Mobile Back button to Chat List */}
                  <button
                    onClick={() => {
                      triggerHaptic('light')
                      setMobileView('list')
                    }}
                    className={`md:hidden p-1.5 rounded-xl border transition-colors ${
                      isLight ? 'hover:bg-slate-100 border-slate-200 text-slate-700' : 'hover:bg-[#18181b] border-[#27272a] text-[#a1a1aa]'
                    }`}
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>

                  {/* Active Contact Avatar & Name (Clickable Profile) */}
                  <div
                    onClick={() => setShowContactInfoModal(true)}
                    className="flex items-center gap-2.5 min-w-0 cursor-pointer group hover:opacity-90 active:scale-[0.99] transition-all select-none"
                    title="Click to view contact profile & encryption details"
                  >
                    <div className="relative shrink-0">
                      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center font-black text-sm border overflow-hidden transition-transform group-hover:scale-105 ${
                        isLight 
                          ? 'bg-amber-100 text-amber-700 border-amber-300' 
                          : 'bg-[#facc15]/20 text-[#facc15] border-yellow-500/30'
                      }`}>
                        {activeConversation.contact_avatar ? (
                          <img src={resolveMediaUrl(activeConversation.contact_avatar)} alt="" className="w-full h-full object-cover" />
                        ) : (
                          activeConversation.contact_name?.[0]?.toUpperCase() || 'U'
                        )}
                      </div>
                      {peerOnline && (
                        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center pointer-events-none" title="Online">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-white dark:border-[#121215]" />
                        </span>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className={`text-sm font-black truncate group-hover:underline ${
                          isLight ? 'text-slate-900' : 'text-white'
                        }`}>
                          {activeConversation.contact_name}
                        </h3>
                        <ShieldCheck className={`w-4 h-4 shrink-0 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                        {mutedRooms.includes(activeRoomId) && (
                          <VolumeX className="w-3.5 h-3.5 text-zinc-400 shrink-0" title="Notifications muted" />
                        )}
                      </div>
                      <p className="text-[11px] font-mono flex items-center gap-1.5">
                        <span className={isLight ? 'text-amber-700 font-bold' : 'text-[#facc15] font-bold'}>
                          @{activeConversation.contact_username}
                        </span>
                        <span className={`opacity-40 ${isLight ? 'text-slate-400' : 'text-[#71717a]'}`}>•</span>
                        <span className={`text-[10px] font-bold ${peerTyping ? 'text-amber-500' : peerOnline ? 'text-emerald-500' : 'opacity-50'}`}>
                          {peerTyping ? 'typing…' : (peerOnline ? 'Online' : 'Offline')}
                        </span>
                        <span className={`opacity-40 ${isLight ? 'text-slate-400' : 'text-[#71717a]'}`}>•</span>
                        <span className="text-[10px] text-emerald-500 font-bold flex items-center gap-0.5">
                          <Lock className="w-2.5 h-2.5" /> {activeConversation?.contact_public_key ? 'Text E2EE' : 'Encrypted text (legacy)'}
                        </span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Messages Scroll Area with Luxury Starlight Wallpaper */}
              <div 
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
                style={{
                  overflowX: 'hidden',
                  touchAction: 'pan-y',
                  overscrollBehaviorX: 'none'
                }}
                className={`flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-6 py-4 space-y-1.5 overscroll-contain transition-colors ${
                  showDoodle ? 'chat-wallpaper-doodle' : ''
                } ${
                  isLight ? 'bg-slate-50' : 'bg-[#09090b]'
                }`}
              >
                {/* Encryption Banner (WhatsApp Style) */}
                <div className="w-full max-w-md mx-auto my-2">
                  <div className={`p-2.5 rounded-2xl border text-center flex items-center justify-center gap-2 ${
                    isLight 
                      ? 'bg-amber-50/80 border-amber-200 text-amber-900' 
                      : 'bg-yellow-500/5 border-yellow-500/15 text-[#facc15]'
                  }`}>
                    <Lock className="w-3.5 h-3.5 shrink-0" />
                    <span className="text-[11px] font-medium leading-tight">
                      Text messages in direct chats are end-to-end encrypted on your device. Photos, voice notes, videos and files are uploaded to the chat server but are not end-to-end encrypted yet. Official support chats are encrypted in transit and at rest.
                    </span>
                  </div>
                </div>

                {/* Older-history pagination (loads one 200-message page) */}
                {messagesHasMore && (
                  <div className="text-center py-2">
                    {loadingOlderMessages ? (
                      <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-500/10 border border-yellow-500/30 text-[#facc15] text-[11px] font-mono font-bold shadow-xs animate-pulse">
                        <RotateCw className="w-3.5 h-3.5 animate-spin text-[#facc15]" />
                        <span>Decrypting earlier messages…</span>
                        <span className="flex items-center gap-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#facc15] animate-bounce [animation-delay:-0.3s]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-[#facc15] animate-bounce [animation-delay:-0.15s]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-[#facc15] animate-bounce" />
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={loadOlderMessages}
                        className={`px-3 py-1.5 rounded-xl border text-[11px] font-bold transition-all active:scale-95 cursor-pointer inline-flex items-center gap-1.5 ${
                          isLight
                            ? 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50 shadow-xs'
                            : 'bg-[#18181b] border-[#27272a] text-zinc-300 hover:bg-[#202026]'
                        }`}
                      >
                        <Clock className="w-3.5 h-3.5 opacity-60" />
                        <span>Load older messages</span>
                      </button>
                    )}
                  </div>
                )}

                {/* Messages Bubbles with Sticky Floating Date Separator & Tails */}
                {((messagesLoading || (activeRoomId && !sameId(initialRoomFetchedRef.current, activeRoomId))) && (!messages || messages.length === 0)) ? (
                  <div className="py-6 space-y-4 px-2 sm:px-4 max-w-2xl mx-auto w-full select-none" aria-label="Loading messages">
                    {/* Security Syncing Pill */}
                    <div className="flex flex-col items-center justify-center pt-2 pb-1">
                      <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border shadow-xs animate-pulse ${
                        isLight 
                          ? 'bg-amber-50/90 border-amber-200 text-amber-900' 
                          : 'bg-yellow-500/10 border-yellow-500/25 text-[#facc15]'
                      }`}>
                        <Lock className="w-3 h-3 text-amber-500" />
                        <span className="text-[10px] font-mono font-bold tracking-tight">Syncing End-to-End Encrypted Chat…</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                      </div>
                    </div>

                    {/* Shimmer Skeleton Bubble 1: Received Left */}
                    <div className="flex items-end gap-2 justify-start animate-fade-in">
                      <div className={`w-7 h-7 rounded-xl shrink-0 chat-shimmer-sweep ${
                        isLight ? 'bg-slate-200' : 'bg-[#202024]'
                      }`} />
                      <div className={`p-3 rounded-2xl rounded-bl-xs w-[68%] sm:w-[52%] space-y-2 border chat-shimmer-sweep ${
                        isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-[#18181b] border-[#27272a]'
                      }`}>
                        <div className={`h-2.5 rounded-full w-4/5 ${isLight ? 'bg-slate-200' : 'bg-zinc-700/60'}`} />
                        <div className={`h-2 rounded-full w-2/5 ${isLight ? 'bg-slate-100' : 'bg-zinc-800'}`} />
                      </div>
                    </div>

                    {/* Shimmer Skeleton Bubble 2: Sent Right */}
                    <div className="flex justify-end animate-fade-in">
                      <div className={`p-3 rounded-2xl rounded-br-xs w-[54%] sm:w-[40%] space-y-2 border chat-shimmer-sweep ${
                        isLight 
                          ? 'bg-gradient-to-r from-amber-100 to-amber-200/80 border-amber-300/60 text-amber-900' 
                          : 'bg-gradient-to-r from-yellow-500/20 to-amber-500/15 border-yellow-500/30'
                      }`}>
                        <div className={`h-2.5 rounded-full w-3/4 ${isLight ? 'bg-amber-300/70' : 'bg-yellow-400/30'}`} />
                        <div className={`h-2 rounded-full w-1/3 ml-auto ${isLight ? 'bg-amber-200' : 'bg-yellow-400/20'}`} />
                      </div>
                    </div>

                    {/* Shimmer Skeleton Bubble 3: Photo Attachment Received Left */}
                    <div className="flex items-end gap-2 justify-start animate-fade-in">
                      <div className={`w-7 h-7 rounded-xl shrink-0 chat-shimmer-sweep ${
                        isLight ? 'bg-slate-200' : 'bg-[#202024]'
                      }`} />
                      <div className={`p-2 rounded-2xl rounded-bl-xs w-[65%] sm:w-[48%] space-y-2 border chat-shimmer-sweep ${
                        isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-[#18181b] border-[#27272a]'
                      }`}>
                        <div className={`h-32 sm:h-36 rounded-xl flex items-center justify-center ${
                          isLight ? 'bg-slate-100' : 'bg-[#222228]'
                        }`}>
                          <ImageIcon className="w-8 h-8 opacity-20 text-[#facc15]" />
                        </div>
                        <div className={`h-2 rounded-full w-1/2 ${isLight ? 'bg-slate-200' : 'bg-zinc-700/60'}`} />
                      </div>
                    </div>

                    {/* Shimmer Skeleton Bubble 4: Sent Right (Quick Reply) */}
                    <div className="flex justify-end animate-fade-in">
                      <div className={`px-4 py-2.5 rounded-2xl rounded-br-xs w-[40%] sm:w-[30%] border chat-shimmer-sweep ${
                        isLight 
                          ? 'bg-gradient-to-r from-amber-100 to-amber-200/80 border-amber-300/60' 
                          : 'bg-gradient-to-r from-yellow-500/20 to-amber-500/15 border-yellow-500/30'
                      }`}>
                        <div className={`h-2.5 rounded-full w-4/5 ${isLight ? 'bg-amber-300/70' : 'bg-yellow-400/30'}`} />
                      </div>
                    </div>

                    {/* Shimmer Skeleton Bubble 5: Received Left */}
                    <div className="flex items-end gap-2 justify-start animate-fade-in">
                      <div className={`w-7 h-7 rounded-xl shrink-0 chat-shimmer-sweep ${
                        isLight ? 'bg-slate-200' : 'bg-[#202024]'
                      }`} />
                      <div className={`p-3 rounded-2xl rounded-bl-xs w-[45%] sm:w-[35%] space-y-1.5 border chat-shimmer-sweep ${
                        isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-[#18181b] border-[#27272a]'
                      }`}>
                        <div className={`h-2.5 rounded-full w-3/4 ${isLight ? 'bg-slate-200' : 'bg-zinc-700/60'}`} />
                      </div>
                    </div>
                  </div>
                ) : (!messages || messages.length === 0) ? (
                  <div className="py-16 text-center space-y-2">
                    <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-zinc-300'}`}>
                      No messages here yet. Send a greeting to start chatting!
                    </p>
                  </div>
                ) : (
                  (groupedMessages || []).map((item, idx) => {
                    const isAlbum = item.type === 'album'
                    const m = item.message
                    const lastMsg = item.lastMessage || m
                    const album = item.messages || [m]
                    const isUser = sameId(m.user_id, chatUser?.id) || (m.sender_type === 'user' && m.username === chatUser?.username)
                    const curDate = parseUtcDate(m.created_at)
                    const curDateStr = curDate ? curDate.toDateString() : ''
                    const prevItem = idx > 0 ? groupedMessages[idx - 1] : null
                    const prevMsg = prevItem ? prevItem.message : null
                    const prevDate = prevMsg ? parseUtcDate(prevMsg.created_at) : null
                    const prevDateStr = prevDate ? prevDate.toDateString() : ''
                    const showDateDivider = idx === 0 || (curDateStr && curDateStr !== prevDateStr)

                    const isSameSenderAsPrev = Boolean(
                      prevMsg &&
                      (sameId(prevMsg.user_id, m.user_id) || (prevMsg.sender_type === 'user' && prevMsg.username === m.username)) &&
                      curDateStr === prevDateStr
                    )
                    const isFirstInGroup = !isSameSenderAsPrev

                    const nextItem = idx < groupedMessages.length - 1 ? groupedMessages[idx + 1] : null
                    const nextMsg = nextItem ? nextItem.message : null
                    const nextDate = nextMsg ? parseUtcDate(nextMsg.created_at) : null
                    const nextDateStr = nextDate ? nextDate.toDateString() : ''
                    const isSameSenderAsNext = Boolean(
                      nextMsg &&
                      (sameId(nextMsg.user_id, m.user_id) || (nextMsg.sender_type === 'user' && nextMsg.username === m.username)) &&
                      curDateStr === nextDateStr
                    )
                    const isLastInGroup = !isSameSenderAsNext

                    const bubbleCorners = isUser
                      ? (isFirstInGroup && isLastInGroup
                          ? 'rounded-2xl rounded-br-none'
                          : isFirstInGroup
                            ? 'rounded-2xl rounded-br-md'
                            : isLastInGroup
                              ? 'rounded-2xl rounded-tr-md rounded-br-none'
                              : 'rounded-2xl rounded-r-md')
                      : (isFirstInGroup && isLastInGroup
                          ? 'rounded-2xl rounded-bl-none'
                          : isFirstInGroup
                            ? 'rounded-2xl rounded-bl-md'
                            : isLastInGroup
                              ? 'rounded-2xl rounded-tl-md rounded-bl-none'
                              : 'rounded-2xl rounded-l-md')

                    const hasMedia = Boolean(m.media_url)
                    const isImage = isChatImageMessage(m)
                    const hasText = Boolean(
                      m.message &&
                      !m.deleted &&
                      m.message_type !== 'deleted' &&
                      (!hasMedia || (
                        m.message !== 'Sent an image attachment' &&
                        m.message !== 'Sent an audio attachment' &&
                        m.message !== 'Sent a video attachment' &&
                        m.message !== 'Sent a document attachment'
                      ))
                    )

                    const singleImageIdx = isImage ? allChatImages.findIndex((img) => sameId(img.id, m.id)) : -1

                    const albumImages = isAlbum
                      ? album.map((pm, pIdx) => ({
                          url: resolveMediaUrl(pm.media_url),
                          id: pm.id,
                          caption: (pm.message && !['Sent an image attachment', 'Sent an audio attachment', 'Sent a video attachment', 'Sent a document attachment'].includes(pm.message)) ? pm.message : '',
                          sender_name: pm.sender_name,
                          created_at: pm.created_at,
                          index: pIdx,
                        }))
                      : []

                    const albumCaptions = isAlbum
                      ? album
                          .map((pm) => pm.message?.trim())
                          .filter((msg) => Boolean(
                            msg &&
                            !['Sent an image attachment', 'Sent an audio attachment', 'Sent a video attachment', 'Sent a document attachment'].includes(msg)
                          ))
                      : []
                    const hasAlbumCaptions = albumCaptions.length > 0

                    const albumReactions = (() => {
                      if (!isAlbum) return []
                      const map = {}
                      album.forEach((pm) => {
                        (pm.reactions || []).forEach((r) => {
                          if (!map[r.emoji]) {
                            map[r.emoji] = { emoji: r.emoji, count: 0, mine: false, targetId: pm.id }
                          }
                          map[r.emoji].count += r.count || 1
                          if (r.mine) map[r.emoji].mine = true
                        })
                      })
                      return Object.values(map)
                    })()

                    const renderCellUploadOverlay = (pm) => {
                      if (pm._uploading) {
                        return (
                          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px] flex flex-col items-center justify-center gap-1 z-10 select-none">
                            <div className="relative w-10 h-10 flex items-center justify-center">
                              <svg className="w-10 h-10 -rotate-90 transform" viewBox="0 0 48 48">
                                <circle cx="24" cy="24" r="20" className="stroke-white/20 fill-none" strokeWidth="3.5" />
                                <circle
                                  cx="24"
                                  cy="24"
                                  r="20"
                                  className="stroke-[#facc15] fill-none transition-all duration-150 ease-out"
                                  strokeWidth="3.5"
                                  strokeDasharray={2 * Math.PI * 20}
                                  strokeDashoffset={2 * Math.PI * 20 * (1 - (pm._uploadProgress || 0) / 100)}
                                  strokeLinecap="round"
                                />
                              </svg>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCancelUpload(pm.id)
                                }}
                                className="absolute inset-0 flex items-center justify-center text-white/90 hover:text-white transition cursor-pointer"
                                title="Cancel upload"
                              >
                                <X className="w-3.5 h-3.5 drop-shadow" />
                              </button>
                            </div>
                            <span className="text-[10px] font-black text-white tracking-wider drop-shadow-md">
                              {pm._uploadProgress || 0}%
                            </span>
                          </div>
                        )
                      }
                      if (pm._uploadFailed) {
                        return (
                          <div className="absolute inset-0 bg-black/75 backdrop-blur-xs flex flex-col items-center justify-center gap-1 p-2 text-center z-10 select-none">
                            <div className="w-7 h-7 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400">
                              <AlertCircle className="w-4 h-4" />
                            </div>
                            <p className="text-[10px] font-bold text-white drop-shadow">Failed</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRetryUpload(pm)
                                }}
                                className="px-2 py-0.5 rounded-full bg-[#facc15] text-[#09090b] text-[10px] font-black flex items-center gap-1 shadow-md hover:bg-yellow-400 active:scale-95 transition cursor-pointer"
                              >
                                <RotateCw className="w-2.5 h-2.5" />
                                <span>Retry</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCancelUpload(pm.id)
                                }}
                                className="px-2 py-0.5 rounded-full bg-white/20 text-white text-[10px] font-semibold hover:bg-white/30 active:scale-95 transition cursor-pointer"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        )
                      }
                      return null
                    }

                    return (
                      <div key={item.id} className="w-full flex flex-col">
                        {/* Floating Glassmorphic Date Separator (WhatsApp / Telegram style) */}
                        {showDateDivider && (
                          <div className="flex justify-center my-3 select-none pointer-events-none">
                            <span className={`px-3.5 py-1 rounded-full text-[11px] font-semibold tracking-wide backdrop-blur-md transition-all shadow-md ${
                              isLight 
                                ? 'bg-white/85 text-slate-700 border border-slate-200/90 shadow-slate-200/50' 
                                : 'bg-[#18181b]/85 text-zinc-300 border border-white/10 shadow-black/40'
                            }`}>
                              {formatMessageDateDivider(m.created_at)}
                            </span>
                          </div>
                        )}

                        {/* Message Bubble Body with Swipe-to-reply and Double-tap */}
                        <div
                          className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[85%] sm:max-w-[70%] ${
                            isUser ? 'ml-auto' : 'mr-auto'
                          } ${isFirstInGroup ? 'mt-2.5 sm:mt-3' : 'mt-1'} ${isLastInGroup ? 'mb-2' : 'mb-0.5'} ${
                            m._pending ? 'animate-message-pop' : 'animate-message-entrance'
                          }`}
                        >
                          <SwipeableMessageBubble
                            isUser={isUser}
                            m={m}
                            onSwipeReply={(msg) => {
                              setReplyTo(msg)
                              if (textareaRef.current) textareaRef.current.focus()
                            }}
                            onDoubleTap={handleDoubleTapReaction}
                            onLongPress={(msg, rect) => {
                              triggerHaptic('heavy')
                              handleOpenActionMenu(msg, rect)
                            }}
                          >
                            <div
                              data-message-bubble="true"
                              onDoubleClick={() => handleDoubleTapReaction(m)}
                              style={{ WebkitTouchCallout: 'none' }}
                              className={`group relative ${
                                isAlbum
                                  ? 'p-1 sm:p-1.5 w-[280px] sm:w-[320px] max-w-full'
                                  : (isImage && !hasText)
                                    ? 'p-1 sm:p-1.5 w-[260px] sm:w-[300px] max-w-full'
                                    : 'px-3.5 py-2 sm:px-4 sm:py-2.5 text-[13px] sm:text-[14px]'
                              } leading-relaxed shadow-sm break-words select-none md:select-text ${bubbleCorners} ${
                                isUser
                                  ? 'bg-gradient-to-br from-[#facc15] via-[#eab308] to-[#ca8a04] text-[#09090b] font-medium shadow-yellow-500/10'
                                  : isLight
                                    ? 'bg-white text-slate-900 border border-slate-200/90 shadow-sm shadow-slate-200/40'
                                    : 'bg-[#18181b] text-zinc-100 border border-[#27272a] shadow-md shadow-black/30'
                              }`}
                            >
                              {/* Floating Heart Burst on Double-Tap */}
                              {album.some((x) => sameId(floatingHeartId, x.id)) && (
                                <span className="absolute top-1/2 left-1/2 pointer-events-none text-3xl z-30 animate-heart-float select-none">
                                  ❤️
                                </span>
                              )}

                              {/* Authentic Corner Tail Notch */}
                              {isLastInGroup && (
                                isUser ? (
                                  <span className="absolute -right-2 bottom-0 w-2 h-3.5 pointer-events-none select-none z-10" aria-hidden="true">
                                    <svg viewBox="0 0 8 14" className="w-2 h-3.5 fill-[#ca8a04]">
                                      <path d="M0,0 C0,7 3,12 8,14 L0,14 Z" />
                                    </svg>
                                  </span>
                                ) : (
                                  <span className="absolute -left-2 bottom-0 w-2 h-3.5 pointer-events-none select-none z-10" aria-hidden="true">
                                    <svg viewBox="0 0 8 14" className={`w-2 h-3.5 ${isLight ? 'fill-white' : 'fill-[#18181b]'}`}>
                                      <path d="M8,0 C8,7 5,12 0,14 L8,14 Z" />
                                    </svg>
                                  </span>
                                )
                              )}

                              {/* Sender Name ONLY in Group Chats (never in 1-on-1 direct chats) */}
                              {!isUser && isFirstInGroup && activeConversation?.room_type === 'group' && (
                                <p className={`text-[11px] font-bold mb-1 tracking-tight select-none ${isAlbum || (isImage && !hasText) ? 'px-1.5 pt-0.5' : ''} ${
                                  isLight ? 'text-amber-700' : 'text-amber-400'
                                }`}>
                                  {m.sender_name || 'Member'}
                                </p>
                              )}

                              {/* Quoted reply context */}
                              {m.reply_to_id && (() => {
                                const quoted = (messages || []).find((x) => sameId(x.id, m.reply_to_id))
                                return (
                                  <div className={`mb-1.5 px-2.5 py-1.5 rounded-lg border-l-2 text-[11px] ${
                                    isUser
                                      ? 'bg-black/10 border-[#09090b]/50 text-[#09090b]'
                                      : isLight
                                        ? 'bg-slate-50 border-amber-400 text-slate-700'
                                        : 'bg-[#09090b]/80 border-[#facc15] text-zinc-300'
                                  } ${isAlbum || (isImage && !hasText) ? 'mx-1 mt-1 mb-1.5' : ''}`}>
                                    <p className="font-black truncate">
                                      {quoted ? (quoted.sender_name || 'Message') : 'Message'}
                                    </p>
                                    <p className="truncate opacity-80">
                                      {quoted
                                        ? (quoted.deleted || quoted.message_type === 'deleted'
                                          ? 'This message was deleted'
                                          : quoted.message)
                                        : 'Original message'}
                                    </p>
                                  </div>
                                )
                              })()}

                              {/* ── MULTI-PHOTO ALBUM / COLLAGE VIEW (Item 2 Standard) ── */}
                              {isAlbum ? (
                                <div className="flex flex-col">
                                  <div className="relative rounded-xl overflow-hidden shadow-xs">
                                    {/* 2 Photos: Side-by-Side 50/50 Split */}
                                    {album.length === 2 && (
                                      <div className="grid grid-cols-2 gap-1 rounded-xl overflow-hidden bg-black/20">
                                        {album.slice(0, 2).map((pm, pIdx) => (
                                          <div key={pm.id} className="relative aspect-square overflow-hidden group/cell bg-zinc-900/60">
                                            <img
                                              src={resolveMediaUrl(pm.media_url)}
                                              alt={`Photo ${pIdx + 1}`}
                                              onClick={() => {
                                                if (pm._uploading || pm._uploadFailed) return
                                                openLightbox(resolveMediaUrl(pm.media_url), albumImages, pIdx)
                                              }}
                                              className={`w-full h-full object-cover transition-transform duration-200 ${
                                                pm._uploading ? 'filter brightness-75' : 'cursor-pointer hover:scale-[1.03]'
                                              }`}
                                            />
                                            {renderCellUploadOverlay(pm)}
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* 3 Photos: 1 Prominent Top Banner + 2 Side-by-Side Below */}
                                    {album.length === 3 && (
                                      <div className="grid grid-cols-2 gap-1 rounded-xl overflow-hidden bg-black/20">
                                        <div className="col-span-2 relative aspect-[16/10] overflow-hidden group/cell bg-zinc-900/60">
                                          <img
                                            src={resolveMediaUrl(album[0].media_url)}
                                            alt="Photo 1"
                                            onClick={() => {
                                              if (album[0]._uploading || album[0]._uploadFailed) return
                                              openLightbox(resolveMediaUrl(album[0].media_url), albumImages, 0)
                                            }}
                                            className={`w-full h-full object-cover transition-transform duration-200 ${
                                              album[0]._uploading ? 'filter brightness-75' : 'cursor-pointer hover:scale-[1.03]'
                                            }`}
                                          />
                                          {renderCellUploadOverlay(album[0])}
                                        </div>
                                        {album.slice(1, 3).map((pm, idx) => {
                                          const pIdx = idx + 1
                                          return (
                                            <div key={pm.id} className="col-span-1 relative aspect-square overflow-hidden group/cell bg-zinc-900/60">
                                              <img
                                                src={resolveMediaUrl(pm.media_url)}
                                                alt={`Photo ${pIdx + 1}`}
                                                onClick={() => {
                                                  if (pm._uploading || pm._uploadFailed) return
                                                  openLightbox(resolveMediaUrl(pm.media_url), albumImages, pIdx)
                                                }}
                                                className={`w-full h-full object-cover transition-transform duration-200 ${
                                                  pm._uploading ? 'filter brightness-75' : 'cursor-pointer hover:scale-[1.03]'
                                                }`}
                                              />
                                              {renderCellUploadOverlay(pm)}
                                            </div>
                                          )
                                        })}
                                      </div>
                                    )}

                                    {/* 4 Photos: Clean 2x2 Grid Collage */}
                                    {album.length === 4 && (
                                      <div className="grid grid-cols-2 gap-1 rounded-xl overflow-hidden bg-black/20">
                                        {album.slice(0, 4).map((pm, pIdx) => (
                                          <div key={pm.id} className="col-span-1 relative aspect-square overflow-hidden group/cell bg-zinc-900/60">
                                            <img
                                              src={resolveMediaUrl(pm.media_url)}
                                              alt={`Photo ${pIdx + 1}`}
                                              onClick={() => {
                                                if (pm._uploading || pm._uploadFailed) return
                                                openLightbox(resolveMediaUrl(pm.media_url), albumImages, pIdx)
                                              }}
                                              className={`w-full h-full object-cover transition-transform duration-200 ${
                                                pm._uploading ? 'filter brightness-75' : 'cursor-pointer hover:scale-[1.03]'
                                              }`}
                                            />
                                            {renderCellUploadOverlay(pm)}
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* 5+ Photos: 2x2 Grid with Frosted +N Badge on 4th Cell */}
                                    {album.length >= 5 && (
                                      <div className="grid grid-cols-2 gap-1 rounded-xl overflow-hidden bg-black/20">
                                        {album.slice(0, 3).map((pm, pIdx) => (
                                          <div key={pm.id} className="col-span-1 relative aspect-square overflow-hidden group/cell bg-zinc-900/60">
                                            <img
                                              src={resolveMediaUrl(pm.media_url)}
                                              alt={`Photo ${pIdx + 1}`}
                                              onClick={() => {
                                                if (pm._uploading || pm._uploadFailed) return
                                                openLightbox(resolveMediaUrl(pm.media_url), albumImages, pIdx)
                                              }}
                                              className={`w-full h-full object-cover transition-transform duration-200 ${
                                                pm._uploading ? 'filter brightness-75' : 'cursor-pointer hover:scale-[1.03]'
                                              }`}
                                            />
                                            {renderCellUploadOverlay(pm)}
                                          </div>
                                        ))}
                                        <div
                                          className="col-span-1 relative aspect-square overflow-hidden group/cell bg-zinc-900/60 cursor-pointer"
                                          onClick={() => {
                                            const pm = album[3]
                                            if (pm._uploading || pm._uploadFailed) return
                                            openLightbox(resolveMediaUrl(pm.media_url), albumImages, 3)
                                          }}
                                        >
                                          <img
                                            src={resolveMediaUrl(album[3].media_url)}
                                            alt="Photo 4"
                                            className="w-full h-full object-cover filter brightness-[0.55] transition-transform duration-200 hover:scale-[1.03]"
                                          />
                                          <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] flex flex-col items-center justify-center text-white pointer-events-none">
                                            <span className="text-2xl sm:text-3xl font-black drop-shadow-lg tracking-tight">
                                              +{album.length - 3}
                                            </span>
                                            <span className="text-[10px] font-bold uppercase tracking-wider opacity-90 drop-shadow">
                                              photos
                                            </span>
                                          </div>
                                          {renderCellUploadOverlay(album[3])}
                                        </div>
                                      </div>
                                    )}

                                    {/* Floating Timestamp & Read Status for Album when NO Caption is attached */}
                                    {!hasAlbumCaptions && (
                                      <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-white text-[10px] flex items-center gap-1 shadow-md z-10 pointer-events-none select-none">
                                        <span className="tracking-tight">{formatMessageTime(lastMsg.created_at)}</span>
                                        {isUser && (
                                          <span className="inline-flex items-center ml-0.5">
                                            {album.some((pm) => pm._pending || pm._uploading) ? (
                                              <span className="w-3 h-3 border-2 border-white/80 border-t-transparent rounded-full animate-spin" />
                                            ) : album.some((pm) => pm._failed || pm._uploadFailed) ? (
                                              <span className="text-rose-400 font-bold">!</span>
                                            ) : (
                                              <span title={(peerLastReadId >= lastMsg.id || lastMsg.is_read) ? 'Read' : 'Delivered'} className="inline-flex items-center">
                                                {(peerLastReadId >= lastMsg.id || lastMsg.is_read) ? (
                                                  <CheckCheck className="w-3.5 h-3.5 text-[#facc15]" />
                                                ) : (
                                                  <Check className="w-3.5 h-3.5 text-white/80" />
                                                )}
                                              </span>
                                            )}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  {/* Album Caption(s) if attached */}
                                  {hasAlbumCaptions && (
                                    <div className="px-2 pt-2 pb-0.5 space-y-1">
                                      {albumCaptions.map((cap, cIdx) => (
                                        <p key={cIdx} className="text-[13px] sm:text-[14px] leading-relaxed select-none md:select-text whitespace-pre-line break-words">
                                          {cap}
                                        </p>
                                      ))}
                                    </div>
                                  )}

                                  {/* Combined Reactions for Album */}
                                  {albumReactions.length > 0 && (
                                    <div className="flex flex-wrap gap-1 px-1.5 pt-1.5 pb-0.5 w-full">
                                      {albumReactions.map((r) => (
                                        <button
                                          key={r.emoji}
                                          type="button"
                                          onClick={() => toggleReaction(r.targetId || m.id, r.emoji)}
                                          className={`px-1.5 py-0.5 rounded-full text-[11px] border active:scale-95 transition ${
                                            r.mine
                                              ? 'bg-amber-500/20 border-amber-500/50'
                                              : isUser
                                                ? 'bg-black/10 border-black/20'
                                                : isLight
                                                  ? 'bg-slate-100 border-slate-200'
                                                  : 'bg-[#27272a] border-[#3f3f46]'
                                          }`}
                                        >
                                          {r.emoji} {r.count}
                                        </button>
                                      ))}
                                    </div>
                                  )}

                                  {/* Inline Metadata Cluster below Album Caption */}
                                  {hasAlbumCaptions && (
                                    <div
                                      className={`flex items-center justify-end gap-1 text-[10px] select-none ml-auto shrink-0 self-end px-2 pb-1 ${
                                        isUser 
                                          ? 'text-[#09090b]/80 font-semibold' 
                                          : isLight 
                                            ? 'text-slate-400 font-medium' 
                                            : 'text-zinc-400 font-medium'
                                      }`}
                                    >
                                      <span className="tracking-tight">{formatMessageTime(lastMsg.created_at)}</span>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          const rect = e.currentTarget.closest('[data-message-bubble]')?.getBoundingClientRect() || e.currentTarget.getBoundingClientRect()
                                          handleOpenActionMenu(lastMsg, rect)
                                        }}
                                        title="Message actions"
                                        className="hidden md:inline-flex opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-0.5 -mr-0.5 cursor-pointer"
                                      >
                                        <MoreVertical className="w-3 h-3" />
                                      </button>
                                      {isUser && (
                                        <span className="inline-flex items-center ml-0.5">
                                          {album.some((pm) => pm._pending || pm._uploading) ? (
                                            <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin opacity-70" title="Sending…" />
                                          ) : (
                                            <span title={(peerLastReadId >= lastMsg.id || lastMsg.is_read) ? 'Read' : 'Delivered to server'} className="inline-flex items-center">
                                              {(peerLastReadId >= lastMsg.id || lastMsg.is_read) ? (
                                                <CheckCheck className="w-3.5 h-3.5 text-[#09090b]" />
                                              ) : (
                                                <Check className="w-3.5 h-3.5 text-[#09090b]/60" />
                                              )}
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                /* ── SINGLE MESSAGE (Photo, Audio, Video, Document, or Text) ── */
                                <>
                                  {/* Voice Note Player */}
                                  {m.media_url && m.message_type === 'audio' && (
                                    <VoiceNotePlayer
                                      audioUrl={resolveMediaUrl(m.media_url)}
                                      isUser={isUser}
                                      isLight={isLight}
                                      seedId={m.id}
                                    />
                                  )}

                                  {/* Video Player */}
                                  {m.media_url && m.message_type === 'video' && (
                                    <video
                                      controls
                                      playsInline
                                      src={resolveMediaUrl(m.media_url)}
                                      className="max-h-60 rounded-xl mb-1.5"
                                    />
                                  )}

                                  {/* Document (PDF) Attachment */}
                                  {m.media_url && (m.message_type === 'document' || m.media_url.toLowerCase().endsWith('.pdf')) && (
                                    <a
                                      href={resolveMediaUrl(m.media_url)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className={`mb-2 p-2.5 rounded-xl border flex items-center gap-3 transition-all ${
                                        isUser
                                          ? 'bg-black/15 border-black/20 text-[#09090b] hover:bg-black/20'
                                          : isLight
                                            ? 'bg-slate-100 border-slate-200 text-slate-800 hover:bg-slate-200/80'
                                            : 'bg-white/10 border-white/15 text-white hover:bg-white/15'
                                      }`}
                                    >
                                      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-500/20 text-blue-500 shrink-0 shadow-xs">
                                        <FileText className="w-5 h-5" />
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-xs font-bold truncate">
                                          {m.media_url.split('/').pop().replace(/^chat_[a-f0-9]+_/, '') || 'Document.pdf'}
                                        </p>
                                        <span className="text-[10px] opacity-75 font-semibold">PDF Document • Tap to open</span>
                                      </div>
                                      <Download className="w-4 h-4 shrink-0 opacity-70" />
                                    </a>
                                  )}

                                  {/* Single Image Attachment */}
                                  {isImage && (
                                    <div className="relative mb-1 overflow-hidden rounded-xl cursor-pointer group/single select-none">
                                      <img
                                        src={resolveMediaUrl(m.media_url)}
                                        alt="Attachment"
                                        onClick={() => {
                                          if (m._uploading || m._uploadFailed) return
                                          openLightbox(resolveMediaUrl(m.media_url), allChatImages, singleImageIdx >= 0 ? singleImageIdx : 0)
                                        }}
                                        className={`max-h-72 w-full rounded-xl object-cover transition-all duration-200 ${
                                          m._uploading ? 'filter brightness-75' : 'hover:scale-[1.01]'
                                        }`}
                                      />
                                      {renderCellUploadOverlay(m)}

                                      {/* Floating Timestamp & Read ticks for Single Photo without Caption */}
                                      {!hasText && (
                                        <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-white text-[10px] flex items-center gap-1 shadow-md z-10 pointer-events-none select-none">
                                          <span className="tracking-tight">{formatMessageTime(m.created_at)}</span>
                                          {isUser && (
                                            <span className="inline-flex items-center ml-0.5">
                                              {m._pending || m._uploading ? (
                                                <span className="w-3 h-3 border-2 border-white/80 border-t-transparent rounded-full animate-spin" />
                                              ) : m._failed || m._uploadFailed ? (
                                                <span className="text-rose-400 font-bold">!</span>
                                              ) : (
                                                <span title={(peerLastReadId >= m.id || m.is_read) ? 'Read' : 'Delivered'} className="inline-flex items-center">
                                                  {(peerLastReadId >= m.id || m.is_read) ? (
                                                    <CheckCheck className="w-3.5 h-3.5 text-[#facc15]" />
                                                  ) : (
                                                    <Check className="w-3.5 h-3.5 text-white/80" />
                                                  )}
                                                </span>
                                              )}
                                            </span>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* Text Message Content & Inline Metadata Cluster (when text exists) */}
                                  {(!isImage || hasText) && (
                                    <div className="flex flex-wrap items-end justify-between gap-x-2.5 gap-y-0.5 min-w-[80px]">
                                      {m.deleted || m.message_type === 'deleted' ? (
                                        <p className="italic text-[13px] opacity-70">🚫 This message was deleted</p>
                                      ) : (m._locked || m.message === '🔒 [Encrypted Message]') ? (
                                        <div className="text-[13px] sm:text-[14px] leading-relaxed break-words flex items-center gap-1.5 py-0.5">
                                          <span className="opacity-80 select-none md:select-text">🔒 [Encrypted Message]</span>
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation()
                                              if (activeRoomId) fetchRoomMessages(activeRoomId)
                                              fetchConversations()
                                            }}
                                            className="text-[11px] font-semibold text-amber-500 hover:text-amber-400 underline cursor-pointer ml-1"
                                            title="Click to retry decrypting message"
                                          >
                                            Tap to decrypt
                                          </button>
                                        </div>
                                      ) : hasText ? (
                                        <div className="text-[13px] sm:text-[14px] leading-relaxed break-words select-none md:select-text">
                                          <span className="whitespace-pre-line">{m.message}</span>
                                        </div>
                                      ) : null}

                                      {/* Emoji reactions */}
                                      {Array.isArray(m.reactions) && m.reactions.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1 mb-0.5 w-full">
                                          {m.reactions.map((r) => (
                                            <button
                                              key={r.emoji}
                                              type="button"
                                              onClick={() => toggleReaction(m.id, r.emoji)}
                                              className={`px-1.5 py-0.5 rounded-full text-[11px] border active:scale-95 transition ${
                                                r.mine
                                                  ? 'bg-amber-500/20 border-amber-500/50'
                                                  : isUser
                                                    ? 'bg-black/10 border-black/20'
                                                    : isLight
                                                      ? 'bg-slate-100 border-slate-200'
                                                      : 'bg-[#27272a] border-[#3f3f46]'
                                              }`}
                                            >
                                              {r.emoji} {r.count}
                                            </button>
                                          ))}
                                        </div>
                                      )}

                                      {/* Integrated Inline Time & Read Status Cluster */}
                                      <div
                                        className={`flex items-center justify-end gap-1 text-[10px] select-none ml-auto shrink-0 self-end pb-0.5 ${
                                          isUser 
                                            ? 'text-[#09090b]/80 font-semibold' 
                                            : isLight 
                                              ? 'text-slate-400 font-medium' 
                                              : 'text-zinc-400 font-medium'
                                        }`}
                                      >
                                        <span title="Encrypted message (AES-GCM)" className="inline-flex items-center opacity-60">
                                          <Lock className="w-2.5 h-2.5" />
                                        </span>
                                        <span className="tracking-tight">{formatMessageTime(m.created_at)}</span>
                                        {m.edited_at && <span className="opacity-60 text-[9px]">(edited)</span>}
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            const rect = e.currentTarget.closest('[data-message-bubble]')?.getBoundingClientRect() || e.currentTarget.getBoundingClientRect()
                                            handleOpenActionMenu(m, rect)
                                          }}
                                          title="Message actions"
                                          className="hidden md:inline-flex opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-0.5 -mr-0.5 cursor-pointer"
                                        >
                                          <MoreVertical className="w-3 h-3" />
                                        </button>
                                        {isUser && (
                                          <span className="inline-flex items-center ml-0.5">
                                            {m._pending ? (
                                              <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin opacity-70" title="Sending…" />
                                            ) : m._failed ? (
                                              <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); handleRetryMessage(m); }}
                                                className="inline-flex items-center gap-1 text-[9px] font-black text-rose-900 bg-rose-200/90 px-1.5 py-0.5 rounded-md hover:scale-105 active:scale-95 transition cursor-pointer shadow-xs"
                                                title="Send failed. Tap to retry."
                                              >
                                                <span>Retry</span>
                                                <RotateCcw className="w-2.5 h-2.5" />
                                              </button>
                                            ) : (
                                              <span title={(peerLastReadId >= m.id || m.is_read) ? 'Read' : 'Delivered to server'} className="inline-flex items-center">
                                                {(peerLastReadId >= m.id || m.is_read) ? (
                                                  <CheckCheck className="w-3.5 h-3.5 text-[#09090b]" />
                                                ) : (
                                                  <Check className="w-3.5 h-3.5 text-[#09090b]/60" />
                                                )}
                                              </span>
                                            )}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </SwipeableMessageBubble>
                        </div>
                      </div>
                    )
                  })
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Jump to latest message Floating Action Button (FAB) */}
              {showScrollBottomFab && (
                <button
                  type="button"
                  onClick={handleJumpToBottom}
                  className="absolute right-4 sm:right-7 bottom-20 z-30 p-2.5 sm:p-3 rounded-full bg-gradient-to-tr from-[#facc15] to-[#eab308] text-[#09090b] shadow-xl shadow-yellow-500/25 hover:scale-105 active:scale-95 transition-all flex items-center gap-1.5 font-black cursor-pointer animate-in fade-in slide-in-from-bottom-3"
                  title="Jump to latest message"
                  aria-label="Jump to latest message"
                >
                  <ChevronDown className="w-5 h-5 stroke-[2.5]" />
                  {unreadBelowCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-black bg-[#09090b] text-[#facc15] shadow-xs">
                      {unreadBelowCount}
                    </span>
                  )}
                </button>
              )}

              {/* Active Chat Message Input Bar */}
              <footer className={`relative shrink-0 border-t p-2.5 sm:p-3 ${
                isKeyboardOpen ? 'pb-2' : 'pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]'
              } z-20 transition-colors backdrop-blur-2xl ${
                isLight
                  ? 'bg-white/95 border-slate-200/80 shadow-[0_-4px_24px_rgba(0,0,0,0.03)]'
                  : 'bg-[#0f0f12]/95 border-white/5 shadow-[0_-4px_30px_rgba(0,0,0,0.5)]'
              }`}>
                {/* ── ATTACHMENT TRAY POPOVER (WhatsApp / Telegram 4-Tile Luxury Drawer) ── */}
                {showAttachmentTray && !isBlockedConversation && (
                  <>
                    <div
                      className="fixed inset-0 z-30"
                      onClick={() => setShowAttachmentTray(false)}
                    />
                    <div className={`absolute bottom-full left-2 sm:left-4 mb-3 p-3.5 rounded-3xl border shadow-2xl z-40 grid grid-cols-3 gap-3.5 sm:gap-5 animate-in fade-in zoom-in-95 duration-150 backdrop-blur-2xl ${
                      isLight
                        ? 'bg-white/95 border-slate-200 shadow-slate-300/70'
                        : 'bg-[#18181b]/95 border-white/10 shadow-black/80'
                    }`}>
                      {/* Option 1: Gallery (Photos & Videos) */}
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light')
                          if (fileInputRef.current) {
                            fileInputRef.current.accept = 'image/*,video/*'
                            fileInputRef.current.click()
                          }
                          setShowAttachmentTray(false)
                        }}
                        className="flex flex-col items-center gap-1.5 group cursor-pointer active:scale-95 transition-transform"
                      >
                        <span className="w-12 h-12 rounded-2xl flex items-center justify-center bg-gradient-to-tr from-purple-600 to-indigo-500 text-white shadow-lg shadow-purple-500/25 group-hover:scale-105 group-hover:shadow-purple-500/40 transition-all">
                          <ImageIcon className="w-5 h-5" />
                        </span>
                        <span className={`text-[11px] font-bold tracking-tight ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                          Gallery
                        </span>
                      </button>

                      {/* Option 2: Documents (PDF) */}
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light')
                          if (fileInputRef.current) {
                            fileInputRef.current.accept = '.pdf,application/pdf'
                            fileInputRef.current.click()
                          }
                          setShowAttachmentTray(false)
                        }}
                        className="flex flex-col items-center gap-1.5 group cursor-pointer active:scale-95 transition-transform"
                      >
                        <span className="w-12 h-12 rounded-2xl flex items-center justify-center bg-gradient-to-tr from-blue-600 to-cyan-500 text-white shadow-lg shadow-blue-500/25 group-hover:scale-105 group-hover:shadow-blue-500/40 transition-all">
                          <FileText className="w-5 h-5" />
                        </span>
                        <span className={`text-[11px] font-bold tracking-tight ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                          Document
                        </span>
                      </button>

                      {/* Option 3: Audio (Music / Clips) */}
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light')
                          if (fileInputRef.current) {
                            fileInputRef.current.accept = 'audio/*'
                            fileInputRef.current.click()
                          }
                          setShowAttachmentTray(false)
                        }}
                        className="flex flex-col items-center gap-1.5 group cursor-pointer active:scale-95 transition-transform"
                      >
                        <span className="w-12 h-12 rounded-2xl flex items-center justify-center bg-gradient-to-tr from-emerald-600 to-teal-500 text-white shadow-lg shadow-emerald-500/25 group-hover:scale-105 group-hover:shadow-emerald-500/40 transition-all">
                          <Music className="w-5 h-5" />
                        </span>
                        <span className={`text-[11px] font-bold tracking-tight ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                          Audio
                        </span>
                      </button>
                    </div>
                  </>
                )}

                {/* ── EMOJI PICKER DRAWER / POPOVER ── */}
                {showEmojiPicker && (
                  <>
                    <div
                      className="fixed inset-0 z-30"
                      onClick={() => setShowEmojiPicker(false)}
                    />
                    <div className={`absolute bottom-full left-2 sm:left-14 mb-3 w-[320px] sm:w-[360px] max-w-[calc(100vw-1rem)] p-3 rounded-3xl border shadow-2xl z-40 animate-in fade-in zoom-in-95 duration-150 backdrop-blur-2xl ${
                      isLight
                        ? 'bg-white/95 border-slate-200 shadow-slate-300/70'
                        : 'bg-[#18181b]/95 border-white/10 shadow-black/80'
                    }`}>
                      {/* Emoji Header with Category Tabs */}
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 gap-1 overflow-x-auto custom-scrollbar">
                        <div className="flex items-center gap-1">
                          {QUICK_EMOJI_CATEGORIES.map((cat, idx) => (
                            <button
                              key={cat.name}
                              type="button"
                              onClick={() => setActiveEmojiCategory(idx)}
                              className={`px-2 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1 select-none ${
                                activeEmojiCategory === idx
                                  ? 'bg-[#facc15] text-[#09090b] shadow-xs'
                                  : isLight
                                    ? 'text-slate-600 hover:bg-slate-100'
                                    : 'text-zinc-400 hover:bg-white/5'
                              }`}
                            >
                              <span>{cat.icon}</span>
                              <span className="hidden sm:inline">{cat.name}</span>
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowEmojiPicker(false)}
                          className={`p-1 rounded-lg shrink-0 ${isLight ? 'hover:bg-slate-100 text-slate-500' : 'hover:bg-white/10 text-zinc-400'} cursor-pointer`}
                          title="Close"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Active Category Emoji Grid */}
                      <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto pr-1 select-none custom-scrollbar">
                        {QUICK_EMOJI_CATEGORIES[activeEmojiCategory]?.emojis.map((em, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => handleInsertEmoji(em)}
                            className="w-8 h-8 flex items-center justify-center text-lg rounded-xl hover:bg-amber-500/15 hover:scale-125 active:scale-90 transition-all cursor-pointer"
                          >
                            {em}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {replyTo && (
                  <div className={`max-w-4xl mx-auto mb-2 px-3 py-2 rounded-xl border-l-4 flex items-center justify-between gap-2 backdrop-blur-md transition-all ${
                    isLight
                      ? 'bg-amber-50/80 border-amber-500 text-slate-700'
                      : 'bg-[#18181b]/80 border-[#facc15] text-zinc-200'
                  }`}>
                    <div className="min-w-0">
                      <p className={`text-[10px] font-black truncate ${isLight ? 'text-amber-700' : 'text-[#facc15]'}`}>
                        Replying to {replyTo.sender_name || 'message'}
                      </p>
                      <p className="text-[11px] truncate opacity-85">
                        {replyTo.deleted ? 'This message was deleted' : replyTo.message}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="p-1 shrink-0 opacity-70 hover:opacity-100 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {editingId && (
                  <div className={`max-w-4xl mx-auto mb-2 px-3 py-2 rounded-xl border-l-4 flex items-center justify-between gap-2 backdrop-blur-md transition-all ${
                    isLight
                      ? 'bg-amber-50/80 border-amber-500 text-slate-700'
                      : 'bg-[#18181b]/80 border-[#facc15] text-zinc-200'
                  }`}>
                    <div className="min-w-0">
                      <p className={`text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5 ${isLight ? 'text-amber-700' : 'text-[#facc15]'}`}>
                        <Edit3 className="w-3.5 h-3.5" />
                        Editing message
                      </p>
                      <p className="text-[11px] truncate opacity-85">
                        Press Enter or Send to save changes
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null)
                        setInputText('')
                        if (textareaRef.current) textareaRef.current.style.height = 'auto'
                      }}
                      className="p-1 shrink-0 opacity-70 hover:opacity-100 cursor-pointer"
                      title="Cancel edit"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {isBlockedConversation && (
                  <div className={`max-w-4xl mx-auto mb-2 px-3 py-2 rounded-xl text-[11px] font-bold text-center border flex items-center justify-center gap-2 ${
                    isLight
                      ? 'bg-rose-50 border-rose-200 text-rose-700'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  }`}>
                    <span>
                      {activeConversation?.blocked_by_me
                        ? 'You blocked this user.'
                        : 'You can\'t message this user.'}
                    </span>
                    {activeConversation?.blocked_by_me && (
                      <button
                        type="button"
                        onClick={async () => {
                          const targetId = activeConversation?.other_user?.id
                          if (!targetId) return
                          triggerHaptic('medium')
                          toast.success('User unblocked')
                          const ok = await unblockUser(targetId)
                          if (!ok) toast.error('Could not unblock user')
                        }}
                        className="underline text-amber-500 hover:text-amber-400 font-black cursor-pointer ml-1"
                      >
                        Unblock
                      </button>
                    )}
                  </div>
                )}
                <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex items-end gap-2 relative">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleMediaSelect}
                    disabled={isBlockedConversation}
                    accept="image/*,audio/*,video/*,.pdf"
                    multiple
                    className="hidden"
                  />
                  <input
                    type="file"
                    ref={addMoreImagesInputRef}
                    onChange={handleAddMoreImages}
                    disabled={isBlockedConversation}
                    accept="image/*"
                    multiple
                    className="hidden"
                  />

                  {/* Attachment Button */}
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light')
                      setShowAttachmentTray((prev) => !prev)
                      setShowEmojiPicker(false)
                    }}
                    disabled={uploadingImage || isRecording || Boolean(voiceReview) || isBlockedConversation}
                    title={isBlockedConversation ? 'Unblock this user to attach files' : 'Attach photo, video, document or audio'}
                    className={`p-2.5 sm:p-3 rounded-2xl sm:rounded-3xl border active:scale-95 transition-all shrink-0 cursor-pointer ${
                      showAttachmentTray
                        ? 'bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] border-[#facc15] shadow-md shadow-yellow-500/20'
                        : isLight
                          ? 'bg-slate-50 border-slate-200 text-slate-600 hover:text-amber-700 hover:border-amber-300 shadow-xs'
                          : 'bg-[#18181b] border-white/10 text-[#a1a1aa] hover:text-[#facc15] hover:border-[#facc15]/40 shadow-xs'
                    }`}
                  >
                    {uploadingImage ? (
                      <div className={`w-5 h-5 border-2 border-t-transparent rounded-full animate-spin ${
                        isLight ? 'border-amber-600' : 'border-[#facc15]'
                      }`}></div>
                    ) : (
                      <Paperclip className="w-5 h-5" />
                    )}
                  </button>

                  {/* Center Composer: Voice Review Mode OR Live Recording Bar OR Luxury Input Capsule */}
                  {voiceReview ? (
                    <div className={`flex-1 flex items-center justify-between px-2.5 sm:px-4 py-2 sm:py-2.5 rounded-2xl sm:rounded-3xl border transition-all animate-in fade-in duration-200 ${
                      isLight ? 'bg-amber-50/90 border-amber-300 shadow-xs' : 'bg-[#18181b] border-yellow-500/30 shadow-inner'
                    }`}>
                      {/* Hidden audio element for preview */}
                      <audio
                        ref={reviewAudioRef}
                        src={voiceReview.url}
                        preload="auto"
                        onTimeUpdate={() => {
                          if (reviewAudioRef.current) {
                            setVoiceReview((prev) => prev ? { ...prev, currentTime: reviewAudioRef.current.currentTime } : null)
                          }
                        }}
                        onEnded={() => {
                          setVoiceReview((prev) => prev ? { ...prev, isPlaying: false, currentTime: 0 } : null)
                          if (reviewAudioRef.current) reviewAudioRef.current.currentTime = 0
                        }}
                      />

                      {/* Discard Trash Button */}
                      <button
                        type="button"
                        onClick={discardVoiceReview}
                        title="Discard voice note"
                        className="p-1.5 sm:p-2 rounded-xl text-zinc-400 hover:text-rose-500 hover:bg-rose-500/10 active:scale-95 transition cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-rose-500" />
                      </button>

                      {/* Play / Pause Circular Button */}
                      <button
                        type="button"
                        onClick={toggleReviewPlay}
                        title={voiceReview.isPlaying ? 'Pause preview' : 'Play preview'}
                        className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gradient-to-tr from-[#facc15] to-[#eab308] text-[#09090b] flex items-center justify-center shrink-0 shadow-md active:scale-90 hover:scale-105 transition cursor-pointer ml-1"
                      >
                        {voiceReview.isPlaying ? (
                          <Pause className="w-4 h-4 fill-current" />
                        ) : (
                          <Play className="w-4 h-4 fill-current ml-0.5" />
                        )}
                      </button>

                      {/* Scrubbing Track */}
                      <div
                        onClick={handleReviewScrub}
                        className="flex-1 h-6 flex items-center cursor-pointer group py-1 mx-2 min-w-0"
                        title="Click to seek"
                      >
                        <div className="w-full h-1.5 sm:h-2 rounded-full bg-zinc-700/60 overflow-hidden relative">
                          <div
                            style={{
                              width: `${
                                voiceReview.duration > 0
                                  ? Math.min(100, Math.max(0, (voiceReview.currentTime / voiceReview.duration) * 100))
                                  : 0
                              }%`
                            }}
                            className="h-full bg-[#facc15] rounded-full transition-all duration-75"
                          />
                        </div>
                      </div>

                      {/* Current Time / Duration */}
                      <span className="text-[11px] font-mono font-bold text-zinc-400 shrink-0 mr-1.5 select-none">
                        {formatRecordingDuration(Math.round(voiceReview.isPlaying ? voiceReview.currentTime : (voiceReview.duration || 0)))}
                      </span>

                      {/* Speed Cycle Button */}
                      <button
                        type="button"
                        onClick={cycleReviewSpeed}
                        className="px-2 py-0.5 rounded-full text-[10px] font-mono font-black bg-white/10 hover:bg-white/15 text-[#facc15] active:scale-95 transition cursor-pointer shrink-0"
                        title="Playback speed (1x / 1.5x / 2x)"
                      >
                        {reviewPlaybackRate}x
                      </button>
                    </div>
                  ) : isRecording ? (
                    <div className={`flex-1 flex items-center justify-between px-3 sm:px-4 py-2.5 rounded-2xl sm:rounded-3xl border transition-all animate-in fade-in duration-200 ${
                      isLight ? 'bg-rose-50/95 border-rose-200 shadow-xs' : 'bg-rose-500/10 border-rose-500/30 shadow-inner'
                    }`}>
                      {/* Left: Pulsing Red Recording Indicator & Duration */}
                      <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
                        <span className="relative flex h-3.5 w-3.5 shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-rose-500 shadow-xs shadow-rose-500/50"></span>
                        </span>
                        <span className="text-xs font-mono font-black text-rose-500 tracking-wider shrink-0">
                          {formatRecordingDuration(recordingDuration)}
                        </span>
                        {/* Dynamic Audio Waves Visualizer */}
                        <div className="hidden sm:flex items-center gap-1 ml-1 h-5">
                          {[40, 85, 55, 100, 70, 45, 90, 60, 35].map((h, i) => (
                            <span
                              key={i}
                              style={{ height: `${h}%`, animationDuration: `${600 + (i % 3) * 200}ms` }}
                              className="w-1 bg-rose-500 rounded-full animate-pulse"
                            />
                          ))}
                        </div>
                      </div>

                      {/* Center: Slide-to-Cancel Guide (When holding touch & not locked) */}
                      {!isVoiceLocked && (
                        <div 
                          style={{
                            transform: `translateX(${voiceSlideX * 0.4}px)`,
                            opacity: Math.max(0.2, 1 - Math.abs(voiceSlideX) / 80)
                          }}
                          className="flex items-center gap-1 text-zinc-400 text-xs font-semibold animate-pulse transition-transform"
                        >
                          <ChevronLeft className="w-4 h-4 text-zinc-400" />
                          <span className="text-[11px] sm:text-xs">Slide to cancel</span>
                        </div>
                      )}

                      {/* Right: Stop & Review button + Discard button */}
                      <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
                        <button
                          type="button"
                          onClick={cancelVoiceRecording}
                          title="Discard recording"
                          className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 active:scale-95 text-rose-500 transition-all cursor-pointer flex items-center gap-1 text-xs font-black border border-rose-500/20"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Cancel</span>
                        </button>
                        <button
                          type="button"
                          onClick={stopVoiceRecordingToReview}
                          title="Pause & Review recording"
                          className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 active:scale-95 text-[#facc15] transition-all cursor-pointer flex items-center gap-1.5 text-xs font-black border border-yellow-500/30"
                        >
                          <Square className="w-3.5 h-3.5 fill-current" />
                          <span>Review</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={`flex-1 flex items-end rounded-2xl sm:rounded-3xl border transition-colors px-2 py-1 sm:px-3 sm:py-1.5 ${
                      isLight
                        ? 'bg-slate-50/90 border-slate-200 hover:border-slate-300 focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-500/15 focus-within:bg-white shadow-xs'
                        : 'bg-[#18181b]/90 border-white/10 hover:border-white/15 focus-within:border-[#facc15]/70 focus-within:ring-2 focus-within:ring-[#facc15]/15 focus-within:bg-[#1c1c20] shadow-xs'
                    }`}>
                      {/* Emoji Smile Button */}
                      <button
                        type="button"
                        onClick={() => {
                          setShowEmojiPicker((prev) => !prev)
                          setShowAttachmentTray(false)
                        }}
                        title="Choose emoji"
                        className={`p-2 rounded-xl transition-all cursor-pointer shrink-0 self-end mb-0.5 active:scale-95 ${
                          showEmojiPicker
                            ? 'text-[#facc15] bg-yellow-500/15'
                            : isLight
                              ? 'text-slate-400 hover:text-amber-600 hover:bg-slate-200/60'
                              : 'text-zinc-400 hover:text-[#facc15] hover:bg-white/5'
                        }`}
                      >
                        <Smile className="w-5 h-5" />
                      </button>

                      {/* Auto-expanding Textarea */}
                      <textarea
                        ref={textareaRef}
                        rows={1}
                        placeholder={enterToSend ? "Type a message (Shift+Enter for new line)..." : "Type a message (Enter for new line)..."}
                        value={inputText}
                        enterKeyHint={enterToSend ? "send" : "enter"}
                        onFocus={() => {
                          if (typeof window !== 'undefined') {
                            window.scrollTo(0, 0)
                          }
                          if (mobileView === 'chat') {
                            setTimeout(() => {
                              if (typeof window !== 'undefined') {
                                window.scrollTo(0, 0)
                              }
                              scrollToBottom(false)
                            }, 120)
                          }
                        }}
                        onPaste={handlePaste}
                        onChange={(e) => {
                          const val = e.target.value
                          setInputText(val)
                          updateDraft(activeRoomId, val)
                          adjustTextareaHeight()
                          if (val) sendTyping(activeRoomId)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            if (enterToSend) {
                              e.preventDefault()
                              handleSendMessage(e)
                            }
                          }
                        }}
                        disabled={isBlockedConversation}
                        className={`flex-1 min-w-0 px-2 py-1.5 sm:py-2 bg-transparent border-0 focus:outline-none focus:ring-0 text-base sm:text-sm font-medium resize-none overflow-y-auto max-h-[120px] leading-relaxed ${
                          isLight ? 'text-slate-900 placeholder:text-slate-400' : 'text-white placeholder:text-zinc-400'
                        }`}
                      />

                      {/* Clear text button */}
                      {inputText && (
                        <button
                          type="button"
                          onClick={() => {
                            setInputText('')
                            updateDraft(activeRoomId, '')
                            adjustTextareaHeight()
                          }}
                          className={`p-1.5 rounded-lg opacity-40 hover:opacity-100 transition-opacity shrink-0 self-end mb-1 ${
                            isLight ? 'text-slate-500' : 'text-zinc-400'
                          }`}
                          title="Clear text"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Floating Slide-up Lock indicator */}
                  {isRecording && !isVoiceLocked && (
                    <div 
                      style={{
                        transform: `translateY(${Math.min(voiceSlideY * 0.8, 0)}px)`,
                      }}
                      className="absolute bottom-full mb-3 right-1 sm:right-2 z-30 flex flex-col items-center gap-1 animate-bounce pointer-events-none select-none"
                    >
                      <div className="w-9 h-9 rounded-full bg-[#18181b] border border-yellow-500/50 text-[#facc15] flex items-center justify-center shadow-xl shadow-yellow-500/25">
                        <Lock className="w-4 h-4 stroke-[2.2]" />
                      </div>
                      <ChevronUp className="w-4 h-4 text-[#facc15]" />
                    </div>
                  )}

                  {/* Send / Mic / Stop Recording Action Button */}
                  {voiceReview ? (
                    <button
                      type="button"
                      onClick={sendReviewedVoiceNote}
                      title="Send voice note"
                      className="p-2.5 sm:p-3 rounded-2xl sm:rounded-full bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] shadow-lg shadow-yellow-500/20 hover:brightness-105 active:scale-95 transition-all shrink-0 font-black cursor-pointer flex items-center justify-center animate-in fade-in zoom-in-90 duration-150"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  ) : isRecording ? (
                    <button
                      type="button"
                      onClick={stopVoiceRecording}
                      title="Send immediately"
                      className="p-2.5 sm:p-3 rounded-2xl sm:rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/25 hover:brightness-110 active:scale-95 transition-all shrink-0 font-black cursor-pointer flex items-center justify-center animate-in fade-in zoom-in-90 duration-150"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  ) : inputText.trim() ? (
                    <button
                      type="submit"
                      disabled={isBlockedConversation}
                      title="Send message (Enter)"
                      className="p-2.5 sm:p-3 rounded-2xl sm:rounded-full bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] shadow-lg shadow-yellow-500/20 hover:brightness-105 active:scale-95 transition-all shrink-0 font-black cursor-pointer flex items-center justify-center animate-in fade-in zoom-in-90 duration-150"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={startVoiceRecording}
                      onTouchStart={handleMicTouchStart}
                      onTouchMove={handleMicTouchMove}
                      onTouchEnd={handleMicTouchEnd}
                      onTouchCancel={handleMicTouchEnd}
                      disabled={uploadingImage || isBlockedConversation}
                      title="Record voice note (Hold to speak, slide left to cancel, slide up to lock)"
                      className={`p-2.5 sm:p-3 rounded-2xl sm:rounded-full border active:scale-95 transition-all shrink-0 cursor-pointer flex items-center justify-center animate-in fade-in zoom-in-90 duration-150 ${
                        isLight
                          ? 'bg-slate-100 border-slate-200 text-slate-700 hover:text-amber-600 hover:border-amber-300 hover:bg-amber-50 shadow-xs'
                          : 'bg-[#18181b] border-white/10 text-zinc-300 hover:text-[#facc15] hover:border-[#facc15]/40 hover:bg-[#facc15]/10 shadow-xs'
                      }`}
                    >
                      <Mic className="w-5 h-5" />
                    </button>
                  )}
                </form>
              </footer>
            </>
          ) : (!conversationsLoaded ? (
            <div className={`flex-1 flex flex-col items-center justify-center p-6 text-center ${
              isLight ? 'bg-slate-50' : 'bg-[#09090b]'
            }`}>
              <div className={`w-8 h-8 rounded-full border-2 border-t-transparent animate-spin ${
                isLight ? 'border-amber-600' : 'border-[#facc15]'
              }`} />
              <p className={`mt-3 text-xs font-bold ${isLight ? 'text-slate-600' : 'text-zinc-300'}`}>
                Loading your chats…
              </p>
            </div>
          ) : (
            /* Empty State Hero on Desktop / Wide screens (WhatsApp Web style) */
            <div className={`flex-1 flex flex-col items-center justify-center p-6 text-center select-none ${
              isLight ? 'bg-slate-50' : 'bg-[#09090b]'
            }`}>
              <div className={`w-20 h-20 rounded-3xl flex items-center justify-center mb-4 border overflow-hidden p-2 ${
                isLight 
                  ? 'bg-amber-100 text-amber-700 border-amber-200' 
                  : 'bg-[#18181b] text-[#facc15] border-[#27272a]'
              }`}>
                <img
                  src="/logo192.png"
                  alt={chatBrandName || "JDLX Chat"}
                  className="w-full h-full object-contain rounded-2xl"
                />
              </div>
              <h2 className={`text-xl sm:text-2xl font-black mb-1.5 ${
                isLight ? 'text-slate-900' : 'text-white'
              }`}>
                {chatBrandName} for Web &amp; Mobile
              </h2>
              <p className={`text-xs sm:text-sm max-w-sm mb-6 ${
                isLight ? 'text-slate-600' : 'text-zinc-200'
              }`}>
                Send and receive encrypted direct messages with friends across the network.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  onClick={() => {
                    setShowAddFriendModal(true)
                    setFriendModalTab('search')
                  }}
                  className="px-4 py-2.5 rounded-xl font-black text-xs bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] flex items-center gap-2 shadow-lg shadow-yellow-500/15 cursor-pointer active:scale-95 transition-all"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>Add Friend by @username</span>
                </button>
                <button
                  onClick={() => {
                    setShowAddFriendModal(true)
                    setFriendModalTab('invite')
                  }}
                  className={`px-4 py-2.5 rounded-xl font-bold text-xs border flex items-center gap-2 cursor-pointer active:scale-95 transition-all ${
                    isLight 
                      ? 'bg-white border-slate-200 text-slate-800 hover:bg-slate-100 shadow-sm' 
                      : 'bg-[#18181b] border-[#3f3f46] text-white hover:bg-[#27272a]'
                  }`}
                >
                  <Share2 className="w-4 h-4" />
                  <span>Invite Friends</span>
                </button>
              </div>
              <div className="mt-8 flex items-center gap-1.5 text-[11px] text-emerald-500 font-bold">
                <Lock className="w-3.5 h-3.5" />
                <span>Encrypted Private Messaging Network</span>
              </div>
            </div>
          ))}
        </main>
      </div>

      {/* ── ADD FRIEND & GLOBAL SEARCH MODAL (WhatsApp User Discovery) ── */}
      {showAddFriendModal && (
        <div 
          onClick={() => {
            setShowAddFriendModal(false)
            setGlobalSearchQuery('')
            setGlobalSearchResults([])
          }}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in duration-200"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-md rounded-t-[32px] sm:rounded-3xl border border-b-0 sm:border-b p-5 sm:p-6 shadow-2xl flex flex-col space-y-4 max-h-[88vh] overflow-hidden pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] sm:pb-6 animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-200 ${
              isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-[#121215] border-[#27272a] text-[#f4f4f5]'
            }`}
          >
            <SheetGrabHandle onDismiss={() => {
              setShowAddFriendModal(false)
              setGlobalSearchQuery('')
              setGlobalSearchResults([])
            }} />

            {/* Modal Header */}
            <div className={`flex items-center justify-between pb-3 border-b ${
              isLight ? 'border-slate-200' : 'border-[#27272a]'
            }`}>
              <div className="flex items-center gap-2">
                <UserPlus className={`w-5 h-5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                <h3 className={`font-black text-sm ${isLight ? 'text-slate-900' : 'text-white'}`}>
                  Add Friends &amp; Connect
                </h3>
              </div>
              <button
                onClick={() => {
                  triggerHaptic('light')
                  setShowAddFriendModal(false)
                  setGlobalSearchQuery('')
                  setGlobalSearchResults([])
                }}
                className={`p-1.5 rounded-xl transition-colors cursor-pointer ${
                  isLight ? 'hover:bg-slate-100 text-slate-500' : 'hover:bg-[#18181b] text-zinc-400 hover:text-white'
                }`}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Segmented Tab Bar */}
            <div className={`grid grid-cols-3 p-1 rounded-xl border text-xs font-black ${
              isLight ? 'bg-slate-100 border-slate-200 text-slate-600' : 'bg-[#18181b] border-[#27272a] text-zinc-300'
            }`}>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setFriendModalTab('search')
                }}
                className={`py-1.5 rounded-lg transition-all cursor-pointer ${
                  friendModalTab === 'search'
                    ? isLight ? 'bg-white text-slate-900 shadow-sm' : 'bg-[#27272a] text-[#facc15]'
                    : ''
                }`}
              >
                Find People
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setFriendModalTab('requests')
                }}
                className={`py-1.5 rounded-lg transition-all relative cursor-pointer ${
                  friendModalTab === 'requests'
                    ? isLight ? 'bg-white text-slate-900 shadow-sm' : 'bg-[#27272a] text-[#facc15]'
                    : ''
                }`}
              >
                <span>Requests</span>
                {pendingRequestsCount > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[9px] bg-rose-500 text-white font-black">
                    {pendingRequestsCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setFriendModalTab('invite')
                }}
                className={`py-1.5 rounded-lg transition-all cursor-pointer ${
                  friendModalTab === 'invite'
                    ? isLight ? 'bg-white text-slate-900 shadow-sm' : 'bg-[#27272a] text-[#facc15]'
                    : ''
                }`}
              >
                Invite Friend
              </button>
            </div>

            {/* TAB 1: GLOBAL USER SEARCH */}
            {friendModalTab === 'search' && (
              <div className="flex-1 flex flex-col min-h-0 space-y-3">
                <form onSubmit={handleGlobalSearch} className="flex items-center gap-2">
                  <div className="relative flex-1 flex items-center">
                    <span className={`absolute left-3.5 top-2.5 font-black text-xs pointer-events-none select-none ${
                      isLight ? 'text-amber-600' : 'text-[#facc15]'
                    }`}>@</span>
                    <input
                      type="text"
                      placeholder="Search by @username, name, email or phone..."
                      value={globalSearchQuery}
                      onChange={(e) => setGlobalSearchQuery(e.target.value)}
                      className={`w-full pl-8 pr-9 py-2.5 rounded-xl border text-xs focus:outline-none transition-colors ${
                        isLight 
                          ? 'bg-slate-50 border-slate-200 text-slate-900 focus:border-amber-500' 
                          : 'bg-[#18181b] border-[#27272a] text-[#f4f4f5] focus:border-[#facc15]'
                      }`}
                    />
                    {searchingGlobal ? (
                      <Loader2 className="w-4 h-4 absolute right-3 top-3 animate-spin text-amber-500 pointer-events-none" />
                    ) : globalSearchQuery ? (
                      <button
                        type="button"
                        onClick={() => {
                          setGlobalSearchQuery('')
                          setGlobalSearchResults([])
                        }}
                        title="Clear search"
                        className="absolute right-2.5 top-2.5 p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="submit"
                    disabled={searchingGlobal || !globalSearchQuery.trim()}
                    className="px-4 py-2.5 rounded-xl bg-[#facc15] text-[#09090b] font-black text-xs hover:bg-[#eab308] active:scale-95 transition-all disabled:opacity-50 cursor-pointer flex items-center gap-1.5 shrink-0"
                  >
                    {searchingGlobal ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Searching</span>
                      </>
                    ) : (
                      'Search'
                    )}
                  </button>
                </form>

                {/* Results list */}
                <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-60">
                  {searchingGlobal && globalSearchResults.length === 0 ? (
                    <div className="py-8 text-center space-y-2">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto text-amber-500" />
                      <p className={`text-xs ${isLight ? 'text-slate-400' : 'text-[#71717a]'}`}>
                        Searching for users matching &ldquo;{globalSearchQuery}&rdquo;...
                      </p>
                    </div>
                  ) : globalSearchResults.length === 0 ? (
                    <div className="py-8 text-center space-y-2">
                      <p className={`text-xs ${isLight ? 'text-slate-400' : 'text-[#71717a]'}`}>
                        {globalSearchQuery ? 'No users found matching that query.' : 'Type @username or Full Name to find anyone.'}
                      </p>
                      {globalSearchQuery && (
                        <button
                          type="button"
                          onClick={() => setFriendModalTab('invite')}
                          className={`text-xs font-bold underline cursor-pointer ${
                            isLight ? 'text-amber-700' : 'text-[#facc15]'
                          }`}
                        >
                          Invite this friend to {chatBrandName} →
                        </button>
                      )}
                    </div>
                  ) : (
                    globalSearchResults.map((u) => {
                      const isFriend = u.friend_status === 'friends'
                      const isPendingSent = u.friend_status === 'pending_sent'
                      const isPendingRecv = u.friend_status === 'pending_received'
                      const isActionBusy = requestActionLoading === u.id

                      return (
                        <div
                          key={u.id}
                          className={`p-3 rounded-2xl border flex items-center justify-between gap-3 ${
                            isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className={`w-9 h-9 rounded-xl font-black text-xs flex items-center justify-center shrink-0 border ${
                              isLight 
                                ? 'bg-amber-100 text-amber-700 border-amber-300' 
                                : 'bg-yellow-500/20 text-[#facc15] border-yellow-500/30'
                            }`}>
                              {u.profile_image ? (
                                <img src={resolveMediaUrl(u.profile_image)} alt="" className="w-full h-full object-cover rounded-xl" />
                              ) : (
                                u.name?.[0]?.toUpperCase() || 'U'
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className={`text-xs font-bold truncate ${
                                isLight ? 'text-slate-900' : 'text-white'
                              }`}>
                                {u.name}
                              </div>
                              <div className={`text-[10px] font-mono truncate ${
                                isLight ? 'text-amber-700' : 'text-[#facc15]'
                              }`}>
                                @{u.username || `user_${u.id}`}
                              </div>
                            </div>
                          </div>

                          {/* Action Button */}
                          <div className="shrink-0">
                            {isFriend ? (
                              <button
                                onClick={() => handleDirectChatStart(u)}
                                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] text-[11px] font-black cursor-pointer shadow-sm active:scale-95 transition-all"
                              >
                                Message
                              </button>
                            ) : isPendingSent ? (
                              <span className={`px-2.5 py-1 rounded-xl text-[10px] font-bold border ${
                                isLight ? 'bg-slate-200 text-slate-600 border-slate-300' : 'bg-[#27272a] text-zinc-300 border-[#3f3f46]'
                              }`}>
                                Request Sent
                              </span>
                            ) : isPendingRecv ? (
                              <button
                                onClick={() => handleRespondRequest(u.friend_request_id, 'accept')}
                                className="px-3 py-1.5 rounded-xl bg-emerald-500 text-white text-[11px] font-black cursor-pointer shadow-sm active:scale-95 transition-all"
                              >
                                Accept
                              </button>
                            ) : (
                              <button
                                disabled={isActionBusy}
                                onClick={() => handleSendFriendRequest(u)}
                                className={`px-3 py-1.5 rounded-xl border text-[11px] font-black flex items-center gap-1 cursor-pointer active:scale-95 transition-all ${
                                  isLight 
                                    ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 border-amber-300' 
                                    : 'bg-yellow-500/10 hover:bg-yellow-500/20 text-[#facc15] border-yellow-500/30'
                                }`}
                              >
                                <UserPlus className="w-3 h-3" />
                                <span>{isActionBusy ? '...' : 'Add Friend'}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: FRIEND REQUESTS */}
            {friendModalTab === 'requests' && (
              <div className="flex-1 overflow-y-auto space-y-3 max-h-64 pr-1">
                <div>
                  <h4 className={`text-xs font-black uppercase tracking-wider mb-2 ${
                    isLight ? 'text-slate-900' : 'text-white'
                  }`}>
                    Incoming Requests ({incomingRequests.length})
                  </h4>
                  {(!incomingRequests || incomingRequests.length === 0) ? (
                    <div className={`p-4 rounded-2xl border text-center text-xs ${
                      isLight ? 'bg-slate-50 border-slate-200 text-slate-500' : 'bg-[#18181b] border-[#27272a] text-zinc-400'
                    }`}>
                      No incoming friend requests.
                    </div>
                  ) : (
                    (incomingRequests || []).map((req) => (
                      <div
                        key={req.request_id}
                        className={`p-3 rounded-2xl border flex items-center justify-between gap-3 mb-2 ${
                          isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className={`w-9 h-9 rounded-xl font-black text-xs flex items-center justify-center shrink-0 border ${
                            isLight ? 'bg-amber-100 text-amber-700 border-amber-300' : 'bg-yellow-500/20 text-[#facc15] border-yellow-500/30'
                          }`}>
                            {req.name?.[0]?.toUpperCase() || 'U'}
                          </div>
                          <div className="min-w-0">
                            <div className={`text-xs font-bold truncate ${
                              isLight ? 'text-slate-900' : 'text-white'
                            }`}>
                              {req.name}
                            </div>
                            <div className={`text-[10px] font-mono truncate ${isLight ? 'text-amber-700' : 'text-[#facc15]'}`}>
                              @{req.username}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleRespondRequest(req.request_id, 'accept')}
                            className="px-2.5 py-1.5 rounded-xl bg-emerald-500 text-white text-[11px] font-black active:scale-95 transition-all cursor-pointer"
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => handleRespondRequest(req.request_id, 'decline')}
                            className={`px-2 py-1.5 rounded-xl border text-[11px] font-medium active:scale-95 transition-all cursor-pointer ${
                              isLight ? 'bg-white border-slate-200 text-slate-600' : 'bg-[#27272a] border-[#3f3f46] text-zinc-300 hover:text-white'
                            }`}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {outgoingRequests && outgoingRequests.length > 0 && (
                  <div>
                    <h4 className={`text-xs font-black uppercase tracking-wider mb-2 ${
                      isLight ? 'text-slate-900' : 'text-white'
                    }`}>
                      Sent Requests ({outgoingRequests.length})
                    </h4>
                    {(outgoingRequests || []).map((req) => (
                      <div
                        key={req.request_id}
                        className={`p-2.5 rounded-2xl border flex items-center justify-between gap-2 mb-1.5 ${
                          isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                        }`}
                      >
                        <div className={`text-xs font-bold truncate ${
                          isLight ? 'text-slate-900' : 'text-white'
                        }`}>
                          @{req.username}
                        </div>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          isLight ? 'bg-slate-200 text-slate-600' : 'bg-[#27272a] text-zinc-300'
                        }`}>
                          Pending
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {friends && friends.length > 0 && (
                  <div className={`pt-2 border-t ${isLight ? 'border-slate-200' : 'border-[#27272a]'}`}>
                    <h4 className={`text-xs font-black uppercase tracking-wider mb-2 ${
                      isLight ? 'text-slate-900' : 'text-white'
                    }`}>
                      Connected Friends ({friends.length})
                    </h4>
                    {(friends || []).map((fr) => (
                      <div
                        key={fr.friend_id}
                        className={`p-2.5 rounded-2xl border flex items-center justify-between gap-2 mb-1.5 ${
                          isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                        }`}
                      >
                        <div className={`text-xs font-bold truncate ${
                          isLight ? 'text-slate-900' : 'text-white'
                        }`}>
                          @{fr.username || fr.name}
                        </div>
                        <button
                          onClick={() => handleDirectChatStart({ id: fr.friend_id, username: fr.username, name: fr.name })}
                          className="px-2.5 py-1 rounded-xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] text-[10px] font-black cursor-pointer shadow-sm active:scale-95 transition-all"
                        >
                          Message
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: INVITE FRIENDS TO OFFICIAL CHAT */}
            {friendModalTab === 'invite' && (
              <div className="space-y-3.5">
                <div className={`p-4 rounded-2xl border text-center space-y-2 ${
                  isLight ? 'bg-amber-50/70 border-amber-300' : 'bg-yellow-500/10 border-yellow-500/20'
                }`}>
                  <Share2 className={`w-8 h-8 mx-auto ${isLight ? 'text-amber-700' : 'text-[#facc15]'}`} />
                  <h4 className={`text-sm font-black ${
                    isLight ? 'text-slate-900' : 'text-white'
                  }`}>
                    Invite Friends to {chatBrandName}
                  </h4>
                  <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-zinc-200'}`}>
                    Share your personal chat link. When friends open it, they can immediately find your handle and start chatting over encrypted messages.
                  </p>
                </div>

                {/* Invite Link Display Box */}
                <div className={`p-2.5 rounded-xl border flex items-center justify-between gap-2 font-mono text-xs ${
                  isLight ? 'bg-slate-50 border-slate-200 text-slate-800' : 'bg-[#18181b] border-[#27272a] text-white'
                }`}>
                  <span className="truncate">
                    {inviteInfo?.invite_url || `${window.location.origin}/chat/login?ref=@${chatUser?.username || 'member'}`}
                  </span>
                  <button
                    onClick={handleCopyInviteLink}
                    className={`p-1.5 rounded-lg border shrink-0 active:scale-95 transition-all cursor-pointer ${
                      isLight ? 'bg-white hover:bg-slate-100 text-amber-700 border-slate-200' : 'bg-[#27272a] hover:bg-[#3f3f46] text-[#facc15] border-[#3f3f46]'
                    }`}
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    onClick={handleShareInviteWhatsapp}
                    className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 text-white font-black text-xs hover:bg-emerald-700 active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>WhatsApp</span>
                  </button>
                  <button
                    onClick={handleCopyInviteLink}
                    className="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] font-black text-xs hover:brightness-105 active:scale-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Link</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── LUXURY EDITABLE PROFILE & COMPREHENSIVE SETTINGS HUB ── */}
      {showProfileDrawer && (
        <div 
          onClick={() => setShowProfileDrawer(false)}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-md p-0 sm:p-4 animate-in fade-in duration-200"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-lg rounded-t-[32px] sm:rounded-3xl border border-b-0 sm:border-b shadow-2xl relative overflow-hidden transition-all flex flex-col max-h-[90vh] pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:pb-0 animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-200 ${
              isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-[#121215] border-[#27272a] text-white'
            }`}
          >
            <SheetGrabHandle onDismiss={() => setShowProfileDrawer(false)} />

            {/* Header */}
            <div className={`flex items-center justify-between p-4 sm:p-5 border-b shrink-0 ${
              isLight ? 'border-slate-200 bg-slate-50/70' : 'border-[#27272a] bg-[#16161a]'
            }`}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center font-black ${
                  isLight ? 'bg-amber-100 text-amber-800' : 'bg-yellow-500/15 text-[#facc15]'
                }`}>
                  <User className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={`font-black text-sm sm:text-base flex items-center gap-1.5 ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    <span>Profile &amp; Settings</span>
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-gradient-to-r from-amber-500 to-yellow-500 text-black">
                      JDLX
                    </span>
                  </h3>
                  <p className={`text-[11px] font-medium ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                    Customize your profile, preferences &amp; security
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setShowProfileDrawer(false)
                }}
                className={`p-2 rounded-xl transition-colors cursor-pointer ${
                  isLight ? 'hover:bg-slate-200 text-slate-500' : 'hover:bg-[#27272a] text-zinc-400 hover:text-white'
                }`}
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Segmented Tab Bar */}
            <div className={`flex items-center px-4 pt-3 pb-2 gap-2 border-b shrink-0 ${
              isLight ? 'border-slate-200 bg-slate-100/60' : 'border-[#27272a] bg-[#141418]'
            }`}>
              {[
                { id: 'profile', label: 'Profile', Icon: User },
                { id: 'preferences', label: 'Preferences', Icon: Sliders },
                { id: 'security', label: 'Security & Data', Icon: ShieldCheck }
              ].map(({ id, label, Icon }) => {
                const active = profileTab === id
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      triggerHaptic('light')
                      setProfileTab(id)
                    }}
                    className={`flex-1 py-2 px-2.5 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                      active
                        ? isLight
                          ? 'bg-white text-slate-900 shadow-sm border border-slate-200/80'
                          : 'bg-gradient-to-r from-[#facc15] to-[#eab308] text-black shadow-md shadow-yellow-500/20'
                        : isLight
                          ? 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/60'
                          : 'text-zinc-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="truncate">{label}</span>
                  </button>
                )
              })}
            </div>

            {/* Scrollable Tab Body */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5 custom-scrollbar">
              {/* TAB 1: EDIT PROFILE */}
              {profileTab === 'profile' && (
                <form onSubmit={handleSaveProfile} className="space-y-4">
                  {/* Avatar Upload Area */}
                  <div className="flex flex-col items-center justify-center text-center">
                    <input
                      type="file"
                      ref={avatarFileInputRef}
                      onChange={handleAvatarSelect}
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                    />
                    <div className="relative group cursor-pointer" onClick={() => avatarFileInputRef.current?.click()}>
                      <div className={`w-24 h-24 rounded-3xl overflow-hidden flex items-center justify-center font-black text-3xl border-2 transition-all shadow-xl ${
                        isLight
                          ? 'bg-amber-100 text-amber-800 border-amber-300 ring-4 ring-amber-100/60'
                          : 'bg-gradient-to-br from-yellow-500/20 to-amber-600/20 text-[#facc15] border-[#facc15]/50 ring-4 ring-yellow-500/10'
                      }`}>
                        {isUploadingAvatar ? (
                          <Loader2 className="w-8 h-8 animate-spin text-[#facc15]" />
                        ) : chatUser?.profile_image ? (
                          <img
                            src={resolveMediaUrl(chatUser.profile_image)}
                            alt={chatUser?.name || 'User'}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        ) : (
                          <span>{chatUser?.name?.[0]?.toUpperCase() || 'U'}</span>
                        )}
                      </div>
                      <div className="absolute -bottom-1 -right-1 p-2 rounded-xl bg-gradient-to-tr from-[#facc15] to-[#eab308] text-black shadow-lg shadow-yellow-500/30 group-hover:scale-110 active:scale-95 transition-all">
                        <Camera className="w-4 h-4" />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => avatarFileInputRef.current?.click()}
                      disabled={isUploadingAvatar}
                      className={`mt-2.5 text-xs font-black inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                        isLight ? 'text-amber-700 hover:text-amber-800' : 'text-[#facc15] hover:underline'
                      }`}
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>{isUploadingAvatar ? 'Uploading new photo...' : 'Change Profile Photo'}</span>
                    </button>
                    <p className={`text-[10px] mt-0.5 ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                      Supports JPG, PNG or WebP up to 8MB
                    </p>
                  </div>

                  {/* Display Name */}
                  <div className="space-y-1.5">
                    <label className={`block text-xs font-black uppercase tracking-wider ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                      Display Name <span className="text-amber-500">*</span>
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                        <User className="w-4 h-4" />
                      </div>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Your full name"
                        maxLength={80}
                        required
                        className={`w-full pl-10 pr-4 py-2.5 rounded-2xl border text-sm font-medium transition-all outline-none ${
                          isLight
                            ? 'bg-slate-50 border-slate-200 text-slate-900 focus:bg-white focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20'
                            : 'bg-[#18181b] border-[#27272a] text-white focus:border-[#facc15] focus:ring-2 focus:ring-yellow-500/20'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Username */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className={`block text-xs font-black uppercase tracking-wider ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                        Username (@handle)
                      </label>
                      <span className={`text-[10px] font-medium ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                        Alphanumeric &amp; underscores
                      </span>
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-amber-500 font-bold">
                        @
                      </div>
                      <input
                        type="text"
                        value={editUsername}
                        onChange={(e) => setEditUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                        placeholder="your_handle"
                        maxLength={30}
                        className={`w-full pl-8 pr-4 py-2.5 rounded-2xl border text-sm font-mono font-bold transition-all outline-none ${
                          isLight
                            ? 'bg-slate-50 border-slate-200 text-slate-900 focus:bg-white focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20'
                            : 'bg-[#18181b] border-[#27272a] text-white focus:border-[#facc15] focus:ring-2 focus:ring-yellow-500/20'
                        }`}
                      />
                    </div>
                  </div>

                  {/* About / Bio (WhatsApp style) */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className={`block text-xs font-black uppercase tracking-wider ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                        About / Bio Status
                      </label>
                      <span className={`text-[10px] font-mono ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                        {editBio.length}/200
                      </span>
                    </div>
                    <textarea
                      value={editBio}
                      onChange={(e) => setEditBio(e.target.value)}
                      placeholder="Hey there! I am using JDLX Chat"
                      maxLength={200}
                      rows={2}
                      className={`w-full px-3.5 py-2.5 rounded-2xl border text-xs sm:text-sm font-medium transition-all outline-none resize-none ${
                        isLight
                          ? 'bg-slate-50 border-slate-200 text-slate-900 focus:bg-white focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20'
                          : 'bg-[#18181b] border-[#27272a] text-white focus:border-[#facc15] focus:ring-2 focus:ring-yellow-500/20'
                      }`}
                    />

                    {/* Quick status presets */}
                    <div className="pt-1">
                      <span className={`block text-[10px] font-bold uppercase tracking-wider mb-1.5 ${isLight ? 'text-slate-400' : 'text-zinc-400'}`}>
                        Quick Presets (Tap to apply)
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          '🌟 Available',
                          '⚡ Busy',
                          '💼 At work',
                          '🔒 Encrypted & Offline',
                          '🚀 Building greatness',
                          '💤 Sleeping'
                        ].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setEditBio(preset)}
                            className={`px-2.5 py-1 rounded-xl text-[11px] font-bold transition-all cursor-pointer ${
                              editBio === preset
                                ? isLight
                                  ? 'bg-amber-100 text-amber-800 border border-amber-300'
                                  : 'bg-yellow-500/20 text-[#facc15] border border-yellow-500/40'
                                : isLight
                                  ? 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                                  : 'bg-[#1e1e24] hover:bg-[#27272a] text-zinc-300'
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Gender Selector */}
                  <div className="space-y-1.5">
                    <label className={`block text-xs font-black uppercase tracking-wider ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                      Gender
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {[
                        { id: 'male', label: 'Male', emoji: '👨' },
                        { id: 'female', label: 'Female', emoji: '👩' },
                        { id: 'other', label: 'Other', emoji: '🌈' },
                        { id: 'prefer_not_to_say', label: 'Private', emoji: '🔒' }
                      ].map(({ id, label, emoji }) => {
                        const selected = editGender === id
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setEditGender(id)}
                            className={`p-2 rounded-xl border text-xs font-black flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                              selected
                                ? isLight
                                  ? 'bg-amber-50 border-amber-500 text-amber-900 shadow-sm'
                                  : 'bg-yellow-500/20 border-[#facc15] text-[#facc15] shadow-md shadow-yellow-500/10'
                                : isLight
                                  ? 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                                  : 'bg-[#18181b] border-[#27272a] text-zinc-400 hover:bg-[#202025]'
                            }`}
                          >
                            <span>{emoji}</span>
                            <span>{label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Verified Contact Badges (Read-only security info) */}
                  <div className={`p-3 rounded-2xl border space-y-2 ${
                    isLight ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-[#18181b] border-[#27272a] text-zinc-300'
                  }`}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="flex items-center gap-1.5 font-bold">
                        <Phone className="w-3.5 h-3.5 text-amber-500" />
                        <span>Registered Mobile</span>
                      </span>
                      <span className="font-mono font-bold">
                        {chatUser?.phone ? `+91 ${chatUser.phone}` : 'Not linked'}
                      </span>
                    </div>
                    {chatUser?.email && (
                      <div className="flex items-center justify-between text-[11px] pt-1.5 border-t border-inherit">
                        <span className="flex items-center gap-1.5 font-bold">
                          <Mail className="w-3.5 h-3.5 text-amber-500" />
                          <span>Google / Email</span>
                        </span>
                        <span className="truncate max-w-[200px] font-mono">
                          {chatUser.email}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-[11px] pt-1.5 border-t border-inherit">
                      <span className="flex items-center gap-1.5 font-bold">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                        <span>Security Level</span>
                      </span>
                      <span className="text-emerald-500 font-black">Verified Member</span>
                    </div>
                  </div>

                  {/* Save Button */}
                  <button
                    type="submit"
                    disabled={isSavingProfile}
                    className="w-full py-3 rounded-2xl bg-gradient-to-r from-[#facc15] via-[#eab308] to-[#ca8a04] text-[#09090b] font-black text-xs hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer shadow-lg shadow-yellow-500/20 flex items-center justify-center gap-2"
                  >
                    {isSavingProfile ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Saving Changes...</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-4 h-4 stroke-[3]" />
                        <span>Save Profile Changes</span>
                      </>
                    )}
                  </button>
                </form>
              )}

              {/* TAB 2: PREFERENCES (THEME, CHAT EXPERIENCE, SOUNDS) */}
              {profileTab === 'preferences' && (
                <div className="space-y-5">
                  {/* Appearance Theme Selector */}
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-1.5">
                      <Palette className={`w-4 h-4 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                      <h4 className={`text-xs font-black uppercase tracking-wider ${isLight ? 'text-slate-900' : 'text-white'}`}>
                        Color Theme
                      </h4>
                    </div>

                    <div className="space-y-2">
                      {[
                        {
                          id: 'system',
                          label: 'System Match',
                          description: `Follow your OS appearance (currently ${resolvedChatTheme === 'dark' ? 'Dark' : 'Light'})`,
                          Icon: Monitor
                        },
                        { id: 'light', label: 'Light Luxe', description: 'Bright Gold & Crisp Slate', Icon: Sun },
                        { id: 'dark', label: 'Obsidian Dark', description: 'Matte Black & Electric Yellow', Icon: Moon }
                      ].map(({ id, label, description, Icon }) => {
                        const selected = chatTheme === id
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setChatTheme(id)}
                            className={`w-full p-3 rounded-2xl border flex items-center gap-3 text-left transition-all cursor-pointer ${
                              selected
                                ? isLight
                                  ? 'border-amber-500 bg-amber-50/70 shadow-sm'
                                  : 'border-[#facc15] bg-[#18181b] shadow-lg shadow-yellow-500/10'
                                : isLight
                                  ? 'border-slate-200 bg-white hover:border-slate-300'
                                  : 'border-[#27272a] bg-[#18181b] hover:border-[#3f3f46]'
                            }`}
                          >
                            <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                              selected
                                ? isLight ? 'bg-amber-100 text-amber-700' : 'bg-yellow-500/15 text-[#facc15]'
                                : isLight ? 'bg-slate-100 text-slate-500' : 'bg-[#27272a] text-zinc-400'
                            }`}>
                              <Icon className="w-4 h-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className={`block text-xs font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>
                                {label}
                              </span>
                              <span className={`block text-[10px] font-medium ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                                {description}
                              </span>
                            </span>
                            {selected && <CheckCircle2 className={`w-4 h-4 shrink-0 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Chat Experience Toggles */}
                  <div className="space-y-3 pt-2 border-t border-inherit">
                    <div className="flex items-center gap-1.5">
                      <Sliders className={`w-4 h-4 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                      <h4 className={`text-xs font-black uppercase tracking-wider ${isLight ? 'text-slate-900' : 'text-white'}`}>
                        Chat Controls &amp; Behaviors
                      </h4>
                    </div>

                    {/* Enter to Send Toggle */}
                    <div className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                      isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                    }`}>
                      <div className="min-w-0">
                        <div className={`text-xs font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>
                          Press Enter to Send
                        </div>
                        <div className={`text-[10px] font-medium mt-0.5 ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                          {enterToSend ? 'Enter sends message • Shift+Enter inserts newline' : 'Enter creates new line • Send button dispatches'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleToggleEnterToSend(!enterToSend)}
                        className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer shrink-0 ${
                          enterToSend ? 'bg-gradient-to-r from-[#facc15] to-[#eab308]' : 'bg-zinc-700'
                        }`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-black transition-transform ${
                          enterToSend ? 'translate-x-6' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>

                    {/* Chat Sound Effects */}
                    <div className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                      isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                    }`}>
                      <div className="min-w-0">
                        <div className={`text-xs font-black flex items-center gap-1.5 ${isLight ? 'text-slate-900' : 'text-white'}`}>
                          {chatSounds ? <Volume2 className="w-3.5 h-3.5 text-amber-500" /> : <VolumeX className="w-3.5 h-3.5 text-slate-400" />}
                          <span>Sound Effects</span>
                        </div>
                        <div className={`text-[10px] font-medium mt-0.5 ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                          Play acoustic chimes on incoming &amp; sent messages
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleToggleChatSounds(!chatSounds)}
                        className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer shrink-0 ${
                          chatSounds ? 'bg-gradient-to-r from-[#facc15] to-[#eab308]' : 'bg-zinc-700'
                        }`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-black transition-transform ${
                          chatSounds ? 'translate-x-6' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>

                    {/* Wallpaper Doodle Toggle */}
                    <div className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                      isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                    }`}>
                      <div className="min-w-0">
                        <div className={`text-xs font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>
                          Chat Wallpaper Doodle
                        </div>
                        <div className={`text-[10px] font-medium mt-0.5 ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                          Subtle textured geometric doodle pattern behind message bubbles
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleToggleDoodle(!showDoodle)}
                        className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer shrink-0 ${
                          showDoodle ? 'bg-gradient-to-r from-[#facc15] to-[#eab308]' : 'bg-zinc-700'
                        }`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-black transition-transform ${
                          showDoodle ? 'translate-x-6' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>

                    {/* Push Notifications Setup */}
                    <div className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                      isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                    }`}>
                      <div className="min-w-0">
                        <div className={`text-xs font-black flex items-center gap-1.5 ${isLight ? 'text-slate-900' : 'text-white'}`}>
                          <Bell className="w-3.5 h-3.5 text-amber-500" />
                          <span>Push Notifications</span>
                        </div>
                        <div className={`text-[10px] font-medium mt-0.5 ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                          Receive instant alerts on your lock screen when offline
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await enablePushNotifications()
                          if (res.success) toast.success('Push notifications enabled!')
                          else toast.error(res.error || 'Notifications permission denied')
                        }}
                        className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-black text-xs font-black cursor-pointer active:scale-95 transition-all shadow-sm shrink-0"
                      >
                        Enable
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: SECURITY & DATA */}
              {profileTab === 'security' && (
                <div className="space-y-4">
                  {/* E2EE Security Status */}
                  <div className={`p-4 rounded-2xl border ${
                    isLight ? 'bg-amber-50/60 border-amber-200 text-slate-800' : 'bg-yellow-500/10 border-yellow-500/20 text-zinc-200'
                  }`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <Lock className="w-4 h-4 text-amber-500" />
                      <span className="font-black text-xs uppercase tracking-wider text-amber-500">
                        End-to-End Encrypted Text Active
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed">
                      Your text messages are end-to-end encrypted on this device via browser WebCrypto ECDH P-256 and AES-256-GCM. Photos, voice notes, videos and files are uploaded to the chat server but are not end-to-end encrypted yet.
                    </p>
                  </div>

                  {/* Public Key Fingerprint */}
                  <div className={`p-3.5 rounded-2xl border space-y-2 ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-black uppercase tracking-wider flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                        <Key className="w-3.5 h-3.5 text-amber-500" />
                        <span>Device Identity Fingerprint</span>
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyPublicKey}
                        className={`text-[10px] font-black flex items-center gap-1 px-2 py-0.5 rounded-lg border transition-all cursor-pointer ${
                          isLight
                            ? 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                            : 'bg-[#27272a] border-[#3f3f46] text-zinc-300 hover:text-white'
                        }`}
                      >
                        <Copy className="w-3 h-3" />
                        <span>Copy</span>
                      </button>
                    </div>
                    <div className={`p-2.5 rounded-xl font-mono text-[10px] break-all leading-normal select-all ${
                      isLight ? 'bg-white text-slate-600 border border-slate-200' : 'bg-black/40 text-amber-400/90 border border-white/5'
                    }`}>
                      {chatUser?.public_key 
                        ? `${chatUser.public_key.slice(0, 48)}...${chatUser.public_key.slice(-32)}`
                        : 'ECDH P-256 active on this browser session'}
                    </div>
                  </div>

                  {/* Encrypted Recovery Backup */}
                  <div className={`p-3.5 rounded-2xl border ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                  }`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className={`text-xs font-black uppercase tracking-wider flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                          <Key className="w-3.5 h-3.5 text-amber-500" />
                          <span>Recovery PIN</span>
                        </div>
                        <div className={`text-[10px] font-medium mt-0.5 leading-relaxed ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                          Encrypt this device's key so you can restore chats on a new phone. The PIN never leaves this device.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setShowProfileDrawer(false)
                          openRecoverySetup()
                        }}
                        className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-black text-xs font-black cursor-pointer active:scale-95 transition-all shadow-sm shrink-0"
                      >
                        Set PIN
                      </button>
                    </div>
                  </div>

                  {/* Connected Friends Overview */}
                  <div className={`p-3.5 rounded-2xl border ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className={`text-xs font-black uppercase tracking-wider flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-zinc-300'}`}>
                        <Users className="w-3.5 h-3.5 text-amber-500" />
                        <span>Direct Chat Contacts ({friends.length})</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setShowProfileDrawer(false)
                          setShowAddFriendModal(true)
                          setFriendModalTab('search')
                        }}
                        className="text-[10px] font-black text-amber-500 hover:underline cursor-pointer"
                      >
                        + Add Friends
                      </button>
                    </div>
                    {friends.length > 0 ? (
                      <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1 custom-scrollbar">
                        {friends.slice(0, 5).map((fr) => (
                          <div
                            key={fr.friend_id}
                            className={`p-2 rounded-xl flex items-center justify-between text-xs border ${
                              isLight ? 'bg-white border-slate-200' : 'bg-[#121215] border-[#27272a]'
                            }`}
                          >
                            <span className="font-bold truncate">@{fr.username || fr.name}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setShowProfileDrawer(false)
                                handleDirectChatStart({ id: fr.friend_id, username: fr.username, name: fr.name })
                              }}
                              className="px-2 py-0.5 rounded-lg bg-yellow-500/20 text-[#facc15] text-[10px] font-black cursor-pointer hover:bg-yellow-500/30"
                            >
                              Message
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={`text-[11px] ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                        No friends added yet. Share your invite link or search usernames to connect!
                      </p>
                    )}
                  </div>

                  {/* Cache & Maintenance */}
                  <div className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                  }`}>
                    <div>
                      <div className={`text-xs font-black flex items-center gap-1.5 ${isLight ? 'text-slate-900' : 'text-white'}`}>
                        <Database className="w-3.5 h-3.5 text-blue-500" />
                        <span>Clear App &amp; Media Cache</span>
                      </div>
                      <div className={`text-[10px] font-medium mt-0.5 ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                        Free up device storage &amp; refresh cached service worker bundles
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleClearCache}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all cursor-pointer shrink-0 active:scale-95 ${
                        isLight
                          ? 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                          : 'bg-[#27272a] border-[#3f3f46] text-zinc-300 hover:text-white'
                      }`}
                    >
                      Clear Cache
                    </button>
                  </div>

                  {/* Sign Out Section */}
                  <div className="pt-2 border-t border-inherit">
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Are you sure you want to log out of JDLX Chat?')) {
                          chatLogout(true)
                          setShowProfileDrawer(false)
                        }
                      }}
                      className="w-full py-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 text-xs font-black flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-98"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Log Out of JDLX Chat</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Bottom Action Bar */}
            <div className={`p-4 border-t shrink-0 flex items-center justify-between ${
              isLight ? 'border-slate-200 bg-slate-50/70' : 'border-[#27272a] bg-[#16161a]'
            }`}>
              <span className={`text-[10px] font-medium flex items-center gap-1 ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                <span>Protected by JDLX Security Engine</span>
              </span>
              <button
                type="button"
                onClick={() => setShowProfileDrawer(false)}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-black font-black text-xs hover:brightness-105 active:scale-95 transition-all cursor-pointer shadow-sm"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── NOTIFICATIONS DRAWER ── */}
      {showNotificationsDrawer && (
        <div 
          onClick={() => setShowNotificationsDrawer(false)}
          className="fixed inset-0 z-50 flex items-end sm:items-stretch sm:justify-end bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className={`w-full sm:max-w-sm max-h-[85vh] sm:max-h-full rounded-t-[32px] sm:rounded-none border-t sm:border-t-0 sm:border-l flex flex-col shadow-2xl animate-in slide-in-from-bottom-8 sm:slide-in-from-right duration-200 sm:duration-250 transition-colors pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:pb-0 ${
              isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-[#121215] border-[#27272a] text-white'
            }`}
          >
            <SheetGrabHandle onDismiss={() => setShowNotificationsDrawer(false)} />

            <div className={`p-4 border-b flex items-center justify-between ${
              isLight ? 'border-slate-200' : 'border-[#27272a]'
            }`}>
              <div className="flex items-center gap-2">
                <Bell className={`w-5 h-5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                <h3 className={`font-black text-sm ${isLight ? 'text-slate-900' : 'text-white'}`}>
                  Chat Notifications
                </h3>
                {notifications && notifications.filter(n => !n.is_read).length > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-500 text-white">
                    {notifications.filter(n => !n.is_read).length} new
                  </span>
                )}
              </div>
              <button
                onClick={() => {
                  triggerHaptic('light')
                  setShowNotificationsDrawer(false)
                }}
                className={`p-1.5 rounded-xl transition-colors cursor-pointer ${
                  isLight ? 'hover:bg-slate-100 text-slate-500' : 'hover:bg-[#18181b] text-zinc-400 hover:text-white'
                }`}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {(!notifications || notifications.length === 0) ? (
                <div className={`py-12 text-center text-xs ${isLight ? 'text-slate-400' : 'text-zinc-400'}`}>
                  <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  No chat notifications yet.
                </div>
              ) : (
                notifications.map((n) => {
                  const isUnread = !n.is_read
                  const lowerTitle = (n.title || '').toLowerCase()
                  const lowerMsg = (n.message || '').toLowerCase()
                  const isFriendReq = lowerTitle.includes('friend request') || lowerMsg.includes('friend request')
                  const isMsg = Boolean(n.room_id || lowerTitle.includes('message') || lowerTitle.includes('reply'))

                  return (
                    <div
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className={`group relative p-3.5 rounded-2xl border transition-all duration-150 cursor-pointer select-none active:scale-[0.99] ${
                        isUnread
                          ? isLight
                            ? 'border-amber-300 bg-amber-50/80 shadow-xs hover:bg-amber-100/70 hover:border-amber-400'
                            : 'border-yellow-500/40 bg-yellow-500/10 hover:bg-yellow-500/15 hover:border-yellow-500/60'
                          : isLight
                            ? 'border-slate-200 bg-slate-50/70 hover:bg-slate-100/80 opacity-80 hover:opacity-100'
                            : 'border-[#27272a] bg-[#18181b]/70 hover:bg-[#18181b] opacity-75 hover:opacity-100'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        {/* Type Icon Badge */}
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                          isFriendReq
                            ? 'bg-emerald-500/15 text-emerald-500'
                            : isMsg
                              ? isLight ? 'bg-amber-500/15 text-amber-600' : 'bg-yellow-500/15 text-yellow-400'
                              : isLight ? 'bg-slate-200 text-slate-700' : 'bg-zinc-800 text-zinc-300'
                        }`}>
                          {isFriendReq ? (
                            <UserPlus className="w-4 h-4" />
                          ) : isMsg ? (
                            <MessageCircle className="w-4 h-4" />
                          ) : (
                            <Bell className="w-4 h-4" />
                          )}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1 mb-0.5">
                            <span className={`text-xs font-black truncate ${
                              isLight ? 'text-slate-900' : 'text-white'
                            }`}>
                              {n.title}
                            </span>
                            <span className={`text-[10px] shrink-0 font-medium ${
                              isLight ? 'text-slate-400' : 'text-zinc-500'
                            }`}>
                              {formatTime(n.created_at)}
                            </span>
                          </div>

                          <p className={`text-xs leading-relaxed line-clamp-2 ${
                            isLight ? 'text-slate-600' : 'text-zinc-300'
                          }`}>
                            {n.message}
                          </p>

                          {/* Action hints & Delete action */}
                          <div className="mt-2 flex items-center justify-between pt-1 border-t border-black/5 dark:border-white/5">
                            <span className={`text-[10px] font-bold inline-flex items-center gap-1 ${
                              isLight ? 'text-amber-700' : 'text-[#facc15]'
                            }`}>
                              {n.room_id ? 'Open chat' : isFriendReq ? 'View friend requests' : 'View'}
                              <ChevronRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                            </span>

                            <div className="flex items-center gap-1">
                              {isUnread && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    markNotificationRead(n.id)
                                  }}
                                  title="Mark as read"
                                  className={`p-1 rounded-lg text-[10px] font-semibold transition-colors cursor-pointer ${
                                    isLight
                                      ? 'hover:bg-slate-200 text-slate-500'
                                      : 'hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200'
                                  }`}
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  deleteNotification(n.id)
                                }}
                                title="Dismiss notification"
                                className={`p-1 rounded-lg text-[10px] transition-colors cursor-pointer ${
                                  isLight
                                    ? 'hover:bg-rose-100 text-slate-400 hover:text-rose-600'
                                    : 'hover:bg-rose-950/40 text-zinc-500 hover:text-rose-400'
                                }`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {notifications && notifications.length > 0 && (
              <div className={`p-3 border-t flex items-center justify-between text-center ${
                isLight ? 'border-slate-200 bg-slate-50/50' : 'border-[#27272a] bg-[#0e0e11]'
              }`}>
                <span className={`text-[11px] ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
                  {notifications.length} notification{notifications.length > 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    await markAllNotificationsRead()
                    toast.success('Marked all as read')
                  }}
                  className={`text-xs font-bold hover:underline cursor-pointer ${
                    isLight ? 'text-amber-700' : 'text-[#facc15]'
                  }`}
                >
                  Mark all as read
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── FLOATING MESSAGE ACTIONS POPUP (WhatsApp Style Floating Popover) ── */}
      {actionMessage && (() => {
        const isUser = sameId(actionMessage.user_id, chatUser?.id) || (actionMessage.sender_type === 'user' && actionMessage.username === chatUser?.username)
        const vw = typeof window !== 'undefined' ? window.innerWidth : 380
        const vh = typeof window !== 'undefined' ? window.innerHeight : 700

        // Calculate positioning relative to anchored message bubble
        const anchor = actionMessageAnchor
        const hasAnchor = Boolean(anchor && anchor.top !== undefined && anchor.bottom !== undefined)

        // Safe screen bounds (status header & bottom bar)
        const headerSafeTop = 64
        const footerSafeBottom = 76

        const bubbleTop = hasAnchor ? Math.max(headerSafeTop, anchor.top) : vh / 2
        const bubbleBottom = hasAnchor ? Math.min(vh - footerSafeBottom, anchor.bottom) : vh / 2
        const spaceAbove = bubbleTop - headerSafeTop
        const spaceBelow = vh - footerSafeBottom - bubbleBottom

        // Decide placement: If at least 210px space above or spaceAbove > spaceBelow, place above!
        const placeAbove = spaceAbove >= 210 || spaceAbove > spaceBelow

        // Floating Horizontal Alignment:
        // Sent messages align to right; received messages align to left
        const alignRight = isUser
        const horizontalStyle = alignRight
          ? {
              right: hasAnchor ? `${Math.max(12, Math.min(vw - anchor.right, vw - 240))}px` : '16px',
              left: 'auto',
            }
          : {
              left: hasAnchor ? `${Math.max(12, Math.min(anchor.left, vw - 240))}px` : '16px',
              right: 'auto',
            }

        const emojiHorizontalStyle = alignRight
          ? {
              right: hasAnchor ? `${Math.max(12, Math.min(vw - anchor.right, vw - 315))}px` : '16px',
              left: 'auto',
            }
          : {
              left: hasAnchor ? `${Math.max(12, Math.min(anchor.left, vw - 315))}px` : '16px',
              right: 'auto',
            }

        return (
          <div
            onClick={handleCloseActionMenu}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2.5px] animate-in fade-in duration-150 select-none overflow-hidden touch-none"
          >
            {/* 1. Floating Quick Emoji Pill */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                ...(placeAbove
                  ? { bottom: `${Math.max(footerSafeBottom + 60, vh - bubbleTop + 8)}px` }
                  : { top: `${Math.max(headerSafeTop + 8, bubbleBottom + 8)}px` }
                ),
                ...emojiHorizontalStyle,
              }}
              className={`z-50 p-1 sm:p-1.5 rounded-full border shadow-2xl backdrop-blur-2xl flex items-center gap-0.5 sm:gap-1 animate-in zoom-in-75 duration-200 ease-out origin-center ${
                isLight 
                  ? 'bg-white/95 border-slate-200/90 shadow-slate-400/30 text-slate-800' 
                  : 'bg-[#1e1e24]/95 border-[#32323a] shadow-black/90 text-white'
              }`}
            >
              {['❤️', '👍', '🔥', '😂', '😮', '😢', '🙏'].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={async () => {
                    triggerHaptic('medium')
                    await toggleReaction(actionMessage.id, emoji)
                    handleCloseActionMenu()
                  }}
                  className="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-xl sm:text-2xl hover:scale-130 active:scale-95 transition-all duration-150 cursor-pointer hover:bg-amber-500/15"
                >
                  {emoji}
                </button>
              ))}
            </div>

            {/* 2. Floating Contextual Action Menu */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                ...(placeAbove
                  ? (spaceBelow >= 170
                      ? { top: `${Math.min(vh - footerSafeBottom - 170, bubbleBottom + 8)}px` }
                      : { bottom: `${Math.max(footerSafeBottom + 120, vh - bubbleTop + 62)}px` }
                    )
                  : { top: `${Math.max(headerSafeTop + 60, bubbleBottom + 58)}px` }
                ),
                ...horizontalStyle,
              }}
              className={`z-50 w-52 sm:w-56 p-1.5 rounded-2xl border shadow-2xl backdrop-blur-2xl transition-all animate-in zoom-in-95 duration-150 space-y-0.5 ${
                isLight 
                  ? 'bg-white/95 border-slate-200/90 text-slate-800 shadow-slate-400/40' 
                  : 'bg-[#18181d]/95 border-[#2c2c34] text-white shadow-black/90'
              }`}
            >
              {/* Action 1: Reply */}
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setReplyTo(actionMessage)
                  handleCloseActionMenu()
                  if (textareaRef.current) textareaRef.current.focus()
                }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                  isLight ? 'hover:bg-slate-100 text-slate-800' : 'hover:bg-[#25252e] text-zinc-100'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Reply className="w-4 h-4 text-amber-500 shrink-0" />
                  <span>Reply</span>
                </div>
              </button>

              {/* Action 2: Copy Text */}
              {actionMessage.message && !actionMessage.deleted && actionMessage.message_type !== 'deleted' && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light')
                    if (navigator?.clipboard?.writeText) {
                      navigator.clipboard.writeText(actionMessage.message)
                      toast.success('Text copied to clipboard')
                    }
                    handleCloseActionMenu()
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                    isLight ? 'hover:bg-slate-100 text-slate-800' : 'hover:bg-[#25252e] text-zinc-100'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Copy className="w-4 h-4 text-sky-400 shrink-0" />
                    <span>Copy Text</span>
                  </div>
                </button>
              )}

              {/* Action 3: Edit Message (Own text messages only) */}
              {sameId(actionMessage.user_id, chatUser?.id) && !actionMessage.deleted && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light')
                    setEditingId(actionMessage.id)
                    setInputText(actionMessage.message || '')
                    handleCloseActionMenu()
                    if (textareaRef.current) {
                      textareaRef.current.focus()
                      adjustTextareaHeight()
                    }
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                    isLight ? 'hover:bg-slate-100 text-slate-800' : 'hover:bg-[#25252e] text-zinc-100'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Edit3 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Edit Message</span>
                  </div>
                </button>
              )}

              {/* Divider */}
              <div className={`h-px my-1 ${isLight ? 'bg-slate-100' : 'bg-white/5'}`} />

              {/* Action 4: Delete for me */}
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('medium')
                  const targetId = actionMessage.id
                  handleCloseActionMenu()
                  deleteMessage(targetId, 'me').then((ok) => {
                    if (ok) toast.success('Deleted for you')
                    else toast.error('Could not delete message')
                  })
                }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                  isLight ? 'hover:bg-slate-100 text-slate-700' : 'hover:bg-[#25252e] text-zinc-300'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Trash2 className="w-4 h-4 opacity-60 shrink-0" />
                  <span>Delete for me</span>
                </div>
              </button>

              {/* Action 5: Delete for everyone (Own messages only) */}
              {sameId(actionMessage.user_id, chatUser?.id) && !actionMessage.deleted && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('error')
                    const targetId = actionMessage.id
                    handleCloseActionMenu()
                    deleteMessage(targetId, 'everyone').then((ok) => {
                      if (ok) toast.success('Deleted for everyone')
                      else toast.error('Could not delete message')
                    })
                  }}
                  className="w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <Trash2 className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>Delete for everyone</span>
                  </div>
                </button>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── REPORT USER MODAL ── */}
      {showReportModal && (
        <div
          onClick={() => setShowReportModal(false)}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 p-0 sm:p-4 backdrop-blur-sm animate-in fade-in duration-200"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-sm rounded-t-[32px] sm:rounded-3xl border border-b-0 sm:border-b p-5 sm:p-6 space-y-4 animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-200 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] sm:pb-6 ${
              isLight ? 'bg-white border-slate-200' : 'bg-[#121214] border-[#27272a]'
            }`}
          >
            <SheetGrabHandle onDismiss={() => setShowReportModal(false)} />

            <div className="flex items-center justify-between">
              <h3 className={`text-sm font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>
                Report @{activeConversation?.contact_username || 'user'}
              </h3>
              <button
                onClick={() => {
                  triggerHaptic('light')
                  setShowReportModal(false)
                }}
                className={`p-1 rounded-lg ${isLight ? 'hover:bg-slate-100' : 'hover:bg-[#27272a]'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <select
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              className={`w-full px-3 py-2.5 rounded-xl border text-xs font-bold ${
                isLight
                  ? 'bg-slate-50 border-slate-200 text-slate-900'
                  : 'bg-[#18181b] border-[#27272a] text-white'
              }`}
            >
              <option value="spam">Spam</option>
              <option value="harassment">Harassment / abuse</option>
              <option value="scam">Scam / fraud</option>
              <option value="impersonation">Impersonation</option>
              <option value="other">Other</option>
            </select>

            <textarea
              value={reportDetails}
              onChange={(e) => setReportDetails(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What happened? (optional)"
              className={`w-full px-3 py-2.5 rounded-xl border text-xs font-medium resize-none ${
                isLight
                  ? 'bg-slate-50 border-slate-200 text-slate-900 placeholder:text-slate-400'
                  : 'bg-[#18181b] border-[#27272a] text-white placeholder:text-zinc-500'
              }`}
            />

            <button
              onClick={submitReport}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] text-xs font-black active:scale-95 transition-all"
            >
              Submit report
            </button>
            <p className={`text-[10px] text-center ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
              Reports are reviewed by the JDLX team. Blocking works instantly.
            </p>
          </div>
        </div>
      )}

      {/* ── PRE-SEND IMAGE PREVIEW & CAPTION MODAL (WhatsApp / Telegram Standard) ── */}
      {imageSendModal && imageSendModal.items && imageSendModal.items.length > 0 && (() => {
        const activeItem = imageSendModal.items[imageSendModal.activeIndex] || imageSendModal.items[0]
        return (
          <div
            className="fixed inset-0 z-[60] bg-black/95 flex flex-col justify-between text-white backdrop-blur-2xl select-none animate-viewer-backdrop overflow-hidden"
            role="dialog"
            aria-modal="true"
          >
            {/* Top Toolbar */}
            <div className="w-full flex items-center justify-between px-3 sm:px-6 py-3 border-b border-white/10 bg-black/40 backdrop-blur-md z-10 animate-viewer-header">
              <button
                type="button"
                onClick={handleCloseImageSendModal}
                className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white flex items-center justify-center transition border border-white/15 backdrop-blur-md cursor-pointer shrink-0 shadow-md"
                title="Back / Discard"
                aria-label="Back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>

              {/* Center Details */}
              <div className="flex flex-col items-center max-w-[50%] truncate text-center">
                <span className="text-xs sm:text-sm font-bold text-white truncate">
                  {activeConversation?.name || 'Send Photo'}
                </span>
                <span className="text-[10px] text-zinc-400 font-mono flex items-center gap-1.5 truncate">
                  {activeItem.width && activeItem.height ? `${activeItem.width}×${activeItem.height}` : ''}
                  {activeItem.size ? ` • ${(activeItem.size / (1024 * 1024)).toFixed(1)}MB` : ''}
                  <span className="text-[#facc15] font-semibold"> • HD Preview</span>
                </span>
              </div>

              {/* Right Tools: Rotate 90° & Top-Right Close Button */}
              <div className="flex items-center gap-2 shrink-0">
                {activeItem.rotation !== 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setImageSendModal((prev) => {
                        if (!prev || !prev.items[prev.activeIndex]) return prev
                        const next = [...prev.items]
                        next[prev.activeIndex] = { ...next[prev.activeIndex], rotation: 0 }
                        return { ...prev, items: next }
                      })
                    }}
                    title="Reset rotation"
                    className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white flex items-center justify-center transition border border-white/10 backdrop-blur-md cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleRotateActiveImage}
                  className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white hover:text-[#facc15] flex items-center justify-center transition border border-white/10 backdrop-blur-md cursor-pointer"
                  title="Rotate 90° (R)"
                >
                  <RotateCw className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
                <button
                  type="button"
                  onClick={handleCloseImageSendModal}
                  className="w-10 h-10 rounded-full bg-white/10 hover:bg-rose-500/80 active:scale-95 text-white flex items-center justify-center transition border border-white/15 backdrop-blur-md cursor-pointer shadow-md hover:rotate-90"
                  title="Close (Esc)"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Center Active Image Preview Viewport with Smooth Pop-In */}
            <div className="flex-1 flex items-center justify-center p-4 relative overflow-hidden">
              <img
                key={activeItem.id || activeItem.url}
                src={activeItem.url}
                alt="Selected"
                style={{
                  transform: `rotate(${activeItem.rotation}deg)`,
                  transition: 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
                }}
                className="max-h-[55vh] sm:max-h-[62vh] max-w-[92vw] sm:max-w-[80vw] object-contain rounded-2xl shadow-2xl drop-shadow-2xl animate-viewer-image"
              />
            </div>

            {/* Bottom Controls Area */}
            <div className="w-full bg-gradient-to-t from-black via-black/80 to-transparent pt-3 pb-3 sm:pb-6 z-10 flex flex-col gap-2.5">
              {/* Thumbnail Strip (if multiple photos, or add more) */}
              <div className="flex items-center justify-center gap-2 px-4 overflow-x-auto max-w-xl mx-auto scrollbar-none py-1">
                {imageSendModal.items.map((item, idx) => (
                  <div
                    key={item.id}
                    onClick={() => setImageSendModal((prev) => ({ ...prev, activeIndex: idx }))}
                    className={`relative w-12 h-12 rounded-xl overflow-hidden cursor-pointer shrink-0 transition-all ${
                      idx === imageSendModal.activeIndex
                        ? 'ring-2 ring-[#facc15] scale-105 opacity-100 shadow-md shadow-yellow-500/20'
                        : 'opacity-50 hover:opacity-85'
                    }`}
                  >
                    <img
                      src={item.url}
                      alt=""
                      style={{ transform: `rotate(${item.rotation}deg)` }}
                      className="w-full h-full object-cover"
                    />
                    {imageSendModal.items.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRemovePreviewImage(idx)
                        }}
                        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/85 text-white flex items-center justify-center hover:bg-rose-500 transition cursor-pointer"
                        title="Remove"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addMoreImagesInputRef.current?.click()}
                  className="w-12 h-12 rounded-xl border border-dashed border-white/25 hover:border-yellow-400/60 hover:bg-white/5 text-zinc-400 hover:text-[#facc15] flex flex-col items-center justify-center gap-0.5 shrink-0 transition cursor-pointer disabled:opacity-30"
                  title="Add more photos"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-[9px] font-bold">Add</span>
                </button>
              </div>

              {/* Quick Emoji Strip */}
              {imageSendModal.showEmoji && (
                <div className="w-full max-w-2xl mx-auto px-4 pb-1 flex items-center justify-center gap-2 overflow-x-auto scrollbar-none animate-in fade-in slide-in-from-bottom-2">
                  {['❤️', '😂', '👍', '🔥', '😍', '🙏', '🎉', '💯', '👏', '🥳', '✨', '🚀'].map((em) => (
                    <button
                      key={em}
                      type="button"
                      onClick={() => handleCaptionChange((activeItem.caption || '') + em)}
                      className="text-xl p-1 hover:scale-125 active:scale-95 transition-transform cursor-pointer"
                    >
                      {em}
                    </button>
                  ))}
                </div>
              )}

              {/* Caption Input Capsule + Send Button */}
              <div className="w-full max-w-2xl mx-auto px-4 flex items-center gap-2.5">
                <div className="flex-1 flex items-center gap-2 bg-[#18181b]/95 border border-white/15 rounded-3xl px-3.5 py-2 shadow-2xl focus-within:border-[#facc15]/80 focus-within:ring-2 focus-within:ring-yellow-500/20 transition-all">
                  <button
                    type="button"
                    onClick={() => setImageSendModal((prev) => ({ ...prev, showEmoji: !prev.showEmoji }))}
                    className={`p-1 rounded-xl transition shrink-0 cursor-pointer ${
                      imageSendModal.showEmoji ? 'text-[#facc15]' : 'text-zinc-400 hover:text-white'
                    }`}
                    title="Add emojis"
                  >
                    <Smile className="w-5 h-5" />
                  </button>
                  <input
                    type="text"
                    placeholder="Add a caption..."
                    value={activeItem.caption || ''}
                    onChange={(e) => handleCaptionChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleConfirmSendImages()
                      }
                    }}
                    autoFocus
                    maxLength={1000}
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 focus:outline-none"
                  />
                  {activeItem.caption && (
                    <button
                      type="button"
                      onClick={() => handleCaptionChange('')}
                      className="p-1 rounded-full text-zinc-500 hover:text-white transition cursor-pointer"
                      title="Clear caption"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Floating Yellow Send Button */}
                <button
                  type="button"
                  onClick={handleConfirmSendImages}
                  className="w-12 h-12 rounded-full bg-gradient-to-tr from-[#facc15] to-[#eab308] text-[#09090b] flex items-center justify-center shadow-lg shadow-yellow-500/30 hover:scale-105 active:scale-95 transition-all shrink-0 cursor-pointer disabled:opacity-50"
                  title="Send photo"
                >
                  <Send className="w-5 h-5 ml-0.5" />
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── IMAGE FULL PREVIEW LIGHTBOX (MINIMALISTIC, LUXURY, SMOOTH ANIMATION) ── */}
      {selectedPreviewImage && (
        <div
          onClick={handleClosePreview}
          className={`fixed inset-0 z-50 flex flex-col justify-between bg-black/95 backdrop-blur-2xl select-none overflow-hidden ${
            isClosingPreview ? 'animate-viewer-backdrop-exit' : 'animate-viewer-backdrop'
          }`}
          role="dialog"
          aria-modal="true"
        >
          {/* Top Minimalist Header Bar */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between z-30 bg-gradient-to-b from-black/85 via-black/40 to-transparent animate-viewer-header"
          >
            {/* Left: Photo Info & Counter */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="min-w-0 flex flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-white text-sm sm:text-base font-bold truncate">
                    {previewImages.length > 1
                      ? `${previewIndex + 1} of ${previewImages.length}`
                      : 'Photo'}
                  </span>
                  <div className="w-1.5 h-1.5 rounded-full bg-[#facc15] shrink-0" />
                  <span className="text-zinc-400 text-xs font-medium truncate hidden xs:inline">
                    JDLX Chat
                  </span>
                </div>
                {previewImages[previewIndex] && (
                  <p className="text-[11px] text-zinc-400 font-medium truncate">
                    {previewImages[previewIndex].sender_name ? `${previewImages[previewIndex].sender_name} • ` : ''}
                    {previewImages[previewIndex].created_at ? formatMessageTime(previewImages[previewIndex].created_at) : ''}
                  </p>
                )}
              </div>
            </div>

            {/* Right: Minimal Action Buttons & Dedicated Top-Right Cross Button */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              {/* Desktop Zoom Controls (Hidden on mobile to keep header ultra-clean) */}
              <div className="hidden md:flex items-center gap-1 bg-white/5 border border-white/10 rounded-full px-2 py-1 backdrop-blur-md mr-1">
                <button
                  type="button"
                  onClick={() => setPreviewZoom((z) => {
                    const next = Math.max(1, +(z - 0.5).toFixed(1))
                    if (next === 1) setPanOffset({ x: 0, y: 0 })
                    return next
                  })}
                  disabled={previewZoom <= 1}
                  title="Zoom out (-)"
                  className="p-1 rounded-full text-zinc-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewZoom(1)
                    setPanOffset({ x: 0, y: 0 })
                  }}
                  title="Reset zoom (0)"
                  className="px-1.5 text-[11px] font-mono font-bold text-[#facc15] cursor-pointer"
                >
                  {Math.round(previewZoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewZoom((z) => Math.min(3.5, +(z + 0.5).toFixed(1)))}
                  disabled={previewZoom >= 3.5}
                  title="Zoom in (+)"
                  className="p-1 rounded-full text-zinc-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition cursor-pointer"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
              </div>

              {/* Rotate 90° */}
              <button
                type="button"
                onClick={() => setPreviewRotation((r) => (r + 90) % 360)}
                title="Rotate 90° (R)"
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 hover:text-[#facc15] flex items-center justify-center transition border border-white/10 backdrop-blur-md cursor-pointer"
              >
                <RotateCw className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              {/* Copy Image */}
              <button
                type="button"
                onClick={() => handleCopyMedia(selectedPreviewImage)}
                title="Copy Image (C)"
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 hover:text-[#facc15] flex items-center justify-center transition border border-white/10 backdrop-blur-md cursor-pointer"
              >
                <Copy className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              {/* Native Web Share */}
              {typeof navigator !== 'undefined' && navigator.share && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.share({
                        title: 'JDLX Chat Photo',
                        url: selectedPreviewImage,
                      })
                    } catch {}
                  }}
                  title="Share photo"
                  className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 hover:text-[#facc15] flex items-center justify-center transition border border-white/10 backdrop-blur-md cursor-pointer"
                >
                  <Share2 className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
              )}

              {/* Download Media */}
              <button
                type="button"
                onClick={() => handleDownloadMedia(selectedPreviewImage)}
                title="Download photo (D)"
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 hover:text-[#facc15] flex items-center justify-center transition border border-white/10 backdrop-blur-md cursor-pointer"
              >
                <Download className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              {/* Fullscreen (Desktop only) */}
              <button
                type="button"
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit Fullscreen (F)" : "Enter Fullscreen (F)"}
                className="hidden sm:flex w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 hover:text-[#facc15] items-center justify-center transition border border-white/10 backdrop-blur-md cursor-pointer"
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>

              {/* Dedicated Top-Right Cross Button (The ONLY close button) */}
              <button
                type="button"
                onClick={handleClosePreview}
                className="w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-white/15 hover:bg-rose-500/90 active:scale-95 text-white flex items-center justify-center transition-all duration-200 border border-white/20 backdrop-blur-md shadow-xl ml-1 cursor-pointer hover:rotate-90 group"
                title="Close viewer (Esc)"
                aria-label="Close"
              >
                <X className="w-5 h-5 sm:w-6 sm:h-6 transition-transform group-hover:scale-110" />
              </button>
            </div>
          </div>

          {/* Centered Image Canvas with Smooth Scale-In Animation & Navigation Arrows */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex-1 w-full flex items-center justify-center overflow-hidden p-2 sm:p-4 my-auto relative"
          >
            {/* Multi-Image Previous / Next Floating Arrows */}
            {previewImages.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handlePrevPreview()
                  }}
                  className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 z-30 w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-black/60 hover:bg-black/85 text-white/90 hover:text-white border border-white/15 backdrop-blur-md flex items-center justify-center transition-all hover:scale-110 active:scale-95 cursor-pointer shadow-2xl"
                  title="Previous photo (Left Arrow)"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleNextPreview()
                  }}
                  className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 z-30 w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-black/60 hover:bg-black/85 text-white/90 hover:text-white border border-white/15 backdrop-blur-md flex items-center justify-center transition-all hover:scale-110 active:scale-95 cursor-pointer shadow-2xl"
                  title="Next photo (Right Arrow)"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </>
            )}

            <div
              className={`relative flex items-center justify-center max-w-full max-h-full ${
                isClosingPreview ? 'animate-viewer-image-exit' : 'animate-viewer-image'
              }`}
            >
              <img
                key={selectedPreviewImage}
                src={selectedPreviewImage}
                alt="Enlarged Attachment"
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${previewZoom}) rotate(${previewRotation}deg)`,
                  cursor: previewZoom > 1 ? 'grab' : 'zoom-in'
                }}
                onPointerDown={(e) => {
                  if (previewZoom > 1) {
                    isPanningRef.current = true
                    panStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y }
                    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                  }
                }}
                onPointerMove={(e) => {
                  if (isPanningRef.current && previewZoom > 1) {
                    setPanOffset({
                      x: e.clientX - panStartRef.current.x,
                      y: e.clientY - panStartRef.current.y
                    })
                  }
                }}
                onPointerUp={(e) => {
                  isPanningRef.current = false
                  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                }}
                onPointerCancel={(e) => {
                  isPanningRef.current = false
                  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                }}
                onDoubleClick={() => {
                  if (previewZoom > 1) {
                    setPreviewZoom(1)
                    setPanOffset({ x: 0, y: 0 })
                  } else {
                    setPreviewZoom(2)
                  }
                }}
                onTouchStart={(e) => {
                  if (e.touches.length === 1 && previewZoom === 1) {
                    swipeTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
                  }
                  if (e.touches.length === 2) {
                    const dist = Math.hypot(
                      e.touches[0].clientX - e.touches[1].clientX,
                      e.touches[0].clientY - e.touches[1].clientY
                    )
                    touchDistRef.current = dist
                  }
                }}
                onTouchMove={(e) => {
                  if (e.touches.length === 2 && touchDistRef.current) {
                    const dist = Math.hypot(
                      e.touches[0].clientX - e.touches[1].clientX,
                      e.touches[0].clientY - e.touches[1].clientY
                    )
                    const diff = dist - touchDistRef.current
                    if (Math.abs(diff) > 8) {
                      setPreviewZoom((z) => {
                        const next = Math.max(1, Math.min(3.5, +(z + (diff > 0 ? 0.08 : -0.08)).toFixed(2)))
                        if (next === 1) setPanOffset({ x: 0, y: 0 })
                        return next
                      })
                      touchDistRef.current = dist
                    }
                  }
                }}
                onTouchEnd={(e) => {
                  touchDistRef.current = null
                  if (e.changedTouches.length === 1 && previewZoom === 1) {
                    const diffX = e.changedTouches[0].clientX - swipeTouchStartRef.current.x
                    const diffY = e.changedTouches[0].clientY - swipeTouchStartRef.current.y
                    // Swipe down to dismiss gesture (Telegram / WhatsApp standard)
                    if (diffY > 70 && Math.abs(diffY) > Math.abs(diffX) * 1.5) {
                      handleClosePreview()
                      return
                    }
                    // Swipe left / right navigation
                    if (Math.abs(diffX) > 40 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
                      if (diffX < 0) {
                        handleNextPreview()
                      } else {
                        handlePrevPreview()
                      }
                    }
                  }
                }}
                className="max-h-[75vh] sm:max-h-[80vh] max-w-full rounded-2xl object-contain shadow-2xl border border-white/10 transition-transform duration-75 select-none touch-none"
              />
            </div>
          </div>

          {/* Caption Bar (if present on the photo) */}
          {previewImages[previewIndex]?.caption && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="max-w-xl mx-auto px-4 py-2 my-1 rounded-2xl bg-black/75 border border-white/10 backdrop-blur-md text-white text-xs sm:text-sm text-center shadow-xl select-text z-20 animate-viewer-footer"
            >
              {previewImages[previewIndex].caption}
            </div>
          )}

          {/* Bottom Thumbnail Filmstrip Carousel (when browsing multiple photos) */}
          {previewImages.length > 1 && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xl mx-auto flex items-center justify-center gap-2 px-3 py-2 overflow-x-auto scrollbar-none z-20 my-1 animate-viewer-footer"
            >
              {previewImages.map((pImg, pIdx) => (
                <div
                  key={pImg.id || pIdx}
                  onClick={() => handleJumpToPreview(pIdx)}
                  className={`relative w-11 h-11 sm:w-12 sm:h-12 rounded-xl overflow-hidden cursor-pointer shrink-0 transition-all ${
                    pIdx === previewIndex
                      ? 'ring-2 ring-[#facc15] scale-105 opacity-100 shadow-lg shadow-yellow-500/30'
                      : 'opacity-40 hover:opacity-85'
                  }`}
                >
                  <img
                    src={pImg.url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Bottom Hint */}
          <div className="text-[11px] text-zinc-400 select-none pb-1 font-medium text-center animate-viewer-footer">
            {previewImages.length > 1 ? 'Use ← / → arrows or swipe to browse • ' : ''}Double-click to zoom • F for fullscreen • D to download • C to copy • Esc to close
          </div>
        </div>
      )}

      {/* ── CONTACT PROFILE & SECURITY MODAL (Telegram / WhatsApp Luxury Standard) ── */}
      {showContactInfoModal && activeConversation && (
        <div
          onClick={() => setShowContactInfoModal(false)}
          className="fixed inset-0 bg-black/85 backdrop-blur-xl z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-md rounded-t-[36px] sm:rounded-3xl border border-b-0 sm:border-b shadow-2xl overflow-hidden animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-200 max-h-[92vh] flex flex-col pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] sm:pb-6 ${
              isLight ? 'bg-white border-slate-200 text-slate-900 shadow-slate-300/50' : 'bg-[#121215] border-[#27272a] text-white shadow-black/90'
            }`}
          >
            {/* Top Sheet Grab Handle & Header */}
            <div className="relative pt-3 pb-2 px-5 sm:px-6 bg-gradient-to-b from-amber-500/10 via-yellow-500/5 to-transparent shrink-0">
              <SheetGrabHandle onDismiss={() => setShowContactInfoModal(false)} />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[11px] font-black uppercase tracking-wider text-amber-500 flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5" />
                  Contact Profile
                </span>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light')
                    setShowContactInfoModal(false)
                  }}
                  className={`p-1.5 rounded-full border transition-all cursor-pointer ${
                    isLight 
                      ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200' 
                      : 'bg-[#1a1a20] hover:bg-[#25252c] text-zinc-300 border-[#2f2f38]'
                  }`}
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="overflow-y-auto px-5 sm:px-6 py-2 space-y-4 custom-scrollbar">
              {/* Avatar & Contact Details */}
              <div className="flex flex-col items-center text-center pt-1 pb-1">
                <div 
                  onClick={() => {
                    if (activeConversation.contact_avatar) {
                      triggerHaptic('light')
                      openLightbox(resolveMediaUrl(activeConversation.contact_avatar))
                    }
                  }}
                  className={`relative group cursor-pointer ${activeConversation.contact_avatar ? 'hover:scale-105 active:scale-95' : ''} transition-transform duration-200`}
                  title={activeConversation.contact_avatar ? "Click to view full photo" : ""}
                >
                  <div className={`w-24 h-24 sm:w-28 sm:h-28 rounded-[30px] flex items-center justify-center font-black text-3xl border-2 overflow-hidden shadow-xl ${
                    isLight 
                      ? 'bg-gradient-to-tr from-amber-100 to-amber-200 text-amber-800 border-amber-300 shadow-amber-500/15' 
                      : 'bg-gradient-to-tr from-yellow-500/20 to-amber-500/10 text-[#facc15] border-yellow-500/40 shadow-yellow-500/20'
                  }`}>
                    {activeConversation.contact_avatar ? (
                      <img src={resolveMediaUrl(activeConversation.contact_avatar)} alt="" className="w-full h-full object-cover" />
                    ) : (
                      activeConversation.contact_name?.[0]?.toUpperCase() || 'U'
                    )}
                  </div>

                  {/* Online Glowing Pulse Badge */}
                  {peerOnline && (
                    <span className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center pointer-events-none" title="Online now">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-4 w-4 rounded-full bg-emerald-500 border-2 border-white dark:border-[#121215] shadow-sm" />
                    </span>
                  )}

                  {/* Hover Fullscreen Overlay Hint */}
                  {activeConversation.contact_avatar && (
                    <span className="absolute inset-0 rounded-[30px] bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-xs font-bold transition-opacity">
                      <Maximize2 className="w-6 h-6 text-white drop-shadow-md" />
                    </span>
                  )}
                </div>

                <div className="mt-3.5 space-y-1">
                  <div className="flex items-center justify-center gap-1.5">
                    <h3 className="text-lg sm:text-xl font-black tracking-tight">{activeConversation.contact_name}</h3>
                    <ShieldCheck className={`w-5 h-5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} title="Verified JDLX Contact" />
                  </div>

                  {/* Copyable @username pill */}
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light')
                        navigator.clipboard.writeText(`@${activeConversation.contact_username}`)
                        toast.success('Username copied to clipboard!')
                      }}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold border transition-all active:scale-95 cursor-pointer ${
                        isLight 
                          ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100' 
                          : 'bg-yellow-500/10 text-[#facc15] border-yellow-500/30 hover:bg-yellow-500/20'
                      }`}
                      title="Click to copy handle"
                    >
                      <span>@{activeConversation.contact_username}</span>
                      <Copy className="w-3 h-3 opacity-60" />
                    </button>
                  </div>

                  {/* Live Status Indicator */}
                  <div className="flex items-center justify-center gap-1.5 pt-0.5">
                    <span className={`w-2 h-2 rounded-full ${peerTyping ? 'bg-amber-400 animate-pulse' : peerOnline ? 'bg-emerald-500' : 'bg-zinc-500 opacity-50'}`} />
                    <p className={`text-xs font-bold ${peerTyping ? 'text-amber-500' : peerOnline ? 'text-emerald-500' : 'opacity-60'}`}>
                      {peerTyping ? 'typing…' : (peerOnline ? 'Active now' : 'Offline')}
                    </p>
                  </div>
                </div>
              </div>

              {/* Quick Action Tiles (WhatsApp & Telegram 3-Tile Row) */}
              <div className="grid grid-cols-3 gap-2.5 pt-1">
                {/* 1. Chat */}
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light')
                    setShowContactInfoModal(false)
                    if (textareaRef.current) textareaRef.current.focus()
                  }}
                  className={`p-2.5 sm:p-3 rounded-2xl border flex flex-col items-center gap-1.5 transition-all active:scale-95 cursor-pointer ${
                    isLight 
                      ? 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-800 shadow-xs' 
                      : 'bg-[#18181b] hover:bg-[#202026] border-[#27272a] text-zinc-200'
                  }`}
                  title="Direct Message"
                >
                  <MessageSquare className="w-5 h-5 text-amber-500" />
                  <span className="text-[11px] font-bold">Chat</span>
                </button>

                {/* 2. Mute */}
                <button
                  type="button"
                  onClick={() => toggleMuteRoom(activeRoomId)}
                  className={`p-2.5 sm:p-3 rounded-2xl border flex flex-col items-center gap-1.5 transition-all active:scale-95 cursor-pointer ${
                    isLight 
                      ? 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-800 shadow-xs' 
                      : 'bg-[#18181b] hover:bg-[#202026] border-[#27272a] text-zinc-200'
                  }`}
                  title={mutedRooms.includes(activeRoomId) ? "Unmute Notifications" : "Mute Notifications"}
                >
                  {mutedRooms.includes(activeRoomId) ? (
                    <VolumeX className="w-5 h-5 text-rose-500" />
                  ) : (
                    <Volume2 className="w-5 h-5 text-emerald-500" />
                  )}
                  <span className="text-[11px] font-bold">
                    {mutedRooms.includes(activeRoomId) ? 'Muted' : 'Mute'}
                  </span>
                </button>

                {/* 3. Media Shortcut */}
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light')
                    const el = document.getElementById('contact-shared-media-section')
                    if (el) el.scrollIntoView({ behavior: 'smooth' })
                  }}
                  className={`p-2.5 sm:p-3 rounded-2xl border flex flex-col items-center gap-1.5 transition-all active:scale-95 cursor-pointer ${
                    isLight 
                      ? 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-800 shadow-xs' 
                      : 'bg-[#18181b] hover:bg-[#202026] border-[#27272a] text-zinc-200'
                  }`}
                  title="Shared Media"
                >
                  <ImageIcon className="w-5 h-5 text-purple-500" />
                  <span className="text-[11px] font-bold">Media</span>
                </button>
              </div>

              {/* About / Bio Status Card */}
              <div className={`p-4 rounded-2xl border space-y-1.5 ${
                isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
              }`}>
                <span className="text-[10px] font-black uppercase tracking-wider text-amber-500 block">
                  About &amp; Status
                </span>
                <p className="text-xs font-medium leading-relaxed">
                  {activeConversation.contact_bio || activeConversation.other_user?.bio || "Hey there! I am using JDLX Chat"}
                </p>
              </div>

              {/* Shared Media Preview Section */}
              <div 
                id="contact-shared-media-section"
                className={`p-4 rounded-2xl border space-y-2.5 ${
                  isLight ? 'bg-slate-50 border-slate-200' : 'bg-[#18181b] border-[#27272a]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-500 flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5" />
                    Media, Links &amp; Docs
                  </span>
                  <span className="text-[11px] font-bold opacity-60">
                    {previewImages.length} {previewImages.length === 1 ? 'photo' : 'photos'}
                  </span>
                </div>

                {previewImages.length > 0 ? (
                  <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1 custom-scrollbar">
                    {previewImages.slice(0, 8).map((pImg, pIdx) => (
                      <div
                        key={pImg.id || pIdx}
                        onClick={() => {
                          triggerHaptic('light')
                          setShowContactInfoModal(false)
                          openLightbox(pImg.url, previewImages, pIdx)
                        }}
                        className="relative w-14 h-14 sm:w-16 sm:h-16 rounded-xl overflow-hidden shrink-0 border border-white/10 cursor-pointer group hover:scale-105 active:scale-95 transition-all shadow-sm"
                        title="Click to view photo"
                      >
                        <img src={pImg.url} alt="" className="w-full h-full object-cover group-hover:brightness-110 transition-all" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs opacity-50 py-1">No photos or media shared yet</p>
                )}
              </div>

              {/* Encryption & Security Verification Card */}
              <div className={`p-4 rounded-2xl border space-y-2.5 ${
                isLight 
                  ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950' 
                  : 'bg-emerald-950/20 border-emerald-500/30 text-emerald-100'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-black text-xs text-emerald-500">
                    <Lock className="w-4 h-4 shrink-0" />
                    <span>End-to-End Encrypted (ECDH v2)</span>
                  </div>
                  <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-500 border border-emerald-500/30">
                    Verified
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed opacity-85">
                  Messages in this conversation are cryptographically secured with client-side ECDH keys. Nobody outside this chat, not even JDLX servers, can read your text messages.
                </p>

                {/* Safety Number Fingerprint (Signal/WhatsApp standard) */}
                <div className={`p-2.5 rounded-xl border flex items-center justify-between gap-2 font-mono text-[11px] ${
                  isLight 
                    ? 'bg-white/80 border-emerald-200 text-emerald-900' 
                    : 'bg-[#101014]/80 border-emerald-500/20 text-emerald-300'
                }`}>
                  <div className="min-w-0">
                    <span className="text-[9px] uppercase tracking-wider block font-bold text-emerald-600 dark:text-emerald-400">
                      Safety Key Fingerprint
                    </span>
                    <span className="tracking-widest font-black text-xs">
                      {formatSafetyFingerprint(activeConversation.id, activeConversation.contact_public_key)}
                    </span>
                  </div>
                  <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                </div>
              </div>

              {/* Chat Management & Safety (Destructive Actions) */}
              <div className={`rounded-2xl border divide-y overflow-hidden ${
                isLight ? 'bg-slate-50 border-slate-200 divide-slate-200' : 'bg-[#18181b] border-[#27272a] divide-[#27272a]'
              }`}>
                {/* Clear Conversation */}
                <button
                  type="button"
                  onClick={async () => {
                    triggerHaptic('medium')
                    if (window.confirm(`Clear all messages in chat with ${activeConversation.contact_name}?`)) {
                      const ok = await clearChatHistory(activeRoomId)
                      if (ok) {
                        setShowContactInfoModal(false)
                        toast.success('Conversation cleared')
                      } else {
                        toast.error('Could not clear conversation')
                      }
                    }
                  }}
                  className={`w-full px-4 py-3 text-left text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                    isLight ? 'hover:bg-slate-100 text-slate-800' : 'hover:bg-[#202026] text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Trash2 className="w-4 h-4 text-amber-500" />
                    <span>Clear Chat History</span>
                  </div>
                  <ChevronRight className="w-4 h-4 opacity-40" />
                </button>

                {/* Block / Unblock Contact */}
                {activeConversation?.other_user?.id && (
                  <button
                    type="button"
                    onClick={async () => {
                      const targetId = activeConversation.other_user.id
                      const wasBlocked = Boolean(activeConversation.blocked_by_me)
                      setShowContactInfoModal(false)
                      triggerHaptic('medium')
                      toast.success(wasBlocked ? 'User unblocked' : 'User blocked')
                      const ok = wasBlocked ? await unblockUser(targetId) : await blockUser(targetId)
                      if (!ok) toast.error(wasBlocked ? 'Could not unblock user' : 'Could not block user')
                    }}
                    className={`w-full px-4 py-3 text-left text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                      activeConversation.blocked_by_me
                        ? isLight ? 'hover:bg-emerald-50 text-emerald-600' : 'hover:bg-emerald-950/20 text-emerald-400'
                        : isLight ? 'hover:bg-rose-50 text-rose-600' : 'hover:bg-rose-950/20 text-rose-400'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Ban className="w-4 h-4" />
                      <span>{activeConversation.blocked_by_me ? 'Unblock Contact' : 'Block Contact'}</span>
                    </div>
                    <ChevronRight className="w-4 h-4 opacity-40" />
                  </button>
                )}

                {/* Report Contact */}
                {activeConversation?.other_user?.id && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light')
                      setShowContactInfoModal(false)
                      setShowReportModal(true)
                    }}
                    className={`w-full px-4 py-3 text-left text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                      isLight ? 'hover:bg-amber-50 text-amber-700' : 'hover:bg-amber-950/20 text-amber-400'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Flag className="w-4 h-4" />
                      <span>Report Contact</span>
                    </div>
                    <ChevronRight className="w-4 h-4 opacity-40" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── DRAG & DROP LUXURY VIEWPORT DROPZONE OVERLAY (Item 4) ── */}
      {isDraggingOver && activeConversation && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex flex-col items-center justify-center p-6 select-none animate-in fade-in duration-150 pointer-events-none">
          <div className="w-full max-w-md border-2 border-dashed border-[#facc15] bg-[#18181b]/95 rounded-3xl p-8 flex flex-col items-center justify-center gap-4 text-center shadow-2xl shadow-yellow-500/25 animate-in zoom-in-95 duration-150">
            <div className="w-20 h-20 rounded-3xl bg-yellow-400/10 border border-yellow-400/30 flex items-center justify-center text-[#facc15] animate-bounce">
              <Upload className="w-10 h-10 stroke-[2.2]" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-lg font-black text-white tracking-tight">
                Drop photos to send
              </h3>
              <p className="text-xs text-zinc-400 font-medium max-w-xs">
                Drop your image here to preview, crop, add captions, and send to{' '}
                <span className="text-[#facc15] font-bold">
                  {activeConversation.contact_name || 'chat'}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[11px] text-zinc-300 font-mono">
              <ImageIcon className="w-3.5 h-3.5 text-[#facc15]" />
              <span>Supports JPG, PNG, WEBP, GIF, PDF</span>
            </div>
          </div>
        </div>
      )}

      {/* ── PWA & APK INSTALL MODAL ── */}
      {showPwaInstallModal && (
        <div
          onClick={() => setShowPwaInstallModal(false)}
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-sm rounded-t-[32px] sm:rounded-3xl border border-b-0 sm:border-b shadow-2xl p-5 sm:p-6 space-y-4 animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-200 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] sm:pb-6 ${
              isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-[#121215] border-[#27272a] text-white'
            }`}
          >
            <SheetGrabHandle onDismiss={() => setShowPwaInstallModal(false)} />

            <div className="flex items-center justify-between pb-1 border-b border-inherit">
              <span className="text-xs font-black uppercase tracking-wider text-[#facc15]">Install App</span>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light')
                  setShowPwaInstallModal(false)
                }}
                className="p-1 rounded-xl opacity-60 hover:opacity-100 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-center space-y-2">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-tr from-[#facc15] to-[#eab308] p-0.5 flex items-center justify-center text-[#09090b] shadow-lg shadow-yellow-500/20 font-black text-2xl overflow-hidden">
                <div className="w-full h-full rounded-[14px] bg-[#09090b] flex items-center justify-center overflow-hidden">
                  <img src="/logo192.png" alt="JDLX Chat" className="w-full h-full object-contain rounded-[14px]" />
                </div>
              </div>
              <div>
                <h3 className="text-base font-black">Get JDLX Chat App</h3>
                <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-zinc-400'}`}>
                  Install for the fastest experience, instant push alerts, and direct home screen access.
                </p>
              </div>
            </div>

            {deferredPrompt ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await deferredPrompt.prompt()
                    const choice = await deferredPrompt.userChoice
                    if (choice?.outcome === 'accepted') {
                      setDeferredPrompt(null)
                      setIsPwaInstalled(true)
                      setShowPwaInstallModal(false)
                    }
                  } catch {
                    /* fallback */
                  }
                }}
                className="w-full py-3 rounded-2xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] font-black text-xs shadow-md shadow-yellow-500/20 active:scale-98 transition flex items-center justify-center gap-2 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Install JDLX Chat Now</span>
              </button>
            ) : /iphone|ipad|ipod/i.test(navigator?.userAgent || '') ? (
              <div className={`p-3.5 rounded-2xl border text-xs space-y-2 text-left ${
                isLight ? 'bg-amber-50/70 border-amber-200 text-amber-900' : 'bg-yellow-500/10 border-yellow-500/30 text-zinc-200'
              }`}>
                <p className="font-bold">To install on iOS Safari:</p>
                <ol className="list-decimal list-inside space-y-1 text-[11px] opacity-90">
                  <li>Tap the <strong>Share</strong> button (⎋) at bottom of Safari</li>
                  <li>Scroll down and tap <strong>Add to Home Screen</strong> (⊞)</li>
                  <li>Tap <strong>Add</strong> at top-right to launch standalone</li>
                </ol>
              </div>
            ) : (
              <div className="space-y-2">
                <a
                  href={resolveMediaUrl('/static/downloads/official-chat.apk')}
                  download="official-chat.apk"
                  className="w-full py-3 rounded-2xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#09090b] font-black text-xs shadow-md shadow-yellow-500/20 active:scale-98 transition flex items-center justify-center gap-2 cursor-pointer text-center"
                >
                  <Download className="w-4 h-4" />
                  <span>Download Android APK</span>
                </a>
                <p className="text-[10px] text-center opacity-60">
                  Or tap browser menu (⋮) &gt; "Add to Home screen" / "Install app"
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
