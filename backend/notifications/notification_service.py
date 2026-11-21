"""Official Chat push delivery: Web Push (VAPID) + native FCM.

The chat service is a standalone deployment with its own ``chat_users``
identity, so pushes are read from the chat-scoped tables only:

  * ``chat_push_subscriptions`` — browser Web Push subscriptions
  * ``chat_push_tokens``        — FCM device tokens from the packaged app

Both senders are best-effort: they never raise to the request handler, and the
callers already run them on daemon threads. A push failure is logged and the
row is removed only when the provider says it is permanently gone (HTTP 404 /
410 for web push, ``UNREGISTERED``/``INVALID_ARGUMENT`` for FCM).

Configuration is read from the environment because Railway/Render inject it at
runtime:

Web Push (VAPID)
  CHAT_VAPID_PUBLIC_KEY / VAPID_PUBLIC_KEY
  CHAT_VAPID_PRIVATE_KEY / VAPID_PRIVATE_KEY   (base64url, PEM or a file path)
  CHAT_VAPID_SUBJECT / VAPID_SUBJECT           (defaults to a mailto claim)

Native push (FCM HTTP v1)
  FCM_SERVICE_ACCOUNT_JSON / FIREBASE_SERVICE_ACCOUNT_JSON /
  GOOGLE_SERVICE_ACCOUNT_JSON (raw or base64 JSON), or
  FCM_SERVICE_ACCOUNT_FILE / GOOGLE_APPLICATION_CREDENTIALS (file path)
  FCM_PROJECT_ID (optional; falls back to the service account's project_id)
"""

import base64
import json
import logging
import os
import threading

import requests

try:
    from pywebpush import WebPushException, webpush
    _WEBPUSH_AVAILABLE = True
except ImportError:  # pragma: no cover - dependency is in requirements.txt
    WebPushException = Exception
    webpush = None
    _WEBPUSH_AVAILABLE = False

try:
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.oauth2 import service_account as google_service_account
    _GOOGLE_AUTH_AVAILABLE = True
except ImportError:  # pragma: no cover - dependency is in requirements.txt
    GoogleAuthRequest = None
    google_service_account = None
    _GOOGLE_AUTH_AVAILABLE = False

try:
    from cryptography.hazmat.primitives import serialization as crypto_serialization
    from cryptography.hazmat.primitives.asymmetric import ec as crypto_ec
    _CRYPTO_AVAILABLE = True
except ImportError:  # pragma: no cover - pywebpush already depends on it
    crypto_serialization = None
    crypto_ec = None
    _CRYPTO_AVAILABLE = False

logger = logging.getLogger(__name__)

FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects/{project_id}/messages:send'
DEFAULT_VAPID_SUBJECT = 'mailto:admin@jdlxmobile.in'
DEFAULT_TAG = 'jdlx-chat'
REQUEST_TIMEOUT_SECONDS = 10


def _env(*names):
    """First non-empty environment value among ``names``."""
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    return ''


def _normalize_pem(value):
    """Turn an escaped PEM string or a file path into usable key material."""
    if not value:
        return ''
    if os.path.exists(value):
        try:
            with open(value, 'r', encoding='utf-8') as handle:
                return handle.read().strip()
        except OSError:
            return value
    if '\\n' in value and 'BEGIN' in value:
        return value.replace('\\n', '\n')
    return value


VAPID_SUBJECT = (
    _env('CHAT_VAPID_SUBJECT', 'VAPID_SUBJECT', 'VAPID_CLAIMS_SUB') or DEFAULT_VAPID_SUBJECT
)

_vapid_lock = threading.Lock()
_vapid_cache = None  # (public_key, private_key); (None, None) when unavailable


def _generate_vapid_keypair():
    """Create a P-256 keypair in the raw base64url format pywebpush expects."""
    if not (_CRYPTO_AVAILABLE and _WEBPUSH_AVAILABLE):
        return None
    private_key = crypto_ec.generate_private_key(crypto_ec.SECP256R1())
    raw_private = base64.urlsafe_b64encode(
        private_key.private_numbers().private_value.to_bytes(32, 'big')
    ).rstrip(b'=').decode('ascii')
    raw_public = base64.urlsafe_b64encode(
        private_key.public_key().public_bytes(
            crypto_serialization.Encoding.X962,
            crypto_serialization.PublicFormat.UncompressedPoint,
        )
    ).rstrip(b'=').decode('ascii')
    return raw_public, raw_private


def _load_stored_vapid_keys():
    """Read the shared keypair persisted in the chat database, if any."""
    try:
        from database import get_db

        conn = get_db()
        try:
            row = conn.cursor().execute(
                'SELECT public_key, private_key FROM chat_vapid_keys WHERE id = 1'
            ).fetchone()
            if row:
                return row['public_key'], row['private_key']
        finally:
            conn.close()
    except Exception as exc:
        logger.warning('Chat VAPID: could not read stored keys: %s', exc)
    return None, None


def _store_vapid_keys(public_key, private_key):
    try:
        from database import get_db

        conn = get_db()
        try:
            conn.cursor().execute(
                'INSERT OR IGNORE INTO chat_vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)',
                (public_key, private_key),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning('Chat VAPID: could not persist generated keys: %s', exc)


def _resolve_vapid_keys():
    """Return (public, private), preferring env then DB, else generate once.

    Railway deployments previously required manually setting VAPID env vars;
    without them the app showed "push notifications are not configured on the
    server". Persisting an auto-generated pair removes that setup step while
    still letting env vars override the stored key.
    """
    global _vapid_cache
    if _vapid_cache is not None:
        return _vapid_cache

    with _vapid_lock:
        if _vapid_cache is not None:
            return _vapid_cache

        public_key = _env('CHAT_VAPID_PUBLIC_KEY', 'VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PUBLIC_KEY')
        private_key = _normalize_pem(
            _env('CHAT_VAPID_PRIVATE_KEY', 'VAPID_PRIVATE_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY')
        )
        if not (public_key and private_key):
            public_key, private_key = _load_stored_vapid_keys()

        if not (public_key and private_key):
            generated = _generate_vapid_keypair()
            if generated:
                _store_vapid_keys(*generated)
                # Another worker may have won the insert race; read it back so
                # every process signs with the same key.
                stored_public, stored_private = _load_stored_vapid_keys()
                public_key, private_key = (
                    (stored_public, stored_private)
                    if stored_public and stored_private
                    else generated
                )

        _vapid_cache = (public_key or None, private_key or None)
        return _vapid_cache


def is_chat_vapid_enabled():
    public_key, private_key = _resolve_vapid_keys()
    return bool(_WEBPUSH_AVAILABLE and public_key and private_key)


def get_chat_vapid_public_key():
    """Browser subscribe key; ``None`` when Web Push is not configured."""
    public_key, _ = _resolve_vapid_keys()
    return public_key or None


# ─────────────────────────────── Web Push (VAPID) ───────────────────────────────

def _load_push_subscriptions(chat_user_id, limit=10):
    from database import get_db

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT id, endpoint, p256dh, auth
               FROM chat_push_subscriptions
               WHERE chat_user_id = ?
               ORDER BY updated_at DESC, id DESC
               LIMIT ?""",
            (chat_user_id, limit)
        )
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def _delete_push_subscription(subscription_id):
    from database import get_db

    conn = get_db()
    try:
        conn.cursor().execute(
            'DELETE FROM chat_push_subscriptions WHERE id = ?', (subscription_id,)
        )
        conn.commit()
    finally:
        conn.close()


def send_chat_push(chat_user_id, title, body, url='/chat', tag=None, extra=None):
    """Send a Web Push to every browser registered by ``chat_user_id``.

    ``extra`` adds fields to the notification payload (e.g. ``requireInteraction``
    for an incoming call) that public/sw.js knows how to read.

    Returns the number of subscriptions the push provider accepted.
    """
    public_key, private_key = _resolve_vapid_keys()
    if not (_WEBPUSH_AVAILABLE and public_key and private_key):
        return 0

    try:
        subscriptions = _load_push_subscriptions(chat_user_id)
    except Exception as exc:
        logger.warning('Chat web push: could not load subscriptions for %s: %s', chat_user_id, exc)
        return 0

    if not subscriptions:
        return 0

    payload_data = {
        'title': title,
        'body': body,
        'url': url,
        'tag': tag or DEFAULT_TAG,
        'icon': '/logo192.png',
    }
    if isinstance(extra, dict):
        for key, value in extra.items():
            if value is not None:
                payload_data[str(key)] = value
    payload = json.dumps(payload_data)

    sent = 0
    for sub in subscriptions:
        try:
            webpush(
                subscription_info={
                    'endpoint': sub['endpoint'],
                    'keys': {'p256dh': sub['p256dh'], 'auth': sub['auth']},
                },
                data=payload,
                vapid_private_key=private_key,
                vapid_claims={'sub': VAPID_SUBJECT},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            sent += 1
        except WebPushException as exc:
            status_code = getattr(getattr(exc, 'response', None), 'status_code', None)
            if status_code in (404, 410):
                # The browser unsubscribed or the endpoint expired.
                try:
                    _delete_push_subscription(sub['id'])
                except Exception as cleanup_err:
                    logger.warning('Chat web push: stale subscription cleanup failed: %s', cleanup_err)
            else:
                logger.warning('Chat web push failed (%s): %s', status_code, exc)
        except Exception as exc:
            logger.warning('Chat web push error: %s', exc)
    return sent


# ─────────────────────────────── Native push (FCM) ──────────────────────────────

_fcm_credentials = None
_fcm_credentials_key = None
_fcm_lock = threading.Lock()


def _load_fcm_service_account():
    """Parse the FCM service-account credentials from the environment."""
    raw = _env(
        'FCM_SERVICE_ACCOUNT_JSON',
        'FIREBASE_SERVICE_ACCOUNT_JSON',
        'GOOGLE_SERVICE_ACCOUNT_JSON',
        'GOOGLE_SERVICE_ACCOUNT',
    )
    if not raw:
        path = _env('FCM_SERVICE_ACCOUNT_FILE', 'GOOGLE_APPLICATION_CREDENTIALS')
        if path and os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as handle:
                    raw = handle.read().strip()
            except OSError as exc:
                logger.warning('Chat FCM: could not read service account file: %s', exc)
                return None
    if not raw:
        return None

    try:
        data = json.loads(raw)
    except ValueError:
        # Some hosts only allow a single-line env value: accept base64 JSON.
        try:
            data = json.loads(base64.b64decode(raw))
        except Exception:
            logger.warning('Chat FCM: service account JSON could not be parsed')
            return None

    if not isinstance(data, dict):
        return None
    project_id = str(data.get('project_id') or _env('FCM_PROJECT_ID') or '').strip()
    if not project_id:
        logger.warning('Chat FCM: service account is missing project_id')
        return None
    if not data.get('project_id'):
        data['project_id'] = project_id
    return data


def _get_fcm_access_token(service_account):
    global _fcm_credentials, _fcm_credentials_key

    if not _GOOGLE_AUTH_AVAILABLE:
        raise RuntimeError('google-auth is not installed')

    key = service_account.get('client_email') or service_account.get('project_id')
    with _fcm_lock:
        if _fcm_credentials is None or _fcm_credentials_key != key:
            _fcm_credentials = google_service_account.Credentials.from_service_account_info(
                service_account, scopes=[FCM_SCOPE]
            )
            _fcm_credentials_key = key
        credentials = _fcm_credentials
        if not credentials.valid or credentials.expired:
            credentials.refresh(GoogleAuthRequest())
    return credentials.token


class FcmTokenInvalid(Exception):
    """The provider rejected the device token; it should be deleted."""


def _send_fcm_message(
    service_account,
    project_id,
    token,
    title,
    body,
    url='/chat',
    channel_id='chat',
    data=None,
    ttl=None,
    notification_priority='default',
    tag=None,
    include_notification=True,
):
    """POST one FCM HTTP v1 message. Returns True when accepted.

    ``include_notification=False`` sends a data-only message, which the APK's
    native service turns into a full-screen incoming-call notification. If a
    notification payload were present, Android would display it itself while
    the app is backgrounded and the native full-screen UI would never run.
    """
    access_token = _get_fcm_access_token(service_account)

    payload_data = {'url': str(url or '/chat')}
    for key, value in (data or {}).items():
        if value is not None:
            payload_data[str(key)] = str(value)

    android = {'priority': 'high'}
    if ttl:
        android['ttl'] = str(ttl)

    message_payload = {
        'token': token,
        'data': payload_data,
        'android': android,
    }
    if include_notification:
        android_notification = {
            'channel_id': channel_id,
            'sound': 'default',
            'click_action': 'FCM_PLUGIN_ACTIVITY',
            'priority': notification_priority,
            'visibility': 'public',
        }
        if tag:
            android_notification['tag'] = str(tag)
        android['notification'] = android_notification
        message_payload['notification'] = {'title': title, 'body': body}
        message_payload['apns'] = {'payload': {'aps': {'sound': 'default'}}}

    message = {'message': message_payload}
    response = requests.post(
        FCM_ENDPOINT.format(project_id=project_id),
        headers={
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/json',
        },
        json=message,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    if response.status_code == 200:
        return True

    detail = ''
    try:
        error = response.json().get('error', {})
        detail = error.get('status') or error.get('message') or ''
    except ValueError:
        detail = response.text[:200]

    if response.status_code == 404 or detail in ('UNREGISTERED', 'INVALID_ARGUMENT', 'NOT_FOUND'):
        raise FcmTokenInvalid(detail or str(response.status_code))
    raise RuntimeError(f'FCM send failed ({response.status_code}): {detail}')


def _load_chat_push_tokens(chat_user_id, limit=10):
    from database import get_db

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT id, fcm_token, device_type
               FROM chat_push_tokens
               WHERE chat_user_id = ?
               ORDER BY updated_at DESC, id DESC
               LIMIT ?""",
            (chat_user_id, limit)
        )
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def _delete_chat_push_token(token_id):
    from database import get_db

    conn = get_db()
    try:
        conn.cursor().execute('DELETE FROM chat_push_tokens WHERE id = ?', (token_id,))
        conn.commit()
    finally:
        conn.close()


def send_chat_device_push(
    chat_user_id,
    title,
    body,
    url='/chat',
    data=None,
    channel_id='chat',
    ttl=None,
    notification_priority='default',
    tag=None,
    include_notification=True,
):
    """Send an FCM push to every device registered by ``chat_user_id``.

    Returns the number of tokens the FCM API accepted.
    """
    service_account = _load_fcm_service_account()
    if not service_account:
        return 0
    project_id = str(service_account.get('project_id') or '').strip()
    if not project_id:
        return 0

    try:
        tokens = _load_chat_push_tokens(chat_user_id)
    except Exception as exc:
        logger.warning('Chat FCM: could not load tokens for %s: %s', chat_user_id, exc)
        return 0

    if not tokens:
        return 0

    sent = 0
    for row in tokens:
        try:
            if _send_fcm_message(
                service_account,
                project_id,
                row['fcm_token'],
                title,
                body,
                url,
                channel_id=channel_id,
                data=data,
                ttl=ttl,
                notification_priority=notification_priority,
                tag=tag,
                include_notification=include_notification,
            ):
                sent += 1
        except FcmTokenInvalid:
            try:
                _delete_chat_push_token(row['id'])
            except Exception as cleanup_err:
                logger.warning('Chat FCM: stale token cleanup failed: %s', cleanup_err)
        except Exception as exc:
            logger.warning('Chat FCM push failed: %s', exc)
    return sent


def send_chat_call_push(chat_user_id, call_id, room_id, call_type='voice', caller_name='Someone'):
    """Wake the callee's phone for a ringing call.

    The push carries only identifiers; the app fetches the SDP offer from
    /chat/calls/incoming after the user taps (or when it comes to the
    foreground). High priority + a short TTL keeps a stale ring from arriving
    long after the call already ended.
    """
    is_video = str(call_type).lower() == 'video'
    title = 'Incoming video call' if is_video else 'Incoming voice call'
    body = f"{caller_name or 'Someone'} is calling…"
    url = f'/chat?room={room_id}&incoming_call={call_id}'

    # Browsers/PWAs have no FCM service: without a Web Push the call rings
    # nowhere once the tab is hidden or the phone is locked. sw.js shows this
    # only when no visible Chat window exists, so the in-app modal is not
    # duplicated.
    try:
        send_chat_push(
            chat_user_id,
            title,
            body,
            url=url,
            tag=f'call_{call_id}',
            extra={
                'type': 'incoming_call',
                'call_id': call_id,
                'room_id': room_id,
                'requireInteraction': True,
                'vibrate': [800, 600, 800, 600, 800],
            },
        )
    except Exception as exc:
        logger.warning('Call web push failed for %s: %s', chat_user_id, exc)

    return send_chat_device_push(
        chat_user_id,
        title,
        body,
        url=url,
        data={
            'type': 'incoming_call',
            'call_id': call_id,
            'room_id': room_id,
            'call_type': 'video' if is_video else 'voice',
            'caller_name': caller_name or 'Someone',
            'title': title,
            'body': body,
        },
        channel_id='incoming_call',
        ttl='60s',
        notification_priority='max',
        tag=f'call_{call_id}',
        include_notification=False,
    )
