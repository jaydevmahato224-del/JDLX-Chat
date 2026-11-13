/**
 * Message encryption for Official Chat.
 *
 * v2 (current, TRUE end-to-end encryption for direct chats):
 *   Each device generates a P-256 ECDH identity keypair. The private key stays
 *   in local storage/IndexedDB; only the public key is uploaded. For recovery
 *   on another device, the key may be uploaded as a PIN-encrypted blob that
 *   the server cannot decrypt.
 *   Both participants derive the same AES-256-GCM room key from
 *   ECDH(my private, peer public) -> HKDF-SHA256. The server only ever sees
 *   public keys and ciphertext, so it cannot read DM contents.
 *   Envelope: enc:v2:<iv_hex>:<ciphertext_hex>
 *
 * v1 (legacy, NOT end-to-end): the server generates the room secret and hands
 *   it to both participants, so the server can decrypt. Old messages stay
 *   readable through decryptChatMessage(); new direct messages use v2.
 *
 * Limitation worth knowing: the server distributes public keys, so without an
 * out-of-band fingerprint comparison a malicious server could substitute a
 * key (MITM). Key verification UI is not implemented yet.
 */

const KEY_CACHE = new Map()
let V2_KEY_CACHE = new WeakMap()
const IDENTITY_DB = 'jdlx-chat-e2ee'
const IDENTITY_STORE = 'identity'
const LOCAL_STORAGE_KEY_PREFIX = 'jdlx_chat_e2ee_jwk_'
const inMemoryIdentities = new Map()

/**
 * Web Crypto across browser and non-browser (tests) environments.
 */
function getCrypto() {
  if (typeof window !== 'undefined' && window.crypto?.subtle) return window.crypto
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) return globalThis.crypto
  return null
}

/**
 * Convert a hex string to Uint8Array
 */
function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array(0)
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}

/**
 * Convert Uint8Array to a hex string
 */
function bytesToHex(bytes) {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(value) {
  if (typeof atob === 'function') {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(value, 'base64'))
}

/**
 * Derives a deterministic 256-bit AES-GCM CryptoKey for the specific room.
 * Combines roomSecret and roomId with SHA-256 HKDF/Digest. LEGACY (v1) only:
 * the server knows roomSecret, so this is not end-to-end encryption.
 */
export async function getRoomKey(roomSecret, roomId) {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    return null
  }
  // No predictable fallback key: without the room secret we must not pretend
  // to encrypt - a `room_<id>` seed is guessable by anyone.
  if (!roomSecret) return null
  const effectiveSecret = roomSecret
  const cacheKey = `${roomId}:${effectiveSecret}`
  if (KEY_CACHE.has(cacheKey)) {
    return KEY_CACHE.get(cacheKey)
  }

  try {
    const rawSeed = `JDLX-E2EE-v1:${roomId}:${effectiveSecret}`
    const enc = new TextEncoder()
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', enc.encode(rawSeed))
    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      hashBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    KEY_CACHE.set(cacheKey, cryptoKey)
    return cryptoKey
  } catch (err) {
    console.warn('E2EE key derivation error:', err)
    return null
  }
}

/**
 * Encrypts a message string with 256-bit AES-GCM (legacy v1).
 * Output format: enc:v1:<iv_hex>:<ciphertext_hex>
 */
export async function encryptChatMessage(plaintext, roomSecret, roomId) {
  if (!plaintext || typeof plaintext !== 'string') return plaintext
  if (typeof window === 'undefined' || !window.crypto?.subtle) return plaintext

  try {
    const key = await getRoomKey(roomSecret, roomId)
    if (!key) return plaintext

    // 12-byte cryptographically secure random IV
    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const enc = new TextEncoder()
    const encoded = enc.encode(plaintext)

    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    )

    const ivHex = bytesToHex(iv)
    const cipherHex = bytesToHex(new Uint8Array(cipherBuffer))
    return `enc:v1:${ivHex}:${cipherHex}`
  } catch (err) {
    console.warn('E2EE encryption error:', err)
    return plaintext
  }
}

/**
 * Decrypts an encrypted message string with 256-bit AES-GCM (legacy v1).
 * Transparently returns plaintext if message is unencrypted (legacy messages).
 */
export async function decryptChatMessage(rawMessage, roomSecret, roomId) {
  if (!rawMessage || typeof rawMessage !== 'string') return rawMessage
  if (!rawMessage.startsWith('enc:v1:')) return rawMessage
  if (typeof window === 'undefined' || !window.crypto?.subtle) return rawMessage

  try {
    const parts = rawMessage.split(':')
    if (parts.length !== 4) return rawMessage
    const ivHex = parts[2]
    const cipherHex = parts[3]

    const iv = hexToBytes(ivHex)
    const ciphertext = hexToBytes(cipherHex)

    const key = await getRoomKey(roomSecret, roomId)
    if (!key) return rawMessage

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    )

    const dec = new TextDecoder()
    return dec.decode(decryptedBuffer)
  } catch (err) {
    console.warn('E2EE decryption error:', err)
    return '🔒 [Encrypted Message]'
  }
}

/* ------------------------------------------------------------------ */
/* v2 - true end-to-end encryption (ECDH identity keys)                */
/* ------------------------------------------------------------------ */

function openIdentityDb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const request = indexedDB.open(IDENTITY_DB, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
          db.createObjectStore(IDENTITY_STORE, { keyPath: 'userId' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function readIdentity(userId) {
  const key = String(userId)
  if (inMemoryIdentities.has(key)) return inMemoryIdentities.get(key)

  const cryptoObj = getCrypto()
  if (!cryptoObj) return null

  // 1. Primary storage: localStorage with exported JWK (cross-origin resilient, survives all reloads)
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(`${LOCAL_STORAGE_KEY_PREFIX}${key}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.jwkPrivate && parsed?.jwkPublic && parsed?.publicKeyB64) {
          const privateKey = await cryptoObj.subtle.importKey(
            'jwk',
            parsed.jwkPrivate,
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits']
          )
          const publicKey = await cryptoObj.subtle.importKey(
            'jwk',
            parsed.jwkPublic,
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            []
          )
          const record = {
            userId: key,
            privateKey,
            publicKey,
            publicKeyB64: parsed.publicKeyB64,
            jwkPrivate: parsed.jwkPrivate,
            jwkPublic: parsed.jwkPublic
          }
          inMemoryIdentities.set(key, record)
          return record
        }
      }
    } catch (err) {
      console.warn('E2EE identity read from localStorage error:', err)
    }
  }

  // 2. Secondary storage: IndexedDB fallback
  const db = await openIdentityDb()
  if (db) {
    try {
      const stored = await new Promise((resolve) => {
        const tx = db.transaction(IDENTITY_STORE, 'readonly')
        const request = tx.objectStore(IDENTITY_STORE).get(key)
        request.onsuccess = () => resolve(request.result || null)
        request.onerror = () => resolve(null)
      })
      if (stored?.privateKey && stored?.publicKeyB64) {
        if (!stored.jwkPrivate && cryptoObj?.subtle) {
          try {
            stored.jwkPrivate = await cryptoObj.subtle.exportKey('jwk', stored.privateKey)
            stored.jwkPublic = await cryptoObj.subtle.exportKey('jwk', stored.publicKey)
            await writeIdentity(stored)
          } catch {
            /* ignore export errors if non-extractable */
          }
        }
        inMemoryIdentities.set(key, stored)
        return stored
      }
    } catch {
      /* ignore IDB lookup errors */
    }
  }

  return null
}

export async function clearIdentity(userId) {
  if (!userId) return
  const key = String(userId)
  inMemoryIdentities.delete(key)
  KEY_CACHE.clear()
  V2_KEY_CACHE = new WeakMap()

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(`${LOCAL_STORAGE_KEY_PREFIX}${key}`)
    } catch {
      /* ignore storage errors */
    }
  }

  const db = await openIdentityDb()
  if (!db) return
  try {
    await new Promise((resolve) => {
      const tx = db.transaction(IDENTITY_STORE, 'readwrite')
      tx.objectStore(IDENTITY_STORE).delete(key)
      tx.oncomplete = resolve
      tx.onerror = resolve
      tx.onabort = resolve
    })
  } catch {
    /* ignore IDB delete errors */
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

async function writeIdentity(record) {
  const key = String(record.userId)
  inMemoryIdentities.set(key, record)

  // 1. Primary write: localStorage JWK JSON
  if (typeof localStorage !== 'undefined' && record.jwkPrivate && record.jwkPublic) {
    try {
      localStorage.setItem(
        `${LOCAL_STORAGE_KEY_PREFIX}${key}`,
        JSON.stringify({
          jwkPrivate: record.jwkPrivate,
          jwkPublic: record.jwkPublic,
          publicKeyB64: record.publicKeyB64
        })
      )
    } catch (err) {
      console.warn('E2EE identity write to localStorage error:', err)
    }
  }

  // 2. Secondary write: IndexedDB
  const db = await openIdentityDb()
  if (!db) return
  try {
    await new Promise((resolve) => {
      const tx = db.transaction(IDENTITY_STORE, 'readwrite')
      tx.objectStore(IDENTITY_STORE).put(record)
      tx.oncomplete = resolve
      tx.onerror = resolve
      tx.onabort = resolve
    })
  } catch {
    /* localStorage copy already preserved */
  }
}

/**
 * Restore an identity keypair from a JSON string containing exported JWKs.
 * Used only after the user's recovery PIN decrypts their server backup
 * (Web <-> PWA <-> APK).
 */
export async function restoreIdentityFromJwkString(userId, jwkString) {
  if (!userId || !jwkString) return null
  const cryptoObj = getCrypto()
  if (!cryptoObj) return null
  try {
    const parsed = typeof jwkString === 'string' ? JSON.parse(jwkString) : jwkString
    if (parsed?.jwkPrivate && parsed?.jwkPublic && parsed?.publicKeyB64) {
      const privateKey = await cryptoObj.subtle.importKey(
        'jwk',
        parsed.jwkPrivate,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      )
      const publicKey = await cryptoObj.subtle.importKey(
        'jwk',
        parsed.jwkPublic,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
      )
      const record = {
        userId: String(userId),
        privateKey,
        publicKey,
        publicKeyB64: parsed.publicKeyB64,
        jwkPrivate: parsed.jwkPrivate,
        jwkPublic: parsed.jwkPublic
      }
      await writeIdentity(record)
      return record
    }
  } catch (err) {
    console.warn('Failed to restore identity from JWK string:', err)
  }
  return null
}

/**
 * Returns (creating + persisting on first use) this device's ECDH identity
 * keypair for a chat user. The private key only leaves the device inside a
 * PIN-encrypted recovery backup.
 */
export async function getOrCreateIdentityKeypair(userId, serverBackupJwk = null) {
  const key = String(userId || 'anonymous')
  const stored = await readIdentity(key)
  if (stored?.privateKey && stored?.publicKeyB64) return stored

  // Attempt restoring from server backup if provided
  if (serverBackupJwk) {
    const restored = await restoreIdentityFromJwkString(key, serverBackupJwk)
    if (restored?.privateKey && restored?.publicKeyB64) return restored
  }

  const cryptoObj = getCrypto()
  if (!cryptoObj) return null

  try {
    const pair = await cryptoObj.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )
    const spki = new Uint8Array(await cryptoObj.subtle.exportKey('spki', pair.publicKey))
    const jwkPrivate = await cryptoObj.subtle.exportKey('jwk', pair.privateKey)
    const jwkPublic = await cryptoObj.subtle.exportKey('jwk', pair.publicKey)
    const record = {
      userId: key,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyB64: bytesToBase64(spki),
      jwkPrivate,
      jwkPublic
    }
    await writeIdentity(record)
    return record
  } catch (err) {
    console.warn('E2EE identity key generation failed:', err)
    return null
  }
}

/**
 * Derives the shared AES-256-GCM key for a room:
 * ECDH(myPrivate, peerPublic) -> HKDF-SHA256(room). Both participants compute
 * the same key; the server never has either private key.
 */
export async function deriveRoomKeyV2(privateKey, peerPublicKeyB64, roomId) {
  const cryptoObj = getCrypto()
  const cleanPeerKey = (peerPublicKeyB64 && typeof peerPublicKeyB64 === 'string')
    ? peerPublicKeyB64.trim()
    : null
  if (!cryptoObj || !privateKey || !cleanPeerKey) return null

  let perKey = V2_KEY_CACHE.get(privateKey)
  if (!perKey) {
    perKey = new Map()
    V2_KEY_CACHE.set(privateKey, perKey)
  }
  const cacheKey = `${roomId}:${cleanPeerKey}`
  if (perKey.has(cacheKey)) return perKey.get(cacheKey)

  try {
    const peerKey = await cryptoObj.subtle.importKey(
      'spki',
      base64ToBytes(cleanPeerKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    )
    const sharedBits = await cryptoObj.subtle.deriveBits(
      { name: 'ECDH', public: peerKey },
      privateKey,
      256
    )
    const hkdfKey = await cryptoObj.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
    const enc = new TextEncoder()
    const aesKey = await cryptoObj.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: enc.encode('JDLX-E2EE-v2'),
        info: enc.encode(`room:${roomId}`)
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    perKey.set(cacheKey, aesKey)
    return aesKey
  } catch (err) {
    console.warn('E2EE v2 key agreement error:', err)
    return null
  }
}

/**
 * Encrypts a direct-chat message with the ECDH-derived room key.
 * Output: enc:v2:<iv_hex>:<ciphertext_hex>
 */
export async function encryptRoomMessageV2(plaintext, roomId, identity, peerPublicKeyB64) {
  if (!plaintext || typeof plaintext !== 'string') return plaintext
  const cryptoObj = getCrypto()
  const key = await deriveRoomKeyV2(identity?.privateKey, peerPublicKeyB64, roomId)
  if (!cryptoObj || !key) return plaintext

  try {
    const iv = cryptoObj.getRandomValues(new Uint8Array(12))
    const cipherBuffer = await cryptoObj.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    )
    return `enc:v2:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(cipherBuffer))}`
  } catch (err) {
    console.warn('E2EE v2 encryption error:', err)
    return plaintext
  }
}

/**
 * Decrypts a v2 direct-chat message. Returns a lock placeholder when the local
 * identity key or the peer key is missing (e.g. a different device), never the
 * ciphertext itself.
 */
export async function decryptRoomMessageV2(rawMessage, roomId, identity, peerPublicKeyB64) {
  if (!isV2Message(rawMessage)) return rawMessage
  const cryptoObj = getCrypto()
  const key = await deriveRoomKeyV2(identity?.privateKey, peerPublicKeyB64, roomId)
  if (!cryptoObj || !key) return '🔒 [Encrypted Message]'

  try {
    const parts = rawMessage.split(':')
    if (parts.length !== 4) return '🔒 [Encrypted Message]'
    const plainBuffer = await cryptoObj.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(parts[2]) },
      key,
      hexToBytes(parts[3])
    )
    return new TextDecoder().decode(plainBuffer)
  } catch (err) {
    console.warn('E2EE v2 decryption error:', err)
    return '🔒 [Encrypted Message]'
  }
}

/**
 * Checks if a string is encrypted with Official Chat E2EE (v1 or v2).
 */
export function isEncryptedMessage(text) {
  return typeof text === 'string' && (text.startsWith('enc:v1:') || text.startsWith('enc:v2:'))
}

export function isV2Message(text) {
  return typeof text === 'string' && text.startsWith('enc:v2:')
}

// -----------------------------------------------------------------------------
// Recovery backup: the identity JWK is encrypted with a user-chosen recovery
// PIN before it leaves the device. The PIN is never sent to the server, so a
// stored backup cannot be decrypted server-side.
// -----------------------------------------------------------------------------
const IDENTITY_BACKUP_PREFIX = 'jdlx:e2ee-backup:v1:'
const IDENTITY_BACKUP_ITERATIONS = 600000

export function isEncryptedIdentityBackup(value) {
  return typeof value === 'string' && value.startsWith(IDENTITY_BACKUP_PREFIX)
}

async function deriveIdentityBackupKey(cryptoObj, passphrase, salt, iterations) {
  const material = await cryptoObj.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return cryptoObj.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypts the identity JWK JSON with a recovery PIN. Returns an opaque string
 * safe to store on the server, or null when crypto is unavailable.
 */
export async function encryptIdentityBackup(jwkString, passphrase) {
  const cryptoObj = getCrypto()
  if (!cryptoObj || !jwkString || !passphrase) return null
  try {
    const salt = cryptoObj.getRandomValues(new Uint8Array(16))
    const iv = cryptoObj.getRandomValues(new Uint8Array(12))
    const key = await deriveIdentityBackupKey(cryptoObj, passphrase, salt, IDENTITY_BACKUP_ITERATIONS)
    const cipherBuffer = await cryptoObj.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(jwkString)
    )
    const payload = {
      v: 1,
      iterations: IDENTITY_BACKUP_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(cipherBuffer))
    }
    return IDENTITY_BACKUP_PREFIX + bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)))
  } catch (err) {
    console.warn('E2EE backup encryption failed:', err)
    return null
  }
}

/**
 * Decrypts a recovery backup with the user's PIN. Returns the JWK JSON string,
 * or null for a wrong PIN / malformed backup.
 */
export async function decryptIdentityBackup(blob, passphrase) {
  const cryptoObj = getCrypto()
  if (!cryptoObj || !isEncryptedIdentityBackup(blob) || !passphrase) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(blob.slice(IDENTITY_BACKUP_PREFIX.length))))
    const iterations = Number(payload?.iterations)
    if (!payload?.salt || !payload?.iv || !payload?.ciphertext) return null
    if (!Number.isFinite(iterations) || iterations < 10000 || iterations > 1000000) return null
    const key = await deriveIdentityBackupKey(
      cryptoObj,
      passphrase,
      base64ToBytes(payload.salt),
      iterations
    )
    const plainBuffer = await cryptoObj.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
      key,
      base64ToBytes(payload.ciphertext)
    )
    return new TextDecoder().decode(plainBuffer)
  } catch {
    return null
  }
}
