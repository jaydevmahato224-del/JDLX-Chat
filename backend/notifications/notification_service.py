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


VAPID_PUBLIC_KEY = _env('CHAT_VAPID_PUBLIC_KEY', 'VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PUBLIC_KEY')
VAPID_PRIVATE_KEY = _normalize_pem(
    _env('CHAT_VAPID_PRIVATE_KEY', 'VAPID_PRIVATE_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY')
)
VAPID_SUBJECT = (
    _env('CHAT_VAPID_SUBJECT', 'VAPID_SUBJECT', 'VAPID_CLAIMS_SUB') or DEFAULT_VAPID_SUBJECT
)
VAPID_ENABLED = bool(_WEBPUSH_AVAILABLE and VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)


def get_chat_vapid_public_key():
    """Browser subscribe key; ``None`` when Web Push is not configured."""
    return VAPID_PUBLIC_KEY or None


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


def send_chat_push(chat_user_id, title, body, url='/chat', tag=None):
    """Send a Web Push to every browser registered by ``chat_user_id``.

    Returns the number of subscriptions the push provider accepted.
    """
    if not VAPID_ENABLED:
        return 0

    try:
        subscriptions = _load_push_subscriptions(chat_user_id)
    except Exception as exc:
        logger.warning('Chat web push: could not load subscriptions for %s: %s', chat_user_id, exc)
        return 0

    if not subscriptions:
        return 0

    payload = json.dumps({
        'title': title,
        'body': body,
        'url': url,
        'tag': tag or DEFAULT_TAG,
        'icon': '/logo192.png',
    })

    sent = 0
    for sub in subscriptions:
        try:
            webpush(
                subscription_info={
                    'endpoint': sub['endpoint'],
                    'keys': {'p256dh': sub['p256dh'], 'auth': sub['auth']},
                },
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
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


def _send_fcm_message(service_account, project_id, token, title, body, url='/chat', channel_id='chat'):
    """POST one FCM HTTP v1 message. Returns True when accepted."""
    access_token = _get_fcm_access_token(service_account)
    message = {
        'message': {
            'token': token,
            'notification': {'title': title, 'body': body},
            'data': {'url': str(url or '/chat')},
            'android': {
                'priority': 'high',
                'notification': {
                    'channel_id': channel_id,
                    'sound': 'default',
                    'click_action': 'FCM_PLUGIN_ACTIVITY',
                },
            },
            'apns': {
                'payload': {'aps': {'sound': 'default'}},
            },
        }
    }
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


def send_chat_device_push(chat_user_id, title, body, url='/chat'):
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
                channel_id='chat',
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
