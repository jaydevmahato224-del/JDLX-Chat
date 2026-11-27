import { Capacitor, registerPlugin } from '@capacitor/core'

// Native counterpart: android/.../ContactsPlugin.java.
const Contacts = registerPlugin('Contacts')

const isNative = () => typeof window !== 'undefined' && Capacitor?.isNativePlatform?.() === true

/** Normalize any raw Indian phone input/string to canonical 10-digit mobile, or ''. */
export function normalizeIndianPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('0091') && digits.length === 14) {
    digits = digits.slice(4)
  } else if (digits.startsWith('91') && digits.length === 12) {
    digits = digits.slice(2)
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1)
  }
  return digits.length === 10 ? digits : ''
}

/** Extract a 10-digit phone ONLY if the search query looks like a phone number (not @username/text). */
export function extractSearchablePhone(query) {
  const trimmed = String(query || '').trim()
  if (!trimmed || !/^[\d+\-\s()]+$/.test(trimmed)) return ''
  return normalizeIndianPhone(trimmed)
}

export function formatIndianPhoneDisplay(phone10) {
  const clean = normalizeIndianPhone(phone10)
  if (!clean) return String(phone10 || '')
  return `+91 ${clean.slice(0, 5)} ${clean.slice(5)}`
}

export function isWebContactPickerSupported() {
  return (
    !isNative()
    && typeof navigator !== 'undefined'
    && Boolean(navigator.contacts && typeof navigator.contacts.select === 'function')
  )
}

export async function checkNativeContactsPermission() {
  if (!isNative()) {
    return { state: isWebContactPickerSupported() ? 'prompt' : 'unsupported', granted: false }
  }
  try {
    const res = await Contacts.checkPermission()
    return {
      state: res?.state || (res?.granted ? 'granted' : 'prompt'),
      granted: res?.granted === true
    }
  } catch (err) {
    console.warn('[contacts] permission check failed:', err)
    return { state: 'prompt', granted: false }
  }
}

export async function requestNativeContactsPermission() {
  if (!isNative()) {
    return { state: 'unsupported', granted: false }
  }
  try {
    const res = await Contacts.requestPermission()
    return {
      state: res?.state || (res?.granted ? 'granted' : 'denied'),
      granted: res?.granted === true
    }
  } catch (err) {
    console.warn('[contacts] permission request failed:', err)
    return { state: 'denied', granted: false }
  }
}

function dedupeNormalizedContacts(rawList) {
  const map = new Map()
  for (const item of rawList || []) {
    const rawPhone = typeof item === 'string' ? item : (item?.phone || item?.number || '')
    const phone = normalizeIndianPhone(rawPhone)
    if (!phone) continue
    const name = String(typeof item === 'object' ? (item?.name || item?.contact_name || '') : '').trim().slice(0, 120)
    if (!map.has(phone)) {
      map.set(phone, name)
    } else if (!map.get(phone) && name) {
      map.set(phone, name)
    }
  }
  return Array.from(map.entries()).map(([phone, name]) => ({ phone, name }))
}

export async function readNativeDeviceContacts() {
  if (!isNative()) {
    return { permission: 'unsupported', granted: false, contacts: [] }
  }
  const perm = await checkNativeContactsPermission()
  if (!perm.granted) {
    return { permission: perm.state, granted: false, contacts: [] }
  }
  try {
    const res = await Contacts.getContacts()
    return {
      permission: 'granted',
      granted: true,
      contacts: dedupeNormalizedContacts(res?.contacts || [])
    }
  } catch (err) {
    console.warn('[contacts] failed reading phonebook:', err)
    throw err
  }
}

export async function pickWebContacts() {
  if (!isWebContactPickerSupported()) {
    return []
  }
  const selected = await navigator.contacts.select(['name', 'tel'], { multiple: true })
  const flat = []
  for (const entry of selected || []) {
    const label = Array.isArray(entry?.name) ? (entry.name[0] || '') : (entry?.name || '')
    const tels = Array.isArray(entry?.tel) ? entry.tel : []
    for (const tel of tels) {
      flat.push({ name: label, phone: tel })
    }
  }
  return dedupeNormalizedContacts(flat)
}

export function buildInviteMessage({ recipientName = '', inviteInfo = null, chatUser = null, brandName = 'JDLX Chat' } = {}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const handle = chatUser?.username || 'member'
  const fallbackUrl = origin ? `${origin}/chat/login?ref=@${handle}` : ''
  const inviteUrl = inviteInfo?.invite_url || fallbackUrl
  const baseShareText = inviteInfo?.share_text
    || `Hey! Chat with me on ${brandName} – secure, encrypted messaging. Join using my invite link (@${handle}): ${inviteUrl}`.trim()

  const cleanRecipient = String(recipientName || '').trim()
  if (cleanRecipient && !normalizeIndianPhone(cleanRecipient)) {
    return `Hi ${cleanRecipient}, ${baseShareText}`
  }
  return baseShareText
}

export async function inviteViaSms({ phone = '', message = '' } = {}) {
  const cleanPhone = normalizeIndianPhone(phone) || String(phone || '').replace(/\D/g, '')
  if (isNative()) {
    try {
      await Contacts.openSmsInvite({ phone: cleanPhone, message })
      return true
    } catch (err) {
      console.warn('[contacts] native SMS intent failed, falling back:', err)
    }
  }

  if (typeof window !== 'undefined') {
    const encodedBody = encodeURIComponent(message || '')
    const href = `sms:${cleanPhone}?body=${encodedBody}`
    window.location.href = href
    return true
  }
  return false
}

export async function inviteViaWhatsApp({ phone = '', message = '' } = {}) {
  const clean10 = normalizeIndianPhone(phone)
  const waDigits = clean10 ? `91${clean10}` : String(phone || '').replace(/\D/g, '')

  if (isNative()) {
    try {
      await Contacts.openWhatsAppInvite({ phone: clean10 || waDigits, message })
      return true
    } catch (err) {
      console.warn('[contacts] native WhatsApp intent failed, falling back:', err)
    }
  }

  if (typeof window !== 'undefined') {
    const encoded = encodeURIComponent(message || '')
    const url = waDigits
      ? `https://wa.me/${waDigits}?text=${encoded}`
      : `https://api.whatsapp.com/send?text=${encoded}`
    window.open(url, '_blank', 'noopener,noreferrer')
    return true
  }
  return false
}
