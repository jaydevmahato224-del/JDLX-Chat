"""Long-poll handlers must not hold a pooled DB connection while they sleep.

Production showed a room event poll at 44s and a send at 76s: every open chat
kept its connection for the whole long-poll, so the pool ran dry and other
requests built new Turso connections (no timeout on the handshake). The poll
loop now releases the connection before sleeping and re-acquires it after.
"""

import uuid

from chat_routes import issue_chat_token


def _chat_user(db, name):
    cursor = db.execute(
        "INSERT INTO chat_users (email, name, username) VALUES (?, ?, ?)",
        (f"{uuid.uuid4().hex[:10]}@example.com", name, f"u{uuid.uuid4().hex[:10]}"),
    )
    db.commit()
    return cursor.lastrowid


def _direct_room(db, user_a, user_b):
    cursor = db.execute(
        """INSERT INTO official_chat_rooms (user_id, room_key, user_two_id, room_type)
           VALUES (?, ?, ?, 'direct')""",
        (user_a, f"direct-{user_a}-{user_b}", user_b),
    )
    db.commit()
    return cursor.lastrowid


def _headers(user_id):
    token, _refresh = issue_chat_token(
        user_id, f"{user_id}@example.com", f"User {user_id}", f"u{user_id}", "customer"
    )
    return {"Authorization": f"Bearer {token}"}


def test_quiesce_ends_the_transaction_and_drops_a_dead_stream():
    from database import _quiesce_connection

    class Healthy:
        def __init__(self):
            self.commits = 0

        def commit(self):
            self.commits += 1

    healthy = Healthy()
    assert _quiesce_connection(healthy) is True
    assert healthy.commits == 1

    class RolledBack:
        def commit(self):
            raise ValueError(
                "Hrana: SQLite error: interactive transaction was rolled back "
                "because the stream was idle for too long"
            )

        def close(self):
            pass

    assert _quiesce_connection(RolledBack()) is False


def test_room_events_poll_survives_releasing_the_connection(client, db):
    alice = _chat_user(db, "Alice")
    bob = _chat_user(db, "Bob")
    room = _direct_room(db, alice, bob)

    # after_message_id far in the future: the poll sleeps through at least one
    # cycle, releasing and re-acquiring its connection each time.
    res = client.get(
        f"/api/chat/rooms/{room}/events?after_message_id=999&timeout=1",
        headers=_headers(alice),
    )
    assert res.status_code == 200, res.get_json()
    assert res.get_json()["data"]["messages"] == []


def test_social_events_poll_survives_releasing_the_connection(client, db):
    alice = _chat_user(db, "Alice")

    headers = _headers(alice)
    first = client.get("/api/chat/social/events?timeout=1", headers=headers)
    assert first.status_code == 200, first.get_json()
    revision = first.get_json()["data"]["revision"]

    # Nothing changes, so the poll loops (releasing its connection) until the
    # deadline and answers with the same revision.
    res = client.get(f"/api/chat/social/events?timeout=1&since={revision}", headers=headers)
    assert res.status_code == 200, res.get_json()
    assert res.get_json()["data"]["revision"] == revision


def test_warm_pool_once_drains_finite_and_never_loops(monkeypatch):
    import queue
    import time
    import database

    class CleanConn:
        def __init__(self):
            self._discarded = False
            self._released_at = time.monotonic()
            self._needs_quiesce = True
            self.commits = 0

        def commit(self):
            self.commits += 1
            self._needs_quiesce = False

        def close(self):
            pass

    pool = queue.LifoQueue(maxsize=8)
    c1, c2 = CleanConn(), CleanConn()
    pool.put(c1)
    pool.put(c2)

    monkeypatch.setattr(database, "_POOL", pool)
    monkeypatch.setattr(database, "_POOL_WARM_MIN", 2)
    monkeypatch.setattr(database, "_create_turso_connection", lambda: CleanConn())

    database._warm_pool_once()
    assert c1.commits == 1
    assert c2.commits == 1
    assert pool.qsize() == 2

    # Second pass: idle already-quiesced connections must not re-commit.
    database._warm_pool_once()
    assert c1.commits == 1
    assert c2.commits == 1
    assert pool.qsize() == 2


def test_chat_schema_is_current_tracks_chat_tables(monkeypatch, tmp_path):
    import sqlite3
    import database

    path = str(tmp_path / "schema_probe.db")
    monkeypatch.setattr(database, "DATABASE_PATH", path)
    monkeypatch.setattr(database, "USE_TURSO", False)

    # Empty DB: probe reports False.
    conn = sqlite3.connect(path)
    conn.close()
    assert database.chat_schema_is_current() is False

    # After init_db(): probe reports True.
    database.init_db()
    assert database.chat_schema_is_current() is True


def test_health_returns_degraded_without_hanging_on_db_timeout(monkeypatch):
    import threading
    import chat_app

    chat_app.app.config.update(TESTING=True)
    monkeypatch.setattr(chat_app, "USE_TURSO", True)
    monkeypatch.setattr(chat_app, "_HEALTH_PROBE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(chat_app, "_HEALTH_PROBE_SEM", threading.Semaphore(2))

    unblock = threading.Event()

    def slow_open():
        unblock.wait(timeout=1.0)
        raise RuntimeError("timed out")

    monkeypatch.setattr(chat_app, "_open_connection", slow_open)
    try:
        with chat_app.app.test_client() as client:
            res = client.get("/api/health")
            assert res.status_code == 200
            data = res.get_json()
            assert data["service"] == "jdlx-chat"
            assert data["status"] == "degraded"
            assert data["database"] == "timeout"
    finally:
        unblock.set()


def test_chat_token_required_retries_transient_db_error(client, db, monkeypatch):
    import chat_routes

    alice = _chat_user(db, "Alice")
    headers = _headers(alice)
    real_get_db = chat_routes.get_db
    calls = {"count": 0}

    class FlakyAuthConn:
        def __init__(self, inner):
            self._inner = inner

        def __getattr__(self, name):
            return getattr(self._inner, name)

        def execute(self, sql, params=()):
            if "SELECT is_active, min_token_iat" in sql and calls["count"] == 0:
                calls["count"] += 1
                raise ValueError(
                    "Hrana: `stream error: interactive transaction was rolled back "
                    "because the stream was idle for too long`"
                )
            return self._inner.execute(sql, params)

    monkeypatch.setattr(chat_routes, "get_db", lambda: FlakyAuthConn(real_get_db()))
    res = client.get("/api/chat/conversations", headers=headers)
    assert res.status_code == 200, res.get_json()
    assert calls["count"] == 1
