import pytest

import database


class FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self.description = [("value",)]

    def execute(self, sql, parameters=()):
        self._conn.executed.append((sql, parameters))
        if self._conn.failures:
            raise self._conn.failures.pop(0)

    def executemany(self, sql, seq_of_parameters):
        self._conn.executed.append((sql, list(seq_of_parameters)))
        if self._conn.failures:
            raise self._conn.failures.pop(0)


class FakeRawConnection:
    def __init__(self, failures=None):
        self.failures = list(failures or [])
        self.executed = []
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
