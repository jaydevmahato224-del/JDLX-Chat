"""One-time OAuth hand-off codes for the packaged Android app.

The problem
-----------
The app completes Google sign-in in a Chrome Custom Tab (Google refuses to
render its consent screen inside an embedded WebView). The callback then has to
travel back to the app through a custom-scheme URI such as
``jdlxmobile://auth/login?token=...``. Any *other* app on the device that
registered the same scheme can receive that URI first — so putting the session
JWT there hands an attacker a ready-to-use session.

The fix (PKCE-style, RFC 7636)
------------------------------
1. Before starting sign-in the app generates a random ``verifier`` and keeps it
   in its own storage; it sends only ``challenge = base64url(sha256(verifier))``
   along with the OAuth request.
2. The callback stores the freshly minted session behind a random one-time
   ``code`` and returns ``...?code=<code>`` — **no token in the URI**.
3. The app exchanges ``{code, verifier}`` over HTTPS. The server recomputes the
   challenge and only then releases the session.

An interceptor that grabs the deep link therefore holds a code it cannot redeem
(the verifier never left the app). Codes are single-use and short-lived, and are
deleted as soon as they are exchanged.

The web/PWA flow uses the same mechanism: it keeps a PKCE verifier in
sessionStorage, sends only the challenge through Google, and redeems the
returned code over HTTPS. A legacy callback without a challenge still returns
``token`` + ``user`` so older clients keep working during rollout.
"""
import base64
import datetime
import hashlib
import hmac
import json
import secrets

# How long a hand-off code stays redeemable. Long enough for the app to be
# resumed by the OS after the user finishes in the Custom Tab, short enough that
# a leaked code is useless.
HANDOFF_TTL_SECONDS = 180

# Challenge/verifier lengths (base64url of 32 random bytes = 43 chars).
_MAX_CHALLENGE_LEN = 64


def challenge_for_verifier(verifier: str) -> str:
    """base64url(SHA-256(verifier)) — the same value the app computes."""
    digest = hashlib.sha256(str(verifier).encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def new_verifier() -> str:
    """Server-side helper (tests / docs): a fresh PKCE verifier."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")


def normalize_challenge(raw) -> str:
    """Sanitize the challenge that arrives on the OAuth start URL.

    Returns '' when it is missing or malformed, which makes the callback fall
    back to the original browser behaviour (no hand-off code).
    """
    value = str(raw or "").strip()
    if not value or len(value) > _MAX_CHALLENGE_LEN:
        return ""
    # base64url alphabet only — anything else is not something we issued.
    if any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=" for c in value):
        return ""
    return value


def _purge_expired(cursor) -> None:
    """Best-effort cleanup so the table cannot grow without bound."""
    try:
        cursor.execute(
            "DELETE FROM oauth_handoff_codes "
            "WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')"
        )
    except Exception:
        pass


def issue_handoff_code(cursor, user_id, user_data, token, challenge) -> str:
    """Create a single-use code bound to a challenge and to the minted session.

    The session itself is stored (rather than re-derived later) so the token the
    app receives is bit-for-bit the one the callback issued — no second issuer to
    drift out of sync.
    """
    _purge_expired(cursor)
    code = secrets.token_urlsafe(32)
    expires_at = (
        datetime.datetime.utcnow() + datetime.timedelta(seconds=HANDOFF_TTL_SECONDS)
    ).strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        """INSERT INTO oauth_handoff_codes (code, user_id, user_json, token, challenge, used, expires_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)""",
        (code, user_id, json.dumps(user_data, separators=(",", ":")), token, challenge, expires_at),
    )
    # One live code per user is enough — retire any earlier pending ones so a
    # reopened sign-in cannot leave a long-lived redeemable code behind.
    cursor.execute(
        "DELETE FROM oauth_handoff_codes WHERE user_id = ? AND code != ? AND used = 0",
        (user_id, code),
    )
    return code


def consume_handoff_code(cursor, code, verifier):
    """Redeem a code. Returns (payload_dict, None) or (None, reason).

    ``reason`` is a short machine-readable string used for logging — the API
    response stays deliberately generic so it cannot be used to probe valid codes.

    PKCE-bound codes require a verifier whose SHA-256 matches the stored
    challenge. Challenge-less codes (issued for stale web clients during
    rollout) are redeemed without one — single-use and the short TTL are
    what protect them; the code itself never contains the session tokens.
    """
    if not code:
        return None, "missing_params"

    row = cursor.execute(
        """SELECT code, user_id, user_json, token, challenge, used, expires_at
           FROM oauth_handoff_codes WHERE code = ?""",
        (code,),
    ).fetchone()
    if not row:
        return None, "unknown_code"

    # Single-use: burn it first so two racing callers cannot both succeed.
    cursor.execute("UPDATE oauth_handoff_codes SET used = 1 WHERE code = ?", (code,))

    if row["used"]:
        return None, "already_used"

    expires_at = row["expires_at"]
    if expires_at:
        try:
            expiry = datetime.datetime.strptime(str(expires_at), "%Y-%m-%d %H:%M:%S")
            if datetime.datetime.utcnow() > expiry:
                return None, "expired"
        except ValueError:
            return None, "expired"

    expected = str(row["challenge"] or "")
    if expected:
        # PKCE-bound code: the verifier is mandatory and must match.
        if not verifier:
            return None, "challenge_mismatch"
        actual = challenge_for_verifier(verifier)
        if not hmac.compare_digest(expected, actual):
            return None, "challenge_mismatch"
    # Challenge-less code: no verifier to check; single-use + TTL still hold.

    try:
        user_data = json.loads(row["user_json"]) if row["user_json"] else None
    except (TypeError, ValueError):
        return None, "corrupt_payload"
    if not user_data or not row["token"]:
        return None, "corrupt_payload"

    return {"user": user_data, "token": row["token"]}, None


def delete_handoff_code(cursor, code) -> None:
    try:
        cursor.execute("DELETE FROM oauth_handoff_codes WHERE code = ?", (code,))
    except Exception:
        pass
