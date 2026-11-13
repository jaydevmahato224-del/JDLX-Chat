import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, KeyRound, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useChatStore } from '../store/useChatStore'

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
  } = useChatStore()

  const uid = chatUser?.id
  const isLight = resolvedChatTheme === 'light'
  const [mode, setMode] = useState(null)
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmFresh, setConfirmFresh] = useState(false)
  const handledNonceRef = useRef(0)

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
    setBusy(true)
    const result = await unlockWithRecoveryPin(cleanPin)
    setBusy(false)
    if (!result?.success) {
      setError(result?.error || 'Could not unlock your chats.')
      return
    }
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

  const fieldClass = `w-full rounded-xl border px-3 py-2.5 text-sm outline-none transition ${
    isLight
      ? 'border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-yellow-500'
      : 'border-zinc-700 bg-zinc-900 text-white placeholder:text-zinc-500 focus:border-yellow-500'
  }`

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        className={`w-full max-w-sm rounded-2xl border p-5 shadow-2xl ${
          isLight ? 'border-slate-200 bg-white text-slate-900' : 'border-zinc-800 bg-[#111113] text-white'
        }`}
      >
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow-500/15 text-yellow-500">
            {mode === 'unlock' ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </div>
          <div>
            <h2 className="text-base font-bold">
              {mode === 'unlock' ? 'Unlock your chats' : 'Protect your chat backup'}
            </h2>
            <p className={`text-xs ${isLight ? 'text-slate-500' : 'text-zinc-400'}`}>
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
              placeholder="Recovery PIN (min 6 characters)"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={busy}
            />
            <input
              className={fieldClass}
              type="password"
              autoComplete="new-password"
              placeholder="Confirm Recovery PIN"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              disabled={busy}
            />
            {error && <p className="text-xs font-semibold text-red-500">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleLater}
                disabled={busy}
                className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-semibold ${
                  isLight ? 'border-slate-200 text-slate-600' : 'border-zinc-700 text-zinc-300'
                }`}
              >
                Later
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-yellow-500 px-3 py-2.5 text-sm font-bold text-black disabled:opacity-60"
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
              placeholder="Recovery PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={busy}
              autoFocus
            />
            {error && <p className="text-xs font-semibold text-red-500">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-500 px-3 py-2.5 text-sm font-bold text-black disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Unlock chats
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
