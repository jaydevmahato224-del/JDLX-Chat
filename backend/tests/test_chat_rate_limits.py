import sqlite3
import time

import pytest

import chat_routes


CREATE_TABLE = """
    CREATE TABLE IF NOT EXISTS chat_rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
    )
"""


class OneShotConnection:
    """sqlite connection that survives the limiter's per-call close()."""

    def __init__(self, path):
        self._path = path
        self._inner = sqlite3.connect(path)
        self._inner.row_factory = sqlite3.Row
        self.commits = 0

    def execute(self, *args, **kwargs):
        return self._inner.execute(*args, **kwargs)

    def commit(self):
        self.commits += 1
        self._inner.commit()

    def close(self):
        pass


@pytest.fixture
def rate_path(tmp_path, monkeypatch):
    path = str(tmp_path / "rate.db")
    conn = sqlite3.connect(path)
    conn.execute(CREATE_TABLE)
    conn.commit()
    conn.close()

    opened = []

    def _get_db():
        conn = OneShotConnection(path)
        opened.append(conn)
        return conn

    monkeypatch.setattr(chat_routes, "get_db", _get_db)
    monkeypatch.setattr(chat_routes, "_chat_rate_cleanup", {"last": time.monotonic()})
    monkeypatch.delenv("DISABLE_RATE_LIMIT", raising=False)
    return path, opened


def _rows(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return {
            row["key"]: dict(row)
            for row in conn.execute("SELECT * FROM chat_rate_limits")
        }
    finally:
        conn.close()


def test_rate_limit_allows_up_to_budget_then_rejects(rate_path):
    _, _ = rate_path

    assert chat_routes.check_chat_rate_limit("send", "u1", max_requests=2, window_seconds=60) is True
    assert chat_routes.check_chat_rate_limit("send", "u1", max_requests=2, window_seconds=60) is True
    assert chat_routes.check_chat_rate_limit("send", "u1", max_requests=2, window_seconds=60) is False


def test_batched_budgets_use_one_commit(rate_path):
    _, opened = rate_path

    allowed = chat_routes.check_chat_rate_limits([
        ("send", "u1", 40, 60),
        ("new_account", "u1", 300, 3600),
    ])

    assert allowed is True
    assert sum(c.commits for c in opened) == 1


def test_batched_budgets_all_denied_if_one_exceeds(rate_path):
    path, _ = rate_path

    assert chat_routes.check_chat_rate_limits([
        ("send", "u1", 1, 60),
        ("new_account", "u1", 300, 3600),
    ]) is True
    assert chat_routes.check_chat_rate_limits([
        ("send", "u1", 1, 60),
        ("new_account", "u1", 300, 3600),
    ]) is False

    rows = _rows(path)
    assert rows["send:u1"]["count"] == 2
    assert rows["new_account:u1"]["count"] == 2


def test_window_expiry_resets_counter(rate_path):
    path, _ = rate_path
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO chat_rate_limits (key, window_start, count) VALUES (?, ?, ?)",
        ("send:u1", int(time.time()) - 61, 2),
    )
    conn.commit()
    conn.close()

    assert chat_routes.check_chat_rate_limit("send", "u1", max_requests=2, window_seconds=60) is True
    assert _rows(path)["send:u1"]["count"] == 1


def test_limiter_fails_open_when_db_unavailable(monkeypatch):
    def _broken():
        raise RuntimeError("db down")

    monkeypatch.setattr(chat_routes, "get_db", _broken)
    monkeypatch.delenv("DISABLE_RATE_LIMIT", raising=False)

    assert chat_routes.check_chat_rate_limit("send", "u1", max_requests=1) is True


def test_disable_rate_limit_escape_hatch(monkeypatch):
    monkeypatch.setenv("DISABLE_RATE_LIMIT", "1")
    monkeypatch.setattr(
        chat_routes, "get_db", lambda: pytest.fail("limiter must not touch the DB")
    )

    assert chat_routes.check_chat_rate_limit("send", "u1", max_requests=1) is True


def test_is_new_chat_account():
    now = time.time()
    fresh = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now - 60))
    old = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now - 86400 * 2))

    assert chat_routes._is_new_chat_account(fresh) is True
    assert chat_routes._is_new_chat_account(old) is False
    assert chat_routes._is_new_chat_account(None) is False
    assert chat_routes._is_new_chat_account("not-a-date") is False


def test_rate_upsert_commits_on_libsql():
    """Regression guard for the real driver.

    libsql keeps a RETURNING statement "in progress" until all rows are
    consumed. fetchone() leaves it open and the following commit() raises
    "cannot commit transaction - SQL statements in progress", which the limiter
    would swallow as a fail-open. Always exhaust the rows (fetchall).
    """
    libsql = pytest.importorskip("libsql_experimental")
    try:
        conn = libsql.connect(":memory:")
        conn.execute(CREATE_TABLE)
        conn.commit()
    except Exception:
        pytest.skip("libsql in-memory driver unavailable")

    try:
        rows = conn.execute(
            chat_routes._CHAT_RATE_UPSERT, ("send:u1", 100, 60, 60)
        ).fetchall()
        assert [row[0] for row in rows] == [1]
        conn.commit()

        rows = conn.execute(
            chat_routes._CHAT_RATE_UPSERT, ("send:u1", 100, 60, 60)
        ).fetchall()
        assert [row[0] for row in rows] == [2]
        conn.commit()
    finally:
        conn.close()
