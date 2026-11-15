import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, KeyRound, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../store/useChatStore'
import { useDialogA11y } from '../hooks/useDialogA11y'

const SETUP_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Global recovery-key dialog.
 *
 * - "setup"  : local key exists but no PIN-encrypted backup is configured.
 * - "unlock" : a PIN-encrypted backup exists on the server but this device has
 *              no local key (new phone / cleared storage).
 *
 * The PIN never leaves the browser. The server only stores an AES-GCM blob.
 */
export default function RecoveryPinModal() {
  const {
    chatToken,
    chatUser,
    identityKeypair,
    identityNeedsPassphrase,
    recoveryPromptNonce,
    resolvedChatTheme,
    saveRecoveryPin,
    unlockWithRecoveryPin,
    startFreshIdentity
  } = useChatStore(useShallow((state) => state))

  const uid = chatUser?.id
  const isLight = resolvedChatTheme === 'light'
  const [mode, setMode] = useState(null)
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [lockUntil, setLockUntil] = useState(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const handledNonceRef = useRef(0)
  // Keeps Tab focus inside this critical dialog. Escape is intentionally not a
  // dismissal path here: leaving without unlocking would strand the session.
  const dialogRef = useDialogA11y(
    Boolean(mode),
    null,
    mode === 'unlock' ? 'input[type="password"]' : null
  )

  // A short client-side cooldown after repeated wrong PINs. It does not replace
  // the real KDF work, but it stops a scripted UI from spraying guesses and
  // makes casual retry attacks impractical. Persisted per-account so a reload
  // does not clear it.
  useEffect(() => {
    if (!uid) return
    try {
      const until = Number(localStorage.getItem(`jdlx_chat_recovery_lock_${uid}`) || 0)
      if (Number.isFinite(until) && until > Date.now()) setLockUntil(until)
    } catch {
      /* ignore */
    }
  }, [uid])

  useEffect(() => {
    if (!lockUntil || lockUntil <= Date.now()) return undefined
    const id = setInterval(() => {
      const now = Date.now()
      setNowTick(now)
      if (now >= lockUntil) setLockUntil(0)
    }, 1000)
    return () => clearInterval(id)
  }, [lockUntil])

  const lockSecondsLeft = lockUntil > nowTick ? Math.max(0, Math.ceil((lockUntil - nowTick) / 1000)) : 0
  const isLocked = lockSecondsLeft > 0

  useEffect(() => {
    if (!uid || !chatToken) {
      setMode(null)
      return
    }
    if (identityNeedsPassphrase) {
      setMode('unlock')
      setError('')
      return
    }
    if (!identityKeypair) {
      setMode(null)
      return
    }
    if (recoveryPromptNonce > handledNonceRef.current) {
      handledNonceRef.current = recoveryPromptNonce
      setMode('setup')
      setError('')
      return
    }
    let pinSet = false
    let snoozed = false
    try {
      pinSet = localStorage.getItem(`jdlx_chat_recovery_pin_set_${uid}`) === 'true'
      const until = Number(localStorage.getItem(`jdlx_chat_recovery_snoozed_${uid}`) || 0)
      snoozed = Number.isFinite(until) && until > Date.now()
    } catch {
      /* ignore */
    }
    if (!pinSet && !snoozed) {
      setMode('setup')
      setError('')
    }
  }, [uid, chatToken, identityKeypair, identityNeedsPassphrase, recoveryPromptNonce])

  if (!mode) return null

  const resetInputs = () => {
    setPin('')
    setConfirmPin('')
    setError('')
    setConfirmFresh(false)
  }

  const handleLater = () => {
    try {
      localStorage.setItem(
        `jdlx_chat_recovery_snoozed_${uid}`,
        String(Date.now() + SETUP_SNOOZE_MS)
      )
    } catch {
      /* ignore */
    }
    resetInputs()
    setMode(null)
  }

  const handleSetup = async (event) => {
    event.preventDefault()
    setError('')
    const cleanPin = pin.trim()
    if (cleanPin.length < 6) {
      setError('Recovery PIN must be at least 6 characters.')
      return
    }
    if (cleanPin !== confirmPin.trim()) {
      setError('Recovery PINs do not match.')
      return
    }
    setBusy(true)
    const result = await saveRecoveryPin(cleanPin)
    setBusy(false)
    if (!result?.success) {
      setError(result?.error || 'Could not save the recovery backup.')
      return
    }
    resetInputs()
    setMode(null)
    toast.success('Recovery PIN saved. Use it to restore chats on a new device.', { icon: '🔐' })
  }

  const handleUnlock = async (event) => {
    event.preventDefault()
    setError('')
    const cleanPin = pin.trim()
    if (!cleanPin) {
      setError('Enter your recovery PIN.')
      return
    }
    if (isLocked) {
      setError(`Too many attempts. Try again in ${lockSecondsLeft}s.`)
      return
    }
    setBusy(true)
    const result = await unlockWithRecoveryPin(cleanPin)
    setBusy(false)
    if (!result?.success) {
      const attemptsKey = `jdlx_chat_recovery_attempts_${uid}`
      const lockKey = `jdlx_chat_recovery_lock_${uid}`
      let attempts = 1
      try {
        attempts = Number(localStorage.getItem(attemptsKey) || 0) + 1
        localStorage.setItem(attemptsKey, String(attempts))
      } catch {
        /* ignore */
      }
      const delayMs = attempts >= 5 ? 300000 : attempts >= 4 ? 120000 : attempts >= 3 ? 30000 : 0
      if (delayMs) {
        const until = Date.now() + delayMs
        try {
          localStorage.setItem(lockKey, String(until))
        } catch {
          /* ignore */
        }
        setLockUntil(until)
        setNowTick(Date.now())
        setError(`Incorrect PIN. Too many attempts — try again in ${Math.ceil(delayMs / 1000)}s.`)
        return
      }
      setError(result?.error || 'Could not unlock your chats.')
      return
    }
    try {
      localStorage.removeItem(`jdlx_chat_recovery_attempts_${uid}`)
      localStorage.removeItem(`jdlx_chat_recovery_lock_${uid}`)
    } catch {
      /* ignore */
    }
    setLockUntil(0)
    resetInputs()
    setMode(null)
    toast.success('Chats unlocked on this device.')
  }

  const handleFresh = async () => {
    setBusy(true)
    const result = await startFreshIdentity()
    setBusy(false)
    if (!result?.success) {
      setError(result?.error || 'Could not create a new encryption key.')
      return
    }
    resetInputs()
    setMode(null)
    toast('New encryption key created. Older messages may not be readable here.', { icon: '⚠️' })
  }

  const fieldClass = 'ui-input text-sm'

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-pin-title"
        className={`ui-card w-full max-w-sm origin-center p-5 animate-popover-spring ${
          isLight ? 'border-slate-200/90 bg-white text-slate-900' : 'border-white/[0.08] bg-[#0f1114] text-white'
        }`}
      >
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            isLight ? 'bg-amber-50 text-amber-700' : 'bg-amber-500/10 text-amber-400'
          }`}>
            {mode === 'unlock' ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </div>
          <div className="min-w-0">
            <h2 id="recovery-pin-title" className="text-base font-semibold tracking-tight">
              {mode === 'unlock' ? 'Unlock your chats' : 'Protect your chat backup'}
            </h2>
            <p className={`text-[11px] ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
              {mode === 'unlock'
                ? 'This account has an encrypted key backup.'
                : 'Encrypt your key with a Recovery PIN.'}
            </p>
          </div>
        </div>

        {mode === 'setup' ? (
          <form onSubmit={handleSetup} className="space-y-3">
            <p className={`text-xs leading-relaxed ${isLight ? 'text-slate-600' : 'text-zinc-400'}`}>
              Your messages stay end-to-end encrypted. Set a Recovery PIN so you can restore this
              account's chats on a new device. The PIN is never sent to the server and cannot be
              recovered if you forget it.
            </p>
            <input
              className={fieldClass}
              type="password"
              autoComplete="new-password"
              aria-label="Recovery PIN, at least 6 characters"
              placeholder="Recovery PIN (min 6 characters)"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={busy}
            />
            <input
              className={fieldClass}
              type="password"
              autoComplete="new-password"
              aria-label="Confirm Recovery PIN"
              placeholder="Confirm Recovery PIN"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              disabled={busy}
            />
            {error && <p role="alert" className="text-xs font-medium text-rose-500">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleLater}
                disabled={busy}
                className="ui-btn ui-btn-secondary flex-1"
              >
                Later
              </button>
              <button
                type="submit"
                disabled={busy}
                className="ui-btn ui-btn-primary flex-1"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Save PIN
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleUnlock} className="space-y-3">
            <p className={`text-xs leading-relaxed ${isLight ? 'text-slate-600' : 'text-zinc-400'}`}>
              Enter the Recovery PIN you set on your other device. It is checked only on this
              device; the server never sees it.
            </p>
            <input
              className={fieldClass}
              type="password"
              autoComplete="current-password"
              aria-label="Recovery PIN"
              aria-invalid={Boolean(error)}
              placeholder="Recovery PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={busy || isLocked}
              autoFocus
            />
            {error && <p role="alert" className="text-xs font-medium text-rose-500">{error}</p>}
            {isLocked && !error && (
              <p className="text-xs font-medium text-rose-500">Too many attempts. Try again in {lockSecondsLeft}s.</p>
            )}
            <button
              type="submit"
              disabled={busy || isLocked}
              className="ui-btn ui-btn-primary w-full"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {isLocked ? `Try again in ${lockSecondsLeft}s` : 'Unlock chats'}
            </button>

            {confirmFresh ? (
              <div className={`rounded-xl border p-3 text-xs ${isLight ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-900/60 bg-red-950/30 text-red-300'}`}>
                <p className="mb-2 font-semibold">
                  A new key cannot read messages encrypted with the old key. Continue?
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmFresh(false)}
                    disabled={busy}
                    className={`flex-1 rounded-lg border px-2 py-2 font-semibold ${isLight ? 'border-red-200' : 'border-red-900/60'}`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleFresh}
                    disabled={busy}
                    className="flex-1 rounded-lg bg-red-600 px-2 py-2 font-bold text-white disabled:opacity-60"
                  >
                    Start fresh
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmFresh(true)}
                disabled={busy}
                className={`w-full text-center text-xs font-semibold underline-offset-2 hover:underline ${
                  isLight ? 'text-slate-500' : 'text-zinc-500'
                }`}
              >
                Forgot PIN? Use a new key instead
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
