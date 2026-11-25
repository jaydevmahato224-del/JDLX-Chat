"""Standalone WSGI entrypoint for JDLX Chat.

Deploy this file as a separate web service.  It shares the existing Turso
database and JWT secret, but only registers chat routes and chat-only OAuth.
The storefront/admin/warehouse app keeps its own entrypoint and can keep its
chat fallback enabled until the new URL is verified.
"""

import logging
import os
import threading

from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Match the rest of the backend: local development may use backend/.env, while
# Render/production supplies real environment variables.
if os.environ.get("RENDER", "").lower() != "true":
    # Do not override variables supplied by the shell/test harness.
    load_dotenv(os.path.join(BASE_DIR, ".env"), override=False)

from flask import Flask, Response, abort, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

from chat_oauth import chat_oauth_bp
from chat_routes import chat_bp
from database import USE_TURSO, _open_connection, get_db, init_db
from jwt_config import get_jwt_secret

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("jdlx_chat_service")

app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

UPLOAD_FOLDER = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

SECRET_KEY = get_jwt_secret()
app.secret_key = SECRET_KEY
app.config.update(
    JWT_SECRET=SECRET_KEY,
    UPLOAD_FOLDER=UPLOAD_FOLDER,
    MAX_CONTENT_LENGTH=30 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=(
        os.environ.get("RENDER", "").lower() == "true"
        or os.environ.get("FORCE_HTTPS", "").lower() == "true"
        or os.environ.get("SESSION_COOKIE_SECURE", "").lower() == "true"
    ),
)

# Only the chat frontend and the admin panel need browser access.  Additional
# deployments can be added through CHAT_CORS_ORIGINS (comma separated).
_default_cors_origins = [
    r"^https?://localhost(:\d+)?$",
    r"^https?://127\.0\.0\.1(:\d+)?$",
    r"^capacitor://localhost$",
    r"^https?://jdlx-chat\.vercel\.app$",
    r"^https?://jdlx-chat[a-z0-9-]*\.vercel\.app$",
    r"^https?://chat\.jdlxmobile\.in$",
    r"^https?://(www\.)?jdlxmobile\.in$",
    r"^https?://jdlx-mobile-admin\.vercel\.app$",
    r"^https?://jdlx-official-admin\.vercel\.app$",
    r"^https?://jdlx-mobile-wearhouse\.vercel\.app$",
]
_extra_origins = [
    item.strip()
    for item in (
        os.environ.get("CHAT_CORS_ORIGINS")
        or os.environ.get("CORS_ORIGINS")
        or ""
    ).split(",")
    if item.strip()
]
CORS(
    app,
    resources={r"/api/.*": {"origins": _default_cors_origins + _extra_origins}},
    supports_credentials=True,
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "Accept"],
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # Cache the CORS preflight for a day. Without this the browser re-sent an
    # OPTIONS round-trip before EVERY authenticated call (an extra ~0.5s hop to
    # Railway from India on every message send), and any hiccup on that
    # preflight surfaced as a failed send.
    max_age=86400,
)

app.register_blueprint(chat_bp)
app.register_blueprint(chat_oauth_bp)

_ALLOWED_EXTENSIONS = {
    "png", "jpg", "jpeg", "gif", "webp", "svg",
    "mp4", "webm", "ogg", "mp3", "m4a",
}
_IMAGE_MIME_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
}
_MEDIA_MIME_TYPES = {
    **_IMAGE_MIME_TYPES,
    "svg": "image/svg+xml",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "ogg": "audio/ogg",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
}


def _row_value(row, name, index):
    return row[name] if hasattr(row, "keys") else row[index]


def _bytes_value(raw):
    if isinstance(raw, (bytes, bytearray, memoryview)):
        return bytes(raw)
    if isinstance(raw, str):
        return raw.encode("utf-8")
    return bytes(raw)


_HEALTH_PROBE_SEM = threading.Semaphore(2)
_HEALTH_PROBE_TIMEOUT_S = 2.5


def _probe_health_db():
    """Bounded SELECT 1 check so a Turso stall cannot block health workers."""
    if not USE_TURSO:
        conn = get_db()
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
        return "ok"

    if not _HEALTH_PROBE_SEM.acquire(blocking=False):
        return "busy"

    result = {"status": "timeout"}
    done = threading.Event()

    def _run():
        conn = None
        try:
            conn = _open_connection()
            conn.execute("SELECT 1").fetchone()
            result["status"] = "ok"
        except Exception as exc:
            logger.warning("Chat health check DB probe warning: %s", exc)
            result["status"] = "unreachable"
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            _HEALTH_PROBE_SEM.release()
            done.set()

    threading.Thread(target=_run, daemon=True, name="health-db-probe").start()
    done.wait(timeout=_HEALTH_PROBE_TIMEOUT_S)
    return result["status"]


@app.get("/health")
@app.get("/api/health")
def health():
    try:
        db_state = _probe_health_db()
    except Exception as exc:
        logger.warning("Chat health check DB probe warning: %s", exc)
        db_state = "unreachable"
    return jsonify({
        "status": "ok" if db_state == "ok" else "degraded",
        "service": "jdlx-chat",
        "database": db_state,
    }), 200


@app.get("/")
def service_root():
    return jsonify(
        {
            "service": "jdlx-chat",
            "status": "ok",
            "api": "/api/chat",
            "health": "/api/health",
        }
    )


@app.route("/api/media-proxy/<path:media_ref>")
def media_proxy(media_ref):
    """Serve an image from uploaded_media when the source host is blocked."""
    ref = (media_ref or "").strip()
    if not ref:
        abort(404)
    # Signed-URL gate: media referenced with a signature must carry a valid
    # one (legacy signature-less references keep working with softer caching).
    provided_sig = request.args.get("m")
    if provided_sig:
        from media_signing import verify_media_signature
        if not verify_media_signature(os.path.basename(ref), provided_sig):
            abort(403)
    if ref.startswith(("http://", "https://")):
        candidate = ref.rsplit("/", 1)[-1]
    else:
        candidate = os.path.basename(ref)
    candidate = candidate.strip()
    if not candidate or "." not in candidate:
        abort(404)
    ext = candidate.rsplit(".", 1)[1].lower()
    if ext not in _IMAGE_MIME_TYPES:
        abort(403)

    base_name = os.path.basename(candidate)
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT mime_type, data FROM uploaded_media WHERE filename = ? LIMIT 1",
            (base_name,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        abort(404)
    saved_mime = _row_value(row, "mime_type", 0)
    data = _bytes_value(_row_value(row, "data", 1))
    if not data:
        abort(404)
    mime_type = (
        saved_mime
        if saved_mime in _IMAGE_MIME_TYPES.values()
        else _IMAGE_MIME_TYPES[ext]
    )
    response = Response(data, mimetype=mime_type)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response


@app.route("/static/uploads/<path:filename>")
def serve_upload(filename):
    """Serve chat media from disk, rehydrating from uploaded_media if needed."""
    if ".." in filename.replace("\\", "/").split("/"):
        abort(404)
    ext = filename.rsplit(".", 1)[1].lower() if "." in filename else ""
    if ext not in _ALLOWED_EXTENSIONS:
        abort(403)

    # Signed-URL gate: media referenced with a signature must carry a valid
    # one. Legacy signature-less URLs (older messages) keep working, but are
    # served with a softened cache policy instead of long-lived immutable.
    provided_sig = request.args.get("m")
    signed = bool(provided_sig)
    if signed:
        from media_signing import verify_media_signature
        if not verify_media_signature(os.path.basename(filename), provided_sig):
            abort(403)

    file_path = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    if os.path.isfile(file_path):
        response = send_from_directory(app.config["UPLOAD_FOLDER"], filename)
        if signed:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    conn = get_db()
    try:
        base_name = os.path.basename(filename)
        row = conn.execute(
            "SELECT mime_type, data FROM uploaded_media "
            "WHERE filename = ? OR filename = ? OR filename LIKE ? LIMIT 1",
            (filename, base_name, f"%{base_name}"),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        abort(404)

    data = _bytes_value(_row_value(row, "data", 1))
    if not data:
        abort(404)
    saved_mime = _row_value(row, "mime_type", 0)
    mime_type = (
        saved_mime
        if saved_mime in set(_MEDIA_MIME_TYPES.values())
        else _MEDIA_MIME_TYPES.get(ext, "application/octet-stream")
    )
    try:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "wb") as cache_file:
            cache_file.write(data)
    except Exception as exc:
        logger.warning("Could not cache chat media to disk: %s", exc)

    response = Response(data, mimetype=mime_type)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = (
        "public, max-age=31536000, immutable" if signed else "public, max-age=86400"
    )
    return response


@app.teardown_appcontext
def close_request_db(exception=None):
    from flask import g

    conn = g.pop("_jdlx_request_db", None)
    if conn is not None:
        try:
            # The request wrapper's close() is a deliberate no-op (routes call
            # it in their own ``finally`` blocks). Only ``_hard_close()``
            # actually releases the underlying connection, which is what puts
            # it back in the Unix pool for reuse. Calling close() here instead
            # leaked every connection: each request paid a fresh Turso
            # handshake and old connections were never closed.
            hard_close = getattr(conn, "_hard_close", None)
            if hard_close is not None:
                hard_close()
            else:
                conn.close()
        except Exception:
            pass


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return jsonify({"success": False, "message": "Not found"}), 404
    return jsonify({"success": False, "message": "Not found"}), 404


@app.errorhandler(413)
def payload_too_large(_error):
    return jsonify({"success": False, "message": "File is too large"}), 413


@app.errorhandler(500)
def internal_error(error):
    logger.exception("Unhandled chat service error: %s", error)
    # TEMPORARY diagnostics: an intermittent 500 on message send could not be
    # traced without runtime logs, so the response names the exception class
    # (and a short text in ``detail``). No user data or credentials are added —
    # remove once the failing exception is identified.
    original = getattr(error, "original_exception", None) or error
    error_class = type(original).__name__
    try:
        detail = str(original)[:180]
    except Exception:
        detail = ""
    return jsonify({
        "success": False,
        "message": f"Internal server error [{error_class}]",
        "detail": detail,
    }), 500


if __name__ == "__main__":
    # Gunicorn/Render boots schema through migrations_boot.py.  Direct
    # `python chat_app.py` is convenient locally and should still work.
    init_db()
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("CHAT_PORT", "5001")),
        debug=os.environ.get("FLASK_DEBUG", "").lower() == "true",
    )
