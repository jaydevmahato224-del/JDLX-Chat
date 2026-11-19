# JDLX Chat — Standalone Official Messenger

Private, secure end-to-end encrypted messaging application. Standalone frontend and service stack, completely separated from the JDLX Storefront.

## ✨ Features
* **Zero-Knowledge End-to-End Encryption (E2EE v2):** ECDH P-256 key exchange, HKDF derivation, AES-256-GCM authenticated payload encryption.
* **Instant Messaging & Real-Time Sync:** Powered by Supabase Realtime channels with optimistic UI and delivery status ticks.
* **Luxury UI & UX:**
  * WhatsApp-style anchored floating message action menu & quick emoji reaction pills
  * Telegram / iMessage metallic wave shimmer skeleton loader & micro progress line
  * Dynamic Island & iOS notch safe headers with responsive zero-jitter viewport docking
* **Rich Media Support:** High-resolution photo sharing, voice notes with interactive 26-bar waveform scrubbers & 1x/1.5x/2x speed controls, documents, and videos.
* **Android Native App:** Capacitor-powered native Android app project included with push notification support.
* **Progressive Web App (PWA):** Offline capability, modern app manifest, maskable adaptive icons, and instant service worker caching.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Development Server
```bash
npm run dev
```

### 3. Production Build
```bash
npm run build
```

### 4. Build Android APK
```bash
npm run android:sync
npm run android:apk
```

## 🌐 API & Backend Connection
* Default backend: `https://jdlx-chat-production.up.railway.app/api` (configurable via `VITE_CHAT_API_BASE_URL` in `.env`).
* Standalone backend files & Dockerfile available under `backend/`.
