"""Regression tests for the GIL-free Turso Hrana HTTP driver and send resilience."""

import base64
import http.server
import json
import sqlite3
import threading
import time
import uuid

import pytest

import chat_routes
import database
from chat_routes import issue_chat_token


class _MockHranaState:
    def __init__(self, handler_fn=None):
        self.requests = []
        self.headers = []
        self.handler_fn = handler_fn
        self.delay_s = 0.0
        self.next_status = 200
        self.next_base_url = None
        self.next_baton = "baton-1"


def _start_mock_hrana_server(state):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            body = json.loads(raw)
            state.requests.append((self.path, body))
            state.headers.append(dict(self.headers))
            if state.delay_s > 0:
                time.sleep(state.delay_s)

            if state.handler_fn is not None:
                status, payload = state.handler_fn(self.path, body, len(state.requests))
            else:
                status = state.next_status
                if status == 200:
                    results = [
                        {
                            "type": "ok",
                            "response": {
                                "type": "execute" if r.get("type") == "execute" else r.get("type"),
                                "result": {
                                    "cols": [],
                                    "rows": [],
                                    "affected_row_count": 0,
                                    "last_insert_rowid": None,
                                },
                            },
                        }
                        for r in body.get("requests", [])
                    ]
                    payload = {
                        "baton": state.next_baton,
                        "base_url": state.next_base_url,
                        "results": results,
                    }
                else:
                    payload = {"error": f"mock error {status}"}

            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def test_turso_http_url_normalization():
    assert database._normalize_turso_http_url("libsql://db-org.turso.io/") == "https://db-org.turso.io"
    assert database._normalize_turso_http_url("wss://db-org.turso.io") == "https://db-org.turso.io"
    assert database._normalize_turso_http_url("ws://localhost:8080/") == "http://localhost:8080"
    assert database._normalize_turso_http_url("db-org.turso.io") == "https://db-org.turso.io"


def test_turso_http_releases_gil_during_slow_network():
    state = _MockHranaState()
    state.delay_s = 0.35
    srv, base_url = _start_mock_hrana_server(state)
    ticks = 0
    stop = threading.Event()

    def _ticker():
        nonlocal ticks
        while not stop.is_set():
            ticks += 1
            time.sleep(0.02)

    ticker = threading.Thread(target=_ticker, daemon=True)
    ticker.start()
    try:
        conn = database.TursoHttpConnection(base_url, auth_token="secret-tok", timeout=(2.0, 2.0))
        conn.execute("SELECT 1")
        # 350ms wait with 20ms ticker yields ~15+ ticks when GIL is released
        # (libsql_experimental held the GIL and produced <= 1 tick).
        assert ticks >= 8
        assert state.headers[0].get("Authorization") == "Bearer secret-tok"
        assert state.requests[0][0] == "/v2/pipeline"
        conn.close()
    finally:
        stop.set()
        ticker.join(timeout=1.0)
        srv.shutdown()
        srv.server_close()


def test_turso_http_enforces_read_timeout_and_is_transient():
    state = _MockHranaState()
    state.delay_s = 1.0
    srv, base_url = _start_mock_hrana_server(state)
    try:
        conn = database.TursoHttpConnection(base_url, auth_token="tok", timeout=(0.5, 0.2))
        started = time.monotonic()
        with pytest.raises(TimeoutError) as exc_info:
            conn.execute("SELECT 1")
        elapsed = time.monotonic() - started
        assert elapsed < 0.8
        assert database.is_transient_db_error(exc_info.value) is True
    finally:
        srv.shutdown()
        srv.server_close()


def test_turso_http_types_transactions_and_sticky_base_url():
    def _handler(path, body, seq):
        reqs = body["requests"]
        if reqs[0].get("stmt", {}).get("sql") == "SELECT 1 AS a, ? AS b":
            return 200, {
                "baton": "b-read",
                "base_url": None,
                "results": [
                    {
                        "type": "ok",
                        "response": {
                            "type": "execute",
                            "result": {
                                "cols": [
                                    {"name": "a", "decltype": "INTEGER"},
                                    {"name": "b", "decltype": "BLOB"},
                                    {"name": "c", "decltype": "REAL"},
                                    {"name": "d", "decltype": "TEXT"},
                                    {"name": "e", "decltype": None},
                                ],
                                "rows": [[
                                    {"type": "integer", "value": "9007199254740993"},
                                    {"type": "blob", "base64": base64.b64encode(b"\x00\xffhi").decode()},
                                    {"type": "float", "value": 3.5},
                                    {"type": "text", "value": "hello"},
                                    {"type": "null"},
                                ]],
                                "affected_row_count": 0,
                                "last_insert_rowid": None,
                            },
                        },
                    }
                ],
            }
        # Write batch (BEGIN + INSERT), then COMMIT, then close
        if any("INSERT INTO msgs" in (r.get("stmt", {}).get("sql") or "") for r in reqs):
            return 200, {
                "baton": "b-write",
                "base_url": None,
                "results": [
                    {"type": "ok", "response": {"type": "execute", "result": {"cols": [], "rows": [], "affected_row_count": 0, "last_insert_rowid": None}}},
                    {"type": "ok", "response": {"type": "execute", "result": {"cols": [{"name": "id", "decltype": "INTEGER"}], "rows": [[{"type": "integer", "value": "42"}]], "affected_row_count": 1, "last_insert_rowid": "42"}}},
                ],
            }
        return 200, {
            "baton": None if reqs[-1].get("type") == "close" else "b-write",
            "base_url": None,
            "results": [
                {"type": "ok", "response": {"type": r.get("type"), "result": {"cols": [], "rows": [], "affected_row_count": 1, "last_insert_rowid": None}}}
                for r in reqs
            ],
        }

    state = _MockHranaState(_handler)
    srv, base_url = _start_mock_hrana_server(state)
    try:
        conn = database.TursoHttpConnection(base_url, auth_token="tok")
        cur = conn.cursor()

        # Reads must NOT start a transaction; commit() afterwards is a 0-RTT no-op.
        cur.execute("SELECT 1 AS a, ? AS b", (b"raw", True, None, 1.25))
        row = cur.fetchone()
        assert row == (9007199254740993, b"\x00\xffhi", 3.5, "hello", None)
        assert [c[0] for c in cur.description] == ["a", "b", "c", "d", "e"]
        conn.commit()
        assert len(state.requests) == 1
        args = state.requests[0][1]["requests"][0]["stmt"]["args"]
        assert args == [
            {"type": "blob", "base64": base64.b64encode(b"raw").decode()},
            {"type": "integer", "value": "1"},
            {"type": "null"},
            {"type": "float", "value": 1.25},
        ]

        # First write batches BEGIN + statement in ONE HTTP call.
        cur.execute("INSERT INTO msgs (body) VALUES (?) RETURNING id", ("hi",))
        assert cur.fetchone() == (42,)
        assert cur.lastrowid == 42
        assert len(state.requests) == 2
        write_reqs = state.requests[1][1]["requests"]
        assert [r["stmt"]["sql"] for r in write_reqs] == ["BEGIN", "INSERT INTO msgs (body) VALUES (?) RETURNING id"]

        conn.commit()
        assert state.requests[2][1]["baton"] == "b-write"
        assert state.requests[2][1]["requests"][0]["stmt"]["sql"] == "COMMIT"

        conn.close()
        assert state.requests[3][1]["requests"] == [{"type": "close"}]
    finally:
        srv.shutdown()
        srv.server_close()


def test_turso_http_errors_and_transient_replay(monkeypatch):
    def _handler(path, body, seq):
        if seq == 1:
            return 200, {
                "baton": "b-err",
                "base_url": None,
                "results": [
                    {"type": "error", "error": {"code": "SQLITE_CONSTRAINT", "message": "UNIQUE constraint failed: t.id"}}
                ],
            }
        if seq == 2:
            return 404, {"error": "stream not found"}
        if seq == 3:
            return 401, {"error": "unauthorized"}
        return 200, {
            "baton": "b-ok",
            "base_url": None,
            "results": [
                {"type": "ok", "response": {"type": "execute", "result": {"cols": [{"name": "ok"}], "rows": [[{"type": "integer", "value": "1"}]], "affected_row_count": 0, "last_insert_rowid": None}}}
            ],
        }

    state = _MockHranaState(_handler)
    srv, base_url = _start_mock_hrana_server(state)
    try:
        conn = database.TursoHttpConnection(base_url, auth_token="bad")
        with pytest.raises(sqlite3.IntegrityError) as constraint_exc:
            conn.execute("SELECT constraint_err")
        assert database.is_transient_db_error(constraint_exc.value) is False

        with pytest.raises(ConnectionError) as gone_exc:
            conn.execute("SELECT expired")
        assert database.is_transient_db_error(gone_exc.value) is True
        assert conn._baton is None

        with pytest.raises(RuntimeError) as auth_exc:
            conn.execute("SELECT unauth")
        assert database._is_turso_auth_error(auth_exc.value) is True
    finally:
        srv.shutdown()
        srv.server_close()


def test_turso_http_wrapper_executemany_rollback_and_base_url(monkeypatch):
    def _redirect_handler(path, body, seq):
        reqs = body["requests"]
        # First call returns a sticky base_url pointing to the replica/primary server
        if seq == 1 and any("PRAGMA" in (r.get("stmt", {}).get("sql") or "") for r in reqs):
            return 200, {
                "baton": "b-init",
                "base_url": state_target_url["url"],
                "results": [
                    {
                        "type": "ok",
                        "response": {
                            "type": "execute",
                            "result": {
                                "cols": [{"name": "ok"}],
                                "rows": [[{"type": "integer", "value": "1"}]],
                                "affected_row_count": 0,
                                "last_insert_rowid": None,
                            },
                        },
                    }
                ],
            }
        return 200, {
            "baton": "b-init",
            "base_url": None,
            "results": [
                {
                    "type": "ok",
                    "response": {
                        "type": r.get("type"),
                        "result": {"cols": [], "rows": [], "affected_row_count": 1, "last_insert_rowid": None},
                    },
                }
                for r in reqs
            ],
        }

    state_init = _MockHranaState(_redirect_handler)
    state_target = _MockHranaState(_redirect_handler)
    srv_init, url_init = _start_mock_hrana_server(state_init)
    srv_target, url_target = _start_mock_hrana_server(state_target)
    state_target_url = {"url": url_target}
    try:
        monkeypatch.setattr(database, "_WARMER_STARTED", True)
        monkeypatch.setattr(database, "TURSO_URL", url_init)
        monkeypatch.setattr(database, "TURSO_TOKEN", "tok-xyz")
        wrapped = database._create_turso_connection()
        assert len(state_init.requests) == 1
        assert state_init.requests[0][1]["requests"][0]["stmt"]["sql"] == "PRAGMA foreign_keys = ON"
        assert isinstance(wrapped, database.LibsqlConnectionWrapper)
        assert wrapped._conn._base_url == url_target

        # Next query routes to redirected base_url and batches BEGIN + executemany rows
        cur = wrapped.cursor()
        cur.executemany("INSERT INTO t (v) VALUES (?)", [("a",), ("b",)])
        assert cur.rowcount == 2
        assert wrapped._dirty is True
        assert len(state_target.requests) == 1
        batch_reqs = state_target.requests[0][1]["requests"]
        assert [r["stmt"]["sql"] for r in batch_reqs] == [
            "BEGIN",
            "INSERT INTO t (v) VALUES (?)",
            "INSERT INTO t (v) VALUES (?)",
        ]

        # Explicit rollback issues ROLLBACK on the sticky server and clears dirty flag
        wrapped.rollback()
        assert wrapped._dirty is False
        assert state_target.requests[1][1]["requests"][0]["stmt"]["sql"] == "ROLLBACK"

        # Clean read uses LibsqlRow mapping accurately
        state_target.handler_fn = lambda _p, _b, _s: (
            200,
            {
                "baton": "b-init",
                "base_url": None,
                "results": [
                    {
                        "type": "ok",
                        "response": {
                            "type": "execute",
                            "result": {
                                "cols": [{"name": "greeting", "decltype": "TEXT"}],
                                "rows": [[{"type": "text", "value": "namaste"}]],
                                "affected_row_count": 0,
                                "last_insert_rowid": None,
                            },
                        },
                    }
                ],
            },
        )
        row = wrapped.execute("SELECT 'namaste' AS greeting").fetchone()
        assert row["greeting"] == "namaste"
        wrapped._conn.close()
    finally:
        srv_init.shutdown()
        srv_init.server_close()
        srv_target.shutdown()
        srv_target.server_close()


def test_send_recovers_if_rate_limiter_hits_error_with_commit_false(client, db, monkeypatch):
    """If check_chat_rate_limits(..., commit=False) fails after dirtying g._jdlx_request_db,
    it must reset the poisoned connection rather than breaking the message INSERT."""
    alice_id = db.execute(
        "INSERT INTO chat_users (email, name, username) VALUES (?, ?, ?)",
        (f"{uuid.uuid4().hex[:8]}@example.com", "Alice", f"alice_{uuid.uuid4().hex[:6]}"),
    ).lastrowid
    bob_id = db.execute(
        "INSERT INTO chat_users (email, name, username) VALUES (?, ?, ?)",
        (f"{uuid.uuid4().hex[:8]}@example.com", "Bob", f"bob_{uuid.uuid4().hex[:6]}"),
    ).lastrowid
    db.execute(
        "INSERT INTO official_chat_friend_requests (sender_id, receiver_id, status) VALUES (?, ?, 'accepted')",
        (alice_id, bob_id),
    )
    room_id = db.execute(
        "INSERT INTO official_chat_rooms (user_id, room_key, user_two_id, room_type) VALUES (?, ?, ?, 'direct')",
        (alice_id, f"direct-{alice_id}-{bob_id}", bob_id),
    ).lastrowid
    db.commit()

    monkeypatch.delenv("DISABLE_RATE_LIMIT", raising=False)
    monkeypatch.setattr(chat_routes, "_is_new_chat_account", lambda _ts: True)

    real_get_db = chat_routes.get_db
    injected = {"done": False}

    class PartialFailLimiterConn:
        def __init__(self, inner):
            self._inner = inner

        def __getattr__(self, name):
            return getattr(self._inner, name)

        def execute(self, sql, params=()):
            # Let the first budget UPSERT dirty the shared request connection, then fail on the second.
            if "INSERT INTO chat_rate_limits" in sql and params and str(params[0]).startswith("new_account_send:") and not injected["done"]:
                injected["done"] = True
                self._inner._discarded = True
                raise ConnectionError("stream expired mid-limiter")
            return self._inner.execute(sql, params)

    monkeypatch.setattr(chat_routes, "get_db", lambda: PartialFailLimiterConn(real_get_db()))

    token, _ = issue_chat_token(alice_id, "alice@example.com", "Alice", "alice", "customer")
    res = client.post(
        f"/api/chat/rooms/{room_id}/messages",
        json={"message": "hello resilient send", "client_message_id": f"c_{uuid.uuid4().hex}"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.get_json()
    payload = res.get_json()
    assert payload["success"] is True
    assert payload["data"][0]["message"] == "hello resilient send"
    assert injected["done"] is True
