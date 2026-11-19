import pytest

import database


class FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self.description = [("value",)]

    def execute(self, sql, parameters=()):
        self._conn.executed.append((sql, parameters))
        self._conn.rows = list(self._conn.read_rows)
        self._conn.row_index = 0
        if self._conn.failures:
            raise self._conn.failures.pop(0)

    def executemany(self, sql, seq_of_parameters):
        self._conn.executed.append((sql, list(seq_of_parameters)))
        if self._conn.failures:
            raise self._conn.failures.pop(0)

    def _check_fetch_failure(self):
        self._conn.fetches.append("fetch")
        if self._conn.fetch_failures:
            raise self._conn.fetch_failures.pop(0)

    def fetchone(self):
        self._check_fetch_failure()
        if self._conn.row_index < len(self._conn.rows):
            row = self._conn.rows[self._conn.row_index]
            self._conn.row_index += 1
            return row
        return None

    def fetchall(self):
        self._check_fetch_failure()
        rows = self._conn.rows[self._conn.row_index:]
        self._conn.row_index = len(self._conn.rows)
        return rows

    def fetchmany(self, size=None):
        self._check_fetch_failure()
        remaining = self._conn.rows[self._conn.row_index:]
        rows = remaining if size is None else remaining[:size]
        self._conn.row_index += len(rows)
        return rows


class FakeRawConnection:
    def __init__(self, failures=None, fetch_failures=None, read_rows=()):
        self.failures = list(failures or [])
        self.fetch_failures = list(fetch_failures or [])
        self.read_rows = list(read_rows)
        self.rows = []
        self.row_index = 0
        self.executed = []
        self.fetches = []
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.closed = True


def _patch_replacement(monkeypatch, new_raw):
    created = []

    def _create():
        created.append(True)
        return database.LibsqlConnectionWrapper(new_raw)

    monkeypatch.setattr(database, "_create_turso_connection", _create)
    return created


def test_transient_stream_failure_replays_statement_on_fresh_connection(monkeypatch):
    old_raw = FakeRawConnection([ValueError("stream expired due to inactivity")])
    new_raw = FakeRawConnection()
    conn = database.LibsqlConnectionWrapper(old_raw)
    created = _patch_replacement(monkeypatch, new_raw)
    closed = []
    monkeypatch.setattr(
        database, "_destroy_raw_handle_async", lambda handle: closed.append(handle)
    )

    conn.cursor().execute("SELECT 1")

    assert created == [True]
    assert conn._conn is new_raw
    assert old_raw.executed == [("SELECT 1", ())]
    assert new_raw.executed == [("SELECT 1", ())]
    assert closed == [old_raw]
    assert conn._dirty is False


def test_transient_write_failure_is_replayed_and_marks_dirty(monkeypatch):
    old_raw = FakeRawConnection([ValueError("client stream has been closed by the server")])
    new_raw = FakeRawConnection()
    conn = database.LibsqlConnectionWrapper(old_raw)
    _patch_replacement(monkeypatch, new_raw)
    monkeypatch.setattr(database, "_destroy_raw_handle_async", lambda handle: None)

    conn.cursor().execute("INSERT INTO t (x) VALUES (?)", (1,))

    assert new_raw.executed == [("INSERT INTO t (x) VALUES (?)", (1,))]
    assert conn._dirty is True


def test_dirty_connection_never_replays_a_statement(monkeypatch):
    old_raw = FakeRawConnection([ValueError("stream expired due to inactivity")])
    new_raw = FakeRawConnection()
    conn = database.LibsqlConnectionWrapper(old_raw)
    conn._dirty = True
    created = _patch_replacement(monkeypatch, new_raw)

    with pytest.raises(ValueError):
        conn.cursor().execute("UPDATE t SET x = 1")

    assert created == []
    assert conn._discarded is True
    assert new_raw.executed == []


def test_sql_error_is_not_treated_as_transient(monkeypatch):
    old_raw = FakeRawConnection([ValueError("no such column: missing_col")])
    new_raw = FakeRawConnection()
    conn = database.LibsqlConnectionWrapper(old_raw)
    created = _patch_replacement(monkeypatch, new_raw)

    with pytest.raises(ValueError):
        conn.cursor().execute("SELECT missing_col FROM t")

    assert created == []
    assert conn._discarded is True
    assert new_raw.executed == []


def test_second_transient_failure_marks_connection_unhealthy(monkeypatch):
    old_raw = FakeRawConnection([ValueError("stream expired due to inactivity")])
    new_raw = FakeRawConnection(
        [ValueError("client stream has been closed by the server")]
    )
    conn = database.LibsqlConnectionWrapper(old_raw)
    _patch_replacement(monkeypatch, new_raw)
    monkeypatch.setattr(database, "_destroy_raw_handle_async", lambda handle: None)

    with pytest.raises(ValueError):
        conn.cursor().execute("SELECT 1")

    assert conn._discarded is True


def test_healthy_connection_is_untouched(monkeypatch):
    raw = FakeRawConnection()
    conn = database.LibsqlConnectionWrapper(raw)
    created = _patch_replacement(monkeypatch, FakeRawConnection())

    conn.cursor().execute("SELECT 1")

    assert created == []
    assert raw.executed == [("SELECT 1", ())]
    assert conn._discarded is False


def _fetching_cursor(monkeypatch, old_raw, new_raw):
    conn = database.LibsqlConnectionWrapper(old_raw)
    conn.row_factory = database.LibsqlRow
    created = _patch_replacement(monkeypatch, new_raw)
    closed = []
    monkeypatch.setattr(
        database, "_destroy_raw_handle_async", lambda handle: closed.append(handle)
    )
    return conn, conn.cursor(), created, closed


def test_transient_fetchone_failure_replays_last_read(monkeypatch):
    old_raw = FakeRawConnection(
        fetch_failures=[ValueError("stream error: connection reset")],
        read_rows=[(7,)]
    )
    new_raw = FakeRawConnection(read_rows=[(7,)])
    conn, cursor, created, closed = _fetching_cursor(monkeypatch, old_raw, new_raw)

    cursor.execute("SELECT value FROM t")
    row = cursor.fetchone()

    assert row["value"] == 7
    assert created == [True]
    assert new_raw.executed == [("SELECT value FROM t", ())]
    assert closed == [old_raw]
    assert conn._dirty is False


def test_transient_fetchall_failure_replays_last_read(monkeypatch):
    old_raw = FakeRawConnection(
        fetch_failures=[ValueError("client stream has been closed by the server")],
        read_rows=[(1,), (2,)]
    )
    new_raw = FakeRawConnection(read_rows=[(1,), (2,)])
    conn, cursor, created, closed = _fetching_cursor(monkeypatch, old_raw, new_raw)

    cursor.execute("SELECT value FROM t ORDER BY value")
    rows = cursor.fetchall()

    assert [row["value"] for row in rows] == [1, 2]
    assert created == [True]
    assert new_raw.executed == [("SELECT value FROM t ORDER BY value", ())]
    assert closed == [old_raw]


def test_fetch_failure_after_partial_read_is_never_replayed(monkeypatch):
    old_raw = FakeRawConnection(read_rows=[(1,), (2,)])
    new_raw = FakeRawConnection(read_rows=[(1,), (2,)])
    conn, cursor, created, _ = _fetching_cursor(monkeypatch, old_raw, new_raw)

    cursor.execute("SELECT value FROM t")
    assert cursor.fetchone()["value"] == 1
    old_raw.fetch_failures.append(ValueError("stream error: closed"))

    with pytest.raises(ValueError):
        cursor.fetchone()

    assert created == []
    assert new_raw.executed == []
    assert conn._discarded is True


def test_non_transient_fetch_failure_marks_connection_unhealthy(monkeypatch):
    old_raw = FakeRawConnection(
        fetch_failures=[ValueError("no such column: missing")],
        read_rows=[(1,)]
    )
    new_raw = FakeRawConnection(read_rows=[(1,)])
    conn, cursor, created, _ = _fetching_cursor(monkeypatch, old_raw, new_raw)

    cursor.execute("SELECT missing FROM t")
    with pytest.raises(ValueError):
        cursor.fetchone()

    assert created == []
    assert new_raw.executed == []
    assert conn._discarded is True


def test_second_transient_fetch_failure_marks_connection_unhealthy(monkeypatch):
    old_raw = FakeRawConnection(
        fetch_failures=[ValueError("stream error: closed")],
        read_rows=[(1,)]
    )
    new_raw = FakeRawConnection(
        fetch_failures=[ValueError("stream expired due to inactivity")],
        read_rows=[(1,)]
    )
    conn, cursor, _, _ = _fetching_cursor(monkeypatch, old_raw, new_raw)

    cursor.execute("SELECT value FROM t")
    with pytest.raises(ValueError):
        cursor.fetchone()

    assert conn._discarded is True


def test_fetchmany_replays_last_read(monkeypatch):
    old_raw = FakeRawConnection(
        fetch_failures=[ValueError("stream error: closed")],
        read_rows=[(1,), (2,), (3,)]
    )
    new_raw = FakeRawConnection(read_rows=[(1,), (2,), (3,)])
    _, cursor, created, _ = _fetching_cursor(monkeypatch, old_raw, new_raw)

    cursor.execute("SELECT value FROM t")
    rows = cursor.fetchmany(2)

    assert [row["value"] for row in rows] == [1, 2]
    assert created == [True]
    assert new_raw.executed == [("SELECT value FROM t", ())]
