import os
import base64
import hashlib
import hmac
import json
import time
import datetime
import hashlib
import secrets
import logging
import re
import threading
import urllib.request
from functools import wraps
from urllib.parse import urlparse
from flask import Blueprint, request, jsonify, current_app, send_file, redirect, g
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import jwt

from database import get_db, is_transient_db_error
from jwt_config import get_jwt_secret
from media_signing import signed_media_url
from utils.response_utils import success_response, error_response
from auth.oauth_handoff import consume_handoff_code, delete_handoff_code

chat_bp = Blueprint('chat', __name__, url_prefix='/api/chat')

ALLOWED_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'gif'}

# Media kinds the chat accepts, their upload size caps and extensions.
CHAT_MEDIA_LIMITS = {
    'image': 10 * 1024 * 1024,
    'avatar': 5 * 1024 * 1024,
    'audio': 15 * 1024 * 1024,
    'video': 30 * 1024 * 1024,
    'document': 20 * 1024 * 1024,
}
CHAT_MEDIA_EXTENSIONS = {
    'image': {'png', 'jpg', 'jpeg', 'webp', 'gif'},
    'avatar': {'png', 'jpg', 'jpeg', 'webp'},
    'audio': {'webm', 'ogg', 'mp3', 'm4a', 'mp4', 'aac'},
    'video': {'mp4', 'webm'},
    'document': {'pdf'},
}

# The canonical MIME for a given (kind, content). Used to verify the extension
# actually matches what the content claims to be (no HTML/JS/execution code
# disguised as a supported attachment).
CHAT_CONTENT_EXTENSIONS_BY_MIME = {
    'image/png': {'png'},
    'image/jpeg': {'jpg', 'jpeg'},
    'image/gif': {'gif'},
    'image/webp': {'webp'},
    'audio/ogg': {'ogg'},
    'audio/mpeg': {'mp3'},
    'audio/mp4': {'m4a', 'mp4', 'aac'},
    'audio/webm': {'webm'},
    'video/mp4': {'mp4'},
    'video/webm': {'webm'},
    'application/pdf': {'pdf'},
}


def sniff_chat_media(data):
    """Return (kind, canonical mime, allowed extensions) from magic bytes, or None."""
    if not data:
        return None
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image', 'image/png', {'png'}
    if data.startswith(b'\xff\xd8\xff'):
        return 'image', 'image/jpeg', {'jpg', 'jpeg'}
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'image', 'image/gif', {'gif'}
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image', 'image/webp', {'webp'}

    if len(data) >= 12 and data[4:8] == b'ftyp':
        brand = data[8:12]
        # Direct audio M4A / AAC identification
        if brand in (b'M4A ', b'M4B ', b'M4P ', b'm4a ', b'm4b ') or b'M4A ' in data[8:min(len(data), 64)]:
            return 'audio', 'audio/mp4', {'m4a', 'mp4', 'aac'}
        return 'video', 'video/mp4', {'mp4'}
    if data.startswith(b'\x1aE\xdf\xa3'):
        return 'video', 'video/webm', {'webm'}
    if data.startswith(b'OggS'):
        return 'audio', 'audio/ogg', {'ogg'}
    if data.startswith((b'ID3', b'\xff\xfb', b'\xff\xf3', b'\xff\xf2')):
        return 'audio', 'audio/mpeg', {'mp3'}
    if data.startswith((b'\xff\xf1', b'\xff\xf9')):
        return 'audio', 'audio/mp4', {'aac', 'm4a'}
    if data.startswith(b'%PDF-'):
        return 'document', 'application/pdf', {'pdf'}
    return None


def sniff_chat_media_by_kind(data, declared_kind):
    """Like sniff_chat_media, but disambiguates audio vs video containers by the
    client-declared kind (both are already validated to be a allowed kind).
    Returns (sniffed_kind, canonical_mime, allowed_extensions) or None.
    """
    res = sniff_chat_media(data)
    if not res:
        return None
    kind, mime, exts = res
    if declared_kind == 'audio':
        # Disambiguate MP4 / M4A container for audio (iOS Safari MediaRecorder records audio/mp4)
        if len(data) >= 12 and data[4:8] == b'ftyp':
            return 'audio', 'audio/mp4', {'m4a', 'mp4', 'aac'}
        if kind == 'video':
            return None  # EBML/WebM video container flagged as audio
    elif declared_kind in ('image', 'avatar') and kind != 'image':
        return None
    elif declared_kind == 'video' and kind == 'image':
        return None
    elif declared_kind == 'document' and kind != 'document':
        return None

    # The declared kind may differ from the pure-sniffed kind for ambiguous
    # containers only when it matches a real allowed kind; keep content-ext
    # check strict via CHAT_CONTENT_EXTENSIONS_BY_MIME.
    return declared_kind, mime, CHAT_CONTENT_EXTENSIONS_BY_MIME.get(mime, exts)

# Canonical image MIME per sniffed type + the extensions that may claim it.
IMAGE_MIME_BY_TYPE = {
    'png': 'image/png',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
}
IMAGE_EXTENSIONS_BY_TYPE = {
    'png': {'png'},
    'jpeg': {'jpg', 'jpeg'},
    'gif': {'gif'},
    'webp': {'webp'},
}


def sniff_image_type(data):
    """Return (type, canonical mime) from magic bytes, or None.

    The browser-supplied Content-Type is attacker-controlled; the uploaded
    bytes are the only trustworthy signal about what a file really is.
    """
    if not data:
        return None
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png', IMAGE_MIME_BY_TYPE['png']
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpeg', IMAGE_MIME_BY_TYPE['jpeg']
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'gif', IMAGE_MIME_BY_TYPE['gif']
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp', IMAGE_MIME_BY_TYPE['webp']
    return None

logger = logging.getLogger('chat_routes')

# Official Chat runs on its OWN frontend (separate domain). Every link the
# backend hands out (invites) points there.
CHAT_FRONTEND_URL = os.environ.get('CHAT_FRONTEND_URL', '').rstrip('/')

# Canonical public origin: the custom chat domain has no DNS yet, so the Vercel
# deployment is the live app until chat.jdlxmobile.in is configured.
DEFAULT_CHAT_FRONTEND_URL = 'https://jdlx-chat.vercel.app'


def _is_allowed_chat_origin(origin):
    """True only for origins the Official Chat frontend is really served from."""
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host in ('localhost', '127.0.0.1'):
        return True
    if host in ('jdlx-chat.vercel.app', 'chat.jdlxmobile.in'):
        return True
    # Vercel preview deployments of this project only (jdlx-chat-<hash>...).
    # A generic *.vercel.app allowlist would accept attacker-hosted sites.
    first_label = host.split('.')[0]
    return host.endswith('.vercel.app') and first_label.startswith('jdlx-chat')


def get_public_chat_origin():
    """Canonical origin for invite/share links.

    Never trust a raw Origin/Referer header: an attacker could point it at
    their own site and hand out a phishing 'invite' that impersonates JDLX.
    Explicit config wins, known origins are honoured, everything else falls
    back to the canonical deployment.
    """
    if CHAT_FRONTEND_URL:
        return CHAT_FRONTEND_URL
    origin = (request.headers.get('Origin') or '').rstrip('/')
    if origin and _is_allowed_chat_origin(origin):
        return origin
    return DEFAULT_CHAT_FRONTEND_URL


def _dispatch_supabase_broadcast_worker(messages_payload):
    try:
        supabase_url = os.environ.get('SUPABASE_URL') or 'https://fpsvgonupwevbnhbiqoh.supabase.co'
        anon_key = os.environ.get('SUPABASE_ANON_KEY') or 'sb_publishable_3WwQgzqA7iTFcu4sry90LQ_xYc43CqG'
        if not supabase_url or not anon_key:
            return
        broadcast_url = f"{supabase_url.rstrip('/')}/realtime/v1/api/broadcast"
        # On private channels the public anon key cannot publish. Sign a
        # short-lived service-role token with the project JWT secret instead;
        # without the secret we keep the legacy public-channel behaviour.
        jwt_secret = (os.environ.get('SUPABASE_JWT_SECRET') or '').strip()
        if jwt_secret:
            now = int(time.time())
            auth_token = jwt.encode({
                'aud': 'authenticated',
                'iat': now,
                'exp': now + 120,
                'role': 'service_role',
                'sub': 'service_role'
            }, jwt_secret, algorithm='HS256')
        else:
            auth_token = anon_key
        headers = {
            'apikey': anon_key,
            'Authorization': f'Bearer {auth_token}',
            'Content-Type': 'application/json'
        }
        if jwt_secret:
            # The batch endpoint needs the private flag on each message;
            # without it Supabase delivers the event to public channels only.
            messages_payload = [
                {**message, 'private': True} for message in messages_payload
            ]
        body = json.dumps({'messages': messages_payload}).encode('utf-8')
        req = urllib.request.Request(broadcast_url, data=body, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=4) as resp:
            pass
    except Exception as e:
        logger.debug("Supabase broadcast dispatch error (non-fatal): %s", e)


def broadcast_supabase_chat_event(messages):
    """Dispatch Supabase Realtime broadcast in a non-blocking background thread.

    messages: list of tuples (topic_name, event_name, payload_dict)
    """
    if not messages:
        return
    formatted = []
    for item in messages:
        if len(item) == 3:
            topic, event, payload = item
            topic_name = topic if topic.startswith('realtime:') else f"realtime:{topic}"
            formatted.append({
                'topic': topic_name,
                'event': event,
                'payload': payload
            })
    if not formatted:
        return
    try:
        threading.Thread(
            target=_dispatch_supabase_broadcast_worker,
            args=(formatted,),
            daemon=True
        ).start()
    except Exception as e:
        logger.debug("Failed to spawn Supabase broadcast thread: %s", e)



def get_secret_key():
    try:
        if current_app and current_app.config.get("JWT_SECRET"):
            return current_app.config["JWT_SECRET"]
    except Exception:
        pass
    return get_jwt_secret()


def format_utc_iso(dt_val):
    """Normalize SQLite/Turso UTC timestamp to standard ISO 8601 with Z indicator.
    
    SQLite CURRENT_TIMESTAMP generates 'YYYY-MM-DD HH:MM:SS' without timezone.
    Browsers parse strings without 'Z' or timezone offset as LOCAL time, causing
    incorrect clock offsets (e.g., 5.5 hours behind in Indian Standard Time).
    Adding 'Z' ensures browsers accurately convert UTC to the user's local device time.
    """
    if not dt_val:
        return dt_val
    s = str(dt_val).strip()
    if not s:
        return s
    if not s.endswith('Z') and '+' not in s:
        if ' ' in s and len(s) >= 19:
            s = s.replace(' ', 'T') + 'Z'
        elif not s.endswith('Z'):
            s = s + 'Z'
    return s


# DB-backed fixed-window rate limiter for chat endpoints.
#
# The old version kept a dict in process memory: it grew without bound (every
# scope+key ever seen stayed forever), counters were per gunicorn worker (so the
# real limit was N x workers) and they reset on every deploy. Rows now live in
# chat_rate_limits (created by database.init_db() and swept periodically), so
# all workers share one budget and nothing accumulates in RAM.
_CHAT_RATE_CLEANUP_INTERVAL_S = 60
_chat_rate_cleanup = {"last": 0.0}


def _sweep_chat_rate_limits(conn, now):
    """Drop stale windows at most once a minute (cheap, keeps the table tiny)."""
    mono = time.monotonic()
    if mono - _chat_rate_cleanup["last"] < _CHAT_RATE_CLEANUP_INTERVAL_S:
        return
    _chat_rate_cleanup["last"] = mono
    try:
        conn.execute(
            "DELETE FROM chat_rate_limits WHERE window_start < ?",
            (now - 3600,)
        )
        conn.commit()
    except Exception as e:
        logger.warning("Chat rate-limit sweep failed: %s", e)


_CHAT_RATE_UPSERT = """
    INSERT INTO chat_rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
        count = CASE
            WHEN excluded.window_start - chat_rate_limits.window_start >= ?
            THEN 1 ELSE chat_rate_limits.count + 1 END,
        window_start = CASE
            WHEN excluded.window_start - chat_rate_limits.window_start >= ?
            THEN excluded.window_start ELSE chat_rate_limits.window_start END
    RETURNING count
"""


def check_chat_rate_limits(entries, commit=True):
    """Check several (scope, key, max_requests, window_seconds) budgets at once.

    One UPSERT+RETURNING per budget replaces the old SELECT + write pair, and
    every budget shares a single commit — the send path used to spend six
    Turso round-trips on rate limiting alone. Fixed-window semantics are
    unchanged: the window resets once ``window_seconds`` have elapsed and a
    request is allowed while the post-increment count is <= max_requests.

    Shared across workers through the DB. Fails OPEN if the DB is unavailable:
    a limiter outage must never take chat down (the error is logged).

    ``commit=False`` leaves the counter write in the caller's transaction so a
    route that writes more (message send) pays for one commit instead of two.
    """
    # Honor the app-wide test escape hatch (same contract as app.py's own custom
    # limiter): headless test runs must never 429 on the chat endpoints.
    if os.environ.get("DISABLE_RATE_LIMIT") == "1":
        return True

    now = int(time.time())
    allowed = True
    try:
        conn = get_db()
        try:
            for scope, key, max_requests, window_seconds in entries:
                # fetchall(), not fetchone(): libsql keeps a RETURNING statement
                # "in progress" until its rows are exhausted, and commit() then
                # raises "cannot commit transaction - SQL statements in progress".
                rows = conn.execute(
                    _CHAT_RATE_UPSERT,
                    (f"{scope}:{key}", now, window_seconds, window_seconds)
                ).fetchall()
                row = rows[0] if rows else None
                if not row or row["count"] > max_requests:
                    allowed = False
            if commit:
                conn.commit()
                _sweep_chat_rate_limits(conn, now)
            return allowed
        finally:
            conn.close()
    except Exception as e:
        logger.warning("Chat rate limiter unavailable, allowing request: %s", e)
        return True


def check_chat_rate_limit(scope, key, max_requests=25, window_seconds=60):
    """Allow or reject one request for (scope, key) in a fixed window."""
    return check_chat_rate_limits([(scope, key, max_requests, window_seconds)])


def _is_new_chat_account(raw_created_at):
    """True while a chat account is younger than 24h (stricter send budget)."""
    try:
        created_at = datetime.datetime.fromisoformat(
            str(raw_created_at).replace(' ', 'T').replace('Z', '+00:00')
        )
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=datetime.timezone.utc)
        return (
            datetime.datetime.now(datetime.timezone.utc) - created_at
        ).total_seconds() < 86400
    except Exception:
        return False


def get_client_ip_address():
    """Real client IP from the proxy chain.

    Render appends the address it observed, so the RIGHTMOST X-Forwarded-For
    entry is the trustworthy one. The leftmost entries are attacker-controlled:
    a spoofed header used to hand every login/register attempt a fresh identity
    and bypass the limiter entirely.
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    parts = [part.strip() for part in forwarded.split(",") if part.strip()]
    if parts:
        return parts[-1]
    return request.remote_addr or "unknown"


def get_client_fingerprint():
    try:
        ip = get_client_ip_address()
        ua = request.headers.get("User-Agent", "")[:80]
        return hashlib.sha256(f"{ip}:{ua}".encode()).hexdigest()[:16]
    except Exception:
        return "generic_fp"


def log_chat_security_event(conn, user_id, event_type, details=None):
    try:
        ip = get_client_ip_address()
        ua = request.headers.get("User-Agent", "")[:120]
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO official_chat_security_events (user_id, event_type, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)",
            (user_id, event_type, details, ip, ua)
        )
        conn.commit()
    except Exception as e:
        logger.warning(f"Failed to log chat security event: {e}")


def issue_chat_token(user_id, email, name=None, username=None, role='user'):
    """Issues long-lived access token (30 days) and rotatable refresh token (180 days) for persistent chat sessions."""
    now = int(time.time())
    fp = get_client_fingerprint()
    secret = get_secret_key()

    access_payload = {
        'user_id': user_id,
        'email': email,
        'name': name or '',
        'username': username or '',
        'role': role or 'user',
        'type': 'official_chat',
        'fp': fp,
        'iat': now,
        'exp': now + (30 * 24 * 3600)  # 30 days persistent chat session
    }
    refresh_payload = {
        'user_id': user_id,
        'email': email,
        'type': 'official_chat_refresh',
        'fp': fp,
        'iat': now,
        'exp': now + (180 * 24 * 3600)  # 180 days refresh token
    }
    access_token = jwt.encode(access_payload, secret, algorithm='HS256')
    refresh_token = jwt.encode(refresh_payload, secret, algorithm='HS256')
    return access_token, refresh_token


def chat_token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        token = None
        if auth_header:
            parts = auth_header.split(" ", 1)
            if len(parts) == 2 and parts[1].strip():
                token = parts[1].strip()
        if not token:
            token = request.cookies.get("chat_token") or request.cookies.get("token")

        if not token:
            return error_response("Official Chat authentication required", 401)

        secret = get_secret_key()
        try:
            payload = jwt.decode(token, secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return jsonify({'success': False, 'error': 'Chat session expired', 'token_expired': True}), 401
        except Exception:
            return error_response("Invalid chat credentials", 401)

        # Chat and Store share ONE JWT secret, so the token type is the only
        # thing separating the two identity realms. Requiring it exactly stops
        # a storefront session token (no `type` claim) and a chat refresh token
        # (`official_chat_refresh`) from being replayed as a chat access token:
        # both used to authenticate as whichever chat_users row matched user_id.
        if payload.get("type") != "official_chat":
            return error_response("Invalid chat credentials", 401)

        user_id = payload.get("user_id") or payload.get("id")
        if not user_id:
            return error_response("Invalid session payload", 401)

        # Revocation check: logout bumps chat_users.min_token_iat, so every
        # token issued before it (access AND refresh) dies immediately instead
        # of living out its full 1h / 14d lifetime.
        try:
            conn = get_db()
            try:
                row = conn.execute(
                    "SELECT is_active, min_token_iat, created_at FROM chat_users WHERE id = ?",
                    (user_id,)
                ).fetchone()
            finally:
                conn.close()
        except Exception:
            return error_response("Invalid chat credentials", 401)
        if not row or not row['is_active']:
            return error_response("Chat account not found. Please sign in again.", 401)
        issued_at = payload.get('iat')
        if row['min_token_iat'] and issued_at and issued_at < row['min_token_iat']:
            return error_response("Session signed out. Please log in again.", 401)

        request.chat_user = {
            'user_id': user_id,
            'email': payload.get('email', ''),
            'name': payload.get('name', ''),
            'username': payload.get('username', ''),
            'role': payload.get('role', 'user'),
            'type': payload.get('type', 'official_chat'),
            # Account age drives the stricter new-account send budget. Carried
            # from the auth row so hot routes never spend an extra query on it.
            'created_at': row['created_at']
        }
        return f(*args, **kwargs)
    return decorated


def get_chat_user_row(conn, chat_user_id):
    """Fetch the Official Chat identity row (chat_users) or None."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, google_sub, email, phone, name, username, gender, profile_image, role, is_active FROM chat_users WHERE id = ?",
        (chat_user_id,)
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def clean_and_validate_chat_username(raw_username):
    """Sanitize and validate an Official Chat username handle.

    Strict rules:
    - Never contains email address or domain (@, .com, .in, etc.)
    - If user pasted or autofilled an email (e.g. user@gmail.com or usergmailcom),
      automatically extract and sanitize the username prefix.
    - 3 to 30 characters, lowercase alphanumeric and underscore only.
    - Must contain at least one letter (prevents purely numeric handles that clash with phone numbers).
    - Cannot contain email provider names (gmail, yahoo, outlook, icloud, etc.).
    """
    if not raw_username or not str(raw_username).strip():
        return None, "Username must be 3-30 characters long and can only contain letters, numbers, and underscores."

    u = str(raw_username).strip().lower()
    # Strip leading @
    u = u.lstrip('@').strip()

    # If full email was entered/pasted, strip everything from @ onwards
    if '@' in u:
        u = u.split('@')[0]

    # Strip domain extensions and common email provider names from ends
    u = re.sub(r'(?:gmail|yahoo|hotmail|outlook|icloud|proton|rediff|zoho|aol)(?:com|in|net|org)?$', '', u, flags=re.I)
    u = re.sub(r'\.(?:com|in|net|org|co|io|app|ai)$', '', u, flags=re.I)
    u = u.strip('_')

    if not re.match(r'^[a-z0-9_]{3,30}$', u):
        return None, "Username must be 3-30 characters long and can only contain letters, numbers, and underscores."

    if not re.search(r'[a-z]', u):
        return None, "Username must contain at least one letter (numbers-only is reserved for mobile numbers)."
    if re.search(r'(gmail|yahoo|hotmail|outlook|icloud|proton|rediff)', u, re.I):
        return None, "Username cannot contain email service names (e.g. gmail, yahoo)."

    return u, None


CHAT_EMAIL_RE = re.compile(r'^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$')


def is_valid_chat_email(value):
    """True for a syntactically valid email address (lowercased compare)."""
    return bool(CHAT_EMAIL_RE.match(str(value or '').strip().lower()))


def chat_password_policy_error(password):
    """Strong-password policy for NEW chat passwords (registration / Google
    sign-up completion). Login is intentionally NOT gated by this so existing
    accounts can always sign in. Returns an error message, or None when the
    password satisfies the policy: 8+ characters with at least one uppercase
    letter, one lowercase letter and one number."""
    pw = str(password or '')
    if len(pw) < 8:
        return "Password must be at least 8 characters long."
    if not re.search(r'[A-Z]', pw):
        return "Password must include at least one uppercase letter."
    if not re.search(r'[a-z]', pw):
        return "Password must include at least one lowercase letter."
    if not re.search(r'\d', pw):
        return "Password must include at least one number."
    return None


CHAT_GENDERS = {'male', 'female', 'other', 'prefer_not_to_say'}


def create_chat_identity(full_name='', username='', phone='', email='', password=None):
    """Validate + create a NEW CHAT identity. Returns the chat user dict, or an
    (error_response, status) tuple on validation failure.

    Registration only: an existing phone/email row is NEVER modified. The old
    upsert behaviour let anyone who knew a mobile number overwrite the matching
    account's name/username/password and receive a valid token without any
    password check - a full account takeover. Existing accounts must sign in via
    /auth/register (already registered) or /auth/login instead.

    Operates exclusively on `chat_users` - the storefront `users` table is
    never read or written here, so Chat and Store sessions/data can never mix.
    """
    full_name = (full_name or '').strip()
    email = (email or '').strip().lower()
    phone = (phone or '').strip()
    cleaned_phone = phone.replace("+91", "").replace("-", "").replace(" ", "").strip() if phone else ""

    if not full_name or len(full_name) < 2:
        return error_response("Full Name is mandatory so friends and contacts can identify you.", 400)

    clean_username, u_err = clean_and_validate_chat_username(username)
    if u_err:
        return error_response(u_err, 400)

    if not cleaned_phone and not email:
        return error_response("Please enter your email address or mobile number.", 400)
    if email and not is_valid_chat_email(email):
        return error_response("Please enter a valid email address.", 400)
    if cleaned_phone and len(cleaned_phone) < 10:
        return error_response("Please enter a valid mobile number.", 400)

    pw_hash = generate_password_hash(password) if (password and len(str(password)) >= 6) else None

    conn = get_db()
    try:
        cursor = conn.cursor()

        cursor.execute("SELECT id FROM chat_users WHERE LOWER(username) = ?", (clean_username,))
        if cursor.fetchone():
            return error_response(f"Username '@{clean_username}' is already taken. Please choose another username.", 409)

        if cleaned_phone:
            cursor.execute("SELECT id FROM chat_users WHERE phone = ? LIMIT 1", (cleaned_phone,))
            if cursor.fetchone():
                return error_response("An Official Chat account already exists with this mobile number. Please sign in with your password.", 409)

        if email:
            cursor.execute("SELECT id FROM chat_users WHERE LOWER(email) = ?", (email,))
            if cursor.fetchone():
                return error_response("An Official Chat account already exists with this email. Please sign in with your password or use Google login.", 409)

        cursor.execute(
            "INSERT INTO chat_users (email, phone, name, username, password_hash, role) VALUES (?, ?, ?, ?, ?, 'customer')",
            (email or None, cleaned_phone or None, full_name, clean_username, pw_hash)
        )
        conn.commit()
        cursor.execute("SELECT id, google_sub, email, phone, name, username, gender, profile_image, role, is_active FROM chat_users WHERE id = ?", (cursor.lastrowid,))
        return dict(cursor.fetchone())
    finally:
        conn.close()


def get_or_create_chat_room(conn, user_id, user_name='Valued Customer', username=None):
    cursor = conn.cursor()
    # Check for active room
    cursor.execute(
        "SELECT * FROM official_chat_rooms WHERE user_id = ? AND status = 'active' AND user_two_id IS NULL ORDER BY id DESC LIMIT 1",
        (user_id,)
    )
    room = cursor.fetchone()
    if room:
        room_dict = dict(room)
        updated = False
        if username and not room_dict.get('username'):
            cursor.execute("UPDATE official_chat_rooms SET username = ? WHERE id = ?", (username, room_dict['id']))
            updated = True
        if not room_dict.get('e2e_secret'):
            e2e_sec = secrets.token_hex(32)
            cursor.execute("UPDATE official_chat_rooms SET e2e_secret = ? WHERE id = ?", (e2e_sec, room_dict['id']))
            updated = True
        if updated:
            conn.commit()
            cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ?", (room_dict['id'],))
            room = cursor.fetchone()
        return dict(room)

    # Create new official chat room (peer messenger container)
    room_key = f"CR-{secrets.token_hex(6).upper()}"
    title = f"Chat @{username or user_id}"
    e2e_secret = secrets.token_hex(32)
    cursor.execute(
        """INSERT INTO official_chat_rooms (user_id, room_key, title, status, room_type, last_message, username, e2e_secret)
           VALUES (?, ?, ?, 'active', 'direct', 'Welcome to Official Chat Messenger', ?, ?)""",
        (user_id, room_key, title, username, e2e_secret)
    )
    room_id = cursor.lastrowid
    conn.commit()

    cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ?", (room_id,))
    new_room = cursor.fetchone()
    return dict(new_room)


# -----------------------------------------------------------------------------
# AUTHENTICATION ENDPOINTS
# -----------------------------------------------------------------------------

@chat_bp.route('/auth/profile-preview', methods=['POST'])
def chat_auth_profile_preview():
    """DEPRECATED - Official Chat is a standalone app with its own identity.

    Storefront accounts and Chat accounts are separate; the storefront token
    can never sign a user into Chat anymore.
    """
    return error_response(
        "Official Chat sign-in via the JDLX storefront session is discontinued. "
        "Please log in directly inside the Official Chat app.",
        410,
    )


@chat_bp.route('/auth/sso', methods=['POST'])
def chat_auth_sso():
    """DEPRECATED - Storefront SSO removed (Chat identities live in chat_users)."""
    return error_response(
        "Official Chat sign-in via the JDLX storefront session is discontinued. "
        "Please log in directly inside the Official Chat app.",
        410,
    )


@chat_bp.route('/auth/sso/grant-code', methods=['POST'])
def grant_chat_sso_code():
    """DEPRECATED - Storefront SSO removed."""
    return error_response(
        "Official Chat Single Sign-On is discontinued. "
        "Please log in directly inside the Official Chat app.",
        410,
    )


@chat_bp.route('/auth/refresh', methods=['POST'])
def chat_auth_refresh():
    """Exchange a valid 14-day refresh token for a fresh short-lived access token."""
    data = request.get_json(silent=True) or {}
    refresh_token = data.get('refresh_token') or request.cookies.get('chat_refresh_token')
    if not refresh_token:
        return error_response("Refresh token required", 400)

    secret = get_secret_key()
    try:
        payload = jwt.decode(refresh_token, secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return error_response("Refresh token has expired. Please sign in again.", 401)
    except Exception:
        return error_response("Invalid refresh token", 401)

    if payload.get('type') != 'official_chat_refresh':
        return error_response("Invalid token type", 401)

    user_id = payload.get('user_id')
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, google_sub, email, phone, name, username, profile_image, role, is_active, min_token_iat FROM chat_users WHERE id = ?",
            (user_id,)
        )
        user_row = cursor.fetchone()
        if not user_row or not user_row['is_active']:
            return error_response("Chat account not found. Please sign in again.", 404)
        issued_at = payload.get('iat')
        if user_row['min_token_iat'] and issued_at and issued_at < user_row['min_token_iat']:
            return error_response("Session signed out. Please log in again.", 401)

        user_data = dict(user_row)
        new_token, new_refresh = issue_chat_token(
            user_data['id'],
            user_data['email'],
            user_data.get('name'),
            user_data.get('username'),
            user_data.get('role', 'customer')
        )
        log_chat_security_event(conn, user_id, 'TOKEN_ROTATION', "Refreshed short-lived chat session")
        return success_response({
            'chat_token': new_token,
            'refresh_token': new_refresh,
            'user': user_data
        }, "Session refreshed")
    finally:
        conn.close()


@chat_bp.route('/auth/exchange-handoff', methods=['POST'])
def chat_exchange_handoff():
    """Redeem the one-time code returned to the Android app after Google OAuth.

    The code only leaves the Custom Tab, never the session token. A matching
    PKCE verifier (kept inside the app) releases the chat access + refresh
    tokens over HTTPS. Web/PWA sign-in never calls this endpoint.
    """
    client_ip = get_client_ip_address()
    if not check_chat_rate_limit("chat_handoff", client_ip, max_requests=20, window_seconds=300):
        return error_response("Too many sign-in attempts. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    code = str(data.get('code') or '').strip()
    verifier = str(data.get('verifier') or '').strip()
    if not code:
        return error_response("code is required", 400)
    # The verifier is optional here on purpose: PKCE-bound codes enforce the
    # verifier match inside consume_handoff_code; challenge-less codes (legacy
    # web rollout path) are single-use and short-lived instead.

    conn = get_db()
    try:
        cursor = conn.cursor()
        payload, reason = consume_handoff_code(cursor, code, verifier)
        if not payload:
            conn.rollback()
            logger.warning("Chat OAuth hand-off rejected (%s)", reason)
            return error_response(
                "This sign-in link is invalid or has expired. Please sign in again.", 401
            )
        delete_handoff_code(cursor, code)
        conn.commit()
    except Exception as e:
        logger.error("Chat OAuth hand-off exchange failed: %s", e)
        return error_response("Could not complete sign-in. Please try again.", 500)
    finally:
        conn.close()

    chat_user = dict(payload.get('user') or {})
    refresh_token = chat_user.pop('refresh_token', None)
    if not payload.get('token') or not chat_user.get('id'):
        return error_response("Invalid sign-in session. Please sign in again.", 401)

    return success_response({
        'chat_token': payload['token'],
        'refresh_token': refresh_token,
        'user': chat_user,
    }, "Signed in")


@chat_bp.route('/auth/logout', methods=['POST'])
def chat_auth_logout():
    """Revoke every outstanding token for the caller: access (1h) and refresh
    (14d). Logout used to be client-only, so a copied token stayed usable for
    up to two weeks; now chat_users.min_token_iat invalidates all of them."""
    data = request.get_json(silent=True) or {}
    secret = get_secret_key()

    candidates = []
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        candidates.append(auth_header.split(' ', 1)[1].strip())
    if data.get('refresh_token'):
        candidates.append(str(data['refresh_token']).strip())

    user_id = None
    for candidate in candidates:
        if not candidate:
            continue
        try:
            payload = jwt.decode(candidate, secret, algorithms=["HS256"])
        except Exception:
            continue
        if str(payload.get('type') or '').startswith('official_chat'):
            user_id = payload.get('user_id') or payload.get('id')
            if user_id:
                break

    if not user_id:
        return error_response("Invalid chat session", 401)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE chat_users SET min_token_iat = ? WHERE id = ?",
            (int(time.time()), user_id)
        )
        conn.commit()
        log_chat_security_event(conn, user_id, 'CHAT_LOGOUT', 'Revoked all chat access + refresh tokens')
        return success_response(None, "Logged out of Official Chat")
    finally:
        conn.close()


@chat_bp.route('/keys', methods=['POST'])
@chat_token_required
def publish_chat_public_key():
    """Store this device's ECDH public key (SPKI base64) for true E2EE.

    Only public key material is accepted - the private key never leaves the
    browser, so the server can neither derive room keys nor read DM plaintext.
    """
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("key_publish", f"user_{my_id}", max_requests=10, window_seconds=300):
        return error_response("Too many key updates. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    public_key = (data.get('public_key') or '').strip()
    if not public_key or len(public_key) > 400:
        return error_response("Invalid public key", 400)

    try:
        spki = base64.b64decode(public_key, validate=True)
    except Exception:
        return error_response("Invalid public key", 400)

    # P-256 SPKI DER is exactly 91 bytes and starts with the EC public-key
    # header. Anything else is not a key we can do ECDH with.
    ec_p256_spki_prefix = bytes.fromhex('3059301306072a8648ce3d020106082a8648ce3d030107034200')
    if len(spki) != 91 or not spki.startswith(ec_p256_spki_prefix):
        return error_response("Invalid public key", 400)

    identity_backup = (data.get('identity_backup') or '').strip()
    if identity_backup and len(identity_backup) > 4000:
        return error_response("Invalid identity backup", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        if identity_backup:
            cursor.execute(
                "UPDATE chat_users SET public_key = ?, identity_backup = ? WHERE id = ?",
                (public_key, identity_backup, my_id)
            )
        else:
            cursor.execute("UPDATE chat_users SET public_key = ? WHERE id = ?", (public_key, my_id))
        conn.commit()
        return success_response({'public_key': public_key}, "Encryption key published")
    finally:
        conn.close()


@chat_bp.route('/realtime-token', methods=['GET'])
@chat_token_required
def get_chat_realtime_token():
    """Issue a short-lived Supabase Realtime JWT for private channels.

    The token only allows this chat user's personal topic plus the room topics
    they participate in. Requires SUPABASE_JWT_SECRET; without it the endpoint
    reports 503 and the frontend keeps using the legacy public channels.
    """
    jwt_secret = (os.environ.get('SUPABASE_JWT_SECRET') or '').strip()
    if not jwt_secret:
        return error_response('Realtime authorization is not configured', 503)

    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT id FROM official_chat_rooms WHERE user_id = ? OR user_two_id = ?
               UNION
               SELECT room_id FROM official_chat_group_members WHERE user_id = ?
               ORDER BY 1 DESC LIMIT 100""",
            (my_id, my_id, my_id)
        )
        topics = [f"chat_room_{row[0]}" for row in cursor.fetchall()]
    finally:
        conn.close()

    topics.append(f"chat_user_{my_id}")
    now = int(time.time())
    expires_in = 3600
    token = jwt.encode({
        'aud': 'authenticated',
        'iat': now,
        'exp': now + expires_in,
        'sub': str(my_id),
        'role': 'authenticated',
        'chat_user_id': my_id,
        'allowed_topics': topics
    }, jwt_secret, algorithm='HS256')
    return success_response({
        'token': token,
        'expires_in': expires_in,
        'topics': topics
    }, 'Realtime token issued')


@chat_bp.route('/keys/backup', methods=['GET'])
@chat_token_required
def get_chat_identity_backup():
    """Retrieve the device-synced identity keypair for cross-device consistency."""
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT public_key, identity_backup FROM chat_users WHERE id = ?", (my_id,))
        row = cursor.fetchone()
        if not row:
            return error_response("User not found", 404)
        return success_response({
            'public_key': row['public_key'],
            'identity_backup': row['identity_backup'] if 'identity_backup' in row.keys() else None
        }, "Identity backup retrieved")
    finally:
        conn.close()


@chat_bp.route('/push/public-key', methods=['GET'])
def chat_push_public_key():
    """VAPID public key used to create Web Push subscriptions.

    Public by design (it is the browser's subscribe key); `enabled` tells the
    app whether the server has a usable VAPID private key at all.
    """
    from notifications.notification_service import get_chat_vapid_public_key, is_chat_vapid_enabled
    key = get_chat_vapid_public_key()
    return success_response({
        'public_key': key,
        'enabled': bool(key and is_chat_vapid_enabled()),
    }, "Chat push configuration")


@chat_bp.route('/push/subscribe', methods=['POST'])
@chat_token_required
def chat_push_subscribe():
    """Store this browser's push subscription for the signed-in chat identity."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("push_subscribe", f"user_{my_id}", max_requests=20, window_seconds=300):
        return error_response("Too many push updates. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    endpoint = str(data.get('endpoint') or '').strip()
    keys = data.get('keys') or {}
    p256dh = str(keys.get('p256dh') or '').strip()
    auth = str(keys.get('auth') or '').strip()
    device_model = str(data.get('device_model') or '').strip()[:120] or None

    if not endpoint.startswith('https://') or len(endpoint) > 1000:
        return error_response("Invalid push endpoint", 400)
    if not p256dh or len(p256dh) > 300 or not auth or len(auth) > 300:
        return error_response("Invalid push keys", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        # An endpoint belongs to exactly one chat account. Re-subscribing the
        # same browser after switching accounts moves it instead of leaking the
        # previous account's pushes.
        cursor.execute(
            """INSERT INTO chat_push_subscriptions (chat_user_id, endpoint, p256dh, auth, device_model)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET
                 chat_user_id = excluded.chat_user_id,
                 p256dh = excluded.p256dh,
                 auth = excluded.auth,
                 device_model = excluded.device_model,
                 updated_at = CURRENT_TIMESTAMP""",
            (my_id, endpoint, p256dh, auth, device_model)
        )
        # Keep at most 10 browsers per account (oldest drop off).
        cursor.execute(
            """DELETE FROM chat_push_subscriptions
               WHERE chat_user_id = ? AND id NOT IN (
                 SELECT id FROM chat_push_subscriptions
                 WHERE chat_user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 10
               )""",
            (my_id, my_id)
        )
        conn.commit()
        return success_response({'subscribed': True}, "Push notifications enabled")
    finally:
        conn.close()


@chat_bp.route('/push/subscribe', methods=['DELETE'])
@chat_token_required
def chat_push_unsubscribe():
    """Remove this browser's push subscription (only for the caller)."""
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    endpoint = str(data.get('endpoint') or '').strip()
    if not endpoint:
        return error_response("Push endpoint required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM chat_push_subscriptions WHERE endpoint = ? AND chat_user_id = ?",
            (endpoint, my_id)
        )
        conn.commit()
        return success_response({'subscribed': False}, "Push notifications disabled")
    finally:
        conn.close()


@chat_bp.route('/push/device', methods=['POST'])
@chat_token_required
def chat_push_device_register():
    """Store this Android/iOS device's FCM token for the chat identity."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("chat_push_device", f"user_{my_id}", max_requests=20, window_seconds=300):
        return error_response("Too many push updates. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    token = str(data.get('token') or '').strip()
    device_type = str(data.get('device_type') or 'android').strip().lower()[:20]
    device_model = str(data.get('device_model') or '').strip()[:120] or None

    if not token or len(token) > 4096:
        return error_response("Invalid device token", 400)
    if device_type not in ('android', 'ios'):
        return error_response("Unsupported device type", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        # A token belongs to exactly one chat account. Re-registering after an
        # account switch moves it instead of leaking the old account's pushes.
        cursor.execute(
            """INSERT INTO chat_push_tokens (chat_user_id, fcm_token, device_type, device_model)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(fcm_token) DO UPDATE SET
                 chat_user_id = excluded.chat_user_id,
                 device_type = excluded.device_type,
                 device_model = excluded.device_model,
                 updated_at = CURRENT_TIMESTAMP""",
            (my_id, token, device_type, device_model)
        )
        # Keep at most 10 devices per account.
        cursor.execute(
            """DELETE FROM chat_push_tokens
               WHERE chat_user_id = ? AND id NOT IN (
                 SELECT id FROM chat_push_tokens
                 WHERE chat_user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 10
               )""",
            (my_id, my_id)
        )
        conn.commit()
        return success_response({'registered': True}, "Device push enabled")
    finally:
        conn.close()


@chat_bp.route('/push/device', methods=['DELETE'])
@chat_token_required
def chat_push_device_unregister():
    """Remove only the caller's device token."""
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    token = str(data.get('token') or '').strip()
    if not token:
        return error_response("Device token required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM chat_push_tokens WHERE fcm_token = ? AND chat_user_id = ?",
            (token, my_id)
        )
        conn.commit()
        return success_response({'registered': False}, "Device push disabled")
    finally:
        conn.close()


@chat_bp.route('/auth/login-mobile', methods=['POST'])
def chat_login_mobile():
    """Register a NEW chat identity into the `chat_users` table.

    Registration only - an existing phone/email/username is rejected instead of
    being updated (upserting here let anyone who knew a mobile number overwrite
    that account's password and receive a token without any password check).
    Existing accounts sign in through /auth/login with their password.

    Fully independent from the storefront `users` table: registering in Chat
    (even with the same phone/email used in the store) NEVER creates, matches,
    or updates a storefront account.
    """
    # Security: IP Rate Limiting (max 10 attempts per 5 minutes per IP)
    client_ip = get_client_ip_address()
    if not check_chat_rate_limit("mobile_login", client_ip, max_requests=10, window_seconds=300):
        return error_response("Too many login attempts. Please wait 5 minutes before trying again.", 429)

    data = request.get_json(silent=True) or {}
    full_name = (data.get('full_name') or data.get('name') or '').strip()
    raw_username = (data.get('username') or '').strip().lstrip('@').lower().strip()
    phone = (data.get('phone') or '').strip()
    email = (data.get('email') or '').strip().lower()
    password = data.get('password')

    chat_user = create_chat_identity(
        full_name=full_name,
        username=raw_username,
        phone=phone,
        email=email,
        password=password,
    )
    if isinstance(chat_user, tuple):  # (error_response, status)
        return chat_user

    conn = get_db()
    try:
        chat_token, refresh_token = issue_chat_token(
            chat_user['id'],
            chat_user['email'],
            chat_user.get('name'),
            chat_user.get('username'),
            chat_user.get('role', 'customer')
        )
        room = get_or_create_chat_room(conn, chat_user['id'], chat_user.get('name', 'Customer'), chat_user.get('username'))
        log_chat_security_event(conn, chat_user['id'], 'CHAT_REGISTER', f"Chat registration as @{chat_user.get('username')}")
        conn.commit()

        return success_response({
            'chat_token': chat_token,
            'refresh_token': refresh_token,
            'user': chat_user,
            'room': room
        }, "Official Chat login successful")
    finally:
        conn.close()


@chat_bp.route('/auth/check-username', methods=['GET'])
def chat_auth_check_username():
    """Real-time availability check for chat handle.
    Enforces no email domains/addresses, alphanumeric + underscores, and uniqueness in chat_users.
    """
    # This endpoint is unauthenticated by design (it runs while signing up), so
    # it is an enumeration oracle unless throttled: cap lookups per IP so the
    # handle space cannot be bulk-scraped.
    client_ip = get_client_ip_address()
    if not check_chat_rate_limit("username_check", client_ip, max_requests=20, window_seconds=60):
        return error_response("Too many username checks. Please wait a minute and try again.", 429)

    raw = request.args.get('username', '').strip()
    clean_u, err = clean_and_validate_chat_username(raw)
    if err:
        resp = jsonify({
            'success': False,
            'available': False,
            'sanitized': clean_u or '',
            'message': err
        })
        resp.headers['Cache-Control'] = 'no-store'
        return resp, 200

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM chat_users WHERE LOWER(username) = ? LIMIT 1", (clean_u,))
        taken = cursor.fetchone()
        resp = jsonify({
            'success': True,
            'available': not bool(taken),
            'sanitized': clean_u,
            'message': (
                f"@{clean_u} is already taken. Please choose another username."
                if taken else f"@{clean_u} is available!"
            )
        })
        resp.headers['Cache-Control'] = 'no-store'
        return resp, 200
    finally:
        conn.close()


@chat_bp.route('/auth/register', methods=['POST'])
def chat_auth_register():
    """Register a new Official Chat user with full name, unique handle, mobile, and password."""
    client_ip = get_client_ip_address()
    if not check_chat_rate_limit("register", client_ip, max_requests=10, window_seconds=300):
        return error_response("Too many registration attempts. Please wait a few minutes before trying again.", 429)

    data = request.get_json(silent=True) or {}
    full_name = (data.get('full_name') or data.get('name') or '').strip()
    raw_username = (data.get('username') or '').strip()
    phone = (data.get('phone') or '').strip()
    password = data.get('password') or ''
    email = (data.get('email') or '').strip().lower()
    gender = (data.get('gender') or '').strip().lower()

    if not full_name or len(full_name) < 2:
        return error_response("Please enter your full name (at least 2 characters).", 400)

    clean_u, u_err = clean_and_validate_chat_username(raw_username)
    if u_err:
        return error_response(u_err, 400)

    # Email is the primary sign-in id; a mobile number is optional. At least
    # one of the two is required so the account can actually be recovered.
    if email and not is_valid_chat_email(email):
        return error_response("Please enter a valid email address.", 400)

    # Mobile is optional, but when provided it must be a real 10-digit number.
    cleaned_phone = re.sub(r'\D', '', phone)
    if cleaned_phone.startswith('91') and len(cleaned_phone) == 12:
        cleaned_phone = cleaned_phone[2:]
    if cleaned_phone and len(cleaned_phone) != 10:
        return error_response("Please enter a valid 10-digit mobile number.", 400)
    if not cleaned_phone and not email:
        return error_response("Please enter your email address or 10-digit mobile number.", 400)

    pw_policy_err = chat_password_policy_error(password)
    if pw_policy_err:
        return error_response(pw_policy_err, 400)

    if gender and gender not in CHAT_GENDERS:
        return error_response("Please select a valid gender.", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        # 1. Uniqueness check for username
        cursor.execute("SELECT id FROM chat_users WHERE LOWER(username) = ? LIMIT 1", (clean_u,))
        if cursor.fetchone():
            return error_response(f"Username '@{clean_u}' is already taken. Please choose another username.", 409)

        # 2. Check if mobile number already registered (only if mobile was provided)
        if cleaned_phone:
            cursor.execute("SELECT id FROM chat_users WHERE phone = ? LIMIT 1", (cleaned_phone,))
            if cursor.fetchone():
                # Never echo the existing account's @handle here: that turned a
                # duplicate-phone error into an unauthenticated phone -> handle
                # lookup (username enumeration + account disclosure).
                return error_response(
                    "An Official Chat account already exists with this mobile number. "
                    "Please sign in with your password.",
                    409
                )

        # 3. Check email if provided
        if email:
            cursor.execute("SELECT id FROM chat_users WHERE LOWER(email) = ? LIMIT 1", (email,))
            if cursor.fetchone():
                return error_response("An account with this email already exists. Please sign in or use Google login.", 409)

        pw_hash = generate_password_hash(password)
        cursor.execute(
            """INSERT INTO chat_users (name, username, phone, email, password_hash, gender, role)
               VALUES (?, ?, ?, ?, ?, ?, 'customer')""",
            (full_name, clean_u, cleaned_phone or None, email or None, pw_hash, gender or None)
        )
        new_id = cursor.lastrowid
        cursor.execute("SELECT id, google_sub, email, phone, name, username, gender, profile_image, role, is_active FROM chat_users WHERE id = ?", (new_id,))
        chat_user = dict(cursor.fetchone())

        chat_token, refresh_token = issue_chat_token(
            chat_user['id'],
            chat_user['email'],
            chat_user.get('name'),
            chat_user.get('username'),
            chat_user.get('role', 'customer')
        )
        room = get_or_create_chat_room(conn, chat_user['id'], chat_user.get('name', 'Customer'), chat_user.get('username'))
        log_chat_security_event(conn, chat_user['id'], 'CHAT_REGISTER', f"Registered as @{chat_user.get('username')}")
        conn.commit()

        return success_response({
            'chat_token': chat_token,
            'refresh_token': refresh_token,
            'user': chat_user,
            'room': room
        }, "Account created successfully", 201)
    finally:
        conn.close()


@chat_bp.route('/auth/google/complete', methods=['POST'])
def chat_google_complete_signup():
    """Finish a Google sign-up by collecting the details Chat needs.

    Google only proves the email. A brand-new Google user is never inserted
    until they choose a username, password, gender (and optionally a mobile
    number) - otherwise the account could not sign in again without Google
    and would be undiscoverable by friends.
    """
    client_ip = get_client_ip_address()
    if not check_chat_rate_limit("google_complete", client_ip, max_requests=10, window_seconds=300):
        return error_response("Too many attempts. Please wait a few minutes and try again.", 429)

    data = request.get_json(silent=True) or {}
    ticket = (data.get('ticket') or '').strip()
    if not ticket:
        return error_response("Google sign-up session missing. Please sign in with Google again.", 400)

    try:
        payload = jwt.decode(ticket, get_secret_key(), algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return error_response("Google sign-up session expired. Please sign in with Google again.", 401)
    except Exception:
        return error_response("Invalid Google sign-up session. Please sign in with Google again.", 401)

    if payload.get('type') != 'official_chat_google_signup':
        return error_response("Invalid Google sign-up session.", 401)

    google_sub = (payload.get('google_sub') or '').strip()
    email = (payload.get('email') or '').strip().lower()
    picture = (payload.get('picture') or '').strip() or None
    existing_user_id = payload.get('existing_user_id')
    if not google_sub or not is_valid_chat_email(email):
        return error_response("Google account details are incomplete. Please sign in with Google again.", 400)

    full_name = (data.get('full_name') or payload.get('name') or '').strip()
    raw_username = (data.get('username') or '').strip()
    phone = (data.get('phone') or '').strip()
    gender = (data.get('gender') or '').strip().lower()
    password = data.get('password') or ''

    if not full_name or len(full_name) < 2:
        return error_response("Please enter your full name (at least 2 characters).", 400)
    clean_u, u_err = clean_and_validate_chat_username(raw_username)
    if u_err:
        return error_response(u_err, 400)
    if gender not in CHAT_GENDERS:
        return error_response("Please select your gender.", 400)
    pw_policy_err = chat_password_policy_error(password)
    if pw_policy_err:
        return error_response(pw_policy_err, 400)

    cleaned_phone = re.sub(r'\D', '', phone)
    if cleaned_phone.startswith('91') and len(cleaned_phone) == 12:
        cleaned_phone = cleaned_phone[2:]
    if cleaned_phone and len(cleaned_phone) != 10:
        return error_response("Please enter a valid 10-digit mobile number.", 400)

    pw_hash = generate_password_hash(password)
    conn = get_db()
    try:
        cursor = conn.cursor()

        target_id = None
        if existing_user_id:
            cursor.execute("SELECT id, google_sub, email FROM chat_users WHERE id = ?", (existing_user_id,))
            existing = cursor.fetchone()
            if not existing:
                return error_response("Account no longer exists. Please sign in with Google again.", 404)
            if existing['google_sub'] and existing['google_sub'] != google_sub:
                return error_response("This account is linked to a different Google account.", 403)
            if existing['email'] and existing['email'].lower() != email:
                return error_response("This account email does not match the Google account.", 403)
            target_id = existing['id']

        cursor.execute("SELECT id FROM chat_users WHERE LOWER(username) = ? LIMIT 1", (clean_u,))
        taken = cursor.fetchone()
        if taken and taken['id'] != target_id:
            return error_response(f"Username '@{clean_u}' is already taken. Please choose another username.", 409)

        if cleaned_phone:
            cursor.execute("SELECT id FROM chat_users WHERE phone = ? LIMIT 1", (cleaned_phone,))
            phone_row = cursor.fetchone()
            if phone_row and phone_row['id'] != target_id:
                return error_response("This mobile number is already linked to another chat account.", 409)

        if target_id:
            cursor.execute(
                """UPDATE chat_users
                   SET name = ?, username = ?, phone = ?, gender = ?, password_hash = ?,
                       google_sub = ?, email = ?, profile_image = COALESCE(?, profile_image),
                       is_active = 1
                   WHERE id = ?""",
                (full_name, clean_u, cleaned_phone or None, gender, pw_hash,
                 google_sub, email, picture, target_id)
            )
        else:
            cursor.execute("SELECT id FROM chat_users WHERE LOWER(email) = ? LIMIT 1", (email,))
            if cursor.fetchone():
                return error_response("An account already exists with this email. Please sign in instead.", 409)
            cursor.execute(
                """INSERT INTO chat_users (google_sub, email, phone, name, username, password_hash, gender, profile_image, role)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'customer')""",
                (google_sub, email, cleaned_phone or None, full_name, clean_u, pw_hash, gender, picture)
            )
            target_id = cursor.lastrowid

        cursor.execute(
            "SELECT id, google_sub, email, phone, name, username, gender, profile_image, role, is_active FROM chat_users WHERE id = ?",
            (target_id,)
        )
        chat_user = dict(cursor.fetchone())

        chat_token, refresh_token = issue_chat_token(
            chat_user['id'],
            chat_user['email'],
            chat_user.get('name'),
            chat_user.get('username'),
            chat_user.get('role', 'customer')
        )
        room = get_or_create_chat_room(conn, chat_user['id'], chat_user.get('name', 'Customer'), chat_user.get('username'))
        log_chat_security_event(
            conn, chat_user['id'], 'GOOGLE_SIGNUP_COMPLETE',
            f"Google sign-up completed as @{chat_user.get('username')}"
        )
        conn.commit()

        status = 200 if existing_user_id else 201
        return success_response({
            'chat_token': chat_token,
            'refresh_token': refresh_token,
            'user': chat_user,
            'room': room
        }, "Account ready", status)
    finally:
        conn.close()


@chat_bp.route('/auth/login', methods=['POST'])
def chat_auth_login():
    """Login with Identifier (Username or 10-digit Mobile Number) + Password."""
    client_ip = get_client_ip_address()
    if not check_chat_rate_limit("chat_login", client_ip, max_requests=15, window_seconds=300):
        return error_response("Too many login attempts. Please wait 5 minutes before trying again.", 429)

    data = request.get_json(silent=True) or {}
    identifier = (data.get('identifier') or data.get('username') or data.get('phone') or '').strip()
    password = data.get('password') or ''

    if not identifier:
        return error_response("Please enter your Username or Mobile Number.", 400)
    if not password:
        return error_response("Please enter your password.", 400)

    # Disambiguate identifier: email, 10-digit phone number, or username handle
    digits_only = re.sub(r'\D', '', identifier)
    is_phone = False
    is_email = False
    clean_phone = None
    clean_username = None
    clean_email = None

    if is_valid_chat_email(identifier):
        is_email = True
        clean_email = identifier.strip().lower()
    elif len(digits_only) == 10:
        is_phone = True
        clean_phone = digits_only
    elif len(digits_only) == 12 and digits_only.startswith('91'):
        is_phone = True
        clean_phone = digits_only[2:]
    else:
        # Treat as username handle
        clean_username = identifier.lstrip('@').lower().strip()
        # If user pasted email like user@domain.com, strip domain
        if '@' in clean_username:
            clean_username = clean_username.split('@')[0]
        clean_username = re.sub(r'(?:gmail|yahoo|hotmail|outlook|icloud|proton|rediff|zoho|aol)(?:com|in|net|org)?$', '', clean_username, flags=re.I)
        clean_username = re.sub(r'[^a-z0-9_]', '', clean_username)

    conn = get_db()
    try:
        cursor = conn.cursor()
        user_row = None
        if is_email:
            cursor.execute(
                "SELECT id, google_sub, email, phone, name, username, password_hash, profile_image, gender, role, is_active FROM chat_users WHERE LOWER(email) = ? LIMIT 1",
                (clean_email,)
            )
            user_row = cursor.fetchone()
        elif is_phone:
            cursor.execute(
                "SELECT id, google_sub, email, phone, name, username, password_hash, profile_image, gender, role, is_active FROM chat_users WHERE phone = ? LIMIT 1",
                (clean_phone,)
            )
            user_row = cursor.fetchone()
        else:
            cursor.execute(
                "SELECT id, google_sub, email, phone, name, username, password_hash, profile_image, gender, role, is_active FROM chat_users WHERE LOWER(username) = ? LIMIT 1",
                (clean_username,)
            )
            user_row = cursor.fetchone()

        if not user_row:
            if is_email:
                return error_response(f"No account found with email {clean_email}. Please create an account.", 404)
            if is_phone:
                return error_response(f"No account found with mobile number +91 {clean_phone}. Please create an account.", 404)
            return error_response(f"No account found with username '@{clean_username}'. Please check your username or create an account.", 404)

        user_data = dict(user_row)
        if not user_data.get('is_active', 1):
            return error_response("This chat account is inactive. Please contact support.", 403)

        stored_pw_hash = user_data.get('password_hash')
        if not stored_pw_hash:
            return error_response("No password has been set for this account yet. Please sign in with Google or create an account.", 400)

        if not check_password_hash(stored_pw_hash, password):
            return error_response("Incorrect password. Please try again.", 401)

        # Remove password_hash from response payload
        user_data.pop('password_hash', None)

        chat_token, refresh_token = issue_chat_token(
            user_data['id'],
            user_data['email'],
            user_data.get('name'),
            user_data.get('username'),
            user_data.get('role', 'customer')
        )
        room = get_or_create_chat_room(conn, user_data['id'], user_data.get('name', 'Customer'), user_data.get('username'))
        log_chat_security_event(conn, user_data['id'], 'CHAT_LOGIN', f"Chat password login as @{user_data.get('username')}")
        conn.commit()

        return success_response({
            'chat_token': chat_token,
            'refresh_token': refresh_token,
            'user': user_data,
            'room': room
        }, "Official Chat login successful")
    finally:
        conn.close()


def get_or_create_direct_room(conn, user1_id, user2_id):
    """Finds or creates a 1-to-1 direct peer-to-peer chat room between two users."""
    u_min = min(user1_id, user2_id)
    u_max = max(user1_id, user2_id)
    room_key = f"DM-{u_min}-{u_max}"
    cursor = conn.cursor()
    cursor.execute(
        """SELECT * FROM official_chat_rooms 
           WHERE (user_id = ? AND user_two_id = ?) 
              OR (user_id = ? AND user_two_id = ?) 
              OR room_key = ? 
           LIMIT 1""",
        (u_min, u_max, u_max, u_min, room_key)
    )
    room = cursor.fetchone()
    if room:
        room_dict = dict(room)
        if not room_dict.get('e2e_secret'):
            e2e_secret = secrets.token_hex(32)
            cursor.execute("UPDATE official_chat_rooms SET e2e_secret = ? WHERE id = ?", (e2e_secret, room_dict['id']))
            conn.commit()
            room_dict['e2e_secret'] = e2e_secret
        return room_dict

    # Fetch participants to format title
    cursor.execute("SELECT id, name, username FROM chat_users WHERE id IN (?, ?)", (user1_id, user2_id))
    users = {row['id']: dict(row) for row in cursor.fetchall()}
    u1 = users.get(user1_id, {})
    u2 = users.get(user2_id, {})
    title = f"{u1.get('username') or u1.get('name') or 'User'} & {u2.get('username') or u2.get('name') or 'User'}"
    e2e_secret = secrets.token_hex(32)

    cursor.execute(
        """INSERT INTO official_chat_rooms 
           (user_id, user_two_id, room_key, title, status, room_type, last_message, e2e_secret)
           VALUES (?, ?, ?, ?, 'active', 'direct', 'Chat started', ?)""",
        (u_min, u_max, room_key, title, e2e_secret)
    )
    conn.commit()
    room_id = cursor.lastrowid
    cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ?", (room_id,))
    return dict(cursor.fetchone())


CHAT_MESSAGE_COLUMNS = (
    "id, room_id, user_id, sender_type, sender_name, message, media_url, "
    "message_type, is_read, created_at, username, reply_to_id, deleted, "
    "edited_at, updated_at"
)

CHAT_REACTION_EMOJIS = {'👍', '❤️', '😂', '😮', '😢', '🙏'}


def _sanitize_chat_message(m):
    """Normalises timestamps and hides ciphertext of deleted messages."""
    if m.get('deleted'):
        m['message'] = ''
        m['media_url'] = None
        m['message_type'] = 'deleted'
    for key in ('created_at', 'edited_at'):
        if m.get(key):
            m[key] = format_utc_iso(m[key])
    m.setdefault('reactions', [])
    return m


def _attach_message_reactions(cursor, messages, my_id):
    """Adds aggregated [{emoji, count, mine}] to a list of message dicts."""
    if not messages:
        return
    ids = [m['id'] for m in messages]
    placeholders = ",".join("?" for _ in ids)
    cursor.execute(
        f"""SELECT message_id, emoji, user_id FROM chat_message_reactions
            WHERE message_id IN ({placeholders})""",
        ids
    )
    by_message = {}
    for row in cursor.fetchall():
        per_emoji = by_message.setdefault(row['message_id'], {})
        entry = per_emoji.setdefault(row['emoji'], {'emoji': row['emoji'], 'count': 0, 'mine': False})
        entry['count'] += 1
        if row['user_id'] == my_id:
            entry['mine'] = True
    for m in messages:
        m['reactions'] = list(by_message.get(m['id'], {}).values())


def chat_block_exists(cursor, user_a, user_b):
    """True when either user has blocked the other (blocks stop both sides)."""
    cursor.execute(
        """SELECT 1 FROM chat_blocks
           WHERE (blocker_id = ? AND blocked_id = ?)
              OR (blocker_id = ? AND blocked_id = ?)
           LIMIT 1""",
        (user_a, user_b, user_b, user_a)
    )
    return cursor.fetchone() is not None


def chat_friendship_accepted(cursor, user_a, user_b):
    """True only when an ACCEPTED friend request connects the two users.

    A direct room alone is not consent: rooms can outlive/import stale data,
    so every direct message is re-checked against this.
    """
    cursor.execute(
        """SELECT 1 FROM official_chat_friend_requests
           WHERE ((sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?))
             AND status = 'accepted'
           LIMIT 1""",
        (user_a, user_b, user_b, user_a)
    )
    return cursor.fetchone() is not None


def _clean_group_title(value):
    """Group names are user text: strip control chars and cap the length."""
    title = re.sub(r'[\u0000-\u001F\u007F-\u009F]', '', str(value or '')).strip()
    return title[:80]


def _parse_group_member_ids(raw_ids, actor_id=None):
    """Normalise a member-id list (dedupe, drop the actor, cap at 49)."""
    if not isinstance(raw_ids, list):
        return None
    ids = []
    for raw in raw_ids:
        try:
            uid = int(raw)
        except (TypeError, ValueError):
            return None
        if uid <= 0 or (actor_id is not None and uid == actor_id):
            continue
        if uid not in ids:
            ids.append(uid)
    return ids[:49]


def get_chat_room_for_user(cursor, room_id, user_id):
    """Return (room_dict, allowed).

    Direct rooms keep their existing participant columns. Group rooms are
    authorised ONLY through official_chat_group_members, which also means a
    removed member loses access immediately without touching the room row.
    """
    cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ? LIMIT 1", (room_id,))
    row = cursor.fetchone()
    if not row:
        return None, False
    room = dict(row)
    if room.get('user_id') == user_id or room.get('user_two_id') == user_id:
        return room, True
    cursor.execute(
        "SELECT role FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
        (room_id, user_id)
    )
    member = cursor.fetchone()
    if member:
        room['group_role'] = member['role'] or 'member'
        return room, True
    return room, False


def _group_member_rows(cursor, room_id):
    cursor.execute(
        """SELECT gm.user_id, gm.role, gm.joined_at,
                  u.name, u.username, u.profile_image,
                  CASE WHEN u.last_seen_at >= datetime('now', '-90 seconds')
                       THEN 1 ELSE 0 END AS is_online
           FROM official_chat_group_members gm
           JOIN chat_users u ON u.id = gm.user_id
           WHERE gm.room_id = ?
           ORDER BY CASE WHEN gm.role = 'admin' THEN 0 ELSE 1 END,
                    gm.joined_at ASC, gm.user_id ASC""",
        (room_id,)
    )
    members = []
    for row in cursor.fetchall():
        member = dict(row)
        member['id'] = member.pop('user_id')
        member['is_online'] = bool(member.get('is_online'))
        member['joined_at'] = format_utc_iso(member.get('joined_at'))
        members.append(member)
    return members


def _group_member_ids(cursor, room_id):
    cursor.execute(
        "SELECT user_id FROM official_chat_group_members WHERE room_id = ? ORDER BY joined_at ASC, user_id ASC",
        (room_id,)
    )
    return [int(row['user_id']) for row in cursor.fetchall()]


def _group_unread_count(cursor, room_id, user_id):
    cursor.execute(
        """SELECT COUNT(*) AS cnt FROM official_chat_messages m
           LEFT JOIN official_chat_read_state rs
             ON rs.room_id = m.room_id AND rs.user_id = ?
           LEFT JOIN official_chat_room_clears c
             ON c.room_id = m.room_id AND c.user_id = ?
           WHERE m.room_id = ? AND m.user_id != ?
             AND m.id > COALESCE(rs.last_read_id, 0)
             AND m.id > COALESCE(c.cleared_upto_id, 0)
             AND m.id NOT IN (SELECT message_id FROM chat_message_hides WHERE user_id = ?)""",
        (user_id, user_id, room_id, user_id, user_id)
    )
    row = cursor.fetchone()
    return int(row['cnt'] or 0) if row else 0


def _build_group_conversation(cursor, room_id, user_id):
    """Inbox shape for a group. Mirrors direct conversations for the UI while
    keeping group-only fields (member_count, is_group) additive."""
    cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ? AND room_type = 'group'", (room_id,))
    row = cursor.fetchone()
    if not row:
        return None
    room = dict(row)
    cursor.execute(
        "SELECT role FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
        (room_id, user_id)
    )
    my_member = cursor.fetchone()
    if not my_member:
        return None

    member_ids = _group_member_ids(cursor, room_id)
    member_count = len(member_ids)

    cursor.execute(
        "SELECT last_read_id FROM official_chat_read_state WHERE room_id = ? AND user_id = ?",
        (room_id, user_id)
    )
    read_row = cursor.fetchone()
    last_read_id = int(read_row['last_read_id'] or 0) if read_row else 0

    cursor.execute(
        "SELECT cleared_upto_id FROM official_chat_room_clears WHERE room_id = ? AND user_id = ?",
        (room_id, user_id)
    )
    clear_row = cursor.fetchone()
    cleared_upto = int(clear_row['cleared_upto_id'] or 0) if clear_row else 0

    cursor.execute(
        """SELECT id, user_id, sender_name, message, message_type, created_at, is_read
           FROM official_chat_messages
           WHERE room_id = ? AND id > ?
             AND id NOT IN (SELECT message_id FROM chat_message_hides WHERE user_id = ?)
           ORDER BY id DESC LIMIT 1""",
        (room_id, cleared_upto, user_id)
    )
    last_msg = cursor.fetchone()

    unread_count = _group_unread_count(cursor, room_id, user_id)

    e2e_secret = room.get('e2e_secret')
    if not e2e_secret:
        e2e_secret = secrets.token_hex(32)
        cursor.execute("UPDATE official_chat_rooms SET e2e_secret = ? WHERE id = ?", (e2e_secret, room_id))

    last_message_is_read = False
    if last_msg and last_msg['user_id'] == user_id:
        # A group message counts as seen only when every other member has read it.
        cursor.execute(
            """SELECT MIN(COALESCE(rs.last_read_id, 0)) AS min_read
               FROM official_chat_group_members gm
               LEFT JOIN official_chat_read_state rs
                 ON rs.room_id = gm.room_id AND rs.user_id = gm.user_id
               WHERE gm.room_id = ? AND gm.user_id != ?""",
            (room_id, user_id)
        )
        min_row = cursor.fetchone()
        min_read = int(min_row['min_read'] or 0) if min_row else 0
        last_message_is_read = bool(member_count > 1 and min_read >= last_msg['id'])

    last_time = last_msg['created_at'] if last_msg else room.get('created_at')
    return {
        'id': room['id'],
        'room_key': room['room_key'],
        'e2e_secret': e2e_secret,
        'room_type': 'group',
        'is_group': True,
        'is_direct': False,
        'is_system': False,
        'other_user': None,
        'contact_name': room.get('title') or 'Group',
        'contact_username': 'group',
        'contact_avatar': room.get('avatar') or None,
        'contact_online': False,
        'contact_public_key': None,
        'contact_bio': f"{member_count} member{'s' if member_count != 1 else ''}",
        'contact_joined_at': format_utc_iso(room.get('created_at')),
        'blocked_by_me': False,
        'blocked_me': False,
        'last_message': (last_msg['message'] if last_msg else '') or '',
        'last_message_at': format_utc_iso(last_time) if last_time else None,
        'last_message_user_id': last_msg['user_id'] if last_msg else None,
        'last_message_sender_name': last_msg['sender_name'] if last_msg else None,
        'last_message_type': (last_msg['message_type'] or 'text') if last_msg else 'text',
        'last_message_is_read': last_message_is_read,
        'unread_count': unread_count,
        'member_count': member_count,
        'member_ids': member_ids,
        'creator_id': room.get('user_id'),
        'is_creator': same_id_check(room.get('user_id'), user_id),
        'my_role': my_member['role'] or 'member',
        'last_read_id': last_read_id,
    }


def same_id_check(a, b):
    """Small helper kept local to avoid importing the frontend id helper."""
    try:
        return int(a) == int(b)
    except (TypeError, ValueError):
        return False


def _group_details(cursor, room_id, user_id):
    cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ? AND room_type = 'group'", (room_id,))
    row = cursor.fetchone()
    if not row:
        return None
    room = dict(row)
    cursor.execute(
        "SELECT role FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
        (room_id, user_id)
    )
    my_member = cursor.fetchone()
    if not my_member:
        return None
    members = _group_member_rows(cursor, room_id)
    return {
        'id': room['id'],
        'title': room.get('title') or 'Group',
        'name': room.get('title') or 'Group',
        'avatar': room.get('avatar') or None,
        'room_key': room['room_key'],
        'room_type': 'group',
        'e2e_secret': room.get('e2e_secret'),
        'creator_id': room.get('user_id'),
        'is_creator': same_id_check(room.get('user_id'), user_id),
        'my_role': my_member['role'] or 'member',
        'member_count': len(members),
        'members': members,
        'created_at': format_utc_iso(room.get('created_at')),
    }


def _group_member_is_admin(cursor, room_id, user_id):
    cursor.execute(
        "SELECT role FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
        (room_id, user_id)
    )
    row = cursor.fetchone()
    return bool(row and (row['role'] or '') in ('admin', 'creator'))


def _insert_group_notifications(cursor, room_id, member_ids, title, message):
    """Create inbox notifications for group membership changes."""
    for member_id in member_ids:
        cursor.execute(
            """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
               VALUES (?, ?, ?, ?)""",
            (member_id, room_id, title[:120], message[:500])
        )


def _dispatch_chat_pushes(user_ids, title, body, url, tag=None):
    """Best-effort Web Push + FCM to chat users, off the request thread.

    Used for group fan-out (messages, creation, new members) where a single
    recipient-loop in the route would duplicate the thread/import boilerplate.
    Never raises: push delivery must not affect the chat flow.
    """
    ids = []
    for uid in user_ids or []:
        try:
            uid = int(uid)
        except (TypeError, ValueError):
            continue
        if uid > 0 and uid not in ids:
            ids.append(uid)
    if not ids:
        return
    try:
        import threading
        from notifications.notification_service import send_chat_device_push, send_chat_push
    except Exception as push_err:
        logger.warning("Chat push unavailable: %s", push_err)
        return
    for uid in ids:
        try:
            threading.Thread(
                target=send_chat_push,
                args=(uid, title, body, url, tag),
                daemon=True,
            ).start()
            threading.Thread(
                target=send_chat_device_push,
                args=(uid, title, body, url),
                daemon=True,
            ).start()
        except Exception as push_err:
            logger.warning("Chat push dispatch failed for %s: %s", uid, push_err)


@chat_bp.route('/messages/<int:message_id>', methods=['PATCH'])
@chat_token_required
def edit_chat_message(message_id):
    """Edit an own text message within 15 minutes."""
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    new_text = (data.get('message') or '').strip()
    if not new_text:
        return error_response("Message text is required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT {CHAT_MESSAGE_COLUMNS} FROM official_chat_messages WHERE id = ?",
            (message_id,)
        )
        row = cursor.fetchone()
        if not row:
            return error_response("Message not found", 404)
        msg = dict(row)

        room, room_allowed = get_chat_room_for_user(cursor, msg['room_id'], my_id)
        if not room_allowed:
            return error_response("Access denied to this chat room", 403)
        # Official specialist/admin rows carry the customer's own user_id
        # (schema legacy), so the user_id check alone would let a customer
        # rewrite or tombstone messages shown as sent by "JDLX Senior
        # Specialist". Staff-authored content is identified by sender_type and
        # is never editable by chat users.
        if (msg.get('sender_type') or 'user') != 'user':
            return error_response("You can only edit your own messages", 403)
        if msg['user_id'] != my_id:
            return error_response("You can only edit your own messages", 403)
        if msg.get('deleted'):
            return error_response("Deleted messages cannot be edited", 400)
        if msg.get('message_type') != 'text':
            return error_response("Only text messages can be edited", 400)

        try:
            created = datetime.datetime.fromisoformat(
                str(msg['created_at']).replace(' ', 'T').replace('Z', '+00:00')
            )
            if created.tzinfo is None:
                created = created.replace(tzinfo=datetime.timezone.utc)
            too_old = (
                datetime.datetime.now(datetime.timezone.utc) - created
            ).total_seconds() > 900
        except Exception:
            too_old = False
        if too_old:
            return error_response("Messages can only be edited within 15 minutes", 400)

        cursor.execute(
            """UPDATE official_chat_messages
               SET message = ?, edited_at = CURRENT_TIMESTAMP, updated_at = ?
               WHERE id = ?""",
            (new_text, int(time.time()), message_id)
        )

        # Keep the inbox preview in sync when the edited message is the latest.
        cursor.execute(
            "SELECT MAX(id) AS max_id FROM official_chat_messages WHERE room_id = ?",
            (msg['room_id'],)
        )
        latest = cursor.fetchone()
        if latest and latest['max_id'] == message_id:
            preview = new_text if new_text.startswith(('enc:v1:', 'enc:v2:')) else new_text[:60]
            cursor.execute(
                "UPDATE official_chat_rooms SET last_message = ? WHERE id = ?",
                (preview, msg['room_id'])
            )
        conn.commit()

        cursor.execute(
            f"SELECT {CHAT_MESSAGE_COLUMNS} FROM official_chat_messages WHERE id = ?",
            (message_id,)
        )
        updated = dict(cursor.fetchone())
        _attach_message_reactions(cursor, [updated], my_id)
        _sanitize_chat_message(updated)
        return success_response([updated], "Message edited")
    finally:
        conn.close()


@chat_bp.route('/messages/<int:message_id>', methods=['DELETE'])
@chat_token_required
def delete_chat_message(message_id):
    """Delete for me (hide) or for everyone (sender-only tombstone)."""
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    scope = str(request.args.get('scope') or data.get('scope') or 'me').strip().lower()
    if scope not in ('me', 'everyone'):
        return error_response("Invalid delete scope", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, room_id, user_id, sender_type FROM official_chat_messages WHERE id = ?",
            (message_id,)
        )
        msg = cursor.fetchone()
        if not msg:
            return error_response("Message not found", 404)

        room, room_allowed = get_chat_room_for_user(cursor, msg['room_id'], my_id)
        if not room_allowed:
            return error_response("Access denied to this chat room", 403)

        if scope == 'me':
            cursor.execute(
                "INSERT OR IGNORE INTO chat_message_hides (message_id, user_id) VALUES (?, ?)",
                (message_id, my_id)
            )
            conn.commit()
            return success_response({'message_id': message_id, 'scope': 'me'}, "Message deleted for you")

        if (msg['sender_type'] or 'user') != 'user':
            # Specialist/admin rows are authored by staff (sender_type), even
            # though their user_id is the customer's own — never tombstoneable
            # by the customer ("delete for everyone").
            return error_response("You can only delete your own message for everyone", 403)
        if msg['user_id'] != my_id:
            return error_response("You can only delete your own message for everyone", 403)

        cursor.execute(
            """UPDATE official_chat_messages
               SET message = '', media_url = NULL, message_type = 'deleted',
                   deleted = 1, edited_at = NULL, updated_at = ?
               WHERE id = ?""",
            (int(time.time()), message_id)
        )
        cursor.execute(
            "SELECT MAX(id) AS max_id FROM official_chat_messages WHERE room_id = ?",
            (msg['room_id'],)
        )
        latest = cursor.fetchone()
        if latest and latest['max_id'] == message_id:
            cursor.execute(
                "UPDATE official_chat_rooms SET last_message = ? WHERE id = ?",
                ("This message was deleted", msg['room_id'])
            )
        conn.commit()
        return success_response({'message_id': message_id, 'scope': 'everyone'}, "Message deleted")
    finally:
        conn.close()


@chat_bp.route('/messages/<int:message_id>/reaction', methods=['POST'])
@chat_token_required
def react_to_chat_message(message_id):
    """Toggle one emoji reaction per user per message."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("reaction", f"user_{my_id}", max_requests=60, window_seconds=60):
        return error_response("Too many reactions.", 429)

    data = request.get_json(silent=True) or {}
    emoji = str(data.get('emoji') or '').strip()
    if emoji not in CHAT_REACTION_EMOJIS:
        return error_response("Unsupported reaction", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, room_id FROM official_chat_messages WHERE id = ?", (message_id,)
        )
        msg = cursor.fetchone()
        if not msg:
            return error_response("Message not found", 404)

        room, room_allowed = get_chat_room_for_user(cursor, msg['room_id'], my_id)
        if not room_allowed:
            return error_response("Access denied to this chat room", 403)

        cursor.execute(
            "SELECT emoji FROM chat_message_reactions WHERE message_id = ? AND user_id = ?",
            (message_id, my_id)
        )
        existing = cursor.fetchone()
        if existing and existing['emoji'] == emoji:
            cursor.execute(
                "DELETE FROM chat_message_reactions WHERE message_id = ? AND user_id = ?",
                (message_id, my_id)
            )
        else:
            cursor.execute(
                """INSERT OR REPLACE INTO chat_message_reactions
                   (message_id, user_id, emoji, created_at)
                   VALUES (?, ?, ?, CURRENT_TIMESTAMP)""",
                (message_id, my_id, emoji)
            )
        cursor.execute(
            "UPDATE official_chat_messages SET updated_at = ? WHERE id = ?",
            (int(time.time()), message_id)
        )
        conn.commit()

        holder = {'id': message_id}
        _attach_message_reactions(cursor, [holder], my_id)
        return success_response({'reactions': holder['reactions']}, "Reaction updated")
    finally:
        conn.close()


@chat_bp.route('/users/<int:target_id>/block', methods=['POST'])
@chat_token_required
def block_chat_user(target_id):
    """Block a user: stops DMs and friend requests in both directions."""
    my_id = request.chat_user['user_id']
    if target_id == my_id:
        return error_response("You cannot block yourself", 400)
    if not check_chat_rate_limit("block", f"user_{my_id}", max_requests=30, window_seconds=3600):
        return error_response("Too many block updates. Please try again later.", 429)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM chat_users WHERE id = ?", (target_id,))
        if not cursor.fetchone():
            return error_response("User not found", 404)

        cursor.execute(
            "INSERT OR IGNORE INTO chat_blocks (blocker_id, blocked_id) VALUES (?, ?)",
            (my_id, target_id)
        )
        # Drop pending requests so the block also cleans up the social state.
        cursor.execute(
            """DELETE FROM official_chat_friend_requests
               WHERE status = 'pending'
                 AND ((sender_id = ? AND receiver_id = ?)
                   OR (sender_id = ? AND receiver_id = ?))""",
            (my_id, target_id, target_id, my_id)
        )
        conn.commit()
        return success_response({'blocked': True, 'user_id': target_id}, "User blocked")
    finally:
        conn.close()


@chat_bp.route('/users/<int:target_id>/block', methods=['DELETE'])
@chat_token_required
def unblock_chat_user(target_id):
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM chat_blocks WHERE blocker_id = ? AND blocked_id = ?",
            (my_id, target_id)
        )
        conn.commit()
        return success_response({'blocked': False, 'user_id': target_id}, "User unblocked")
    finally:
        conn.close()


@chat_bp.route('/blocks', methods=['GET'])
@chat_token_required
def list_blocked_chat_users():
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT b.blocked_id AS id, b.created_at, u.name, u.username, u.profile_image
               FROM chat_blocks b JOIN chat_users u ON u.id = b.blocked_id
               WHERE b.blocker_id = ?
               ORDER BY b.created_at DESC""",
            (my_id,)
        )
        return success_response([dict(r) for r in cursor.fetchall()], "Blocked users retrieved")
    finally:
        conn.close()


@chat_bp.route('/reports', methods=['POST'])
@chat_token_required
def report_chat_user():
    """Report a user for abuse. Stored for admin review."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("report", f"user_{my_id}", max_requests=10, window_seconds=3600):
        return error_response("Too many reports. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    reported_id = data.get('reported_user_id') or data.get('user_id')
    try:
        reported_id = int(reported_id)
    except (TypeError, ValueError):
        return error_response("Invalid reported user", 400)
    if reported_id == my_id:
        return error_response("You cannot report yourself", 400)

    reason = str(data.get('reason') or '').strip().lower()
    if reason not in {'spam', 'harassment', 'scam', 'impersonation', 'other'}:
        return error_response("Invalid report reason", 400)
    details = str(data.get('details') or '').strip()[:2000]

    room_id = data.get('room_id')
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM chat_users WHERE id = ?", (reported_id,))
        if not cursor.fetchone():
            return error_response("User not found", 404)

        if room_id is not None:
            try:
                room_id = int(room_id)
            except (TypeError, ValueError):
                return error_response("Invalid room", 400)
            room, room_allowed = get_chat_room_for_user(cursor, room_id, my_id)
            if not room:
                return error_response("Chat room not found", 404)
            if not room_allowed:
                return error_response("Access denied to this chat room", 403)
        else:
            room_id = None

        cursor.execute(
            """INSERT INTO chat_reports (reporter_id, reported_id, room_id, reason, details)
               VALUES (?, ?, ?, ?, ?)""",
            (my_id, reported_id, room_id, reason, details)
        )
        report_id = cursor.lastrowid
        conn.commit()
        return success_response({'report_id': report_id}, "Report submitted")
    finally:
        conn.close()


@chat_bp.route('/users/search', methods=['GET'])
@chat_token_required
def search_chat_users():
    """Find users by @username or name (a full 10-digit mobile number matches
    exactly). Email/phone are never returned: search is unauthenticated-adjacent
    PII surface, and prefix-matching phone numbers let anyone enumerate
    accounts."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("search", f"user_{my_id}", max_requests=120, window_seconds=60):
        return error_response("Too many searches. Please wait a moment.", 429)

    q = (request.args.get('q') or '').strip().lstrip('@').lower()
    if not q:
        return success_response([])

    # Exact identifiers only: a full mobile number or a complete email address
    # (people share those deliberately). Prefix/wildcard phone/email search is
    # removed so nobody can walk the number/handle space and harvest accounts.
    phone_exact = None
    if re.fullmatch(r'(?:\+91)?\d{10}', q):
        phone_exact = q[-10:]
    email_exact = q if is_valid_chat_email(q) else None

    conn = get_db()
    try:
        cursor = conn.cursor()
        base_select = """
            SELECT 
                u.id, 
                u.name, 
                u.username, 
                u.profile_image, 
                u.role,
                CASE WHEN u.last_seen_at >= datetime('now', '-90 seconds') THEN 1 ELSE 0 END AS is_online,
                fr.id AS friend_request_id,
                fr.sender_id AS fr_sender_id,
                fr.status AS fr_status,
                r.id AS room_id
            FROM chat_users u
            LEFT JOIN official_chat_friend_requests fr ON fr.id = (
                SELECT id FROM official_chat_friend_requests
                WHERE (sender_id = ? AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = ?)
                ORDER BY id DESC LIMIT 1
            )
            LEFT JOIN official_chat_rooms r ON r.id = (
                SELECT id FROM official_chat_rooms
                WHERE (user_id = ? AND user_two_id = u.id) OR (user_id = u.id AND user_two_id = ?)
                LIMIT 1
            )
        """
        if email_exact:
            cursor.execute(
                base_select + """
                WHERE LOWER(u.email) = ? AND u.id != ?
                  AND u.id NOT IN (SELECT blocked_id FROM chat_blocks WHERE blocker_id = ?)
                  AND u.id NOT IN (SELECT blocker_id FROM chat_blocks WHERE blocked_id = ?)
                LIMIT 1
                """,
                (my_id, my_id, my_id, my_id, email_exact, my_id, my_id, my_id)
            )
        elif phone_exact:
            cursor.execute(
                base_select + """
                WHERE u.phone = ? AND u.id != ?
                  AND u.id NOT IN (SELECT blocked_id FROM chat_blocks WHERE blocker_id = ?)
                  AND u.id NOT IN (SELECT blocker_id FROM chat_blocks WHERE blocked_id = ?)
                LIMIT 1
                """,
                (my_id, my_id, my_id, my_id, phone_exact, my_id, my_id, my_id)
            )
        else:
            prefix = f"{q}%"
            like_q = f"%{q}%"
            cursor.execute(
                base_select + """
                WHERE (LOWER(u.username) LIKE ? OR LOWER(u.name) LIKE ?) AND u.id != ?
                  AND u.id NOT IN (SELECT blocked_id FROM chat_blocks WHERE blocker_id = ?)
                  AND u.id NOT IN (SELECT blocker_id FROM chat_blocks WHERE blocked_id = ?)
                ORDER BY 
                    CASE WHEN LOWER(u.username) = ? THEN 0
                         WHEN LOWER(u.username) LIKE ? THEN 1
                         WHEN LOWER(u.name) LIKE ? THEN 2
                         ELSE 3 END,
                    u.id ASC
                LIMIT 30
                """,
                (my_id, my_id, my_id, my_id, like_q, like_q, my_id, my_id, my_id, q, prefix, prefix)
            )

        rows = cursor.fetchall()
        users = []
        for row in rows:
            u = {
                'id': row['id'],
                'name': row['name'],
                'username': row['username'],
                'profile_image': row['profile_image'],
                'role': row['role'],
                'is_online': bool(row['is_online']),
                'room_id': row['room_id'],
                'friend_request_id': row['friend_request_id']
            }
            fr_status = row['fr_status']
            if fr_status == 'accepted':
                u['friend_status'] = 'friends'
            elif fr_status and row['fr_sender_id'] == my_id:
                u['friend_status'] = 'pending_sent'
            elif fr_status:
                u['friend_status'] = 'pending_received'
            else:
                u['friend_status'] = 'none'
            users.append(u)

        return success_response(users, "Users found")
    finally:
        conn.close()


@chat_bp.route('/conversations', methods=['GET'])
@chat_token_required
def get_chat_conversations():
    """Returns list of active conversation threads for current user (WhatsApp-like inbox).
    Optimized: Replaces 51+ sequential N+1 Turso queries with a single unified SQL query.
    """
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT 
                   r.id AS room_id,
                   r.room_key,
                   r.e2e_secret,
                   r.created_at,
                   u.id AS other_id,
                   u.name AS contact_name,
                   u.username AS contact_username,
                   u.profile_image AS contact_avatar,
                   u.public_key AS contact_public_key,
                   COALESCE(u.bio, 'Hey there! I am using JDLX Chat') AS contact_bio,
                   u.created_at AS contact_joined_at,
                   CASE WHEN u.last_seen_at >= datetime('now', '-90 seconds') THEN 1 ELSE 0 END AS contact_online,
                   CASE WHEN b_me.blocker_id IS NOT NULL THEN 1 ELSE 0 END AS blocked_by_me,
                   CASE WHEN b_them.blocker_id IS NOT NULL THEN 1 ELSE 0 END AS blocked_me,
                   COALESCE(unread.cnt, 0) AS unread_count,
                   last_msg.id AS last_msg_id,
                   last_msg.message AS last_msg_text,
                   last_msg.created_at AS last_msg_created_at,
                   last_msg.user_id AS last_msg_user_id,
                   last_msg.sender_name AS last_msg_sender_name,
                   CASE 
                       WHEN last_msg.deleted = 1 THEN 'deleted'
                       WHEN last_msg.message_type IS NOT NULL AND last_msg.message_type != '' THEN last_msg.message_type
                       ELSE 'text'
                   END AS last_msg_type,
                   COALESCE(last_msg.is_read, 0) AS last_msg_is_read
               FROM official_chat_rooms r
               JOIN chat_users u ON u.id = CASE WHEN r.user_id = ? THEN r.user_two_id ELSE r.user_id END
               LEFT JOIN chat_blocks b_me ON b_me.blocker_id = ? AND b_me.blocked_id = u.id
               LEFT JOIN chat_blocks b_them ON b_them.blocker_id = u.id AND b_them.blocked_id = ?
               LEFT JOIN official_chat_room_clears c_clear ON c_clear.room_id = r.id AND c_clear.user_id = ?
               LEFT JOIN (
                   SELECT room_id, COUNT(*) AS cnt
                   FROM official_chat_messages
                   WHERE (user_id != ? OR sender_type != 'user') AND is_read = 0
                   GROUP BY room_id
               ) unread ON unread.room_id = r.id
               LEFT JOIN official_chat_messages last_msg ON last_msg.id = (
                   SELECT id FROM official_chat_messages
                   WHERE room_id = r.id
                     AND id > COALESCE(c_clear.cleared_upto_id, 0)
                     AND id NOT IN (SELECT message_id FROM chat_message_hides WHERE user_id = ?)
                   ORDER BY id DESC LIMIT 1
               )
               WHERE r.user_two_id IS NOT NULL 
                 AND (r.user_id = ? OR r.user_two_id = ?)
               ORDER BY COALESCE(last_msg.created_at, r.created_at) DESC""",
            (my_id, my_id, my_id, my_id, my_id, my_id, my_id, my_id)
        )
        rows = cursor.fetchall()
        conversations = []
        needs_commit = False

        for r in rows:
            room_id = r['room_id']
            other_id = r['other_id']
            e2e_sec = r['e2e_secret']
            if not e2e_sec:
                e2e_sec = secrets.token_hex(32)
                cursor.execute("UPDATE official_chat_rooms SET e2e_secret = ? WHERE id = ?", (e2e_sec, room_id))
                needs_commit = True

            contact_name = r['contact_name'] or r['contact_username'] or 'Friend'
            contact_username = r['contact_username'] or f"user_{other_id}"

            has_last_msg = r['last_msg_id'] is not None
            raw_last_msg = r['last_msg_text'] if has_last_msg else ''
            last_msg_time = r['last_msg_created_at'] if has_last_msg else r['created_at']

            conversations.append({
                'id': room_id,
                'room_key': r['room_key'],
                'e2e_secret': e2e_sec,
                'room_type': 'direct',
                'is_group': False,
                'is_direct': True,
                'is_system': False,
                'other_user': {
                    'id': other_id,
                    'name': r['contact_name'],
                    'username': r['contact_username'],
                    'profile_image': r['contact_avatar'],
                    'public_key': r['contact_public_key'],
                    'bio': r['contact_bio'] or 'Hey there! I am using JDLX Chat',
                    'is_online': bool(r['contact_online'])
                },
                'contact_name': contact_name,
                'contact_username': contact_username,
                'contact_avatar': r['contact_avatar'],
                'contact_online': bool(r['contact_online']),
                'contact_public_key': r['contact_public_key'],
                'contact_bio': r['contact_bio'] or 'Hey there! I am using JDLX Chat',
                'contact_joined_at': format_utc_iso(r['contact_joined_at']) if r['contact_joined_at'] else None,
                'blocked_by_me': bool(r['blocked_by_me']),
                'blocked_me': bool(r['blocked_me']),
                'last_message': raw_last_msg or '',
                'last_message_at': format_utc_iso(last_msg_time) if last_msg_time else None,
                'last_message_user_id': r['last_msg_user_id'] if has_last_msg else None,
                'last_message_sender_name': r['last_msg_sender_name'] if has_last_msg else None,
                'last_message_type': (r['last_msg_type'] or 'text') if has_last_msg else 'text',
                'last_message_is_read': bool(r['last_msg_is_read']) if has_last_msg else False,
                'unread_count': int(r['unread_count']),
                'member_count': 2,
                'member_ids': [other_id] if other_id else []
            })

        # Groups are additive: the direct query above is untouched so existing
        # 1-to-1 inbox behaviour stays exactly the same.
        cursor.execute(
            """SELECT gm.room_id
               FROM official_chat_group_members gm
               JOIN official_chat_rooms r ON r.id = gm.room_id
               WHERE gm.user_id = ? AND r.room_type = 'group' AND r.status != 'deleted'""",
            (my_id,)
        )
        for group_row in cursor.fetchall():
            group_conv = _build_group_conversation(cursor, group_row['room_id'], my_id)
            if group_conv:
                conversations.append(group_conv)

        conversations.sort(
            key=lambda c: c.get('last_message_at') or c.get('contact_joined_at') or '',
            reverse=True
        )

        if needs_commit:
            conn.commit()

        return success_response(conversations, "Conversations retrieved")
    finally:
        conn.close()


@chat_bp.route('/direct-chat/<int:target_user_id>', methods=['POST'])
@chat_token_required
def open_direct_chat(target_user_id):
    """Start or open a direct 1-to-1 conversation with another user."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("direct_chat", f"user_{my_id}", max_requests=30, window_seconds=60):
        return error_response("Too many chat requests. Please wait a moment.", 429)
    if my_id == target_user_id:
        return error_response("You cannot create a conversation with yourself", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, username, profile_image, public_key FROM chat_users WHERE id = ?", (target_user_id,))
        target_user = cursor.fetchone()
        if not target_user:
            return error_response("User not found", 404)

        # Consent gate (strict): a 1-to-1 chat can only be opened when an
        # ACCEPTED friend request connects the two users. An existing room no
        # longer bypasses this - a stale/legacy room must never become a way to
        # message someone who never accepted the request.
        if not chat_friendship_accepted(cursor, my_id, target_user_id):
            return error_response(
                "Send a friend request first - you can chat once they accept it.",
                403
            )

        if chat_block_exists(cursor, my_id, target_user_id):
            return error_response("You can't start a chat with this user.", 403)

        room = get_or_create_direct_room(conn, my_id, target_user_id)
        target_dict = dict(target_user)
        conn.commit()

        conversation = {
            'id': room['id'],
            'room_key': room['room_key'],
            'e2e_secret': room.get('e2e_secret') or room.get('room_key'),
            'is_direct': True,
            'is_system': False,
            'other_user': target_dict,
            'contact_name': target_dict.get('name') or target_dict.get('username'),
            'contact_username': target_dict.get('username') or f"user_{target_user_id}",
            'contact_avatar': target_dict.get('profile_image'),
            'contact_public_key': target_dict.get('public_key'),
            'contact_bio': target_dict.get('bio') or 'Hey there! I am using JDLX Chat',
            'contact_joined_at': format_utc_iso(target_dict.get('created_at')) if target_dict.get('created_at') else None,
            'last_message': room.get('last_message') or 'Conversation opened',
            'last_message_at': format_utc_iso(room.get('last_message_at') or room.get('created_at')),
            'unread_count': 0
        }

        return success_response({
            'room': room,
            'conversation': conversation
        }, "Direct chat opened")
    finally:
        conn.close()


# -----------------------------------------------------------------------------
# GROUP CHAT
# -----------------------------------------------------------------------------

MAX_GROUP_MEMBERS = 50


def _validate_group_friends(cursor, actor_id, member_ids):
    """Every new group member must be an accepted friend of the actor.

    This preserves the existing social consent model: a group can't be used to
    pull a stranger into a conversation they never agreed to join.
    """
    if not member_ids:
        return None
    placeholders = ','.join('?' for _ in member_ids)
    cursor.execute(
        f"SELECT id, name, username FROM chat_users WHERE id IN ({placeholders})",
        member_ids
    )
    found = {int(row['id']): dict(row) for row in cursor.fetchall()}
    for member_id in member_ids:
        if member_id not in found:
            return "One of the selected friends no longer exists"
        if chat_block_exists(cursor, actor_id, member_id):
            return "You can't add a blocked user to a group"
        if not chat_friendship_accepted(cursor, actor_id, member_id):
            return "You can only add friends who accepted your friend request"
    return found


@chat_bp.route('/groups', methods=['POST'])
@chat_token_required
def create_chat_group():
    """Create a group from accepted friends and add it to the inbox."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("group_create", f"user_{my_id}", max_requests=10, window_seconds=3600):
        return error_response("Too many groups created. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    name = _clean_group_title(data.get('name') or data.get('title'))
    if len(name) < 2:
        return error_response("Group name must be at least 2 characters", 400)

    member_ids = _parse_group_member_ids(data.get('member_ids'), my_id)
    if member_ids is None:
        return error_response("Invalid group members", 400)
    if not member_ids:
        return error_response("Add at least one friend to create a group", 400)
    if len(member_ids) + 1 > MAX_GROUP_MEMBERS:
        return error_response(f"A group can have at most {MAX_GROUP_MEMBERS} members", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        members = _validate_group_friends(cursor, my_id, member_ids)
        if isinstance(members, str):
            return error_response(members, 403)

        room_key = f"GRP-{my_id}-{secrets.token_hex(6)}"
        e2e_secret = secrets.token_hex(32)
        cursor.execute(
            """INSERT INTO official_chat_rooms
               (user_id, user_two_id, room_key, title, status, room_type,
                last_message, last_message_at, e2e_secret)
               VALUES (?, NULL, ?, ?, 'active', 'group', 'Group created', CURRENT_TIMESTAMP, ?)""",
            (my_id, room_key, name, e2e_secret)
        )
        room_id = cursor.lastrowid
        cursor.execute(
            """INSERT INTO official_chat_group_members
               (room_id, user_id, role, added_by) VALUES (?, ?, 'admin', ?)""",
            (room_id, my_id, my_id)
        )
        for member_id in member_ids:
            cursor.execute(
                """INSERT INTO official_chat_group_members
                   (room_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)""",
                (room_id, member_id, my_id)
            )

        actor = request.chat_user.get('username') or f"user_{my_id}"
        _insert_group_notifications(
            cursor, room_id, member_ids,
            f"Added to {name}",
            f"@{actor} added you to the group \"{name}\""
        )
        conn.commit()

        conversation = _build_group_conversation(cursor, room_id, my_id)
        conn.commit()
        _dispatch_chat_pushes(
            member_ids,
            f"Added to {name}",
            f"@{actor} added you to the group \"{name}\"",
            f"/chat?room={room_id}",
            f"group-added-{room_id}",
        )
        return success_response({
            'group': _group_details(cursor, room_id, my_id),
            'conversation': conversation
        }, "Group created", 201)
    finally:
        conn.close()


@chat_bp.route('/groups/<int:room_id>', methods=['GET'])
@chat_token_required
def get_chat_group(room_id):
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        group = _group_details(cursor, room_id, my_id)
        if not group:
            return error_response("Group not found or you are not a member", 404)
        return success_response(group, "Group retrieved")
    finally:
        conn.close()


@chat_bp.route('/groups/<int:room_id>', methods=['PATCH'])
@chat_token_required
def rename_chat_group(room_id):
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    name = _clean_group_title(data.get('name') or data.get('title'))
    if len(name) < 2:
        return error_response("Group name must be at least 2 characters", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        group = _group_details(cursor, room_id, my_id)
        if not group:
            return error_response("Group not found or you are not a member", 404)
        if not _group_member_is_admin(cursor, room_id, my_id):
            return error_response("Only group admins can rename this group", 403)

        cursor.execute("UPDATE official_chat_rooms SET title = ? WHERE id = ?", (name, room_id))
        conn.commit()
        return success_response(_group_details(cursor, room_id, my_id), "Group renamed")
    finally:
        conn.close()


@chat_bp.route('/groups/<int:room_id>/avatar', methods=['PATCH'])
@chat_token_required
def update_chat_group_avatar(room_id):
    """Set or clear the group picture. Admins only.

    The image itself is uploaded through /chat/upload (kind=avatar); this
    endpoint stores the resulting media URL on the group room.
    """
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    avatar = str(data.get('avatar') or '').strip()
    if avatar:
        if len(avatar) > 1000:
            return error_response("Invalid group picture URL", 400)
        if not (avatar.startswith('/static/') or avatar.startswith('http://') or avatar.startswith('https://')):
            return error_response("Invalid group picture URL", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        group = _group_details(cursor, room_id, my_id)
        if not group:
            return error_response("Group not found or you are not a member", 404)
        if not _group_member_is_admin(cursor, room_id, my_id):
            return error_response("Only group admins can change the group picture", 403)

        cursor.execute(
            "UPDATE official_chat_rooms SET avatar = ? WHERE id = ?",
            (avatar or None, room_id)
        )
        conn.commit()
        return success_response(
            _group_details(cursor, room_id, my_id),
            "Group picture updated" if avatar else "Group picture removed"
        )
    finally:
        conn.close()


@chat_bp.route('/groups/<int:room_id>/members/<int:member_id>/role', methods=['PATCH'])
@chat_token_required
def update_chat_group_member_role(room_id, member_id):
    """Promote a member to admin or demote an admin back to member.

    The creator keeps admin rights for the life of the group, and an admin
    cannot change their own role (so a group always has a reachable admin).
    """
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    role = str(data.get('role') or '').strip().lower()
    if role not in ('admin', 'member'):
        return error_response("Role must be 'admin' or 'member'", 400)
    if same_id_check(member_id, my_id):
        return error_response("You can't change your own role", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        group = _group_details(cursor, room_id, my_id)
        if not group:
            return error_response("Group not found or you are not a member", 404)
        if not _group_member_is_admin(cursor, room_id, my_id):
            return error_response("Only group admins can change member roles", 403)
        if same_id_check(group.get('creator_id'), member_id):
            return error_response("The group creator is always an admin", 400)

        cursor.execute(
            "SELECT role FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
            (room_id, member_id)
        )
        member = cursor.fetchone()
        if not member:
            return error_response("This person is not in the group", 404)

        if (member['role'] or 'member') == role:
            return success_response(_group_details(cursor, room_id, my_id), "Role already set")

        cursor.execute(
            "UPDATE official_chat_group_members SET role = ? WHERE room_id = ? AND user_id = ?",
            (role, room_id, member_id)
        )
        if role == 'admin':
            title = f"You are now an admin of {group['title']}"
            message = f"@{request.chat_user.get('username') or my_id} made you an admin of \"{group['title']}\""
        else:
            title = f"Admin rights removed in {group['title']}"
            message = f"You are no longer an admin of \"{group['title']}\""
        cursor.execute(
            """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
               VALUES (?, ?, ?, ?)""",
            (member_id, room_id, title[:120], message[:500])
        )
        conn.commit()
        return success_response(_group_details(cursor, room_id, my_id), "Member role updated")
    finally:
        conn.close()


@chat_bp.route('/groups/<int:room_id>/members', methods=['POST'])
@chat_token_required
def add_chat_group_members(room_id):
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("group_add_member", f"user_{my_id}", max_requests=30, window_seconds=3600):
        return error_response("Too many member changes. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    new_ids = _parse_group_member_ids(data.get('member_ids'), my_id)
    if not new_ids:
        return error_response("Select at least one friend to add", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        group = _group_details(cursor, room_id, my_id)
        if not group:
            return error_response("Group not found or you are not a member", 404)
        if not _group_member_is_admin(cursor, room_id, my_id):
            return error_response("Only group admins can add members", 403)

        existing_ids = set(_group_member_ids(cursor, room_id))
        new_ids = [uid for uid in new_ids if uid not in existing_ids]
        if not new_ids:
            return error_response("Those friends are already in this group", 400)
        if len(existing_ids) + len(new_ids) > MAX_GROUP_MEMBERS:
            return error_response(f"A group can have at most {MAX_GROUP_MEMBERS} members", 400)

        members = _validate_group_friends(cursor, my_id, new_ids)
        if isinstance(members, str):
            return error_response(members, 403)

        cursor.execute(
            "SELECT COALESCE(MAX(id), 0) AS max_id FROM official_chat_messages WHERE room_id = ?",
            (room_id,)
        )
        joined_at_id = int(cursor.fetchone()['max_id'] or 0)
        for member_id in new_ids:
            cursor.execute(
                """INSERT INTO official_chat_group_members
                   (room_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)""",
                (room_id, member_id, my_id)
            )
            # New members see prior history but start with zero unread instead of
            # inheriting every old message as an unread badge.
            if joined_at_id:
                cursor.execute(
                    """INSERT OR REPLACE INTO official_chat_read_state
                       (room_id, user_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)""",
                    (room_id, member_id, joined_at_id, int(time.time()))
                )

        actor = request.chat_user.get('username') or f"user_{my_id}"
        _insert_group_notifications(
            cursor, room_id, new_ids,
            f"Added to {group['title']}",
            f"@{actor} added you to the group \"{group['title']}\""
        )
        conn.commit()
        _dispatch_chat_pushes(
            new_ids,
            f"Added to {group['title']}",
            f"@{actor} added you to the group \"{group['title']}\"",
            f"/chat?room={room_id}",
            f"group-added-{room_id}",
        )
        return success_response(_group_details(cursor, room_id, my_id), "Members added")
    finally:
        conn.close()


@chat_bp.route('/groups/<int:room_id>/members/<int:member_id>', methods=['DELETE'])
@chat_token_required
def remove_chat_group_member(room_id, member_id):
    my_id = request.chat_user['user_id']
    if member_id == my_id:
        return error_response("Use leave group to remove yourself", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        group = _group_details(cursor, room_id, my_id)
        if not group:
            return error_response("Group not found or you are not a member", 404)
        if not _group_member_is_admin(cursor, room_id, my_id):
            return error_response("Only group admins can remove members", 403)
        if same_id_check(group.get('creator_id'), member_id):
            return error_response("The group creator cannot be removed", 400)

        cursor.execute(
            "SELECT role FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
            (room_id, member_id)
        )
        member = cursor.fetchone()
        if not member:
            return error_response("This person is not in the group", 404)

        cursor.execute(
            "DELETE FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
            (room_id, member_id)
        )
        cursor.execute(
            "DELETE FROM official_chat_read_state WHERE room_id = ? AND user_id = ?",
            (room_id, member_id)
        )
        cursor.execute(
            """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
               VALUES (?, ?, ?, ?)""",
            (member_id, room_id, f"Removed from {group['title']}",
             f"You were removed from the group \"{group['title']}\"")
        )
        conn.commit()
        return success_response(_group_details(cursor, room_id, my_id), "Member removed")
    finally:
        conn.close()


@chat_bp.route('/groups/<int:room_id>/members/me', methods=['DELETE'])
@chat_token_required
def leave_chat_group(room_id):
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ? AND room_type = 'group'", (room_id,))
        row = cursor.fetchone()
        if not row:
            return error_response("Group not found", 404)
        room = dict(row)
        cursor.execute(
            "SELECT role FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
            (room_id, my_id)
        )
        member = cursor.fetchone()
        if not member:
            return error_response("You are not a member of this group", 403)

        cursor.execute(
            "DELETE FROM official_chat_group_members WHERE room_id = ? AND user_id = ?",
            (room_id, my_id)
        )
        cursor.execute(
            "DELETE FROM official_chat_read_state WHERE room_id = ? AND user_id = ?",
            (room_id, my_id)
        )

        new_creator_id = None
        if same_id_check(room.get('user_id'), my_id):
            cursor.execute(
                """SELECT user_id FROM official_chat_group_members
                   WHERE room_id = ? ORDER BY joined_at ASC, user_id ASC LIMIT 1""",
                (room_id,)
            )
            next_member = cursor.fetchone()
            if next_member:
                new_creator_id = int(next_member['user_id'])
                cursor.execute(
                    "UPDATE official_chat_rooms SET user_id = ? WHERE id = ?",
                    (new_creator_id, room_id)
                )
                cursor.execute(
                    "UPDATE official_chat_group_members SET role = 'admin' WHERE room_id = ? AND user_id = ?",
                    (room_id, new_creator_id)
                )
                cursor.execute(
                    """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
                       VALUES (?, ?, ?, ?)""",
                    (new_creator_id, room_id, f"You are now admin of {room['title']}",
                     f"@{request.chat_user.get('username') or my_id} left the group. You are now the admin.")
                )
            else:
                # Nobody left: retire the room so it disappears from every inbox.
                cursor.execute(
                    "UPDATE official_chat_rooms SET status = 'deleted' WHERE id = ?",
                    (room_id,)
                )
        conn.commit()
        return success_response(
            {'room_id': room_id, 'new_creator_id': new_creator_id},
            "Left group"
        )
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/messages', methods=['GET'])
@chat_token_required
def get_room_messages(room_id):
    """Get all messages for a specific chat room, marking incoming messages as read."""
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        room_dict, can_access = get_chat_room_for_user(cursor, room_id, my_id)
        if not room_dict:
            return error_response("Chat room not found", 404)
        if not can_access:
            return error_response("Access denied to this chat room", 403)

        is_group_room = room_dict.get('room_type') == 'group'
        other_id = None if is_group_room else (
            room_dict.get('user_two_id') if room_dict['user_id'] == my_id else room_dict['user_id']
        )
        peer_pubkey = None
        if other_id:
            cursor.execute("SELECT public_key FROM chat_users WHERE id = ?", (other_id,))
            peer_row = cursor.fetchone()
            if peer_row and peer_row['public_key']:
                peer_pubkey = peer_row['public_key']

        e2e_sec = room_dict.get('e2e_secret')
        if not e2e_sec:
            e2e_sec = secrets.token_hex(32)
            cursor.execute("UPDATE official_chat_rooms SET e2e_secret = ? WHERE id = ?", (e2e_sec, room_id))
            conn.commit()
            room_dict['e2e_secret'] = e2e_sec

        # Per-user clear watermark: messages the caller already cleared stay
        # hidden for them only (the other participant keeps the history).
        cursor.execute(
            "SELECT cleared_upto_id FROM official_chat_room_clears WHERE room_id = ? AND user_id = ?",
            (room_id, request.chat_user['user_id'])
        )
        cleared_row = cursor.fetchone()
        cleared_upto = (cleared_row['cleared_upto_id'] if cleared_row else 0) or 0

        # Pagination / incremental polling: without this every 4s poll (and
        # every send) transferred the ENTIRE room history, which gets slow and
        # expensive as a conversation grows.
        after_id = request.args.get('after_id', type=int)
        before_id = request.args.get('before_id', type=int)
        limit = request.args.get('limit', type=int) or 200
        limit = max(1, min(limit, 500))

        msg_columns = (
            "id, room_id, user_id, sender_type, sender_name, message, media_url, "
            "message_type, is_read, created_at, username, reply_to_id, deleted, "
            "edited_at, updated_at"
        )
        hidden_filter = "AND id NOT IN (SELECT message_id FROM chat_message_hides WHERE user_id = ?)"
        if after_id is not None:
            # Polling: only what arrived after the client's newest message.
            cursor.execute(
                f"""SELECT {msg_columns} FROM official_chat_messages
                    WHERE room_id = ? AND id > ? AND id > ? {hidden_filter}
                    ORDER BY id ASC LIMIT ?""",
                (room_id, after_id, cleared_upto, my_id, limit)
            )
            raw_messages = cursor.fetchall()
        elif before_id is not None:
            # Older page (scroll up). Newest-first internally, ascending to UI.
            cursor.execute(
                f"""SELECT {msg_columns} FROM official_chat_messages
                    WHERE room_id = ? AND id < ? AND id > ? {hidden_filter}
                    ORDER BY id DESC LIMIT ?""",
                (room_id, before_id, cleared_upto, my_id, limit)
            )
            raw_messages = list(reversed(cursor.fetchall()))
        else:
            # Initial open: the newest page only, oldest -> newest.
            cursor.execute(
                f"""SELECT {msg_columns} FROM official_chat_messages
                    WHERE room_id = ? AND id > ? {hidden_filter}
                    ORDER BY id DESC LIMIT ?""",
                (room_id, cleared_upto, my_id, limit)
            )
            raw_messages = list(reversed(cursor.fetchall()))

        cursor.execute("SELECT public_key FROM chat_users WHERE id = ?", (my_id,))
        me_key_row = cursor.fetchone()
        my_pubkey = me_key_row['public_key'] if me_key_row and me_key_row['public_key'] else None

        messages = [dict(m) for m in raw_messages]
        _attach_message_reactions(cursor, messages, my_id)
        for m in messages:
            msg_text = str(m.get('message') or '')
            m['e2e_secret'] = e2e_sec if msg_text.startswith('enc:v1:') else None
            m['contact_public_key'] = peer_pubkey
            if m.get('user_id') == my_id:
                m['sender_public_key'] = my_pubkey
                m['recipient_public_key'] = peer_pubkey
            else:
                m['sender_public_key'] = peer_pubkey
                m['recipient_public_key'] = my_pubkey
            _sanitize_chat_message(m)

        # Mark messages sent by others as read. SKIPPED for history-pagination
        # fetches (before_id): the viewer is scrolling OLDER content they
        # already knew about — flipping every unread message in the room (and
        # jumping the read watermark to the newest id) reported the peer's
        # ticks as ✓✓ for content that was never displayed.
        if before_id is None:
            cursor.execute(
                """UPDATE official_chat_messages SET is_read = 1
                   WHERE room_id = ? AND is_read = 0
                     AND (user_id != ? OR sender_type != 'user')""",
                (room_id, my_id)
            )

            # Read receipts: remember how far the caller has read so the sender's
            # realtime loop can turn its ticks into ✓✓ for exactly those messages.
            # Staff-authored rows (sender_type) carry the viewer's own user_id,
            # so authorship — not user_id — decides what counts as incoming.
            cursor.execute(
                """SELECT MAX(id) AS max_id FROM official_chat_messages
                   WHERE room_id = ? AND (user_id != ? OR sender_type != 'user')""",
                (room_id, my_id)
            )
            read_row = cursor.fetchone()
            max_read_id = int(read_row['max_id'] or 0) if read_row else 0
            if max_read_id:
                cursor.execute(
                    """INSERT OR REPLACE INTO official_chat_read_state
                       (room_id, user_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)""",
                    (room_id, my_id, max_read_id, int(time.time()))
                )

        # Read receipts are best-effort: a stream that was rolled back while it
        # sat idle must not turn a successful history fetch into a 500 (the
        # production log shows exactly that failure on this endpoint).
        try:
            conn.commit()
        except Exception as commit_err:
            if not is_transient_db_error(commit_err):
                raise
            logger.warning("Read-state commit failed, served history anyway: %s", commit_err)

        return success_response(messages, "Messages retrieved")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/read', methods=['POST'])
@chat_token_required
def mark_chat_room_read(room_id):
    """Mark incoming messages in a room as read and persist the read receipt."""
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    max_id = data.get('max_id')

    conn = get_db()
    try:
        cursor = conn.cursor()
        room, can_access = get_chat_room_for_user(cursor, room_id, my_id)
        if not room:
            return error_response("Chat room not found", 404)
        if not can_access:
            return error_response("Access denied", 403)

        is_group_room = room.get('room_type') == 'group'
        now = int(time.time())
        if max_id:
            cursor.execute(
                """UPDATE official_chat_messages SET is_read = 1
                   WHERE room_id = ? AND id <= ? AND is_read = 0
                     AND (user_id != ? OR sender_type != 'user')""",
                (room_id, max_id, my_id)
            )
            cursor.execute(
                """INSERT OR REPLACE INTO official_chat_read_state
                   (room_id, user_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)""",
                (room_id, my_id, max_id, now)
            )
        else:
            cursor.execute(
                """UPDATE official_chat_messages SET is_read = 1
                   WHERE room_id = ? AND is_read = 0
                     AND (user_id != ? OR sender_type != 'user')""",
                (room_id, my_id)
            )
            cursor.execute(
                """SELECT COALESCE(MAX(id), 0) AS max_id FROM official_chat_messages
                   WHERE room_id = ? AND (user_id != ? OR sender_type != 'user')""",
                (room_id, my_id)
            )
            last_id = cursor.fetchone()['max_id'] or 0
            if last_id:
                cursor.execute(
                    """INSERT OR REPLACE INTO official_chat_read_state
                       (room_id, user_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)""",
                    (room_id, my_id, last_id, now)
                )
        conn.commit()
        return success_response({'room_id': room_id}, "Marked as read")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/messages', methods=['POST'])
@chat_token_required
def send_room_message(room_id):
    """Send a message, retrying once after a transient remote-DB failure.

    Turso can drop a stream after the message write but before/while the
    response is produced. The client sees a 500 or its 35s timeout and retries;
    without an idempotency key that produced duplicate bubbles. The retry is
    only safe when the client supplied ``client_message_id`` (all current
    builds do), because the implementation returns the already-committed row
    instead of inserting it again.
    """
    # Latency probe: a send that takes seconds pinpoints a stalled DB stage in
    # the Railway logs instead of only showing up as a client 35s timeout.
    g._jdlx_send_started = time.monotonic()
    try:
        return _send_room_message_impl(room_id)
    except Exception as exc:
        data = request.get_json(silent=True) or {}
        client_message_id = str(data.get('client_message_id') or '').strip()
        if not client_message_id or not is_transient_db_error(exc):
            raise
        logger.warning("Retrying message send after transient DB error: %s", exc)
        # The request-scoped wrapper may hold the dead/dirty stream. Hard-close
        # it and drop the cache so the retry opens a brand-new connection.
        try:
            stale = g.pop('_jdlx_request_db', None)
            if stale is not None:
                stale._hard_close()
        except Exception:
            pass
        g._jdlx_send_retried = True
        return _send_room_message_impl(room_id)


def _send_room_message_impl(room_id):
    """Send a message inside a specific 1-to-1 or group room."""
    my_id = request.chat_user['user_id']
    is_new_account = _is_new_chat_account(request.chat_user.get('created_at'))
    data = request.get_json(silent=True) or {}
    message_text = (data.get('message') or '').strip()
    media_url = data.get('media_url')
    message_type = data.get('message_type', 'text')
    client_message_id = str(data.get('client_message_id') or '').strip()[:128]

    if not message_text and not media_url:
        return error_response("Message text or media is required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        room_dict, can_access = get_chat_room_for_user(cursor, room_id, my_id)
        if not room_dict:
            return error_response("Chat room not found", 404)
        if not can_access:
            return error_response("Access denied to this chat room", 403)

        is_group_room = room_dict.get('room_type') == 'group'
        recipient_id = None
        if room_dict.get('user_two_id') and not is_group_room:
            recipient_id = room_dict['user_two_id'] if room_dict['user_id'] == my_id else room_dict['user_id']

        # Safety: direct messages require BOTH an accepted friendship and no
        # block in either direction. Group access is enforced by membership
        # above and deliberately skips the 1-to-1 friendship gate. The safety
        # flags and both profiles come back in one statement — this used to be
        # three sequential round-trips on every send.
        cursor.execute(
            """SELECT
                 EXISTS(SELECT 1 FROM chat_blocks
                        WHERE (blocker_id = ? AND blocked_id = ?)
                           OR (blocker_id = ? AND blocked_id = ?)) AS blocked,
                 EXISTS(SELECT 1 FROM official_chat_friend_requests
                        WHERE ((sender_id = ? AND receiver_id = ?)
                            OR (sender_id = ? AND receiver_id = ?))
                          AND status = 'accepted') AS friends,
                 me.name AS my_name,
                 me.username AS my_username,
                 me.public_key AS my_pubkey,
                 peer.public_key AS peer_pubkey
               FROM chat_users me
               LEFT JOIN chat_users peer ON peer.id = ?
               WHERE me.id = ?""",
            (my_id, recipient_id, recipient_id, my_id,
             my_id, recipient_id, recipient_id, my_id,
             recipient_id, my_id)
        )
        profile_row = cursor.fetchone()
        if recipient_id:
            if profile_row and profile_row['blocked']:
                return error_response(
                    "You can't message this user. Unblock or ask them to unblock you.",
                    403
                )
            if not profile_row or not profile_row['friends']:
                return error_response(
                    "You can only message someone after they accept your friend request.",
                    403
                )

        my_name = profile_row['my_name'] if profile_row and profile_row['my_name'] else 'Friend'
        my_username = profile_row['my_username'] if profile_row and profile_row['my_username'] else f"user_{my_id}"
        my_pubkey = profile_row['my_pubkey'] if profile_row and profile_row['my_pubkey'] else None
        peer_pubkey = profile_row['peer_pubkey'] if profile_row and profile_row['peer_pubkey'] else None

        e2e_sec = room_dict.get('e2e_secret')
        if not e2e_sec:
            e2e_sec = secrets.token_hex(32)
            cursor.execute("UPDATE official_chat_rooms SET e2e_secret = ? WHERE id = ?", (e2e_sec, room_id))
            conn.commit()
            room_dict['e2e_secret'] = e2e_sec

        started = getattr(g, '_jdlx_send_started', None) or time.monotonic()
        after_prepare = time.monotonic()

        def existing_send_response(row):
            """Return a previously committed send for the same client key."""
            created = dict(row)
            _sanitize_chat_message(created)
            created['reactions'] = []
            created['sender_public_key'] = my_pubkey
            created['recipient_public_key'] = peer_pubkey
            created['contact_public_key'] = peer_pubkey
            created['e2e_secret'] = (
                e2e_sec if str(created.get('message') or '').startswith('enc:v1:') else None
            )
            return success_response([created], "Message already sent")

        # Insert user message. Idempotency is enforced by the unique index on
        # (room_id, user_id, client_message_id) + ON CONFLICT DO NOTHING, so a
        # client retry never creates a second bubble. The pre-INSERT SELECT is
        # gone: it cost a Turso round-trip on EVERY send just to cover the rare
        # retry, and the conflict branch below handles that case instead.

        # Reply/quote target must belong to this same room.
        reply_to_id = data.get('reply_to_id')
        if reply_to_id is not None:
            try:
                reply_to_id = int(reply_to_id)
            except (TypeError, ValueError):
                return error_response("Invalid reply target", 400)
            cursor.execute(
                "SELECT id FROM official_chat_messages WHERE id = ? AND room_id = ?",
                (reply_to_id, room_id)
            )
            if not cursor.fetchone():
                return error_response("Reply target not found in this chat", 400)

        # Rate limiting is applied only now, after every read. It used to run
        # first, which opened a write transaction before the room/profile/reply
        # reads and held Turso's single write lock across all of them (~0.6s
        # each). Concurrent sends and presence heartbeats queued behind that
        # lock for tens of seconds, which the client saw as "Timed out after
        # 35s". Keeping it next to the INSERT keeps the lock held for one short
        # burst instead. A retry must not consume a second budget for the same
        # logical message.
        if not getattr(g, '_jdlx_send_retried', False):
            budgets = [("send_message", f"user_{my_id}", 40, 60)]
            if is_new_account:
                budgets.append(("new_account_send", f"user_{my_id}", 300, 3600))
            # commit=False: the counter rides along in the message transaction
            # below, saving one Turso round-trip on every send.
            if not check_chat_rate_limits(budgets, commit=False):
                return error_response("You are sending messages too fast. Please slow down.", 429)

        is_encrypted = message_text.startswith(('enc:v1:', 'enc:v2:'))
        if is_encrypted:
            # Keep the ciphertext as the inbox preview. The server still cannot
            # read it, while the two clients can decrypt it for a real preview.
            preview = message_text
            notif_text = "Sent an encrypted message"
        else:
            preview = (message_text[:60] + '...') if len(message_text) > 60 else message_text
            notif_text = message_text or "Sent an attachment"

        # Group members are read before the write transaction so membership
        # lookups never sit inside the write lock either.
        group_member_ids = []
        group_push_title = ''
        group_push_body = ''
        if is_group_room:
            group_push_title = f"New message in {room_dict.get('title') or 'Group'}"
            group_push_body = f"@{my_username}: {notif_text}"
            group_member_ids = [
                member_id for member_id in _group_member_ids(cursor, room_id)
                if not same_id_check(member_id, my_id)
            ]

        # Build the response row from known values instead of SELECT-ing the
        # row back: one less Turso round-trip on every send, identical shape.
        now_ts = int(time.time())
        created_at_value = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
        stored_message = message_text or "Sent an attachment"
        # fetchall(), not fetchone(): libsql leaves a RETURNING statement
        # "in progress" until its rows are exhausted, and the later commit()
        # then fails with "SQL statements in progress" (a 500 on send).
        inserted_rows = cursor.execute(
            """INSERT INTO official_chat_messages 
               (room_id, user_id, sender_type, sender_name, message, media_url, message_type, is_read, username, reply_to_id, updated_at, created_at, client_message_id)
               VALUES (?, ?, 'user', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
               ON CONFLICT(room_id, user_id, client_message_id) DO NOTHING
               RETURNING id""",
            (room_id, my_id, my_name, stored_message, media_url, message_type, my_username, reply_to_id, now_ts, created_at_value, client_message_id or None)
        ).fetchall()
        inserted = inserted_rows[0] if inserted_rows else None
        if not inserted:
            # A concurrent retry won the unique-key race: return its row and
            # skip the room bump/notifications/pushes for this attempt.
            if client_message_id:
                cursor.execute(
                    """SELECT id, room_id, user_id, sender_type, sender_name, message,
                              media_url, message_type, is_read, created_at, username,
                              reply_to_id, deleted, edited_at, updated_at, client_message_id
                       FROM official_chat_messages
                       WHERE room_id = ? AND user_id = ? AND client_message_id = ?
                       LIMIT 1""",
                    (room_id, my_id, client_message_id)
                )
                already_sent = cursor.fetchone()
                if already_sent:
                    # Commit the limiter counter taken above (the message write
                    # itself was a no-op thanks to ON CONFLICT DO NOTHING).
                    conn.commit()
                    return existing_send_response(already_sent)
            return error_response("Message could not be saved", 500)
        new_msg_id = inserted['id'] if hasattr(inserted, 'keys') else inserted[0]
        after_insert = time.monotonic()

        cursor.execute(
            """UPDATE official_chat_rooms 
               SET last_message = ?, last_message_at = CURRENT_TIMESTAMP 
               WHERE id = ?""",
            (preview or "Attachment", room_id)
        )

        # Notify recipient in direct chat (peer public key was fetched with
        # the sender profile above — no extra round-trip here).
        if recipient_id:
            cursor.execute(
                """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
                   VALUES (?, ?, ?, ?)""",
                (recipient_id, room_id, f"New message from @{my_username}", notif_text)
            )

        # Group rooms have no single recipient: every other member gets an
        # inbox notification (and, after commit, an OS push) for the message.
        # The member list was read before the write transaction opened.
        if is_group_room:
            _insert_group_notifications(
                cursor, room_id, group_member_ids, group_push_title, group_push_body
            )

        conn.commit()
        after_commit = time.monotonic()
        total_ms = (after_commit - started) * 1000
        if total_ms >= 2000:
            logger.warning(
                "Slow chat send room=%s user=%s total=%.0fms pre=%.0fms insert=%.0fms rest=%.0fms",
                room_id, my_id, total_ms,
                (after_prepare - started) * 1000,
                (after_insert - after_prepare) * 1000,
                (after_commit - after_insert) * 1000,
            )

        # OS notifications while the recipient's app is closed: Web Push for
        # browsers and FCM for the packaged Android app. Best-effort and off the
        # request thread so slow push HTTP never delays the message.
        if recipient_id:
            try:
                import threading
                from notifications.notification_service import send_chat_push, send_chat_device_push
                push_title = f"New message from @{my_username}"
                push_url = f"/chat?room={room_id}"
                threading.Thread(
                    target=send_chat_push,
                    args=(recipient_id, push_title, notif_text, push_url, f"chat-message-{new_msg_id}"),
                    daemon=True,
                ).start()
                threading.Thread(
                    target=send_chat_device_push,
                    args=(recipient_id, push_title, notif_text, push_url),
                    daemon=True,
                ).start()
            except Exception as push_err:
                logger.warning("Chat message push skipped: %s", push_err)

        if group_member_ids:
            _dispatch_chat_pushes(
                group_member_ids,
                group_push_title,
                group_push_body,
                f"/chat?room={room_id}",
                f"chat-message-{new_msg_id}",
            )

        # Return ONLY the message just created. Sending used to reply with the
        # whole room history, so each send re-downloaded the conversation.
        created = {
            'id': new_msg_id,
            'room_id': room_id,
            'user_id': my_id,
            'sender_type': 'user',
            'sender_name': my_name,
            'message': stored_message,
            'media_url': media_url,
            'message_type': message_type,
            'is_read': 0,
            'created_at': created_at_value,
            'username': my_username,
            'reply_to_id': reply_to_id,
            'deleted': 0,
            'edited_at': None,
            'updated_at': now_ts,
            'client_message_id': client_message_id or None,
        }
        created['reactions'] = []
        created['sender_public_key'] = my_pubkey
        created['recipient_public_key'] = peer_pubkey
        created['contact_public_key'] = peer_pubkey
        created['e2e_secret'] = e2e_sec if message_text.startswith('enc:v1:') else None
        _sanitize_chat_message(created)

        # Instant Server-Side Realtime Broadcast via Supabase (<30ms)
        # Guarantees recipient receives message immediately even if sender's client socket was sleeping
        broadcast_items = [
            (f"chat_room_{room_id}", "new_message", created)
        ]
        if recipient_id:
            broadcast_items.append((
                f"chat_user_{recipient_id}",
                "incoming_chat",
                {
                    "room_id": room_id,
                    "sender_id": my_id,
                    "message_id": new_msg_id
                }
            ))
        for member_id in group_member_ids:
            broadcast_items.append((
                f"chat_user_{member_id}",
                "incoming_chat",
                {
                    "room_id": room_id,
                    "sender_id": my_id,
                    "message_id": new_msg_id
                }
            ))
        broadcast_supabase_chat_event(broadcast_items)
        return success_response([created], "Message sent")
    finally:
        conn.close()


# -----------------------------------------------------------------------------
# FRIEND REQUESTS & SOCIAL COMMUNITY ENDPOINTS
# -----------------------------------------------------------------------------

def _chat_social_state(cursor, my_id):
    """Snapshot of friends + friend requests, with a revision fingerprint.

    Shared shape with /friends; the revision changes on every new request,
    accept or decline so the realtime poll can return immediately.
    """
    cursor.execute(
        """SELECT fr.id AS request_id,
                  CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END AS friend_id,
                  u.name, u.username, u.profile_image
           FROM official_chat_friend_requests fr
           JOIN chat_users u ON u.id = CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END
           WHERE (fr.sender_id = ? OR fr.receiver_id = ?) AND fr.status = 'accepted'
           ORDER BY fr.updated_at DESC""",
        (my_id, my_id, my_id, my_id)
    )
    friends = [dict(f) for f in cursor.fetchall()]

    cursor.execute(
        """SELECT fr.id AS request_id, fr.created_at, u.id AS user_id, u.name, u.username, u.profile_image
           FROM official_chat_friend_requests fr
           JOIN chat_users u ON u.id = fr.sender_id
           WHERE fr.receiver_id = ? AND fr.status = 'pending'
           ORDER BY fr.created_at DESC""",
        (my_id,)
    )
    incoming = [dict(r) for r in cursor.fetchall()]

    cursor.execute(
        """SELECT fr.id AS request_id, fr.created_at, u.id AS user_id, u.name, u.username, u.profile_image
           FROM official_chat_friend_requests fr
           JOIN chat_users u ON u.id = fr.receiver_id
           WHERE fr.sender_id = ? AND fr.status = 'pending'
           ORDER BY fr.created_at DESC""",
        (my_id,)
    )
    outgoing = [dict(r) for r in cursor.fetchall()]

    cursor.execute(
        """SELECT id, status, updated_at FROM official_chat_friend_requests
           WHERE sender_id = ? OR receiver_id = ?""",
        (my_id, my_id)
    )
    signature = "|".join(
        f"{r['id']}:{r['status']}:{r['updated_at']}" for r in cursor.fetchall()
    )

    # Realtime inbox awareness: track newest incoming message across user's rooms
    # so messages trigger instant delivery even when user is browsing the conversation list.
    # Direct rooms are owned through user_id/user_two_id; group rooms through
    # official_chat_group_members. Without the group arm, a group message never
    # bumped this revision, so the inbox long-poll stayed asleep for groups.
    cursor.execute(
        """SELECT MAX(m.id) AS max_id, COUNT(m.id) AS unread
           FROM official_chat_messages m
           JOIN official_chat_rooms r ON m.room_id = r.id
           WHERE (
                   (COALESCE(r.room_type, 'direct') != 'group' AND (r.user_id = ? OR r.user_two_id = ?))
                   OR (r.room_type = 'group' AND EXISTS (
                         SELECT 1 FROM official_chat_group_members gm
                         WHERE gm.room_id = r.id AND gm.user_id = ?
                       ))
                 )
             AND (m.user_id != ? OR m.sender_type != 'user') AND m.is_read = 0""",
        (my_id, my_id, my_id, my_id)
    )
    msg_state = cursor.fetchone()
    max_msg_id = (msg_state['max_id'] if msg_state else 0) or 0
    unread_msgs = (msg_state['unread'] if msg_state else 0) or 0
    signature += f"|msg:{max_msg_id}:{unread_msgs}"

    return {
        'friends': friends,
        'incoming_requests': incoming,
        'outgoing_requests': outgoing,
        'pending_count': len(incoming),
        'unread_messages': unread_msgs,
        'latest_message_id': max_msg_id,
        'revision': hashlib.sha1(signature.encode()).hexdigest()[:16],
    }


@chat_bp.route('/social/events', methods=['GET'])
@chat_token_required
def chat_social_events():
    """Long-poll friend requests/accepts so they land instantly.

    Returns as soon as the caller's friendship revision changes (new request,
    accept, decline) or after `timeout` seconds. Without this the UI only
    learned about a request on the next 30-second list refresh.
    """
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("social_events", f"user_{my_id}", max_requests=120, window_seconds=60):
        return error_response("Too many realtime checks. Please slow down.", 429)

    since = (request.args.get('since') or '').strip()
    try:
        timeout = max(1, min(int(request.args.get('timeout', 3)), 4))
    except (TypeError, ValueError):
        timeout = 3

    deadline = time.time() + timeout
    conn = get_db()
    try:
        cursor = conn.cursor()
        while True:
            state = _chat_social_state(cursor, my_id)
            if not since or state['revision'] != since:
                state['server_time'] = int(time.time())
                return success_response(state, "Social state retrieved")
            if time.time() >= deadline:
                state['server_time'] = int(time.time())
                return success_response(state, "No social changes")
            # Same as the room long-poll: never sleep while holding a pooled
            # connection, or a handful of idle clients starve every slot.
            release = getattr(conn, 'release', None)
            if callable(release):
                release()
            time.sleep(0.75)
            if callable(release):
                conn = get_db()
                cursor = conn.cursor()
    finally:
        conn.close()


@chat_bp.route('/friends', methods=['GET'])
@chat_token_required
def get_chat_friends_and_requests():
    """Get accepted friends, incoming friend requests, and outgoing requests."""
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()

        # 1. Accepted Friends
        cursor.execute(
            """SELECT fr.id AS request_id, 
                      CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END AS friend_id,
                      u.name, u.username, u.profile_image,
                      CASE WHEN u.last_seen_at >= datetime('now', '-90 seconds') THEN 1 ELSE 0 END AS is_online
               FROM official_chat_friend_requests fr
               JOIN chat_users u ON u.id = CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END
               WHERE (fr.sender_id = ? OR fr.receiver_id = ?) AND fr.status = 'accepted'
               ORDER BY fr.updated_at DESC""",
            (my_id, my_id, my_id, my_id)
        )
        friends = [dict(f) for f in cursor.fetchall()]

        # 2. Incoming Requests
        cursor.execute(
            """SELECT fr.id AS request_id, fr.created_at, u.id AS user_id, u.name, u.username, u.profile_image
               FROM official_chat_friend_requests fr
               JOIN chat_users u ON u.id = fr.sender_id
               WHERE fr.receiver_id = ? AND fr.status = 'pending'
               ORDER BY fr.created_at DESC""",
            (my_id,)
        )
        incoming = [dict(r) for r in cursor.fetchall()]

        # 3. Outgoing Requests
        cursor.execute(
            """SELECT fr.id AS request_id, fr.created_at, u.id AS user_id, u.name, u.username, u.profile_image
               FROM official_chat_friend_requests fr
               JOIN chat_users u ON u.id = fr.receiver_id
               WHERE fr.sender_id = ? AND fr.status = 'pending'
               ORDER BY fr.created_at DESC""",
            (my_id,)
        )
        outgoing = [dict(r) for r in cursor.fetchall()]

        return success_response({
            'friends': friends,
            'incoming_requests': incoming,
            'outgoing_requests': outgoing,
            'pending_count': len(incoming)
        }, "Friends retrieved")
    finally:
        conn.close()


@chat_bp.route('/friends/request', methods=['POST'])
@chat_token_required
def send_chat_friend_request():
    """Send a friend request by target_user_id or username."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("friend_request", f"user_{my_id}", max_requests=20, window_seconds=300):
        return error_response("Too many friend requests. Please wait a few minutes.", 429)
    data = request.get_json(silent=True) or {}
    target_user_id = data.get('target_user_id') or data.get('receiver_id')
    target_username = (data.get('username') or '').strip().lstrip('@').lower()

    conn = get_db()
    try:
        cursor = conn.cursor()
        if target_user_id:
            cursor.execute("SELECT id, name, username FROM chat_users WHERE id = ?", (target_user_id,))
        elif target_username:
            cursor.execute("SELECT id, name, username FROM chat_users WHERE LOWER(username) = ?", (target_username,))
        else:
            return error_response("Target user or username required", 400)

        target = cursor.fetchone()
        if not target:
            return error_response("User not found", 404)

        target_dict = dict(target)
        target_id = target_dict['id']

        if target_id == my_id:
            return error_response("You cannot send a friend request to yourself", 400)

        if chat_block_exists(cursor, my_id, target_id):
            return error_response("You can't send a friend request to this user.", 403)

        # Check existing connection
        cursor.execute(
            """SELECT id, sender_id, receiver_id, status 
               FROM official_chat_friend_requests 
               WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)""",
            (my_id, target_id, target_id, my_id)
        )
        existing = cursor.fetchone()
        if existing:
            ex_dict = dict(existing)
            if ex_dict['status'] == 'accepted':
                return success_response({'status': 'friends'}, "You are already connected as friends!")
            elif ex_dict['status'] == 'declined':
                # A declined request must not block the pair forever: remove the
                # old row and let this attempt create a fresh pending request.
                cursor.execute(
                    "DELETE FROM official_chat_friend_requests WHERE id = ?",
                    (ex_dict['id'],)
                )
            elif ex_dict['sender_id'] == my_id:
                return success_response({'status': 'pending'}, "Friend request already sent!")
            else:
                # Target user had already sent us a request! Auto-accept it!
                cursor.execute(
                    "UPDATE official_chat_friend_requests SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (ex_dict['id'],)
                )
                conn.commit()
                get_or_create_direct_room(conn, my_id, target_id)
                broadcast_supabase_chat_event([(
                    f"chat_user_{target_id}",
                    "friend_event",
                    {'from_user_id': my_id, 'action': 'accept'}
                )])
                return success_response({'status': 'friends'}, "Mutual connection! You are now friends.")

        cursor.execute(
            """INSERT INTO official_chat_friend_requests (sender_id, receiver_id, status)
               VALUES (?, ?, 'pending')""",
            (my_id, target_id)
        )
        req_id = cursor.lastrowid

        # Notify recipient
        my_uname = request.chat_user.get('username') or f"user_{my_id}"
        cursor.execute(
            """INSERT INTO official_chat_notifications (user_id, title, message)
               VALUES (?, 'New Friend Request', ?)""",
            (target_id, f"@{my_uname} sent you a friend request on Official Chat!")
        )
        conn.commit()
        broadcast_supabase_chat_event([(
            f"chat_user_{target_id}",
            "friend_event",
            {'from_user_id': my_id, 'action': 'request'}
        )])

        # Best-effort OS push so the recipient sees the request even when the
        # Chat app is closed. Runs off-thread: push HTTP is slow and must never
        # delay or fail the friend-request response. The service worker skips
        # showing it when a visible Chat tab already got the in-app toast.
        try:
            import threading
            from notifications.notification_service import send_chat_push, send_chat_device_push
            push_args = (
                target_id,
                "New friend request",
                f"@{my_uname} wants to connect on JDLX Chat",
                "/chat?open=requests",
            )
            threading.Thread(
                target=send_chat_push,
                args=(*push_args, f"friend-request-{req_id}"),
                daemon=True,
            ).start()
            threading.Thread(
                target=send_chat_device_push,
                args=push_args,
                daemon=True,
            ).start()
        except Exception as push_err:
            logger.warning("Chat friend-request push skipped: %s", push_err)

        return success_response({'request_id': req_id, 'status': 'pending'}, "Friend request sent successfully!")
    finally:
        conn.close()


@chat_bp.route('/friends/respond', methods=['POST'])
@chat_token_required
def respond_chat_friend_request():
    """Accept or decline an incoming friend request."""
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    request_id = data.get('request_id')
    action = (data.get('action') or '').strip().lower()

    if not request_id or action not in ('accept', 'decline'):
        return error_response("Valid request_id and action ('accept' or 'decline') required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM official_chat_friend_requests WHERE id = ? AND receiver_id = ?", (request_id, my_id))
        fr = cursor.fetchone()
        if not fr:
            return error_response("Friend request not found", 404)

        fr_dict = dict(fr)
        sender_id = fr_dict['sender_id']

        if action == 'accept':
            cursor.execute(
                "UPDATE official_chat_friend_requests SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (request_id,)
            )
            room = get_or_create_direct_room(conn, my_id, sender_id)

            my_uname = request.chat_user.get('username') or f"user_{my_id}"
            cursor.execute(
                """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
                   VALUES (?, ?, 'Friend Request Accepted', ?)""",
                (sender_id, room['id'], f"@{my_uname} accepted your friend request. You can now chat!")
            )
            conn.commit()
            broadcast_supabase_chat_event([(
                f"chat_user_{sender_id}",
                "friend_event",
                {'from_user_id': my_id, 'action': 'accept', 'room_id': room['id']}
            )])
            return success_response({'status': 'accepted', 'room_id': room['id']}, "Friend request accepted! Chat ready.")
        else:
            cursor.execute(
                "UPDATE official_chat_friend_requests SET status = 'declined', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (request_id,)
            )
            conn.commit()
            broadcast_supabase_chat_event([(
                f"chat_user_{sender_id}",
                "friend_event",
                {'from_user_id': my_id, 'action': 'decline'}
            )])
            return success_response({'status': 'declined'}, "Friend request declined")
    finally:
        conn.close()


@chat_bp.route('/invite-info', methods=['GET'])
@chat_token_required
def get_chat_invite_info():
    """Generates a shareable invite link & pre-filled text to invite contacts."""
    username = request.chat_user.get('username') or f"user_{request.chat_user['user_id']}"
    origin = get_public_chat_origin()
    invite_url = f"{origin}/chat/login?ref=@{username}"
    share_text = f"Hey! Chat with me on Official Chat – secure, encrypted messaging. Connect with my @{username} handle here: {invite_url}"
    return success_response({
        'username': username,
        'invite_url': invite_url,
        'share_text': share_text
    }, "Invite details generated")


@chat_bp.route('/auth/session', methods=['GET'])
@chat_token_required
def chat_auth_session():
    """Verify active chat session and return current user and room state."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, username, email, phone, gender, profile_image, role, bio FROM chat_users WHERE id = ?", (user_id,))
        user_row = cursor.fetchone()
        if not user_row:
            return error_response("User not found", 404)

        user_data = dict(user_row)
        room = get_or_create_chat_room(conn, user_id, user_data.get('name', 'Customer'))

        # Fetch unread notifications count
        cursor.execute(
            "SELECT COUNT(*) AS cnt FROM official_chat_notifications WHERE user_id = ? AND is_read = 0",
            (user_id,)
        )
        notif_cnt = cursor.fetchone()['cnt'] or 0

        return success_response({
            'user': user_data,
            'room': room,
            'unread_notifications_count': notif_cnt
        }, "Chat session active")
    finally:
        conn.close()


@chat_bp.route('/profile', methods=['GET', 'PUT'])
@chat_token_required
def chat_user_profile():
    """Get or update current authenticated user's profile details."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        if request.method == 'GET':
            cursor.execute(
                "SELECT id, google_sub, email, phone, name, username, gender, profile_image, role, is_active, bio, created_at, public_key FROM chat_users WHERE id = ?",
                (user_id,)
            )
            row = cursor.fetchone()
            if not row:
                return error_response("User not found", 404)
            return success_response({"profile": dict(row)})

        # PUT: Update profile fields
        data = request.get_json(silent=True) or {}
        name = (data.get('name') or '').strip()
        raw_username = data.get('username')
        bio = (data.get('bio') or '').strip()
        gender = (data.get('gender') or '').strip().lower()
        profile_image = data.get('profile_image')

        cursor.execute("SELECT * FROM chat_users WHERE id = ?", (user_id,))
        current_user = cursor.fetchone()
        if not current_user:
            return error_response("User not found", 404)
        current_user = dict(current_user)

        # 1. Validate & sanitize Name
        if name:
            if len(name) > 80:
                name = name[:80]
        else:
            name = current_user.get('name') or 'Customer'

        # 2. Validate & sanitize Username if provided
        final_username = current_user.get('username')
        if raw_username is not None and str(raw_username).strip():
            clean_u, u_err = clean_and_validate_chat_username(raw_username)
            if u_err or not clean_u:
                return error_response(u_err or "Invalid username handle.", 400)
            cursor.execute("SELECT id FROM chat_users WHERE LOWER(username) = ? AND id != ? LIMIT 1", (clean_u, user_id))
            if cursor.fetchone():
                return error_response(f"Username @{clean_u} is already taken by another user.", 409)
            final_username = clean_u

        # 3. Bio / Status (WhatsApp style about)
        if len(bio) > 200:
            bio = bio[:200]
        if not bio and 'bio' in data:
            bio = ''
        elif not bio:
            bio = current_user.get('bio') or ''

        # 4. Gender
        valid_genders = ('male', 'female', 'other', 'prefer_not_to_say')
        if gender not in valid_genders:
            gender = current_user.get('gender')

        # 5. Profile Image
        if profile_image is None and 'profile_image' not in data:
            profile_image = current_user.get('profile_image')

        cursor.execute(
            """UPDATE chat_users
               SET name = ?, username = ?, bio = ?, gender = ?, profile_image = ?
               WHERE id = ?""",
            (name, final_username, bio, gender, profile_image, user_id)
        )
        conn.commit()

        cursor.execute(
            "SELECT id, google_sub, email, phone, name, username, gender, profile_image, role, is_active, bio, created_at, public_key FROM chat_users WHERE id = ?",
            (user_id,)
        )
        updated_row = dict(cursor.fetchone())
        return success_response({"message": "Profile updated successfully", "user": updated_row})
    finally:
        conn.close()


# -----------------------------------------------------------------------------
# CHAT ROOM & MESSAGING ENDPOINTS
# -----------------------------------------------------------------------------

@chat_bp.route('/room', methods=['GET'])
@chat_token_required
def get_chat_room():
    """Get active official chat room details for user."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM chat_users WHERE id = ?", (user_id,))
        u_row = cursor.fetchone()
        user_name = u_row['name'] if u_row and u_row['name'] else 'Customer'
        room = get_or_create_chat_room(conn, user_id, user_name)
        return success_response(room, "Room retrieved")
    finally:
        conn.close()


@chat_bp.route('/messages', methods=['GET'])
@chat_token_required
def get_chat_messages():
    """Get all messages for user's official chat room, marking incoming messages as read."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        # Legacy support room only: a DM room can also have user_id = me (the
        # lower-id participant), so user_two_id IS NULL is required here.
        cursor.execute(
            "SELECT id FROM official_chat_rooms WHERE user_id = ? AND status = 'active' AND user_two_id IS NULL LIMIT 1",
            (user_id,)
        )
        room = cursor.fetchone()
        if not room:
            # Auto-create if not exists
            user_name = request.chat_user.get('name', 'Customer')
            room_dict = get_or_create_chat_room(conn, user_id, user_name)
            room_id = room_dict['id']
        else:
            room_id = room['id']

        # Fetch messages
        cursor.execute(
            """SELECT id, room_id, user_id, sender_type, sender_name, message, media_url, message_type, is_read, created_at
               FROM official_chat_messages 
               WHERE room_id = ? 
               ORDER BY created_at ASC, id ASC""",
            (room_id,)
        )
        messages = [dict(m) for m in cursor.fetchall()]
        for m in messages:
            if m.get('created_at'):
                m['created_at'] = format_utc_iso(m['created_at'])

        # Mark specialist messages as read
        cursor.execute(
            "UPDATE official_chat_messages SET is_read = 1 WHERE room_id = ? AND sender_type != 'user' AND is_read = 0",
            (room_id,)
        )
        conn.commit()

        return success_response(messages, "Messages retrieved")
    finally:
        conn.close()


@chat_bp.route('/messages', methods=['POST'])
@chat_token_required
def send_chat_message():
    """Send a user message in Official Chat, with intelligent specialist auto-reply."""
    user_id = request.chat_user['user_id']
    if not check_chat_rate_limit("send_support_message", f"user_{user_id}", max_requests=30, window_seconds=60):
        return error_response("You are sending messages too fast. Please slow down.", 429)
    data = request.get_json(silent=True) or {}
    message_text = (data.get('message') or '').strip()
    media_url = data.get('media_url')
    message_type = data.get('message_type', 'text')

    if not message_text and not media_url:
        return error_response("Message text or media is required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name FROM chat_users WHERE id = ?", (user_id,))
        u_row = cursor.fetchone()
        sender_name = u_row['name'] if u_row and u_row['name'] else 'Customer'

        room = get_or_create_chat_room(conn, user_id, sender_name)
        room_id = room['id']

        # Insert user message
        cursor.execute(
            """INSERT INTO official_chat_messages 
               (room_id, user_id, sender_type, sender_name, message, media_url, message_type, is_read)
               VALUES (?, ?, 'user', ?, ?, ?, ?, 1)""",
            (room_id, user_id, sender_name, message_text or "Sent an attachment", media_url, message_type)
        )
        user_msg_id = cursor.lastrowid

        # Update room last_message
        preview = (message_text[:60] + '...') if len(message_text) > 60 else message_text
        cursor.execute(
            """UPDATE official_chat_rooms 
               SET last_message = ?, last_message_at = CURRENT_TIMESTAMP 
               WHERE id = ?""",
            (preview or "Attachment", room_id)
        )

        # Context-aware smart automated assistant response
        lower_msg = message_text.lower()
        auto_reply = None

        if any(w in lower_msg for w in ['order', 'track', 'delivery', 'dispatch', 'kahan', 'status']):
            auto_reply = (
                "📦 I am checking your order status right now! If this is regarding a recent purchase, "
                "please share your Order ID or tap 'Order Status' below. Our logistics dispatch team "
                "is tracking it in real-time."
            )
        elif any(w in lower_msg for w in ['return', 'exchange', 'replace', 'damaged', 'faulty', 'tuta']):
            auto_reply = (
                "🔄 We are here to help with your return or replacement request. JDLX guarantees zero-hassle "
                "support. If your item was damaged or incorrect, please attach a quick photo here so our "
                "inspection team can instantly approve your resolution."
            )
        elif any(w in lower_msg for w in ['refund', 'money', 'paisa', 'payment', 'cashback']):
            auto_reply = (
                "💸 Regarding your refund/payment: approved refunds are credited back to your JDLX Wallet or original "
                "payment method within 24–48 banking hours. Our finance supervisor has been notified."
            )
        elif any(w in lower_msg for w in ['vip', 'membership', 'premium', 'discount', 'coupon']):
            auto_reply = (
                "👑 JDLX VIP Concierge: Active members enjoy priority shipping, exclusive preview access, and direct hotline support. "
                "Let me know what offer or perk you would like to know more about!"
            )
        else:
            auto_reply = (
                "Thank you for reaching out to JDLX Official Chat. Our Senior Specialist has received your message "
                "and is currently reviewing your account details. A dedicated specialist will assist you shortly!"
            )

        if auto_reply:
            specialist_name = room.get('assigned_specialist', 'JDLX Senior Specialist (Verified)')
            cursor.execute(
                """INSERT INTO official_chat_messages 
                   (room_id, user_id, sender_type, sender_name, message, message_type, is_read)
                   VALUES (?, ?, 'specialist', ?, ?, 'text', 0)""",
                (room_id, user_id, specialist_name, auto_reply)
            )
            spec_msg_id = cursor.lastrowid

            # Add isolated chat notification for this reply
            cursor.execute(
                """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
                   VALUES (?, ?, 'New Specialist Reply', ?)""",
                (user_id, room_id, f"Specialist: {auto_reply[:90]}...")
            )

        conn.commit()

        # Fetch latest messages to return
        cursor.execute(
            """SELECT id, room_id, user_id, sender_type, sender_name, message, media_url, message_type, is_read, created_at
               FROM official_chat_messages 
               WHERE room_id = ? 
               ORDER BY created_at ASC, id ASC""",
            (room_id,)
        )
        messages = [dict(m) for m in cursor.fetchall()]
        for m in messages:
            if m.get('created_at'):
                m['created_at'] = format_utc_iso(m['created_at'])

        return success_response(messages, "Message sent successfully")
    finally:
        conn.close()


_CHAT_UPLOAD_SWEEP_INTERVAL_S = 3600
_chat_upload_sweep = {"last": 0.0}


def _sweep_orphaned_chat_uploads(conn):
    """Delete week-old chat uploads that no message references.

    Runs at most once an hour (inside an upload request), caps work at 200
    rows, and only touches `chat_` filenames, so the DB does not accumulate
    abandoned 5MB blobs forever.
    """
    mono = time.monotonic()
    if mono - _chat_upload_sweep["last"] < _CHAT_UPLOAD_SWEEP_INTERVAL_S:
        return
    _chat_upload_sweep["last"] = mono
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT filename FROM uploaded_media
               WHERE filename LIKE 'chat_%'
                 AND created_at < datetime('now', '-7 days')
                 AND NOT EXISTS (
                     SELECT 1 FROM official_chat_messages m
                     WHERE m.media_url LIKE '%' || uploaded_media.filename || '%'
                 )
               LIMIT 200"""
        )
        stale = [row['filename'] for row in cursor.fetchall()]
        if not stale:
            return
        upload_folder = current_app.config.get(
            'UPLOAD_FOLDER', os.path.join(os.path.dirname(__file__), 'static', 'uploads')
        )
        for name in stale:
            cursor.execute("DELETE FROM uploaded_media WHERE filename = ?", (name,))
            try:
                disk_path = os.path.join(upload_folder, name)
                if os.path.isfile(disk_path):
                    os.remove(disk_path)
            except OSError:
                pass
        conn.commit()
        logger.info("Swept %s unused chat uploads", len(stale))
    except Exception as e:
        logger.warning("Chat upload sweep skipped: %s", e)


@chat_bp.route('/upload', methods=['POST'])
@chat_token_required
def upload_chat_media():
    """Upload an image attachment for Official Chat with database persistence."""
    uploader_id = request.chat_user['user_id']
    if not check_chat_rate_limit("chat_upload", f"user_{uploader_id}", max_requests=20, window_seconds=60):
        return error_response("Too many uploads. Please wait a moment.", 429)
    # Uploads are tied to a room the caller actually participates in, so an
    # authenticated account can't use chat as free unlimited file storage.
    # Note: User profile avatars belong to the caller's account and do not require a room_id.
    declared_kind = (request.form.get('kind') or request.args.get('kind') or 'image').strip().lower()
    if declared_kind not in CHAT_MEDIA_LIMITS:
        return error_response("Unsupported media type", 400)

    room_row = None
    if declared_kind in ('avatar', 'profile'):
        room_id = None
    else:
        raw_room_id = request.form.get('room_id') or request.args.get('room_id')
        try:
            room_id = int(raw_room_id)
        except (TypeError, ValueError):
            return error_response("A valid room_id is required for uploads", 400)

        conn = get_db()
        try:
            room_row, room_allowed = get_chat_room_for_user(
                conn.cursor(), room_id, uploader_id
            )
        finally:
            conn.close()
        if not room_row:
            return error_response("Chat room not found", 404)
        if not room_allowed:
            return error_response("Access denied to this chat room", 403)

    if 'file' not in request.files:
        return error_response("No file provided", 400)

    file = request.files['file']
    if not file or not file.filename:
        return error_response("Empty file", 400)

    filename = secure_filename(file.filename)
    if not filename or '.' not in filename:
        return error_response("Invalid file name", 400)
    ext = filename.rsplit('.', 1)[1].lower()

    if ext not in CHAT_MEDIA_EXTENSIONS[declared_kind]:
        return error_response(
            f"Allowed {declared_kind} formats: {', '.join(sorted(CHAT_MEDIA_EXTENSIONS[declared_kind]))}",
            400
        )

    # Read one byte past the per-kind cap: never buffer an unbounded body.
    size_limit = CHAT_MEDIA_LIMITS[declared_kind]
    file_bytes = file.read(size_limit + 1)
    if len(file_bytes) > size_limit:
        return error_response(
            f"{declared_kind.capitalize()} file must be under {size_limit // (1024 * 1024)}MB",
            400
        )

    # Never trust the client Content-Type or extension: sniff magic bytes and
    # store the canonical MIME. Otherwise HTML/JS/executables renamed to a
    # supported extension would be served as text/html from our own origin
    # (stored XSS).
    sniffed = sniff_chat_media_by_kind(file_bytes, declared_kind)
    if not sniffed:
        return error_response("File content is not a supported media type", 400)
    sniffed_kind, mime_type, allowed_exts = sniffed
    if ext not in allowed_exts:
        return error_response("File extension does not match its content", 400)
    if sniffed_kind != declared_kind:
        # WebM/EBML registered as audio/webm or video/webm, MP4 as video/mp4 -
        # only the server-declared kind disambiguates those two, which we
        # already trusted once the container passed the above.
        pass

    unique_filename = f"chat_{secrets.token_hex(8)}_{filename}"

    # WhatsApp-grade server-side safeguard: If image exceeds max dimension or byte cap,
    # apply lossless EXIF orientation correction and adaptive Lanczos downscaling to ~150KB.
    if declared_kind in ('image', 'avatar') and mime_type in ('image/jpeg', 'image/png', 'image/webp'):
        try:
            from PIL import Image as PILImage, ImageOps as PILImageOps
            import io as py_io
            with PILImage.open(py_io.BytesIO(file_bytes)) as pil_img:
                pil_img = PILImageOps.exif_transpose(pil_img)
                max_edge = 512 if declared_kind == 'avatar' else 1280
                target_byte_cap = 80 * 1024 if declared_kind == 'avatar' else 320 * 1024
                if max(pil_img.size) > max_edge or len(file_bytes) > target_byte_cap:
                    pil_img.thumbnail((max_edge, max_edge), PILImage.Resampling.LANCZOS)
                    out_io = py_io.BytesIO()
                    if pil_img.mode in ('RGBA', 'LA') or (pil_img.mode == 'P' and 'transparency' in pil_img.info):
                        bg = PILImage.new('RGB', pil_img.size, (255, 255, 255))
                        bg.paste(pil_img, mask=pil_img.convert('RGBA').split()[3])
                        pil_img = bg
                    elif pil_img.mode != 'RGB':
                        pil_img = pil_img.convert('RGB')
                    pil_img.save(out_io, format='JPEG', quality=74, optimize=True)
                    opt_bytes = out_io.getvalue()
                    if len(opt_bytes) < len(file_bytes):
                        file_bytes = opt_bytes
                        mime_type = 'image/jpeg'
                        if not unique_filename.lower().endswith(('.jpg', '.jpeg')):
                            unique_filename = unique_filename.rsplit('.', 1)[0] + '.jpg'
        except Exception as img_err:
            logger.warning("Server-side image optimization safeguard bypassed: %s", img_err)

    # Try saving to disk if upload folder is configured
    upload_folder = current_app.config.get('UPLOAD_FOLDER', os.path.join(os.path.dirname(__file__), 'static', 'uploads'))
    os.makedirs(upload_folder, exist_ok=True)
    disk_path = os.path.join(upload_folder, unique_filename)
    try:
        with open(disk_path, 'wb') as f:
            f.write(file_bytes)
    except Exception as e:
        print(f"[CHAT UPLOAD] Failed to save to disk: {e}")

    # Persist in uploaded_media database table so Render restarts don't lose the image
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """INSERT OR REPLACE INTO uploaded_media (filename, mime_type, data)
               VALUES (?, ?, ?)""",
            (unique_filename, mime_type, file_bytes)
        )
        conn.commit()
        _sweep_orphaned_chat_uploads(conn)
    finally:
        conn.close()

    media_url = signed_media_url(f"/static/uploads/{unique_filename}")
    return success_response({
        'url': media_url,
        'filename': unique_filename,
        'media_kind': declared_kind,
        'mime_type': mime_type
    }, "File uploaded successfully")


# -----------------------------------------------------------------------------
# ISOLATED CHAT NOTIFICATIONS ENDPOINTS
# -----------------------------------------------------------------------------

@chat_bp.route('/notifications', methods=['GET'])
@chat_token_required
def get_chat_notifications():
    """Get user's isolated official chat notifications (100% separated from store)."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT id, user_id, room_id, title, message, is_read, created_at
               FROM official_chat_notifications
               WHERE user_id = ?
               ORDER BY created_at DESC LIMIT 50""",
            (user_id,)
        )
        notifications = [dict(n) for n in cursor.fetchall()]
        for n in notifications:
            if n.get('created_at'):
                n['created_at'] = format_utc_iso(n['created_at'])
        return success_response(notifications, "Chat notifications retrieved")
    finally:
        conn.close()


@chat_bp.route('/notifications/<int:nid>/read', methods=['PATCH', 'POST'])
@chat_token_required
def mark_chat_notification_read(nid):
    """Mark an isolated chat notification as read."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE official_chat_notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
            (nid, user_id)
        )
        conn.commit()
        return success_response(None, "Notification marked as read")
    finally:
        conn.close()


@chat_bp.route('/notifications/<int:nid>', methods=['DELETE'])
@chat_token_required
def delete_chat_notification(nid):
    """Delete an isolated chat notification for current user."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM official_chat_notifications WHERE id = ? AND user_id = ?",
            (nid, user_id)
        )
        conn.commit()
        return success_response(None, "Notification deleted")
    finally:
        conn.close()


@chat_bp.route('/notifications/read-all', methods=['POST'])
@chat_token_required
def mark_all_chat_notifications_read():
    """Mark all isolated chat notifications as read for current user."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE official_chat_notifications SET is_read = 1 WHERE user_id = ?",
            (user_id,)
        )
        conn.commit()
        return success_response(None, "All chat notifications marked as read")
    finally:
        conn.close()


@chat_bp.route('/unread-count', methods=['GET'])
@chat_token_required
def get_chat_unread_count():
    """Returns isolated unread count for Official Chat badge."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        # Count every unread message in ANY room the user participates in.
        # The old query only looked at rooms where user_id = me (legacy support
        # rooms) and excluded sender_type='user', so direct messages were never
        # counted at all - and for the user_two_id side of a DM room nothing
        # was counted even in the room filter.
        cursor.execute(
            """SELECT COUNT(*) AS unread_msgs
               FROM official_chat_messages m
               JOIN official_chat_rooms r ON m.room_id = r.id
               LEFT JOIN official_chat_room_clears cc
                 ON cc.room_id = m.room_id AND cc.user_id = ?
               WHERE m.is_read = 0
                 AND (
                   r.user_id = ? OR r.user_two_id = ?
                   OR m.room_id IN (SELECT room_id FROM official_chat_group_members WHERE user_id = ?)
                 )
                 AND (m.user_id != ? OR m.sender_type != 'user')
                 AND m.id > COALESCE(cc.cleared_upto_id, 0)
                 AND m.id NOT IN (SELECT message_id FROM chat_message_hides WHERE user_id = ?)""",
            (user_id, user_id, user_id, user_id, user_id, user_id)
        )
        unread_msgs = cursor.fetchone()['unread_msgs'] or 0

        cursor.execute(
            "SELECT COUNT(*) AS unread_notifs FROM official_chat_notifications WHERE user_id = ? AND is_read = 0",
            (user_id,)
        )
        unread_notifs = cursor.fetchone()['unread_notifs'] or 0

        return success_response({
            'unread_messages': unread_msgs,
            'unread_notifications': unread_notifs,
            'total_unread': unread_msgs + unread_notifs
        }, "Unread count retrieved")
    finally:
        conn.close()


@chat_bp.route('/clear', methods=['POST'])
@chat_token_required
def clear_chat_history():
    """Clears user's active official chat messages and resets conversation."""
    user_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        # Support room ONLY. This query used to match a DM room whenever the
        # caller was its lower-id participant and then DELETE all of its
        # messages for BOTH sides - which is exactly how direct-chat history
        # vanished. Direct rooms are cleared through /rooms/<id>/clear, which
        # is participant-checked and per-user.
        cursor.execute(
            "SELECT id FROM official_chat_rooms WHERE user_id = ? AND status = 'active' AND user_two_id IS NULL",
            (user_id,)
        )
        room = cursor.fetchone()
        if room:
            room_id = room['id']
            cursor.execute("DELETE FROM official_chat_messages WHERE room_id = ?", (room_id,))
            cursor.execute("DELETE FROM official_chat_notifications WHERE user_id = ?", (user_id,))
            
            # Re-seed welcome message
            cursor.execute("SELECT name FROM chat_users WHERE id = ?", (user_id,))
            u_row = cursor.fetchone()
            user_name = u_row['name'] if u_row and u_row['name'] else 'Customer'
            
            welcome_text = (
                f"Hello {user_name}! 👋 Conversation restarted.\n"
                "I am your assigned JDLX Specialist. How can I assist you right now?"
            )
            cursor.execute(
                """INSERT INTO official_chat_messages 
                   (room_id, user_id, sender_type, sender_name, message, message_type, is_read)
                   VALUES (?, ?, 'specialist', 'JDLX Senior Specialist (Verified)', ?, 'text', 0)""",
                (room_id, user_id, welcome_text)
            )
            cursor.execute(
                "UPDATE official_chat_rooms SET last_message = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?",
                ("Conversation restarted", room_id)
            )
            conn.commit()

        return success_response(None, "Chat conversation restarted")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/typing', methods=['POST'])
@chat_token_required
def set_room_typing(room_id):
    """Mark the caller as typing in a room (short-lived, DB-backed)."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("typing", f"user_{my_id}", max_requests=60, window_seconds=60):
        return error_response("Too many typing updates.", 429)

    conn = get_db()
    try:
        cursor = conn.cursor()
        room, room_allowed = get_chat_room_for_user(cursor, room_id, my_id)
        if not room:
            return error_response("Chat room not found", 404)
        if not room_allowed:
            return error_response("Access denied to this chat room", 403)

        cursor.execute(
            "INSERT OR REPLACE INTO chat_typing (room_id, user_id, updated_at) VALUES (?, ?, ?)",
            (room_id, my_id, int(time.time()))
        )
        conn.commit()
        return success_response(None, "Typing state updated")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/events', methods=['GET'])
@chat_token_required
def poll_room_events(room_id):
    """Long-poll realtime events for a room: new messages + presence.

    Only the new-message query has to run every cycle. Typing, read receipts
    and edit/delete/reaction changes used to add 3 more queries per 0.75s for
    every open chat, which starved the gunicorn threads and delayed sends; they
    are delivered by the Supabase broadcast channel instead.

    Read state is still WRITTEN here (messages fetched by this poll are marked
    read, which drives unread badges); only the peer's receipt is no longer
    read back on every cycle.

    Long-poll instead of WebSocket/SSE keeps the sync gunicorn deployment
    working (no new dependency/worker class) while still delivering messages in
    well under a second instead of the old 4s full-room poll. Requests are
    capped at ~12s so a thread is never held indefinitely.
    """
    my_id = request.chat_user['user_id']
    after_id = request.args.get('after_message_id', type=int) or 0
    timeout = request.args.get('timeout', type=int) or 3
    timeout = max(1, min(timeout, 4))
    known_online = request.args.get('online', type=int)

    conn = get_db()
    try:
        cursor = conn.cursor()
        room, room_allowed = get_chat_room_for_user(cursor, room_id, my_id)
        if not room:
            return error_response("Chat room not found", 404)
        if not room_allowed:
            return error_response("Access denied to this chat room", 403)

        other_id = room['user_two_id'] if room['user_id'] == my_id else room['user_id']
        peer_pubkey = None
        if other_id:
            cursor.execute("SELECT public_key FROM chat_users WHERE id = ?", (other_id,))
            peer_row = cursor.fetchone()
            if peer_row and peer_row['public_key']:
                peer_pubkey = peer_row['public_key']

        cursor.execute(
            "SELECT cleared_upto_id FROM official_chat_room_clears WHERE room_id = ? AND user_id = ?",
            (room_id, my_id)
        )
        cleared_row = cursor.fetchone()
        cleared_upto = (cleared_row['cleared_upto_id'] if cleared_row else 0) or 0

        # Legacy v1 messages need the room secret; v2 messages never do.
        cursor.execute("SELECT e2e_secret FROM official_chat_rooms WHERE id = ?", (room_id,))
        secret_row = cursor.fetchone()
        room_secret = secret_row['e2e_secret'] if secret_row else None

        deadline = time.time() + timeout
        last_presence_ping = 0
        last_online_check = 0
        peer_online = None
        while True:
            now = int(time.time())
            # Presence heartbeat. 45s is safely inside the 90s "online" window
            # and cuts these write+commit round-trips to a third; they used to
            # compete with message writes on every open chat.
            if now - last_presence_ping >= 45:
                cursor.execute(
                    "UPDATE chat_users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (my_id,)
                )
                conn.commit()
                last_presence_ping = now

            cursor.execute(
                f"""SELECT {CHAT_MESSAGE_COLUMNS} FROM official_chat_messages
                    WHERE room_id = ? AND id > ? AND id > ?
                      AND id NOT IN (SELECT message_id FROM chat_message_hides WHERE user_id = ?)
                    ORDER BY id ASC LIMIT 100""",
                (room_id, after_id, cleared_upto, my_id)
            )
            rows = cursor.fetchall()

            peer_typing = False
            if other_id:
                # The peer's online flag changes slowly; querying it every
                # 0.75s cycle was one of the biggest remote-DB read loads.
                if peer_online is None or now - last_online_check >= 15:
                    cursor.execute(
                        """SELECT CASE WHEN last_seen_at >= datetime('now', '-90 seconds')
                                       THEN 1 ELSE 0 END AS online
                           FROM chat_users WHERE id = ?""",
                        (other_id,)
                    )
                    online_row = cursor.fetchone()
                    peer_online = bool(online_row and online_row['online'])
                    last_online_check = now
            else:
                peer_online = False

            online_changed = (known_online is not None) and (int(peer_online) != int(known_online))

            if rows or online_changed:
                merged = {}
                for row in rows:
                    merged[row['id']] = dict(row)
                messages = sorted(merged.values(), key=lambda m: m['id'])
                _attach_message_reactions(cursor, messages, my_id)
                cursor.execute("SELECT public_key FROM chat_users WHERE id = ?", (my_id,))
                me_key_row = cursor.fetchone()
                my_pubkey = me_key_row['public_key'] if me_key_row and me_key_row['public_key'] else None

                for m in messages:
                    msg_text = str(m.get('message') or '')
                    m['e2e_secret'] = room_secret if msg_text.startswith('enc:v1:') else None
                    m['contact_public_key'] = peer_pubkey
                    if m.get('user_id') == my_id:
                        m['sender_public_key'] = my_pubkey
                        m['recipient_public_key'] = peer_pubkey
                    else:
                        m['sender_public_key'] = peer_pubkey
                        m['recipient_public_key'] = my_pubkey
                    _sanitize_chat_message(m)
                if rows:
                    # Reading via long-poll counts as read too (badge + receipts).
                    # Same authorship rule as the clear endpoint: staff rows carry
                    # the viewer's own user_id, so they must still mark as read.
                    cursor.execute(
                        """UPDATE official_chat_messages SET is_read = 1
                           WHERE room_id = ? AND is_read = 0
                             AND (user_id != ? OR sender_type != 'user')""",
                        (room_id, my_id)
                    )
                    cursor.execute(
                        """SELECT MAX(id) AS max_id FROM official_chat_messages
                           WHERE room_id = ? AND (user_id != ? OR sender_type != 'user')""",
                        (room_id, my_id)
                    )
                    latest = cursor.fetchone()
                    latest_id = int(latest['max_id'] or 0) if latest else 0
                    if latest_id:
                        cursor.execute(
                            """INSERT OR REPLACE INTO official_chat_read_state
                               (room_id, user_id, last_read_id, updated_at)
                               VALUES (?, ?, ?, ?)""",
                            (room_id, my_id, latest_id, now)
                        )
                    try:
                        conn.commit()
                    except Exception as commit_err:
                        # Same as the history endpoint: the messages were read,
                        # so deliver them; only the tick/bookkeeping write is
                        # lost if the stream died while sleeping.
                        if not is_transient_db_error(commit_err):
                            raise
                        logger.warning("Long-poll read-state commit failed: %s", commit_err)

                return success_response({
                    'messages': messages,
                    'peer_typing': peer_typing,
                    'peer_online': peer_online,
                    'server_time': now
                }, "Events retrieved")

            if time.time() >= deadline:
                return success_response({
                    'messages': [],
                    'peer_typing': peer_typing,
                    'peer_online': peer_online,
                    'server_time': now
                }, "No new events")

            # Hand the pooled stream back before sleeping. Holding it across
            # the 0.75s gap meant every open chat occupied one pool slot for as
            # long as the chat stayed open; other requests then had to build
            # fresh Turso connections (multi-second each — the "send is stuck"
            # stalls, one measured 44s in the production logs) and Turso rolled
            # back the transaction that sat idle here.
            release = getattr(conn, 'release', None)
            if callable(release):
                release()
            time.sleep(0.75)
            if callable(release):
                conn = get_db()
                cursor = conn.cursor()
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/clear', methods=['POST'])
@chat_token_required
def clear_room_history(room_id):
    """Clear a conversation for the CALLER only.

    The old global /chat/clear wiped whichever legacy support room happened to
    be active (regardless of what the user was actually looking at) and deleted
    rows for BOTH sides. This endpoint is room-scoped, membership-checked, and
    hides history behind a per-user watermark.
    """
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        room, room_allowed = get_chat_room_for_user(cursor, room_id, my_id)
        if not room:
            return error_response("Chat room not found", 404)
        if not room_allowed:
            return error_response("Access denied to this chat room", 403)

        cursor.execute(
            "SELECT COALESCE(MAX(id), 0) AS max_id FROM official_chat_messages WHERE room_id = ?",
            (room_id,)
        )
        max_id = cursor.fetchone()['max_id'] or 0
        cursor.execute(
            """INSERT OR REPLACE INTO official_chat_room_clears
               (room_id, user_id, cleared_upto_id, cleared_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)""",
            (room_id, my_id, max_id)
        )
        # Clearing also resolves the caller's unread state for this room.
        cursor.execute(
            """UPDATE official_chat_messages SET is_read = 1
               WHERE room_id = ? AND is_read = 0
                 AND (user_id != ? OR sender_type != 'user')""",
            (room_id, my_id)
        )
        conn.commit()
        return success_response(
            {'room_id': room_id, 'cleared_upto_id': max_id},
            "Conversation cleared"
        )
    finally:
        conn.close()


# -----------------------------------------------------------------------------
# ADMIN OFFICIAL CHAT CONTROLS ENDPOINTS
# -----------------------------------------------------------------------------

# Roles that may operate the Official Chat control panel (kept in sync with
# auth.role_guard.ADMIN_ROLES).
CHAT_ADMIN_PANEL_ROLES = {
    'super_admin', 'admin', 'manager', 'support_admin',
    'inventory_admin', 'delivery_admin',
}


def _load_live_admin(payload):
    """Return the live admin row for a decoded token, or None.

    A JWT is only a snapshot of the moment it was issued. If the account was
    deleted, disabled or demoted afterwards, that stale token must stop working
    immediately - only the database is authoritative.
    """
    admin_id = payload.get('user_id') or payload.get('sub')
    try:
        admin_id = int(admin_id)
    except (TypeError, ValueError):
        return None

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, role, account_status FROM users WHERE id = ?",
            (admin_id,)
        ).fetchone()
    finally:
        conn.close()

    if not row:
        return None
    db_role = str(row['role'] or '').strip().lower()
    if db_role not in CHAT_ADMIN_PANEL_ROLES:
        return None
    if str(row['account_status'] or 'active').strip().lower() != 'active':
        return None
    return {'id': admin_id, 'role': db_role}


def admin_token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        # Bearer only: a cookie-authenticated admin API is CSRF-able (a
        # cross-site form can trigger state-changing admin actions). The admin
        # SPA already sends the token in the Authorization header.
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return error_response("Admin authorization token missing", 401)
        token = auth_header.split(" ", 1)[1].strip()
        if not token:
            return error_response("Admin authorization token missing", 401)

        secret = get_secret_key()
        try:
            # An admin token without exp would be valid forever.
            payload = jwt.decode(
                token, secret, algorithms=["HS256"],
                options={"require": ["exp"]}
            )
        except Exception:
            return error_response("Invalid or expired admin session", 401)

        # Realm separation: chat / warehouse / delivery / request tokens share
        # the signing secret but are different session domains.
        token_type = str(payload.get('type') or '').strip().lower()
        if token_type and token_type not in ('access', 'admin'):
            return error_response("Admin privileges required", 403)

        claim_role = str(payload.get('role', '')).strip().lower()
        if claim_role not in CHAT_ADMIN_PANEL_ROLES:
            return error_response("Admin privileges required", 403)

        live_admin = _load_live_admin(payload)
        if not live_admin:
            return error_response("Admin privileges required", 403)
        if live_admin['role'] != claim_role:
            return error_response("Admin session is out of date. Please sign in again.", 403)

        request.admin_user = payload
        return f(*args, **kwargs)
    return decorated


@chat_bp.route('/admin/stats', methods=['GET'])
@admin_token_required
def get_chat_admin_stats():
    """Retrieve aggregate statistics for the Official Chat control panel."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        
        # Total rooms
        cursor.execute("SELECT COUNT(*) AS total_rooms FROM official_chat_rooms")
        total_rooms = cursor.fetchone()['total_rooms'] or 0

        # Active rooms
        cursor.execute("SELECT COUNT(*) AS active_rooms FROM official_chat_rooms WHERE status = 'active'")
        active_rooms = cursor.fetchone()['active_rooms'] or 0

        # Total messages
        cursor.execute("SELECT COUNT(*) AS total_messages FROM official_chat_messages")
        total_messages = cursor.fetchone()['total_messages'] or 0

        # Unread messages (from customer, waiting for admin/specialist response)
        cursor.execute("SELECT COUNT(*) AS unread_messages FROM official_chat_messages WHERE sender_type = 'user' AND is_read = 0")
        unread_messages = cursor.fetchone()['unread_messages'] or 0

        # Total registered users with chat handles
        cursor.execute("SELECT COUNT(*) AS total_chat_users FROM chat_users WHERE username IS NOT NULL AND username != ''")
        total_chat_users = cursor.fetchone()['total_chat_users'] or 0

        return success_response({
            'total_rooms': total_rooms,
            'active_rooms': active_rooms,
            'total_messages': total_messages,
            'unread_messages': unread_messages,
            'total_chat_users': total_chat_users,
            'specialists_online': 4  # Certified specialist pool
        }, "Admin chat stats retrieved")
    finally:
        conn.close()


@chat_bp.route('/admin/rooms', methods=['GET'])
@admin_token_required
def get_chat_admin_rooms():
    """List all official customer chat rooms with search and filter for admin console."""
    status_filter = request.args.get('status')
    search_query = (request.args.get('q') or '').strip().lower()

    conn = get_db()
    try:
        cursor = conn.cursor()
        query = """
            SELECT 
                r.id, 
                r.user_id, 
                r.room_key, 
                r.title, 
                r.status, 
                r.assigned_specialist, 
                r.last_message, 
                r.last_message_at, 
                r.created_at,
                r.username AS room_username,
                u.name AS user_name,
                u.email AS user_email,
                u.phone AS user_phone,
                u.username AS user_handle,
                u.profile_image,
                (
                    SELECT COUNT(*) 
                    FROM official_chat_messages m 
                    WHERE m.room_id = r.id AND m.sender_type = 'user' AND m.is_read = 0
                ) AS unread_count
            FROM official_chat_rooms r
            LEFT JOIN chat_users u ON r.user_id = u.id
            WHERE 1=1
        """
        params = []

        if status_filter and status_filter != 'all':
            query += " AND r.status = ?"
            params.append(status_filter)

        if search_query:
            clean_q = search_query.lstrip('@')
            query += " AND (LOWER(u.name) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(r.username) LIKE ? OR u.phone LIKE ?)"
            params.extend([f"%{clean_q}%", f"%{clean_q}%", f"%{clean_q}%", f"%{clean_q}%"])

        query += " ORDER BY r.last_message_at DESC LIMIT 100"
        cursor.execute(query, tuple(params))
        rooms = [dict(row) for row in cursor.fetchall()]
        for r in rooms:
            if r.get('last_message_at'):
                r['last_message_at'] = format_utc_iso(r['last_message_at'])
            if r.get('created_at'):
                r['created_at'] = format_utc_iso(r['created_at'])

        return success_response(rooms, "Admin chat rooms retrieved")
    finally:
        conn.close()


@chat_bp.route('/admin/rooms/<int:room_id>/messages', methods=['GET'])
@admin_token_required
def get_chat_admin_room_messages(room_id):
    """Retrieve full message history for a specific room and mark user messages as read."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        
        # Verify room exists
        cursor.execute(
            """SELECT r.*, u.name as user_name, u.phone as user_phone, u.email as user_email, u.username as user_handle
               FROM official_chat_rooms r
               LEFT JOIN chat_users u ON r.user_id = u.id
               WHERE r.id = ?""",
            (room_id,)
        )
        room_row = cursor.fetchone()
        if not room_row:
            return error_response("Chat room not found", 404)

        # Mark user messages as read by admin/specialist
        cursor.execute(
            "UPDATE official_chat_messages SET is_read = 1 WHERE room_id = ? AND sender_type = 'user'",
            (room_id,)
        )
        conn.commit()

        # Fetch messages
        cursor.execute(
            """SELECT id, room_id, user_id, sender_type, sender_name, message, media_url, message_type, is_read, created_at, username
               FROM official_chat_messages
               WHERE room_id = ?
               ORDER BY id ASC""",
            (room_id,)
        )
        messages = [dict(m) for m in cursor.fetchall()]
        for m in messages:
            if m.get('created_at'):
                m['created_at'] = format_utc_iso(m['created_at'])

        return success_response({
            'room': dict(room_row),
            'messages': messages
        }, "Room messages retrieved")
    finally:
        conn.close()


@chat_bp.route('/admin/rooms/<int:room_id>/reply', methods=['POST'])
@admin_token_required
def post_chat_admin_reply(room_id):
    """Send an official admin/specialist reply into customer room."""
    data = request.get_json(silent=True) or {}
    message_text = (data.get('message') or '').strip()
    specialist_name = (data.get('specialist_name') or 'JDLX Senior Specialist (Verified)').strip()
    media_url = data.get('media_url')

    if not message_text and not media_url:
        return error_response("Message cannot be empty", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id, user_id FROM official_chat_rooms WHERE id = ?", (room_id,))
        room = cursor.fetchone()
        if not room:
            return error_response("Room not found", 404)

        user_id = room['user_id']

        # Insert specialist message
        cursor.execute(
            """INSERT INTO official_chat_messages 
               (room_id, user_id, sender_type, sender_name, message, media_url, message_type, is_read)
               VALUES (?, ?, 'specialist', ?, ?, ?, 'text', 0)""",
            (room_id, user_id, specialist_name, message_text, media_url)
        )
        msg_id = cursor.lastrowid

        # Update room last_message
        preview = (message_text[:60] + '...') if len(message_text) > 60 else message_text
        cursor.execute(
            "UPDATE official_chat_rooms SET last_message = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?",
            (preview, room_id)
        )

        # Insert isolated chat notification
        cursor.execute(
            """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
               VALUES (?, ?, 'Specialist Message', ?)""",
            (user_id, room_id, f"{specialist_name}: {message_text[:90]}")
        )
        conn.commit()

        cursor.execute("SELECT * FROM official_chat_messages WHERE id = ?", (msg_id,))
        new_msg = dict(cursor.fetchone())
        if new_msg.get('created_at'):
            new_msg['created_at'] = format_utc_iso(new_msg['created_at'])

        return success_response(new_msg, "Specialist reply sent successfully")
    finally:
        conn.close()


CHAT_ROOM_STATUSES = {'active', 'closed', 'flagged'}


@chat_bp.route('/admin/rooms/<int:room_id>/status', methods=['PATCH'])
@admin_token_required
def update_chat_admin_room_status(room_id):
    """Update room status ('active' | 'closed' | 'flagged') or assign specialist."""
    data = request.get_json(silent=True) or {}
    new_status = data.get('status')
    specialist = data.get('assigned_specialist')

    if new_status is None and specialist is None:
        return error_response("Provide a status or an assigned_specialist to update", 400)

    if new_status is not None:
        new_status = str(new_status).strip().lower()
        if new_status not in CHAT_ROOM_STATUSES:
            return error_response(
                f"Invalid status. Allowed: {', '.join(sorted(CHAT_ROOM_STATUSES))}", 400
            )

    if specialist is not None:
        # An empty string clears the assignment (admin panel "Unassign").
        specialist = str(specialist).strip()
        if len(specialist) > 120:
            return error_response("assigned_specialist must be 120 characters or fewer", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        # Check existence first: updating/`dict()`-ing a missing room used to
        # raise AttributeError (500) instead of a clean 404.
        cursor.execute("SELECT id FROM official_chat_rooms WHERE id = ?", (room_id,))
        if not cursor.fetchone():
            return error_response("Chat room not found", 404)

        if new_status is not None:
            cursor.execute("UPDATE official_chat_rooms SET status = ? WHERE id = ?", (new_status, room_id))
        if specialist is not None:
            cursor.execute("UPDATE official_chat_rooms SET assigned_specialist = ? WHERE id = ?", (specialist, room_id))
        conn.commit()

        cursor.execute("SELECT * FROM official_chat_rooms WHERE id = ?", (room_id,))
        updated_room = dict(cursor.fetchone())
        return success_response(updated_room, "Room status updated")
    finally:
        conn.close()


@chat_bp.route('/admin/broadcast', methods=['POST'])
@admin_token_required
def post_chat_admin_broadcast():
    """Send an isolated official announcement broadcast to all chat users."""
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or 'JDLX Official Announcement').strip()
    message = (data.get('message') or '').strip()

    if not message:
        return error_response("Broadcast message is required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id, user_id FROM official_chat_rooms WHERE status = 'active'")
        active_rooms = cursor.fetchall()

        for room in active_rooms:
            # Add message to room
            cursor.execute(
                """INSERT INTO official_chat_messages 
                   (room_id, user_id, sender_type, sender_name, message, message_type, is_read)
                   VALUES (?, ?, 'system', 'JDLX Official Announcement', ?, 'text', 0)""",
                (room['id'], room['user_id'], f"📢 {title}\n\n{message}")
            )
            # Add isolated chat notification
            cursor.execute(
                """INSERT INTO official_chat_notifications (user_id, room_id, title, message)
                   VALUES (?, ?, ?, ?)""",
                (room['user_id'], room['id'], title, message[:90])
            )

        conn.commit()
        return success_response({
            'delivered_rooms': len(active_rooms)
        }, f"Broadcast sent to {len(active_rooms)} active chat rooms")
    finally:
        conn.close()


# -----------------------------------------------------------------------------
# OFFICIAL CHAT BRANDING & APP ICON ADMIN CONTROLS
# -----------------------------------------------------------------------------

@chat_bp.route('/admin/settings', methods=['GET'])
@admin_token_required
def get_chat_admin_settings():
    """Retrieve Official Chat branding & logo settings."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM system_settings WHERE key IN ('official_chat_logo', 'official_chat_name')")
        rows = cursor.fetchall()
        settings = {
            'official_chat_logo': '',
            'official_chat_name': 'JDLX Chat'
        }
        for row in rows:
            settings[row['key']] = row['value']
        return success_response(settings, "Chat settings retrieved")
    finally:
        conn.close()


@chat_bp.route('/admin/settings', methods=['POST'])
@admin_token_required
def update_chat_admin_settings():
    """Update Official Chat branding, logo URL, or reset to default."""
    data = request.get_json(silent=True) or {}
    conn = get_db()
    try:
        cursor = conn.cursor()
        if 'official_chat_logo' in data:
            logo_val = str(data.get('official_chat_logo') or '').strip()
            cursor.execute(
                """INSERT INTO system_settings (key, value) VALUES ('official_chat_logo', ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                (logo_val,)
            )
        if 'official_chat_name' in data:
            name_val = str(data.get('official_chat_name') or 'JDLX Chat').strip()
            cursor.execute(
                """INSERT INTO system_settings (key, value) VALUES ('official_chat_name', ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                (name_val,)
            )
        conn.commit()
    finally:
        conn.close()

    # Clear cache
    try:
        from app import cache
        cache.clear()
    except Exception:
        pass

    return success_response(None, "Official Chat settings updated successfully")


@chat_bp.route('/admin/upload-logo', methods=['POST'])
@admin_token_required
def upload_chat_logo():
    """Upload or update the Official Chat logo/app icon with persistent storage."""
    if 'file' not in request.files:
        return error_response("No file provided", 400)

    file = request.files['file']
    if not file or not file.filename:
        return error_response("Empty file", 400)

    filename = secure_filename(file.filename)
    ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''
    allowed = {'png', 'jpg', 'jpeg', 'webp', 'svg'}
    if ext not in allowed:
        return error_response(f"Allowed formats: {', '.join(sorted(allowed))}", 400)

    file_bytes = file.read()
    if len(file_bytes) > 5 * 1024 * 1024:  # 5MB max
        return error_response("Logo image file must be under 5MB", 400)

    unique_filename = f"chat_logo_{secrets.token_hex(6)}_{filename}"
    mime_type = file.mimetype or f"image/{ext}"

    # 1. Save to disk in static/uploads
    upload_folder = current_app.config.get('UPLOAD_FOLDER', os.path.join(os.path.dirname(__file__), 'static', 'uploads'))
    os.makedirs(upload_folder, exist_ok=True)
    disk_path = os.path.join(upload_folder, unique_filename)
    try:
        with open(disk_path, 'wb') as f:
            f.write(file_bytes)
    except Exception as e:
        print(f"[CHAT LOGO UPLOAD] Failed to save to disk: {e}")

    # 2. Persist in uploaded_media and system_settings in a single fast, immediate DB transaction
    media_url = signed_media_url(f"/static/uploads/{unique_filename}")
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """INSERT OR REPLACE INTO uploaded_media (filename, mime_type, data)
               VALUES (?, ?, ?)""",
            (unique_filename, mime_type, file_bytes)
        )
        cursor.execute(
            """INSERT INTO system_settings (key, value) VALUES ('official_chat_logo', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
            (media_url,)
        )
        conn.commit()
    except Exception as dbe:
        print(f"[CHAT LOGO UPLOAD] DB insert error, retrying with fresh connection: {dbe}")
        try:
            conn.close()
        except Exception:
            pass
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            """INSERT OR REPLACE INTO uploaded_media (filename, mime_type, data)
               VALUES (?, ?, ?)""",
            (unique_filename, mime_type, file_bytes)
        )
        cursor.execute(
            """INSERT INTO system_settings (key, value) VALUES ('official_chat_logo', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
            (media_url,)
        )
        conn.commit()
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # 3. Optional async/fast cloud mirror (done AFTER DB is committed and closed)
    try:
        from services.cloud_image_service import upload_image_to_cloud
        cloud_url = upload_image_to_cloud(file_bytes, unique_filename)
        if cloud_url and cloud_url.startswith("http"):
            media_url = cloud_url
            try:
                c2 = get_db()
                c2.cursor().execute(
                    """INSERT INTO system_settings (key, value) VALUES ('official_chat_logo', ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                    (cloud_url,)
                )
                c2.commit()
                c2.close()
            except Exception as ce2:
                print(f"[CHAT LOGO UPLOAD] Cloud URL DB update failed: {ce2}")
    except Exception as ce:
        print(f"[CHAT LOGO UPLOAD] Cloud mirror skipped: {ce}")

    # Invalidate settings cache
    try:
        from app import cache
        cache.clear()
    except Exception:
        pass

    return success_response({
        'url': media_url,
        'filename': unique_filename
    }, "Official Chat logo uploaded and updated successfully")


# The chat APK is served from this backend only. It must never fall back to a
# storefront URL: installing the "chat" app used to download the store APK.
@chat_bp.route('/download/apk', methods=['GET'])
def download_chat_apk():
    """Direct APK download endpoint for the Official Chat Android app."""
    backend_root = os.path.dirname(os.path.abspath(__file__))
    # A separate chat service may not have the APK inside its deploy image.
    # CHAT_APK_PATH lets ops point at an absolute path without changing code.
    configured_apk = (os.environ.get('CHAT_APK_PATH') or '').strip()
    candidates = tuple(
        path for path in (
            configured_apk,
            os.path.join(backend_root, 'static', 'downloads', 'official-chat.apk'),
            os.path.join(backend_root, 'static', 'downloads', 'jdlx-chat.apk'),
        ) if path
    )
    target = next((p for p in candidates if os.path.isfile(p)), None)
    if target:
        return send_file(
            target,
            mimetype='application/vnd.android.package-archive',
            as_attachment=True,
            download_name='official-chat.apk'
        )
    return error_response('Official Chat APK not found on server.', 404)


# -----------------------------------------------------------------------------
# VOICE / VIDEO CALL SIGNALING (SDP + ICE candidates over HTTP, no WebSocket)
# -----------------------------------------------------------------------------
_CALL_RATE_LIMIT = {"max_requests": 30, "window_seconds": 60}


def _call_peer_ids(cursor, room_id, my_id):
    """Return (caller_is_user_id, other_id) for a direct room, or None if not a
    participant / not a direct room."""
    cursor.execute(
        "SELECT user_id, user_two_id, room_type FROM official_chat_rooms WHERE id = ?",
        (room_id,)
    )
    room = cursor.fetchone()
    if not room:
        return None
    if room['room_type'] != 'direct':
        return None
    if my_id != room['user_id'] and my_id != room['user_two_id']:
        return None
    other_id = room['user_two_id'] if my_id == room['user_id'] else room['user_id']
    return other_id


def _parse_candidates(raw):
    if not raw:
        return []
    try:
        arr = json.loads(raw)
        return arr if isinstance(arr, list) else []
    except (ValueError, TypeError):
        return []


def _turn_rest_credentials(secret, user_key, ttl_seconds):
    """Ephemeral TURN credentials for coturn's ``use-auth-secret`` mode.

    The relay validates the same HMAC-SHA1 itself, so a long-lived password is
    never shipped to the browser: every call gets a username of
    ``<expiry>:<user id>`` and a credential that dies with it. Without this a
    public relay either needs a static password in the client (leak = free
    relay for anyone) or per-user accounts.
    """
    username = f"{int(time.time()) + int(ttl_seconds)}:{user_key}"
    digest = hmac.new(
        secret.encode('utf-8'), username.encode('utf-8'), hashlib.sha1
    ).digest()
    return username, base64.b64encode(digest).decode('ascii')


@chat_bp.route('/ice-servers', methods=['GET'])
@chat_token_required
def chat_ice_servers():
    """ICE servers for WebRTC calls (STUN + optional TURN relay).

    STUN alone only connects peers that can reach each other directly; mobile
    carrier NAT and strict corporate networks need a TURN relay. Configure a
    TURN provider on the backend (TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL, or a
    complete list via ICE_SERVERS_JSON) and both the web app and the APK pick
    it up without a rebuild.

    For a self-hosted coturn, prefer TURN_URLS + TURN_SECRET (coturn
    ``use-auth-secret``): each call gets a short-lived HMAC credential instead
    of a shared password embedded in the client.
    """
    servers = []

    raw = (os.getenv('ICE_SERVERS_JSON') or '').strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                servers = [s for s in parsed if isinstance(s, dict) and s.get('urls')]
        except (ValueError, TypeError):
            logger.warning('ICE_SERVERS_JSON is not valid JSON; ignoring it')

    if not servers:
        stun_env = os.getenv('STUN_URLS') or 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
        stun_urls = [u.strip() for u in stun_env.split(',') if u.strip()]
        servers = [{'urls': u} for u in stun_urls]

        turn_urls = [u.strip() for u in (os.getenv('TURN_URLS') or os.getenv('TURN_URL') or '').split(',') if u.strip()]
        turn_username = (os.getenv('TURN_USERNAME') or '').strip()
        turn_credential = (os.getenv('TURN_CREDENTIAL') or os.getenv('TURN_PASSWORD') or '').strip()
        turn_secret = (os.getenv('TURN_SECRET') or os.getenv('TURN_STATIC_AUTH_SECRET') or '').strip()

        turn_entry = None
        if turn_urls and turn_secret:
            # Rotating credentials (coturn use-auth-secret) win over a static
            # password: the browser only ever holds a short-lived credential.
            ttl_raw = (os.getenv('TURN_TTL') or '').strip()
            try:
                ttl = int(ttl_raw) if ttl_raw else 3600
            except ValueError:
                ttl = 3600
            ttl = max(300, min(ttl, 86400))
            username, credential = _turn_rest_credentials(
                turn_secret, request.chat_user['user_id'], ttl
            )
            turn_entry = {
                'urls': turn_urls if len(turn_urls) > 1 else turn_urls[0],
                'username': username,
                'credential': credential,
            }
        elif turn_urls and turn_username and turn_credential:
            turn_entry = {
                'urls': turn_urls if len(turn_urls) > 1 else turn_urls[0],
                'username': turn_username,
                'credential': turn_credential,
            }
        if turn_entry:
            servers.append(turn_entry)

    # Credentials expire, so this response must never be served from a cache.
    body, status = success_response({'ice_servers': servers}, 'ICE servers')
    body.headers['Cache-Control'] = 'no-store'
    return body, status


@chat_bp.route('/calls/incoming', methods=['GET'])
@chat_token_required
def chat_incoming_call():
    """The ringing call waiting for the caller, across every room.

    Without this the callee only learns about a call while that exact room is
    open (the room-scoped /call/state poll), so calls from any other chat rang
    nowhere. Polled while the app is open; cheap indexed lookup.
    """
    my_id = request.chat_user['user_id']
    now = int(time.time())
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT c.id, c.room_id, c.caller_id, c.callee_id, c.call_type,
                      c.offer_sdp, c.started_at,
                      u.name AS caller_name, u.username AS caller_username,
                      u.profile_image AS caller_avatar
               FROM official_chat_calls c
               LEFT JOIN chat_users u ON u.id = c.caller_id
               WHERE c.callee_id = ? AND c.state = 'ringing'
                 AND c.started_at IS NOT NULL AND ? - c.started_at <= 90
               ORDER BY c.id DESC LIMIT 1""",
            (my_id, now)
        )
        call = cursor.fetchone()
        if not call:
            return success_response({"state": "idle"}, "No incoming call")
        return success_response({
            "call_id": call['id'],
            "state": "ringing",
            "room_id": call['room_id'],
            "caller_id": call['caller_id'],
            "callee_id": call['callee_id'],
            "call_type": call['call_type'] or 'voice',
            "offer_sdp": call['offer_sdp'],
            "started_at": call['started_at'],
            "caller_name": call['caller_name'],
            "caller_username": call['caller_username'],
            "caller_avatar": call['caller_avatar'],
        }, "Incoming call")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/call/offer', methods=['POST'])
@chat_token_required
def chat_call_offer(room_id):
    """Initiate a voice/video call. Stores an SDP offer so the callee can poll
    /call/state and retrieve it."""
    my_id = request.chat_user['user_id']
    if not check_chat_rate_limit("call_offer", f"user_{my_id}", **_CALL_RATE_LIMIT):
        return error_response("Too many call attempts. Please try again later.", 429)

    data = request.get_json(silent=True) or {}
    call_type = str(data.get('call_type') or 'voice')
    if call_type not in ('voice', 'video'):
        call_type = 'voice'
    offer_sdp = str(data.get('offer_sdp') or '').strip()
    if not offer_sdp:
        return error_response("Offer SDP is required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        other_id = _call_peer_ids(cursor, room_id, my_id)
        if other_id is None:
            return error_response("Access denied to this chat room", 403)

        # Expire stale rows first: a 'ringing' row whose caller vanished
        # (closed the tab mid-ring) or an 'active' row abandoned long ago
        # would otherwise block every new offer for this room with 409 forever.
        now_ts = int(time.time())
        cursor.execute(
            """UPDATE official_chat_calls
               SET state = 'ended', ended_at = ?
               WHERE room_id = ? AND state = 'ringing'
                 AND started_at IS NOT NULL AND ? - started_at > 90""",
            (now_ts, room_id, now_ts)
        )
        # A call nobody is polling any more is dead even if the row still says
        # 'active': the caller closed the tab, the phone died, or the answer
        # round-trip was lost. Both peers refresh last_seen every few seconds
        # while the call screen is open, so a >60s gap means the call is over
        # and must not block this new offer for the old 4-hour window.
        cursor.execute(
            """UPDATE official_chat_calls
               SET state = 'ended', ended_at = ?
               WHERE room_id = ? AND state = 'active'
                 AND COALESCE(last_seen, started_at, 0) < ?""",
            (now_ts, room_id, now_ts - 60)
        )
        cursor.execute(
            """UPDATE official_chat_calls
               SET state = 'ended', ended_at = ?
               WHERE room_id = ? AND state = 'active'
                 AND started_at IS NOT NULL AND ? - started_at > 14400""",
            (now_ts, room_id, now_ts)
        )
        conn.commit()

        # Only one live call per room at a time.
        cursor.execute(
            "SELECT id, state FROM official_chat_calls WHERE room_id = ? AND state IN ('ringing','active') ORDER BY id DESC LIMIT 1",
            (room_id,)
        )
        existing = cursor.fetchone()
        if existing:
            return error_response("A call is already in progress in this room", 409)

        now = int(time.time())
        cursor.execute(
            """INSERT INTO official_chat_calls
               (room_id, caller_id, callee_id, call_type, state, offer_sdp, candidates, started_at, last_seen)
               VALUES (?, ?, ?, ?, 'ringing', ?, '[]', ?, ?)""",
            (room_id, my_id, other_id, call_type, offer_sdp, now, now)
        )
        call_id = cursor.lastrowid
        cursor.execute(
            "SELECT name, username FROM chat_users WHERE id = ?", (my_id,)
        )
        caller = cursor.fetchone()
        caller_name = ''
        if caller:
            caller_name = str(caller['name'] or caller['username'] or '').strip()
        conn.commit()

        # Wake the callee's phone even when the app is backgrounded or killed.
        # Best-effort and off the request thread: a push failure must never
        # fail or delay the call offer itself.
        try:
            import threading
            from notifications.notification_service import send_chat_call_push

            threading.Thread(
                target=send_chat_call_push,
                args=(other_id, call_id, room_id, call_type, caller_name or 'Someone'),
                daemon=True,
            ).start()
        except Exception as push_err:
            logger.warning("Call push dispatch failed for %s: %s", other_id, push_err)

        return success_response(
            {"call_id": call_id, "call_type": call_type, "state": "ringing"},
            "Call offered"
        )
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/call/answer', methods=['POST'])
@chat_token_required
def chat_call_answer(room_id):
    """Callee answers with an SDP answer, moving the call to 'active'."""
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    answer_sdp = str(data.get('answer_sdp') or '').strip()
    if not answer_sdp:
        return error_response("Answer SDP is required", 400)

    conn = get_db()
    try:
        cursor = conn.cursor()
        other_id = _call_peer_ids(cursor, room_id, my_id)
        if other_id is None:
            return error_response("Access denied to this chat room", 403)

        cursor.execute(
            "SELECT id, caller_id, state FROM official_chat_calls WHERE room_id = ? AND state = 'ringing' ORDER BY id DESC LIMIT 1",
            (room_id,)
        )
        call = cursor.fetchone()
        if not call:
            return error_response("No ringing call to answer", 404)
        if call['caller_id'] == my_id:
            return error_response("You cannot answer your own call", 403)

        cursor.execute(
            "UPDATE official_chat_calls SET state = 'active', answer_sdp = ?, callee_id = ?, last_seen = ? WHERE id = ?",
            (answer_sdp, my_id, int(time.time()), call['id'])
        )
        conn.commit()
        return success_response({"state": "active"}, "Call answered")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/call/ice-candidate', methods=['POST'])
@chat_token_required
def chat_call_ice_candidate(room_id):
    """Exchange one or more ICE candidates (appended to the call's list).

    Accepts ``candidate`` (legacy single value) or a batched ``candidates``
    array. One round-trip matters here: a phone emits a candidate every few
    hundred milliseconds, and the old per-candidate path was an access check +
    SELECT + read-modify-write UPDATE + COMMIT on a remote database. Two phones
    spent tens of seconds exchanging candidates while the UI already said
    "active", so the call stayed silent. The append is now a single UPDATE that
    matches the call and appends via json_insert.
    """
    my_id = request.chat_user['user_id']
    data = request.get_json(silent=True) or {}
    raw = data.get('candidates')
    if raw is None:
        raw = [data.get('candidate')]
    elif isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raw = []
    cands = [str(c).strip() for c in raw if c and str(c).strip()][:50]
    if not cands:
        return error_response("Candidate is required", 400)

    placeholders = ', '.join(["'$[#]', ?"] * len(cands))
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            f"""UPDATE official_chat_calls
                SET candidates = json_insert(COALESCE(candidates, '[]'), {placeholders}),
                    last_seen = ?
                WHERE id = (
                    SELECT c.id FROM official_chat_calls c
                    JOIN official_chat_rooms r ON r.id = c.room_id
                    WHERE c.room_id = ? AND c.state IN ('ringing','active')
                      AND r.room_type = 'direct'
                      AND (r.user_id = ? OR r.user_two_id = ?)
                    ORDER BY c.id DESC LIMIT 1
                )""",
            (*cands, int(time.time()), room_id, my_id, my_id)
        )
        updated = cursor.rowcount
        conn.commit()
        if updated == 0:
            return error_response("No active call to exchange candidates with", 404)
        return success_response(None, "Candidate stored")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/call/end', methods=['POST'])
@chat_token_required
def chat_call_end(room_id):
    """End/hangup a call. Marks the call row 'ended'."""
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        peer_id = _call_peer_ids(cursor, room_id, my_id)
        if peer_id is None:
            # Same membership check as every other call endpoint — without it
            # any authenticated user could end the call of any room by id.
            return error_response("Access denied to this chat room", 403)
        cursor.execute(
            "SELECT id FROM official_chat_calls WHERE room_id = ? AND state IN ('ringing','active') ORDER BY id DESC LIMIT 1",
            (room_id,)
        )
        call = cursor.fetchone()
        if call:
            cursor.execute(
                "UPDATE official_chat_calls SET state = 'ended', ended_at = ? WHERE id = ?",
                (int(time.time()), call['id'])
            )
            conn.commit()
        return success_response(None, "Call ended")
    finally:
        conn.close()


@chat_bp.route('/rooms/<int:room_id>/call/state', methods=['GET'])
@chat_token_required
def chat_call_state(room_id):
    """Current call state for a room (polled by the callee / both peers)."""
    my_id = request.chat_user['user_id']
    conn = get_db()
    try:
        cursor = conn.cursor()
        # One statement for the participant check and the call row: this runs
        # every 1.5s from both phones, and an extra access query cost another
        # full remote round-trip on every poll (which delayed the answer and
        # candidate delivery the call depends on).
        call_state_sql = """SELECT c.id, c.caller_id, c.callee_id, c.call_type, c.state,
                                  c.offer_sdp, c.answer_sdp, c.candidates,
                                  c.started_at, c.ended_at, c.last_seen
                           FROM official_chat_calls c
                           JOIN official_chat_rooms r ON r.id = c.room_id
                           WHERE c.room_id = ? AND r.room_type = 'direct'
                             AND (r.user_id = ? OR r.user_two_id = ?)
                           ORDER BY c.id DESC LIMIT 1"""
        cursor.execute(call_state_sql, (room_id, my_id, my_id))
        call = cursor.fetchone()
        if not call:
            return success_response({"state": "idle"}, "No call")

        # Auto-expire abandoned ringing calls (e.g. the caller closed the tab
        # and nobody answered): a stale 'ringing' row would otherwise block
        # every new offer for this room with 409 forever.
        # Heartbeat: a live call polls this endpoint every 1.5s, so refreshing
        # last_seen every 30s is enough to tell a running call from an
        # abandoned one without paying a DB write on every poll.
        if call['state'] in ('ringing', 'active'):
            now_ts = int(time.time())
            last_seen = call['last_seen'] if 'last_seen' in call.keys() else None
            if last_seen is None or now_ts - int(last_seen) >= 30:
                try:
                    cursor.execute(
                        "UPDATE official_chat_calls SET last_seen = ? WHERE id = ?",
                        (now_ts, call['id'])
                    )
                    conn.commit()
                except Exception as hb_err:
                    logger.warning("Call heartbeat update failed: %s", hb_err)

        if call['state'] == 'ringing' and call['started_at'] and (int(time.time()) - int(call['started_at'])) > 90:
            cursor.execute(
                "UPDATE official_chat_calls SET state = 'ended', ended_at = ? WHERE id = ?",
                (int(time.time()), call['id'])
            )
            conn.commit()
            cursor.execute(call_state_sql, (room_id, my_id, my_id))
            call = cursor.fetchone()
            if not call:
                return success_response({"state": "idle"}, "No call")

        return success_response({
            "call_id": call['id'],
            "caller_id": call['caller_id'],
            "callee_id": call['callee_id'],
            "call_type": call['call_type'],
            "state": call['state'],
            "offer_sdp": call['offer_sdp'],
            "answer_sdp": call['answer_sdp'],
            "candidates": _parse_candidates(call['candidates']),
            "started_at": call['started_at'],
            "ended_at": call['ended_at'],
        }, "Call state")
    finally:
        conn.close()



