"""Shared fixtures for the chat backend test suite.

These fixtures used to be missing from the repository, so every test failed
with "fixture 'client' not found". Every test gets its own throwaway SQLite
database; the Flask app and the test body then work on the same file.
"""

import os
import sqlite3
import sys
import time
import uuid

import jwt
import pytest

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import database  # noqa: E402  (import needs BACKEND_DIR on sys.path)
from jwt_config import get_jwt_secret  # noqa: E402


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """Fresh schema per test, plus a connection the test body can query."""
    path = str(tmp_path / "chat_test.db")
    monkeypatch.setattr(database, "DATABASE_PATH", path)
    monkeypatch.setattr(database, "USE_TURSO", False)
    database.init_db()

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture()
def client(db):
    import chat_app

    chat_app.app.config.update(TESTING=True)
    return chat_app.app.test_client()


@pytest.fixture()
def make_user(db):
    """Insert a storefront/admin user row and return its id."""

    def _make_user(email=None, role="admin", name="Test Admin", **extra):
        email = email or f"test-{uuid.uuid4().hex[:12]}@example.com"
        status = extra.get("account_status") or "active"
        cursor = db.execute(
            """INSERT INTO users (google_id, name, email, role, account_status)
               VALUES (?, ?, ?, ?, ?)""",
            (f"test-{uuid.uuid4().hex}", name, email, role, status),
        )
        db.commit()
        return cursor.lastrowid

    return _make_user


@pytest.fixture()
def mint_token():
    """Sign an admin-panel JWT the way the real login does."""

    def _mint_token(user_id, role="admin", type=None, expires_in=3600):
        now = int(time.time())
        payload = {
            "user_id": user_id,
            "role": role,
            "iat": now,
            "exp": now + expires_in,
        }
        if type:
            payload["type"] = type
        return jwt.encode(payload, get_jwt_secret(), algorithm="HS256")

    return _mint_token


@pytest.fixture()
def app_module():
    """The storefront/admin backend that hosts the web chat OAuth hand-off.

    It lives in the main JDLX backend, not in this standalone chat repo, so
    the hand-off test skips instead of failing when it is not checked out.
    """
    try:
        import app as main_app
    except Exception:
        pytest.skip("main storefront app module is not available in this repo")
    if not hasattr(main_app, "_chat_google_oauth_handoff"):
        pytest.skip("main storefront app module has no chat OAuth hand-off")
    return main_app
