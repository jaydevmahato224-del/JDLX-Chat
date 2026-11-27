import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  MessageSquare,
  Shield,
  Lock,
  ArrowRight,
  AlertCircle,
  AtSign,
  User,
  X,
  Smartphone,
  Eye,
  EyeOff,
  Sparkles,
  Sun,
  Moon,
  Monitor,
  Mail,
  CheckCircle,
  XCircle,
  UserPlus,
  Users,
  LogIn,
  Loader2,
  ExternalLink,
  Download
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../store/useChatStore'
import { API_BASE_URL, resolveMediaUrl, isCapacitorNative } from '../config'
import { apiFetch } from '../utils/apiFetch'
import { useScreenProtection } from '../utils/screenProtection'
import toast from 'react-hot-toast'

const OAUTH_VERIFIER_KEY = 'jdlx_chat_oauth_verifier'
const OAUTH_WEB_VERIFIER_KEY = 'jdlx_chat_oauth_web_verifier'

function base64Url(bytes) {
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function createPkcePair() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

async function exchangeOAuthHandoff(code, verifier) {
  const res = await apiFetch('/chat/auth/exchange-handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, verifier })
  })
  const json = await res.json()
  if (!res.ok || !json.success) {
    throw new Error(json.message || 'Could not complete Google sign-in.')
  }
  return json.data
}

function parseGoogleTicket(ticket) {
  try {
    const part = String(ticket || '').split('.')[1] || ''
    const padded = part.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '=')
    return JSON.parse(decodeURIComponent(escape(atob(padded))))
  } catch {
    return null
  }
}

// Password strength evaluator (0 to 4 score)
function getPasswordStrength(password) {
  if (!password) return { score: 0, label: '', color: '', textColor: '', hint: '' }
  let score = 0
  if (password.length >= 6) score += 1
  if (password.length >= 8) score += 1
  if (/[0-9]/.test(password) && /[a-zA-Z]/.test(password)) score += 1
  if (/[^a-zA-Z0-9]/.test(password)) score += 1

  if (score <= 1) {
    return {
      score: 1,
      label: 'Weak',
      color: 'bg-rose-500',
      textColor: 'text-rose-500',
      hint: 'Too weak — use 8+ chars with an uppercase, a lowercase & a number'
    }
  }
  if (score === 2) {
    return {
      score: 2,
      label: 'Fair',
      color: 'bg-amber-500',
      textColor: 'text-amber-500',
      hint: 'Almost! Include an uppercase, a lowercase and a number'
    }
  }
  if (score === 3) {
    return {
      score: 3,
      label: 'Good',
      color: 'bg-emerald-500',
      textColor: 'text-emerald-500',
      hint: 'Good password! Meets security standards'
    }
  }
  return {
    score: 4,
    label: 'Strong',
    color: 'bg-emerald-400',
    textColor: 'text-emerald-400',
    hint: 'Excellent! High-entropy cryptographic strength'
  }
}

// Hard requirement enforced on submit (mirrors the backend policy): 8+
// characters with at least one uppercase letter, one lowercase letter and one
// number. Returns an error message, or null when the password qualifies.
function getPasswordPolicyError(password) {
  const pw = password || ''
  if (pw.length < 8) return 'Password must be at least 8 characters long.'
  if (!/[A-Z]/.test(pw)) return 'Password must include at least one uppercase letter.'
  if (!/[a-z]/.test(pw)) return 'Password must include at least one lowercase letter.'
  if (!/[0-9]/.test(pw)) return 'Password must include at least one number.'
  return null
}

function formatIndianPhone(value) {
  const digits = (value || '').replace(/\D/g, '').slice(0, 10)
  if (digits.length > 5) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`
  }
  return digits
}

function getIdentifierType(value) {
  const clean = (value || '').trim()
  if (!clean) return null
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) return { label: 'Email', color: 'text-sky-500' }
  const phoneDigits = clean.replace(/\D/g, '')
  if (phoneDigits.length === 10 && /^[6-9]/.test(phoneDigits)) return { label: 'Mobile (India)', color: 'text-emerald-500' }
  if (clean.startsWith('@') || /^[a-zA-Z0-9_]{3,}$/.test(clean)) return { label: 'Username', color: 'text-amber-500' }
  return null
}

const GoogleIcon = () => (
  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 4.53 2.18 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
)

export default function ChatLogin() {
  const navigate = useNavigate()

  // Login screen is part of the protected surface too (blank capture shield).
  useScreenProtection('login', true)

  // Warm the chat bundle while the user is still on the login screen so the
  // post-login transition does not wait on the lazy route download. Runs idle,
  // fails silently, and the route's own import() stays the source of truth.
  useEffect(() => {
    const timer = setTimeout(() => {
      import('./ChatConversation.jsx').catch(() => {})
    }, 1500)
    return () => clearTimeout(timer)
  }, [])

  const {
    chatToken,
    chatUser,
    chatTheme,
    resolvedChatTheme,
    officialChatLogo,
    officialChatName,
    fetchChatBranding,
    toggleChatTheme,
    loginWithPassword,
    registerWithPassword,
    checkUsernameAvailability,
    completeGoogleSignup,
    setChatAuth,
    loading
  } = useChatStore(useShallow((state) => state))

  useEffect(() => {
    fetchChatBranding()
  }, [fetchChatBranding])

  // Invite deep link: /chat/login?ref=@username. Keep the handle across the
  // login/registration (and OAuth redirect) so ChatConversation can open the
  // inviter's direct chat once the user is authenticated.
  const [inviteRef, setInviteRef] = useState('')
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const ref = (params.get('ref') || params.get('invite') || '')
        .trim()
        .replace(/^@+/, '')
        .slice(0, 40)
      if (ref.length < 3) return
      localStorage.setItem('jdlx_chat_pending_invite', ref)
      setInviteRef(ref)
    } catch {
      // Ignore storage/URL parsing failures; normal login still works.
    }
  }, [])

  // Already signed in and an invite link was opened: go straight to chat,
  // where the pending invite is consumed.
  useEffect(() => {
    if (inviteRef && chatToken) navigate('/chat', { replace: true })
  }, [inviteRef, chatToken, navigate])

  const isLight = resolvedChatTheme === 'light'
  const chatBrandName = officialChatName || 'JDLX Chat'
  const themeLabel = chatTheme === 'system' ? 'System' : chatTheme === 'light' ? 'Light' : 'Dark'

  // Tab mode: 'signin' | 'register' (default: 'signin')
  const [authMode, setAuthMode] = useState('signin')
  const [errorMsg, setErrorMsg] = useState('')
  const cardRef = useRef(null)
  const errorRef = useRef(null)
  const authModeMountedRef = useRef(false)

  // A validation error must never render above the user's current scroll
  // position on the long registration form. Bring it into view when it appears.
  useEffect(() => {
    if (!errorMsg) return
    errorRef.current?.scrollIntoView({ block: 'center' })
  }, [errorMsg])

  // Switching between Sign in and Create account should show the new form from
  // the top instead of preserving the previous form's scroll offset.
  useEffect(() => {
    if (!authModeMountedRef.current) {
      authModeMountedRef.current = true
      return
    }
    cardRef.current?.scrollIntoView({ block: 'start' })
  }, [authMode])

  // Sign In Form States
  const [loginIdentifier, setLoginIdentifier] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)

  // Registration Form States
  const [regFullName, setRegFullName] = useState('')
  const [regUsername, setRegUsername] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPhone, setRegPhone] = useState('')
  const [regGender, setRegGender] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [showRegPassword, setShowRegPassword] = useState(false)
  // Set when the backend redirects a verified Google identity that has no
  // completed chat profile yet. No account exists until this form is sent.
  const [googleSignupTicket, setGoogleSignupTicket] = useState('')
  // React StrictMode replays mount effects; a handoff code is single-use, so
  // make sure only the first invocation attempts the exchange.
  const oauthHandoffHandledRef = useRef(false)

  // Derived inputs: Password strength & Login identifier detection
  const pwStrength = getPasswordStrength(regPassword)
  const detectedLoginType = getIdentifierType(loginIdentifier)

  const handlePhoneChange = (e) => {
    setErrorMsg('')
    let digits = e.target.value.replace(/\D/g, '')
    // Indian mobile numbers never start with 0, but people habitually dial
    // "0" before the number: "09102852964" used to be sliced to the FIRST 10
    // digits, storing a wrong number. Strip the prefix instead of truncating.
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '')
    if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(2)
    setRegPhone(digits.slice(0, 10))
  }

  // Real-time username check state
  const [usernameStatus, setUsernameStatus] = useState({
    checking: false,
    available: null,
    message: ''
  })
  const debounceTimerRef = useRef(null)
  // Monotonic id for availability checks: a slow response for an older handle
  // must never overwrite the status of the handle currently in the input.
  const usernameCheckSeqRef = useRef(0)

  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    usernameCheckSeqRef.current += 1
  }, [])

  // 1. Consume Google OAuth redirect parameters if returning from Google
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const codeParam = params.get('code')
      const tokenParam = params.get('token')
      const userParam = params.get('user')
      const refreshParam = params.get('refresh')
      const errorParam = params.get('error')
      const googleSignupParam = params.get('google_signup')

      if (googleSignupParam) {
        let ticketPayload = null
        try {
          const part = googleSignupParam.split('.')[1] || ''
          const padded = part.replace(/-/g, '+').replace(/_/g, '/')
            .padEnd(Math.ceil(part.length / 4) * 4, '=')
          ticketPayload = JSON.parse(decodeURIComponent(escape(atob(padded))))
        } catch (e) {
          console.warn('Could not read Google sign-up ticket:', e)
        }
        setGoogleSignupTicket(googleSignupParam)
        setAuthMode('register')
        setRegFullName(ticketPayload?.name || '')
        setRegEmail(ticketPayload?.email || '')
        window.history.replaceState({}, document.title, window.location.pathname)
        return
      }

      if (codeParam) {
        if (oauthHandoffHandledRef.current) return
        oauthHandoffHandledRef.current = true

        let verifier = ''
        try {
          verifier = sessionStorage.getItem(OAUTH_WEB_VERIFIER_KEY) || ''
        } catch {}
        window.history.replaceState({}, document.title, window.location.pathname)

        // A missing verifier is fine for challenge-less codes (stale-page
        // rollout path): the backend enforces the PKCE binding for codes that
        // were issued with one, so nothing is weakened by attempting anyway.
        exchangeOAuthHandoff(codeParam, verifier)
          .then((data) => {
            try {
              sessionStorage.removeItem(OAUTH_WEB_VERIFIER_KEY)
            } catch {}
            setChatAuth(data.chat_token, data.user, null, data.refresh_token)
            toast.success(`Welcome to ${chatBrandName}, ${data.user?.name || 'User'}!`, { icon: '💬' })
            navigate('/chat', { replace: true })
          })
          .catch((e) => {
            setErrorMsg(e.message || 'Could not complete Google sign-in. Please try again.')
          })
        return
      }

      // Legacy callback link: kept only so a frontend deployed ahead of the
      // backend does not lose sign-in during a rolling release. New callbacks
      // return a one-time code, never a session token in the URL.
      if (tokenParam && userParam) {
        let parsedUser = null
        try {
          parsedUser = JSON.parse(userParam)
        } catch {
          try {
            parsedUser = JSON.parse(decodeURIComponent(userParam))
          } catch (e) {
            console.error('Failed to parse userParam:', e)
          }
        }
        if (parsedUser) {
          setChatAuth(tokenParam, parsedUser, null, refreshParam || null)
          window.history.replaceState({}, document.title, window.location.pathname)
          toast.success(`Welcome to ${chatBrandName}, ${parsedUser.name || 'User'}!`, { icon: '💬' })
          navigate('/chat', { replace: true })
          return
        }
      }

      if (errorParam === 'account_locked') {
        Promise.resolve().then(() => setErrorMsg('This account is temporarily locked. Please try again later.'))
      } else if (errorParam === 'google_failed') {
        Promise.resolve().then(() => setErrorMsg('Google login failed. Please try again.'))
      } else if (errorParam) {
        Promise.resolve().then(() => setErrorMsg('Google login failed or was cancelled. Please try again.'))
      }
    } catch (e) {
      console.warn('OAuth callback parse error in ChatLogin:', e)
    }
  }, [navigate, setChatAuth, chatBrandName])

  // 1b. Native Google OAuth returns from a Chrome Custom Tab through
  // `jdlxchat://auth?code=...` (code only, never the session token).
  useEffect(() => {
    if (!isCapacitorNative()) return undefined
    let listener = null
    let active = true
    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        const handleUrl = async ({ url }) => {
          let parsed
          try {
            parsed = new URL(url)
          } catch {
            return
          }
          if (parsed.protocol !== 'jdlxchat:' || parsed.hostname !== 'auth') return
          try {
            const { Browser } = await import('@capacitor/browser')
            await Browser.close()
          } catch {
            /* tab may already be closed */
          }

          const code = parsed.searchParams.get('code')
          const ticket = parsed.searchParams.get('google_signup')
          const error = parsed.searchParams.get('error')

          if (error) {
            setErrorMsg('Google login failed or was cancelled. Please try again.')
            return
          }
          if (ticket) {
            const payload = parseGoogleTicket(ticket)
            setGoogleSignupTicket(ticket)
            setAuthMode('register')
            setRegFullName(payload?.name || '')
            setRegEmail(payload?.email || '')
            setErrorMsg('')
            return
          }
          if (!code) return

          const verifier = localStorage.getItem(OAUTH_VERIFIER_KEY)
          if (!verifier) {
            setErrorMsg('Google sign-in session expired. Please try again.')
            return
          }
          try {
            const data = await exchangeOAuthHandoff(code, verifier)
            localStorage.removeItem(OAUTH_VERIFIER_KEY)
            const { chat_token, refresh_token, user } = data
            setChatAuth(chat_token, user, null, refresh_token)
            toast.success(`Welcome to ${chatBrandName}, ${user.name || 'User'}!`, { icon: '💬' })
            navigate('/chat', { replace: true })
          } catch (e) {
            setErrorMsg(e.message || 'Could not complete Google sign-in. Please try again.')
          }
        }

        // The OS may have killed the app while the Custom Tab was open.
        const launch = await App.getLaunchUrl()
        if (launch?.url) await handleUrl(launch)
        const sub = await App.addListener('appUrlOpen', handleUrl)
        if (!active) {
          sub.remove().catch(() => {})
        } else {
          listener = sub
        }
      } catch (e) {
        console.warn('Native OAuth listener failed:', e)
      }
    })()
    return () => {
      active = false
      if (listener) {
        listener.remove().catch(() => {})
      }
    }
  }, [navigate, setChatAuth, chatBrandName])

  // 2. If already authenticated in Chat, auto-redirect to active conversation
  useEffect(() => {
    if (chatToken && chatUser) {
      navigate('/chat', { replace: true })
    }
  }, [chatToken, chatUser, navigate])

  // Username live sanitizer: prevents email domain concatenations & strips emails automatically
  const handleUsernameChange = (inputVal) => {
    setErrorMsg('')
    let clean = (inputVal || '').toLowerCase()

    // If pasted an email address (e.g. jaydev@gmail.com), strip @ and everything after
    if (clean.includes('@')) {
      clean = clean.split('@')[0]
    }
    // Remove trailing email domains accidentally glued together (e.g. jaydevgmailcom or jaydev.com)
    clean = clean.replace(/(?:gmail|yahoo|outlook|hotmail|icloud|proton|rediff|zoho|aol)+(?:com|in|net|org)?$/gi, '')
    clean = clean.replace(/\.(?:com|in|net|org|co|io|app|ai)$/gi, '')
    clean = clean.replace(/[^a-z0-9_]/g, '')

    setRegUsername(clean)

    // Debounce username availability verification. Bumping the sequence here
    // also invalidates any request already in flight for the previous value.
    const requestId = ++usernameCheckSeqRef.current
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    if (!clean || clean.length < 3) {
      setUsernameStatus({ checking: false, available: null, message: '' })
      return
    }

    setUsernameStatus({ checking: true, available: null, message: 'Checking handle availability...' })

    debounceTimerRef.current = setTimeout(async () => {
      const res = await checkUsernameAvailability(clean)
      // A newer keystroke has superseded this check; drop the stale response.
      if (usernameCheckSeqRef.current !== requestId) return
      if (res && res.available) {
        setUsernameStatus({ checking: false, available: true, message: `@${clean} is available!` })
      } else if (res && res.available === false) {
        setUsernameStatus({
          checking: false,
          available: false,
          message: res.message || `@${clean} is unavailable`
        })
      } else {
        // Throttled/unreachable availability check must not block signup:
        // the server still validates the handle on submit.
        setUsernameStatus({
          checking: false,
          available: null,
          message: res?.message || 'Could not verify this handle right now — we will check it when you submit.'
        })
      }
    }, 350)
  }

  // Handle Sign In submission (Username or Mobile Number + Password)
  const handleSignInSubmit = async (e) => {
    e.preventDefault()
    setErrorMsg('')

    const cleanIdentifier = loginIdentifier.trim()
    if (!cleanIdentifier) {
      setErrorMsg('Please enter your Username or Mobile Number.')
      return
    }

    if (!loginPassword) {
      setErrorMsg('Please enter your password.')
      return
    }

    const result = await loginWithPassword(cleanIdentifier, loginPassword)
    if (result.success) {
      toast.success(`Welcome back, ${result.user?.name || 'User'}!`)
      navigate('/chat', { replace: true })
    } else {
      setErrorMsg(result.error || 'Login failed. Please check your credentials.')
    }
  }

  // Handle Registration submission
  const handleRegisterSubmit = async (e) => {
    e.preventDefault()
    setErrorMsg('')

    const cleanFullName = regFullName.trim()
    const cleanUsername = regUsername.trim()
    const cleanEmail = regEmail.trim().toLowerCase()
    const cleanPhone = regPhone.replace(/\D/g, '')

    if (!cleanFullName || cleanFullName.length < 2) {
      setErrorMsg('Full Name is mandatory so contacts can identify you.')
      return
    }

    if (!cleanUsername || cleanUsername.length < 3) {
      setErrorMsg('Username must be at least 3 characters long.')
      return
    }

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      setErrorMsg('Please enter a valid email address.')
      return
    }

    if (!cleanPhone) {
      setErrorMsg(
        googleSignupTicket
          ? 'Please enter your 10-digit mobile number to finish Google sign-up.'
          : 'Mobile number is required so your contacts can find you on chat.'
      )
      return
    }

    if (cleanPhone.length !== 10) {
      setErrorMsg('Please enter a valid 10-digit mobile number.')
      return
    }

    if (!regGender) {
      setErrorMsg('Please select your gender.')
      return
    }

    const passwordPolicyError = getPasswordPolicyError(regPassword)
    if (passwordPolicyError) {
      setErrorMsg(`${passwordPolicyError} Use 8+ characters with an uppercase letter, a lowercase letter and a number.`)
      return
    }

    if (usernameStatus.available === false) {
      setErrorMsg(usernameStatus.message || 'Please choose an available username.')
      return
    }

    const result = googleSignupTicket
      ? await completeGoogleSignup({
          ticket: googleSignupTicket,
          fullName: cleanFullName,
          username: cleanUsername,
          phone: cleanPhone,
          gender: regGender,
          password: regPassword
        })
      : await registerWithPassword({
          fullName: cleanFullName,
          username: cleanUsername,
          email: cleanEmail,
          phone: cleanPhone,
          gender: regGender,
          password: regPassword
        })

    if (result.success) {
      toast.success(googleSignupTicket
        ? `Google account ready! Welcome to ${chatBrandName}, @${cleanUsername}!`
        : `Account created! Welcome to ${chatBrandName}, @${cleanUsername}!`)
      navigate('/chat', { replace: true })
    } else {
      setErrorMsg(result.error || 'Registration failed. Please check your information.')
    }
  }

  // Login with Google — flows through backend Google OAuth for chat_users identity.
  // Inside the APK this MUST run in a Chrome Custom Tab: Google blocks embedded
  // WebViews, so the app sends a PKCE challenge and receives a one-time code.
  const handleGoogleLogin = async () => {
    setErrorMsg('')
    const backendOrigin = (API_BASE_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '')

    if (isCapacitorNative()) {
      try {
        const { verifier, challenge } = await createPkcePair()
        localStorage.setItem(OAUTH_VERIFIER_KEY, verifier)
        const returnUrl = 'jdlxchat://auth'
        const authUrl = `${backendOrigin}/login/google?flow=chat&frontend_url=${encodeURIComponent(returnUrl)}&state_challenge=${encodeURIComponent(challenge)}`
        const { Browser } = await import('@capacitor/browser')
        await Browser.open({ url: authUrl })
      } catch (e) {
        console.warn('Could not open Google sign-in:', e)
        setErrorMsg('Could not open Google sign-in. Please try again.')
      }
      return
    }

    try {
      const { verifier, challenge } = await createPkcePair()
      sessionStorage.setItem(OAUTH_WEB_VERIFIER_KEY, verifier)
      const frontendUrl = window.location.origin
      const authUrl = `${backendOrigin}/login/google?flow=chat&frontend_url=${encodeURIComponent(frontendUrl)}&state_challenge=${encodeURIComponent(challenge)}`
      window.location.href = authUrl
    } catch (e) {
      console.warn('Could not start Google sign-in:', e)
      setErrorMsg('Could not start Google sign-in. Please try again.')
    }
  }

  return (
    <div className={`login-sheet app-scroll-root w-full font-sans select-text transition-colors duration-200 ${
      isLight ? 'bg-[#f6f7f9] text-slate-900' : 'official-chat-dark dark bg-[#090a0c] text-white'
    }`}>
      {/* Full-bleed sticky top bar (no horizontal scroll gaps on mobile) */}
      <header className={`sticky top-0 z-30 w-full ios-safe-header border-b px-4 pt-[max(0.9rem,env(safe-area-inset-top))] pb-2 transition-colors duration-200 sm:px-6 ${
        isLight ? 'bg-white border-slate-200' : 'bg-[#090a0c] border-white/10'
      }`}>
        <div className="mx-auto flex w-full max-w-[440px] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={`h-9 w-9 shrink-0 overflow-hidden rounded-xl border ${isLight ? 'border-slate-200 bg-white shadow-sm' : 'border-white/10 bg-[#14171b]'}`}>
            <img src="/logo192.png" alt="" className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0">
            <p className={`truncate text-[13px] font-semibold leading-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
              {chatBrandName}
            </p>
            <p className={`mt-0.5 flex items-center gap-1 text-[10px] font-medium ${isLight ? 'text-slate-500' : 'text-zinc-500'}`}>
              <Lock className="h-2.5 w-2.5 shrink-0" />
              End-to-end encrypted
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <a
            href="https://jdlxmobile.in"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the JDLX store"
            aria-label="Open the JDLX store in a new tab"
            className={`ui-btn ui-btn-ghost h-9 min-h-0 gap-1.5 px-2.5 text-[11px] ${isLight ? 'text-slate-600' : 'text-zinc-400'}`}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">Store</span>
          </a>

          {!isCapacitorNative() && (
            <a
              href="/downloads/official-chat.apk"
              download="official-chat.apk"
              title="Download the JDLX Chat Android APK"
              aria-label="Download the JDLX Chat Android APK"
              className={`ui-btn ui-btn-ghost h-9 min-h-0 gap-1.5 px-2.5 text-[11px] ${isLight ? 'text-slate-600' : 'text-zinc-400'}`}
            >
              <Download className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">APK</span>
            </a>
          )}

          {/* Theme Switcher */}
          <button
            type="button"
            onClick={toggleChatTheme}
            title={`Theme: ${themeLabel} — click to change`}
            aria-label={`Theme: ${themeLabel}. Click to change.`}
            className={`ui-icon-btn h-9 w-9 border ${isLight ? 'border-slate-200 bg-white shadow-sm' : 'border-white/10 bg-[#14171b]'}`}
          >
            {chatTheme === 'system'
              ? <Monitor className="h-4 w-4" />
              : chatTheme === 'light'
                ? <Moon className="h-4 w-4" />
                : <Sun className="h-4 w-4 text-amber-500" />}
          </button>
        </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col px-4 sm:px-6 pb-[env(safe-area-inset-bottom)]">
      {/* Main Card */}
      <main className="flex w-full flex-1 flex-col pt-3 sm:pt-5 pb-4 sm:pb-8">
        <div ref={cardRef} className={`ui-card relative overflow-hidden p-5 transition-colors sm:p-6 w-full min-w-0 ${
          isLight
            ? 'border-slate-200/90 bg-white rounded-3xl md:rounded-2xl shadow-2xl'
            : 'border-white/[0.07] bg-[#0f1114] rounded-3xl md:rounded-2xl shadow-2xl'
        }`}>
          {/* Emblem & Branding */}
          <div className="mb-5 flex items-start gap-3.5">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border ${
              isLight ? 'border-slate-200 bg-white shadow-sm' : 'border-white/10 bg-[#14171b]'
            }`}>
              <img
                src="/logo192.png"
                alt={chatBrandName || "JDLX Chat"}
                className="h-full w-full object-contain"
              />
            </div>
            <div className="min-w-0 pt-0.5">
              <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                isLight ? 'text-amber-700' : 'text-amber-400'
              }`}>
                <Shield className="h-3 w-3" />
                <span>Secure access</span>
              </div>
              <h1 className={`text-[22px] font-semibold leading-tight tracking-tight ${
                isLight ? 'text-slate-900' : 'text-white'
              }`}>
                {authMode === 'signin'
                  ? 'Welcome back'
                  : googleSignupTicket ? 'Finish Google sign-up' : 'Create your account'}
              </h1>
            </div>
          </div>
          <p className={`mb-5 text-[12.5px] leading-relaxed ${
            isLight ? 'text-slate-600' : 'text-zinc-400'
          }`}>
            {authMode === 'signin'
              ? 'Sign in with your username, email or mobile number to continue to your private chats.'
              : googleSignupTicket
                ? 'Google verified your email. Add the details your friends will see.'
                : 'Create your handle with your email and mobile number so friends can find you.'}
          </p>

          {inviteRef && (
            <div className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-medium leading-snug ${
              isLight
                ? 'border-amber-200 bg-amber-50/70 text-amber-900'
                : 'border-amber-500/20 bg-amber-500/[0.07] text-amber-200'
            }`}>
              <UserPlus className="h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">
                Invited by <strong className="font-semibold">@{inviteRef}</strong>. Sign in or create an account to connect.
              </span>
            </div>
          )}

          {/* Mode Switcher */}
          <div className={`mb-4 grid grid-cols-2 gap-1 rounded-xl p-1 ${
            isLight ? 'bg-slate-100' : 'bg-white/[0.05]'
          }`}>
            <button
              type="button"
              onClick={() => { setAuthMode('signin'); setErrorMsg('') }}
              aria-pressed={authMode === 'signin'}
              className={`flex flex-1 cursor-pointer touch-manipulation items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-all ${
                authMode === 'signin'
                  ? isLight
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'bg-[#23262c] text-white shadow-sm'
                  : isLight ? 'text-slate-600 hover:text-slate-900' : 'text-zinc-400 hover:text-white'
              }`}
            >
              <LogIn className="h-3.5 w-3.5" />
              <span>Sign in</span>
            </button>
            <button
              type="button"
              onClick={() => { setAuthMode('register'); setErrorMsg('') }}
              aria-pressed={authMode === 'register'}
              className={`flex flex-1 cursor-pointer touch-manipulation items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-all ${
                authMode === 'register'
                  ? isLight
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'bg-[#23262c] text-white shadow-sm'
                  : isLight ? 'text-slate-600 hover:text-slate-900' : 'text-zinc-400 hover:text-white'
              }`}
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>Create account</span>
            </button>
          </div>

          {/* Error Message Box */}
          {errorMsg && (
            <div
              ref={errorRef}
              role="alert"
              className={`mb-3 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-xs font-medium animate-shake ${
                isLight
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : 'border-rose-500/25 bg-rose-500/10 text-rose-300'
              }`}
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words leading-snug">{errorMsg}</span>
            </div>
          )}

          {/* TAB 1: SIGN IN FORM */}
          {authMode === 'signin' && (
            <form onSubmit={handleSignInSubmit} className="space-y-3">
              {/* Identifier Input (Username, Email or Mobile) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="field-label flex items-center gap-1.5">
                    <User className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                    <span>Username, Email or Mobile</span>
                    <span className="text-amber-500 font-black">*</span>
                  </label>
                  {detectedLoginType && (
                    <span className={`text-[10px] font-bold ${detectedLoginType.color} flex items-center gap-1 animate-fade-in`}>
                      <CheckCircle className="w-3 h-3" />
                      <span>{detectedLoginType.label}</span>
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="username"
                  aria-label="Username, email address or mobile number"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  placeholder="@username, email or 10-digit mobile"
                  value={loginIdentifier}
                  onChange={(e) => setLoginIdentifier(e.target.value)}
                  className="ui-input text-base sm:text-sm"
                  required
                />
              </div>

              {/* Password Input */}
              <div className="space-y-1">
                <label className="field-label flex items-center gap-1.5">
                  <Lock className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Password</span>
                  <span className="text-amber-500 font-black">*</span>
                </label>
                <div className="relative flex items-center">
                  <input
                    type={showLoginPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    aria-label="Password"
                    placeholder="Enter your password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    className="ui-input pr-10 text-base sm:text-sm"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword(!showLoginPassword)}
                    aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                    className={`absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg transition-colors ${
                      isLight ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                    title={showLoginPassword ? 'Hide password' : 'Show password'}
                  >
                    {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Sign In Submit Button */}
              <button
                type="submit"
                disabled={loading}
                className="ui-btn ui-btn-primary mt-1 w-full touch-manipulation"
              >
                {loading ? (
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#171204]/30 border-t-[#171204]"></div>
                ) : (
                  <>
                    <span>Sign in to {chatBrandName}</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>

              {/* Switch to Register link */}
              <div className="text-center pt-0.5">
                <button
                  type="button"
                  onClick={() => { setAuthMode('register'); setErrorMsg('') }}
                  className={`text-xs font-medium underline-offset-4 transition-colors hover:underline ${
                    isLight ? 'text-slate-600 hover:text-slate-900' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  New to {chatBrandName}? Create an account →
                </button>
              </div>
            </form>
          )}

          {/* TAB 2: CREATE ACCOUNT FORM */}
          {authMode === 'register' && (
            <form onSubmit={handleRegisterSubmit} className="space-y-2.5">
              {/* Google verified the identity; the chat account itself is
                  created only when this form is submitted. */}
              {googleSignupTicket && (
                <div className={`rounded-xl border p-3 text-[11px] font-medium leading-snug ${
                  isLight
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
                }`}>
                  Google account verified. Choose your username, password, mobile number and gender to create your Chat id.
                </div>
              )}

              {/* 1. Full Name */}
              <div className="space-y-1">
                <label className="field-label flex items-center gap-1.5">
                  <User className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Full Name</span>
                  <span className="text-amber-500 font-black">*</span>
                </label>
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="name"
                  aria-label="Full name"
                  autoCapitalize="words"
                  autoCorrect="off"
                  placeholder="e.g. Jaydev Mahato"
                  value={regFullName}
                  onChange={(e) => setRegFullName(e.target.value)}
                  className="ui-input text-base sm:text-sm"
                  required
                />
              </div>

              {/* 2. Username (@handle) — Auto-sanitized, No email domain */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="field-label flex items-center gap-1.5">
                    <AtSign className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                    <span>Unique Handle</span>
                    <span className="text-amber-500 font-black">*</span>
                  </label>
                  <span className={`text-[10px] ${isLight ? 'text-slate-400' : 'text-zinc-400'}`}>
                    No email domains
                  </span>
                </div>
                <div className="relative flex items-center">
                  <span className={`absolute left-3.5 font-black text-sm ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`}>@</span>
                  <input
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    aria-label="Unique username handle"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck="false"
                    placeholder="choose_handle"
                    value={regUsername}
                    onChange={(e) => handleUsernameChange(e.target.value)}
                    className="ui-input pl-8 pr-10 font-mono text-base sm:text-sm"
                    required
                  />
                  <div className="absolute right-3 flex items-center">
                    {usernameStatus.checking && (
                      <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
                    )}
                    {!usernameStatus.checking && usernameStatus.available === true && (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    )}
                    {!usernameStatus.checking && usernameStatus.available === false && (
                      <XCircle className="w-4 h-4 text-rose-500" />
                    )}
                  </div>
                </div>

                {/* Real-time username feedback message */}
                {usernameStatus.message && (
                  <p aria-live="polite" className={`text-[11px] font-medium transition-all ${
                    usernameStatus.available === true
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : usernameStatus.available === false
                        ? 'text-rose-500'
                        : isLight ? 'text-slate-500' : 'text-zinc-400'
                  }`}>
                    {usernameStatus.message}
                  </p>
                )}
              </div>

              {/* 3. Email Address (primary sign-in identity) */}
              <div className="space-y-1">
                <label className="field-label flex items-center gap-1.5">
                  <Mail className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Email Address</span>
                  <span className="text-amber-500 font-black">*</span>
                </label>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  aria-label="Email address"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck="false"
                  placeholder="you@example.com"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  readOnly={Boolean(googleSignupTicket)}
                  className={`ui-input text-base sm:text-sm ${googleSignupTicket ? 'cursor-not-allowed opacity-70' : ''}`}
                  required
                />
              </div>

              {/* 4. Mobile Number (Dedicated Indian Mobile Component) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="field-label flex items-center gap-1.5">
                    <Smartphone className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                    <span>Mobile Number</span>
                    <span className="text-amber-500 font-black">*</span>
                  </label>
                  {regPhone.length === 10 && (
                    <span className="text-[10px] font-bold text-emerald-500 flex items-center gap-1 animate-fade-in">
                      <CheckCircle className="w-3 h-3" />
                      <span>Valid 10-digit</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className={`flex shrink-0 select-none items-center gap-1.5 rounded-[14px] border px-2.5 py-2.5 ${
                    isLight
                      ? 'border-slate-200 bg-slate-50 text-slate-800'
                      : 'border-white/10 bg-[#14171b] text-zinc-200'
                  }`}>
                    <span className="text-sm leading-none" role="img" aria-label="India flag">🇮🇳</span>
                    <span className={`text-xs font-black ${isLight ? 'text-amber-700' : 'text-[#facc15]'}`}>+91</span>
                  </div>
                  <div className="relative flex-1 flex items-center">
                    <input
                      type="tel"
                      inputMode="numeric"
                      pattern="[0-9 ]*"
                      title="Enter a 10-digit Indian mobile number"
                      aria-label="Indian mobile number"
                      autoComplete="tel-national"
                      maxLength={11}
                      placeholder="98765 43210"
                      value={formatIndianPhone(regPhone)}
                      onChange={handlePhoneChange}
                      required
                      className={`ui-input tracking-wide text-base sm:text-sm ${
                        regPhone.length === 10 ? 'border-emerald-500/60 focus:border-emerald-500' : ''
                      }`}
                    />
                    {regPhone.length === 10 && (
                      <CheckCircle className="absolute right-3 w-4 h-4 text-emerald-500 animate-fade-in pointer-events-none" />
                    )}
                  </div>
                </div>
                <p className={`text-[10px] ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                  Indian standard 10-digit mobile number (e.g. 98765 43210)
                </p>
              </div>

              {/* 5. Gender */}
              <div className="space-y-1">
                <label className="field-label flex items-center gap-1.5">
                  <Users className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Gender</span>
                  <span className="text-amber-500 font-black">*</span>
                </label>
                <select
                  value={regGender}
                  onChange={(e) => setRegGender(e.target.value)}
                  aria-label="Gender"
                  className="ui-input ui-select text-base sm:text-sm"
                  required
                >
                  <option value="">Select gender</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                  <option value="prefer_not_to_say">Prefer not to say</option>
                </select>
              </div>

              {/* 6. Set Password */}
              <div className="space-y-1">
                <label className="field-label flex items-center gap-1.5">
                  <Lock className={`w-3.5 h-3.5 ${isLight ? 'text-amber-600' : 'text-[#facc15]'}`} />
                  <span>Create Password</span>
                  <span className="text-amber-500 font-black">*</span>
                </label>
                <div className="relative flex items-center">
                  <input
                    type={showRegPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    aria-label="Create password"
                    placeholder="Min 8 characters (A-Z, a-z, 0-9)"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    className="ui-input pr-10 text-base sm:text-sm"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegPassword(!showRegPassword)}
                    aria-label={showRegPassword ? 'Hide password' : 'Show password'}
                    className={`absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg transition-colors ${
                      isLight ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                    title={showRegPassword ? 'Hide password' : 'Show password'}
                  >
                    {showRegPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className={`text-[10px] ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                  Use 8+ characters with an uppercase letter, a lowercase letter and a number.
                </p>

                {/* Password Strength Meter (Dynamic Segmented Bar) */}
                {regPassword.length > 0 && (
                  <div className="space-y-1 pt-1 animate-fade-in">
                    <div className="flex items-center justify-between text-[10px] font-bold">
                      <span className={isLight ? 'text-slate-500' : 'text-zinc-400'}>
                        Password strength
                      </span>
                      <span className={`font-semibold ${pwStrength.textColor}`}>
                        {pwStrength.label}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5 h-1.5">
                      {[1, 2, 3, 4].map((step) => (
                        <div
                          key={step}
                          className={`h-full rounded-full transition-all duration-300 ${
                            step <= pwStrength.score
                              ? pwStrength.color
                              : isLight ? 'bg-slate-200' : 'bg-zinc-800'
                          }`}
                        />
                      ))}
                    </div>
                    <p className={`text-[10px] ${isLight ? 'text-slate-400' : 'text-zinc-500'}`}>
                      {pwStrength.hint}
                    </p>
                  </div>
                )}
              </div>

              {googleSignupTicket && (
                <button
                  type="button"
                  onClick={() => {
                    setGoogleSignupTicket('')
                    setRegEmail('')
                    setAuthMode('signin')
                    setErrorMsg('')
                  }}
                  className={`w-full text-[11px] font-medium hover:underline ${
                    isLight ? 'text-slate-500' : 'text-zinc-400'
                  }`}
                >
                  Cancel and use a different sign-in method
                </button>
              )}

              {/* Register Submit Button */}
              <button
                type="submit"
                disabled={loading}
                className="ui-btn ui-btn-primary mt-1 w-full touch-manipulation"
              >
                {loading ? (
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#171204]/30 border-t-[#171204]"></div>
                ) : (
                  <>
                    <span>Create account &amp; enter chat</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>

              {/* Switch to Sign In link */}
              <div className="text-center pt-0.5">
                <button
                  type="button"
                  onClick={() => { setAuthMode('signin'); setErrorMsg('') }}
                  className={`text-xs font-medium underline-offset-4 transition-colors hover:underline ${
                    isLight ? 'text-slate-600 hover:text-slate-900' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Already have an account? Sign in →
                </button>
              </div>
            </form>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3 py-3">
            <div className={`h-px flex-1 ${isLight ? 'bg-slate-200' : 'bg-white/[0.08]'}`}></div>
            <span className={`text-[10px] font-medium uppercase tracking-[0.12em] ${
              isLight ? 'text-slate-400' : 'text-zinc-500'
            }`}>
              or
            </span>
            <div className={`h-px flex-1 ${isLight ? 'bg-slate-200' : 'bg-white/[0.08]'}`}></div>
          </div>

          {/* Login with Google — creates/uses chat-only identity */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="ui-btn ui-btn-secondary w-full touch-manipulation gap-3"
          >
            <GoogleIcon />
            <span>Continue with Google</span>
          </button>

          {/* Security & Notification Isolation Guarantee */}
          <div className={`mt-5 space-y-2 border-t pt-4 ${isLight ? 'border-slate-200' : 'border-white/[0.07]'}`}>
            <div className={`flex items-start gap-2 text-[11px] leading-relaxed ${
              isLight ? 'text-slate-600' : 'text-zinc-400'
            }`}>
              <Lock className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isLight ? 'text-amber-700' : 'text-amber-400'}`} />
              <span>
                <strong className={`font-semibold ${isLight ? 'text-slate-900' : 'text-zinc-200'}`}>Isolated account.</strong>{' '}
                Sign in anytime with your username, email or mobile number and password.
              </span>
            </div>
            <div className={`flex items-center gap-2 text-[10px] font-medium ${
              isLight ? 'text-slate-500' : 'text-zinc-500'
            }`}>
              <CheckCircle className={`h-3.5 w-3.5 shrink-0 ${isLight ? 'text-emerald-600' : 'text-emerald-500'}`} />
              <span>Encrypted messaging · Private and secure</span>
            </div>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className={`py-3 pb-[max(0.9rem,env(safe-area-inset-bottom,0px))] text-center text-[10px] font-medium ${
        isLight ? 'text-slate-500' : 'text-zinc-500'
      }`}>
        {chatBrandName} · Private standalone messenger
      </footer>
      </div>
    </div>
  )
}
