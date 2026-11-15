"""Encryption-at-rest for small operator secrets (e.g. Android keystore passwords).

Why this exists
---------------
The admin panel's "Mobile App" section lets a super admin keep an offline-safe
copy of the Android signing keystore. Signing passwords are *secrets*: they must
never sit in the database as plaintext, even though only super admins can read
them through the API. This module encrypts them with Fernet
(AES-128-CBC + HMAC-SHA256, authenticated) before they are written.

Master key resolution (first non-empty wins)
--------------------------------------------
1. ``APP_VAULT_KEY`` — explicit, deploy-time secret (recommended for production).
2. ``JWT_SECRET`` (env var, else the persisted ``.jwt_secret`` file) — so the
   feature works with zero new configuration on existing deployments.

Derivation is ``SHA-256(master) -> urlsafe base64``, which is exactly the key
format Fernet expects. Rotating the master key makes previously stored
ciphertexts undecryptable — that is intentional, but note it in ops docs.

Format: ciphertexts are stored as ``enc:v1:<fernet-token>`` so plaintext values
from an older/manual row are detected and never crash a decrypt path.
"""
import base64
import hashlib
import os

_PREFIX = "enc:v1:"
_cached_key = None


def _master_secret():
    explicit = (os.environ.get("APP_VAULT_KEY") or "").strip()
    if explicit:
        return explicit

    # Fall back to the central JWT secret loader so no new env var is required.
    from jwt_config import get_jwt_secret

    return get_jwt_secret()


def _fernet():
    global _cached_key
    if _cached_key is None:
        from cryptography.fernet import Fernet

        digest = hashlib.sha256(_master_secret().encode("utf-8")).digest()
        _cached_key = Fernet(base64.urlsafe_b64encode(digest))
    return _cached_key


def encrypt_secret(plaintext):
    """Encrypt a string for storage. Empty/None returns None (never stored)."""
    if plaintext is None:
        return None
    value = str(plaintext)
    if value == "":
        return ""
    return _PREFIX + _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(token):
    """Decrypt a stored value.

    Values without the ``enc:v1:`` marker are treated as legacy plaintext and
    returned as-is, so a manually-entered row can never break the reveal path.
    """
    if token is None:
        return None
    value = str(token)
    if value == "":
        return ""
    if not value.startswith(_PREFIX):
        return value
    from cryptography.fernet import InvalidToken

    try:
        return _fernet().decrypt(value[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except InvalidToken:
        # Master key rotated (or row corrupted) — surface a clear operator
        # message instead of a raw exception.
        raise ValueError(
            "Stored secret could not be decrypted. The vault master key may have "
            "changed (APP_VAULT_KEY / JWT_SECRET). Re-save the credentials."
        )


def key_source():
    """Name of the master secret currently protecting stored ciphertexts.

    Surfaced to the admin UI so an operator can see whether a dedicated
    ``APP_VAULT_KEY`` is configured. When this returns ``JWT_SECRET`` and that
    secret is not pinned by an env var (jwt_config generates/persists one), a
    redeploy on an ephemeral filesystem rotates it and previously stored
    passwords become undecryptable — the panel warns about exactly that.
    """
    return "APP_VAULT_KEY" if (os.environ.get("APP_VAULT_KEY") or "").strip() else "JWT_SECRET"


def is_encrypted(value):
    return isinstance(value, str) and value.startswith(_PREFIX)


def mask_secret(value):
    """Render a stored secret as ``••••••  (last 4)`` for list views."""
    if not value:
        return ""
    if is_encrypted(value):
        return "••••••••"
    text = str(value)
    if len(text) <= 4:
        return "••••"
    return "••••••••" + text[-4:]
