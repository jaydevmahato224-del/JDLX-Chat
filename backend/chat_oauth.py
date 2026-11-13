"""Google OAuth for the standalone JDLX Chat service.

The chat frontend is a separate origin from the storefront.  This blueprint
only accepts chat flows, keeps the existing handoff/PKCE format, and reuses the
shared chat identity, DB and JWT secret.  It intentionally lives outside
``app.py`` so the separate service never needs to import the storefront app.
"""

import hmac
import json
import logging
import os
import secrets
import time
from urllib.parse import quote, urlencode, urlparse

import jwt
import requests
from flask import Blueprint, current_app, redirect, request, session

from auth.oauth_handoff import issue_handoff_code, normalize_challenge
from chat_routes import (
    CHAT_FRONTEND_URL,
    DEFAULT_CHAT_FRONTEND_URL,
    _is_allowed_chat_origin,
    get_or_create_chat_room,
    issue_chat_token,
    log_chat_security_event,
)
from database import get_db
from jwt_config import get_jwt_secret

logger = logging.getLogger(__name__)
chat_oauth_bp = Blueprint("chat_oauth", __name__)

_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


def _env(name):
    return (os.environ.get(name) or "").strip()


def _client_id():
    return _env("CHAT_GOOGLE_CLIENT_ID") or _env("GOOGLE_CLIENT_ID")


def _client_secret():
    return _env("CHAT_GOOGLE_CLIENT_SECRET") or _env("GOOGLE_CLIENT_SECRET")


def _redirect_uri():
    configured = _env("CHAT_GOOGLE_REDIRECT_URI") or _env("GOOGLE_REDIRECT_URI")
    if configured:
        return configured
    return request.url_root.rstrip("/") + "/google/callback"


def _canonical_frontend():
    return (CHAT_FRONTEND_URL or DEFAULT_CHAT_FRONTEND_URL).rstrip("/")


def _safe_frontend(raw):
    """Only return known web origins or the native app auth scheme."""
    raw = (raw or "").strip().rstrip("/")
    if not raw or "|" in raw:
        return _canonical_frontend()
    try:
        parsed = urlparse(raw)
    except Exception:
        return _canonical_frontend()
    if parsed.scheme in ("http", "https") and _is_allowed_chat_origin(raw):
        return raw
    if parsed.scheme == "jdlxchat" and parsed.netloc == "auth":
        return raw
    return _canonical_frontend()


def _is_native(frontend_url, challenge):
    return bool(challenge) and not frontend_url.startswith(("http://", "https://"))


def _login_redirect(frontend_url, native, params):
    target = frontend_url if native else frontend_url + "/login"
    separator = "&" if "?" in target else "?"
    return redirect(f"{target}{separator}{urlencode(params)}")


def _error_redirect(frontend_url, native, error):
    return _login_redirect(frontend_url, native, {"error": error})


def _cookie_settings():
    secure = (
        os.environ.get("RENDER", "").lower() == "true"
        or os.environ.get("FORCE_HTTPS", "").lower() == "true"
        or os.environ.get("SESSION_COOKIE_SECURE", "").lower() == "true"
    )
    return {
        "httponly": True,
        "secure": secure,
        "samesite": "None" if secure else "Lax",
    }


def _chat_signup_ticket(email, name, picture, google_sub):
    now = int(time.time())
    payload = {
        "type": "official_chat_google_signup",
        "google_sub": google_sub,
        "email": email,
        "name": name,
        "picture": picture,
        "iat": now,
        "exp": now + 900,
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm="HS256")


def _chat_handoff(frontend_url, native, challenge, google_sub, email, name, picture):
    """Find/create the chat identity and return the frontend to the app."""
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM chat_users WHERE google_sub = ? OR email = ? ORDER BY id LIMIT 1",
            (google_sub, email),
        )
        user = cursor.fetchone()

        if not user:
            ticket = _chat_signup_ticket(email, name, picture, google_sub)
            return _login_redirect(
                frontend_url, native, {"google_signup": ticket, "flow": "chat"}
            )

        user = dict(user)
        if google_sub and not user.get("google_sub"):
            cursor.execute(
                "UPDATE chat_users SET google_sub = ? WHERE id = ?",
                (google_sub, user["id"]),
            )
        if picture and not user.get("profile_image"):
            cursor.execute(
                "UPDATE chat_users SET profile_image = ? WHERE id = ?",
                (picture, user["id"]),
            )
        conn.commit()

        cursor.execute("SELECT * FROM chat_users WHERE id = ?", (user["id"],))
        user = dict(cursor.fetchone())

        token, refresh_token = issue_chat_token(
            user["id"], user["email"], user.get("name"), user.get("username")
        )
        room = get_or_create_chat_room(
            conn, user["id"], user.get("name") or "Valued Customer", user.get("username")
        )
        log_chat_security_event(conn, user["id"], "google_login", "OAuth login via chat service")

        handoff_user = dict(user)
        handoff_user["refresh_token"] = refresh_token
        if identity_provider := (os.environ.get("CHAT_IDENTITY_PROVIDER") or "google"):
            handoff_user.setdefault("provider", identity_provider)

        if challenge:
            # Both the APK and the web/PWA keep the PKCE verifier locally. Only
            # a one-time code is placed in the redirect URL; the session tokens
            # are released over HTTPS by /api/chat/auth/exchange-handoff.
            code = issue_handoff_code(
                cursor,
                user["id"],
                handoff_user,
                token,
                challenge,
            )
            conn.commit()
            return _login_redirect(
                frontend_url, native, {"code": code, "flow": "chat"}
            )

        response = _login_redirect(
            frontend_url,
            False,
            {
                "token": token,
                "refresh": refresh_token,
                "user": quote(json.dumps(handoff_user, separators=(",", ":"))),
                "flow": "chat",
            },
        )
        response.set_cookie(
            "official_chat_token",
            token,
            max_age=3600,
            path="/",
            **_cookie_settings(),
        )
        response.set_cookie(
            "official_chat_refresh",
            refresh_token,
            max_age=14 * 24 * 3600,
            path="/",
            **_cookie_settings(),
        )
        return response
    finally:
        conn.close()


@chat_oauth_bp.route("/login/google", methods=["GET"])
def chat_google_start():
    if (request.args.get("flow") or "chat").strip().lower() != "chat":
        return {"success": False, "message": "This service only handles chat login"}, 400

    frontend_url = _safe_frontend(
        request.args.get("frontend_url") or request.headers.get("Origin")
    )
    challenge = normalize_challenge(request.args.get("state_challenge"))
    native = _is_native(frontend_url, challenge)
    ref = (request.args.get("ref") or "").strip()[:24]
    nonce = secrets.token_urlsafe(18)
    session["chat_oauth_csrf_nonce"] = nonce

    state = f"chat|{frontend_url}|{ref}|{nonce}"
    if challenge:
        state += f"|{challenge}"

    client_id = _client_id()
    if not client_id:
        logger.error("CHAT_GOOGLE_CLIENT_ID/GOOGLE_CLIENT_ID is not configured")
        return _error_redirect(frontend_url, native, "google_not_configured")

    params = {
        "client_id": client_id,
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    }
    return redirect(f"{_GOOGLE_AUTH_URL}?{urlencode(params)}")


@chat_oauth_bp.route("/google/callback", methods=["GET"])
def chat_google_callback():
    state = request.args.get("state") or ""
    parts = state.split("|")
    frontend_url = _safe_frontend(parts[1] if len(parts) > 1 else "")
    challenge = normalize_challenge(parts[4] if len(parts) > 4 else "")
    native = _is_native(frontend_url, challenge)
    received_nonce = parts[3] if len(parts) > 3 else ""

    stored_nonce = session.pop("chat_oauth_csrf_nonce", None)
    if stored_nonce and received_nonce and not hmac.compare_digest(
        str(stored_nonce), str(received_nonce)
    ):
        return _error_redirect(frontend_url, native, "csrf_validation_failed")

    error = (request.args.get("error") or "").strip()
    if error:
        return _error_redirect(frontend_url, native, error)
    code = (request.args.get("code") or "").strip()
    if not code:
        return _error_redirect(frontend_url, native, "missing_google_code")

    client_id, client_secret = _client_id(), _client_secret()
    if not client_id or not client_secret:
        logger.error("Chat Google OAuth credentials are not configured")
        return _error_redirect(frontend_url, native, "google_not_configured")

    try:
        token_response = requests.post(
            _GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": _redirect_uri(),
                "grant_type": "authorization_code",
            },
            timeout=15,
        )
        token_response.raise_for_status()
        access_token = (token_response.json() or {}).get("access_token")
        if not access_token:
            raise ValueError("Google token response did not contain access_token")

        userinfo_response = requests.get(
            _GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15,
        )
        userinfo_response.raise_for_status()
        userinfo = userinfo_response.json() or {}
    except Exception as exc:
        logger.error("Chat Google OAuth exchange failed: %s", exc)
        return _error_redirect(frontend_url, native, "google_auth_failed")

    google_sub = str(userinfo.get("sub") or "").strip()
    email = str(userinfo.get("email") or "").strip().lower()
    if not google_sub or not email:
        return _error_redirect(frontend_url, native, "google_email_missing")

    try:
        from security.login_guard import is_account_locked

        if is_account_locked(email):
            return _error_redirect(frontend_url, native, "account_locked")
    except Exception:
        pass

    name = str(userinfo.get("name") or email.split("@")[0]).strip()[:120]
    picture = str(userinfo.get("picture") or "").strip()
    return _chat_handoff(
        frontend_url, native, challenge, google_sub, email, name, picture
    )
