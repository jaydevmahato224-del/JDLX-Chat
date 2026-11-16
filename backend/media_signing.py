"""HMAC-signed chat media URLs.

Chat media is rendered inside <img>/<video>/<audio> tags, which cannot attach
an Authorization header, so the serving endpoints cannot use the chat token.
Instead every NEW upload returns a URL carrying a non-expiring HMAC signature
of its filename (?m=...). The serving endpoints verify it when present and
still serve legacy signature-less URLs (old messages keep working) with a
softened cache policy. Signing prevents URL forging/fuzzing for new uploads;
legacy files keep the random-token filename protection they were created with.
"""

import hashlib
import hmac

from jwt_config import get_jwt_secret

_MEDIA_SIG_PREFIX = "jdlx-media-v1|"


def media_signature(filename):
    """Stable per-file signature; non-expiring because chat media is permanent."""
    secret = (get_jwt_secret() or "").encode()
    digest = hmac.new(
        secret, f"{_MEDIA_SIG_PREFIX}{filename}".encode(), hashlib.sha256
    ).hexdigest()
    return digest[:32]


def signed_media_url(path_or_filename):
    """Append the signature param to an already-built /static/uploads URL."""
    url = (path_or_filename or "").split("?", 1)[0]
    filename = url.rsplit("/", 1)[-1]
    if not filename:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}m={media_signature(filename)}"


def verify_media_signature(filename, provided):
    if not provided:
        return False
    try:
        return hmac.compare_digest(str(provided), media_signature(filename))
    except Exception:
        return False
