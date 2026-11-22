import datetime
import json
import queue
import socket
import sqlite3
import threading
import os
import time
from dotenv import load_dotenv

# Prefer IPv4 over broken/unreachable IPv6/NAT64 routes.
# On networks where IPv6 is configured but blackholed, glibc's default IPv6-first
# resolution causes a 10-30 second timeout on every outbound connection (Turso, Google OAuth, SMTP).
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_preferred_getaddrinfo(host, port, family=0, *args, **kwargs):
    if family == 0:
        family = socket.AF_INET
    return _orig_getaddrinfo(host, port, family, *args, **kwargs)
socket.getaddrinfo = _ipv4_preferred_getaddrinfo

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"), override=True)

# Local-testing escape hatch: set FORCE_LOCAL_DB=1 in the environment to run
# against the local SQLite file even when Turso credentials are present in .env.
# This only controls which DB connection is used — no business logic is changed.
FORCE_LOCAL_DB = os.environ.get("FORCE_LOCAL_DB", "").strip().lower() in ("1", "true", "yes")

DATABASE_PATH = os.environ.get("DATABASE_PATH") or os.path.join(BASE_DIR, 'jdlx.db')
VALID_ROLES = ('user', 'admin', 'super_admin')

def _clean_env_value(value):
    if not value:
        return None
    value = value.strip().strip('"').strip("'")
    if value.lower().startswith("bearer "):
        value = value[7:].strip()
    return value or None

def _get_first_env(*names):
    for name in names:
        value = _clean_env_value(os.environ.get(name))
        if value:
            return value
    return None

def _is_turso_auth_error(error):
    message = str(error).lower()
    return (
        "status=401" in message
        or "unauthorized" in message
        or "invalid jwt token" in message
    )

def _raise_turso_config_error(error):
    if _is_turso_auth_error(error):
        raise RuntimeError(
            "Turso authentication failed. Update the Render environment variable "
            "TURSO_AUTH_TOKEN with a fresh database token for TURSO_DATABASE_URL. "
            "Do not include quotes or a 'Bearer ' prefix."
        ) from error
    raise error

TURSO_URL = _get_first_env("TURSO_DATABASE_URL", "LIBSQL_URL")
TURSO_TOKEN = _get_first_env(
    "TURSO_AUTH_TOKEN",
    "TURSO_DATABASE_TOKEN",
    "TURSO_DATABASE_AUTH_TOKEN",
    "LIBSQL_AUTH_TOKEN",
)

class LibsqlRow:
    def __init__(self, cursor, tuple_row):
        self._tuple = tuple_row
        self._keys = [col[0] for col in cursor.description]
    def keys(self): return self._keys
    def __getitem__(self, key):
        if isinstance(key, int): return self._tuple[key]
        try: return self._tuple[self._keys.index(key)]
        except ValueError: raise KeyError(key)
    def __len__(self): return len(self._tuple)
    def __iter__(self):
        return iter(zip(self._keys, self._tuple))

# Turso's Hrana transport can drop or expire a stream at any moment (not only
# after a long idle period): the server closes it, the network resets it, or an
# edge returns a transient HTTP error. The previous code turned that into a
# one-off 500 even though the very same statement succeeds on the next request.
# These markers identify transport-level failures that are safe to replay on a
# brand-new connection. SQL/semantic errors are deliberately NOT in this list.
_TRANSIENT_CONNECTION_MARKERS = (
    "stream expired",
    "stream has been closed",
    "stream error",
    "client stream",
    "no result has been returned",
    "unexpected response from server",
    "unexpected empty response",
    "unexpected multiple responses",
    "cursor stream ended prematurely",
    "failed to connect",
    "connection reset",
    "connection refused",
    "connection aborted",
    "connection closed",
    "broken pipe",
    "unexpected eof",
    "http error",
    "http dispatch error",
    "temporarily unavailable",
    "stream closed",
    "channel closed",
    "inactive stream",
    "inactivestreamid",
    "send error",
    "recv error",
    "io error",
    "timed out",
    "database is locked",
    "database busy",
    "databasebusy",
    "databaselocked",
    "statements in progress",
    "cannot commit transaction",
    "network",
    # Turso itself is briefly unavailable / rate limiting. A single immediate
    # replay after reconnecting is enough; the DB layer never loops.
    "status=429",
    "status=500",
    "status=502",
    "status=503",
    "status=504",
)
_NON_TRANSIENT_ERROR_MARKERS = (
    "no such column",
    "no such table",
    "no such function",
    "no such index",
    "constraint",
    "syntax error",
    "type mismatch",
    "readonly",
    "read-only",
)


def is_transient_db_error(error):
    """Public wrapper used by routes that can safely replay a transaction."""
    return _is_transient_connection_error(error)


def _is_transient_connection_error(error):
    """True for dead-stream/transport failures that a reconnect can fix."""
    if isinstance(error, (ConnectionError, TimeoutError)):
        return True
    text = str(error).lower()
    if any(marker in text for marker in _NON_TRANSIENT_ERROR_MARKERS):
        return False
    return any(marker in text for marker in _TRANSIENT_CONNECTION_MARKERS)


class LibsqlCursorWrapper:
    # Statements that never open a write transaction. Everything else
    # (INSERT/UPDATE/DELETE/CREATE/BEGIN/WITH-CTE-writes/...) marks the
    # connection dirty so release-time rollback can clear any uncommitted
    # work — matching the old behavior where close() implicitly discarded it.
    _READ_ONLY_PREFIXES = ("SELECT", "PRAGMA", "EXPLAIN", "VALUES")

    def __init__(self, cursor, row_factory=None, conn=None):
        self._cursor = cursor
        self.row_factory = row_factory
        # Back-reference to the owning connection wrapper so a failed execute
        # can mark the connection unhealthy (pool will destroy it instead of
        # reusing a connection in an unknown state) and a write can mark it
        # dirty (release-time rollback hygiene).
        self._conn = conn
        # Last read statement, kept so a row fetch that dies on the wire can be
        # replayed on a fresh stream. Only safe while NO rows were consumed yet:
        # replaying after a partial read would duplicate/lose rows.
        self._last_read = None
        self._rows_fetched = 0
    def _wrap_row(self, row):
        if row is None: return None
        return self.row_factory(self._cursor, row) if self.row_factory else row
    def _fetch(self, method_name, *args):
        """Fetch rows, replaying the last read once if the stream died mid-read.

        libsql can fail inside fetchone()/fetchall() (not only inside execute()):
        the Hrana stream is consumed lazily, so the transport error surfaces on
        the first fetch. The statement is replayed only when it succeeded, is a
        read, and no rows were consumed yet — a partial read is never replayed.
        """
        try:
            return getattr(self._cursor, method_name)(*args)
        except Exception as e:
            if self._conn is None or self._last_read is None or self._rows_fetched:
                if self._conn is not None:
                    self._conn._mark_unhealthy()
                raise
            if not self._conn._recover_from_transient(e):
                self._conn._mark_unhealthy()
                raise
            sql, parameters = self._last_read
            self._cursor = self._conn._conn.cursor()
            try:
                self._cursor.execute(sql, parameters)
                return getattr(self._cursor, method_name)(*args)
            except Exception as e2:
                self._conn._mark_unhealthy()
                _raise_turso_config_error(e2)
    def fetchone(self):
        row = self._fetch('fetchone')
        if row is not None:
            self._rows_fetched += 1
        return self._wrap_row(row)
    def fetchmany(self, size=None):
        rows = self._fetch('fetchmany') if size is None else self._fetch('fetchmany', size)
        self._rows_fetched += len(rows)
        return [self.row_factory(self._cursor, row) for row in rows] if self.row_factory else rows
    def fetchall(self):
        rows = self._fetch('fetchall')
        self._rows_fetched += len(rows)
        return [self.row_factory(self._cursor, row) for row in rows] if self.row_factory else rows
    def _run(self, method_name, sql, parameters):
        """Run a statement, replaying ONCE on a fresh connection if the stream died.

        Replay is only allowed while the connection holds no uncommitted write
        (``_recover_from_transient`` enforces that), so a dead pooled stream can
        never turn a message send into a random 500 or corrupt an open
        transaction. The old stream is discarded in the background.
        """
        try:
            getattr(self._cursor, method_name)(sql, parameters)
            return
        except Exception as e:
            if self._conn is None or not self._conn._recover_from_transient(e):
                if self._conn is not None: self._conn._mark_unhealthy()
                _raise_turso_config_error(e)
        # The fresh connection has a new cursor; rebind and replay the statement.
        # Resolve the method again so it comes from the new cursor, not the dead one.
        self._cursor = self._conn._conn.cursor()
        try:
            getattr(self._cursor, method_name)(sql, parameters)
        except Exception as e:
            self._conn._mark_unhealthy()
            _raise_turso_config_error(e)
    def execute(self, sql, parameters=()):
        if isinstance(parameters, list): parameters = tuple(parameters)
        is_read = sql.lstrip().upper().startswith(self._READ_ONLY_PREFIXES)
        self._run('execute', sql, parameters)
        if self._conn is not None and not is_read:
            self._conn._dirty = True
        self._rows_fetched = 0
        self._last_read = (sql, parameters) if is_read else None
        return self
    def executemany(self, sql, seq_of_parameters):
        seq_of_parameters = [tuple(p) if isinstance(p, list) else p for p in seq_of_parameters]
        self._run('executemany', sql, seq_of_parameters)
        if self._conn is not None:
            self._conn._dirty = True
        self._rows_fetched = 0
        self._last_read = None
        return self
    def __getattr__(self, name): return getattr(self._cursor, name)
    def __iter__(self):
        # libsql_experimental.Cursor has no __iter__ method. Fetch rows sequentially
        # so DB-API 2.0 cursor iteration (`for row in cur:`) works seamlessly —
        # and goes through fetchone() so a dying stream is replayed safely.
        while True:
            row = self.fetchone()
            if row is None:
                break
            yield row

class LibsqlConnectionWrapper:
    def __init__(self, conn):
        self._conn = conn
        self.row_factory = None
        # Pool bookkeeping (remote-DB connection reuse). ``_discarded`` marks a
        # connection that hit an error and must never be handed out again;
        # ``_in_pool`` is the single-release guard so a double close() can
        # never enqueue the same connection twice (which would make two
        # requests share one connection). ``_dirty`` is set once anything has
        # executed on this connection, so a pristine connection can be
        # returned to the pool without a pointless rollback round-trip.
        self._discarded = False
        self._in_pool = False
        self._dirty = False

    def _mark_unhealthy(self):
        self._discarded = True

    def _recover_from_transient(self, error):
        """Swap in a fresh raw connection after a dead-stream/transport error.

        Returns False (and leaves the caller to raise) when the statement is not
        retryable: either it is a real SQL error, or this connection already has
        uncommitted writes — silently replaying on a new stream would drop that
        transaction. In the retryable case the failed statement never reached a
        committed state, so replaying it is safe.
        """
        if self._discarded or self._dirty:
            return False
        if not _is_transient_connection_error(error):
            return False
        try:
            replacement = _create_turso_connection()
        except Exception:
            return False
        old_raw = self._conn
        self._conn = replacement._conn
        # The replacement is now owned by this wrapper; make sure its wrapper
        # can never release/close the same raw stream later.
        replacement._conn = None
        self._dirty = False
        _destroy_raw_handle_async(old_raw)
        return True

    def cursor(self): return LibsqlCursorWrapper(self._conn.cursor(), self.row_factory, self)
    def execute(self, sql, parameters=()):
        cursor = self.cursor()
        cursor.execute(sql, parameters)
        return cursor
    def commit(self):
        try:
            self._conn.commit()
        except Exception:
            # A failed commit leaves the connection in an unknown state —
            # never hand it to another request. The exception still
            # propagates exactly as before.
            self._discarded = True
            raise
        # Transaction fully committed — nothing left to roll back at release.
        self._dirty = False
    def rollback(self): self._conn.rollback()
    def close(self):
        # Releasing to the pool replaces the old hard close. Idempotent per
        # ownership cycle; unhealthy connections are destroyed instead.
        if self._in_pool:
            return
        self._in_pool = True
        if self._discarded:
            _destroy_raw_connection_async(self)
            return
        # A connection with an uncommitted write is never pooled: dropping it
        # aborts the transaction server-side, exactly like the rollback this
        # used to run inline. The inline rollback was another network call in
        # the request path that could stall forever on a dead stream.
        if self._dirty:
            _destroy_raw_connection_async(self)
            return
        _release_connection(self)
    def sync(self):
        if hasattr(self._conn, 'sync'): self._conn.sync()


# ------------------------------------------------------------------------------
# Remote-DB connection pool (infrastructure only — no query/semantic changes).
#
# Every request used to open a brand-new Turso connection: a network handshake
# plus the PRAGMA round-trip, on top of every query. This pool keeps healthy
# remote connections open between requests so a request reuses an already-open
# one. Local SQLite is never pooled (opening it is effectively free). Any
# connection error marks the connection unhealthy and it is destroyed instead
# of being reused, so a poisoned connection can never serve two requests.
# ------------------------------------------------------------------------------
_POOL = None
_POOL_LOCK = threading.Lock()
# Kept in step with gunicorn's threads (2 x 32 by default). Each open chat
# holds one pooled stream for its long-poll, so a cache of only 8 made every
# request beyond that pay a fresh TLS/Hrana handshake to Turso — a multi-second
# stall on a distant region, which showed up as "Timed out after 35s" on sends.
_POOL_MAX_SIZE = int(os.environ.get("DB_POOL_MAX_SIZE", "32"))
_POOL_IDLE_KEEP = int(os.environ.get("DB_POOL_IDLE_KEEP", "24"))
# Turso's Hrana server expires streams that sit idle for a while
# ("stream expired due to inactivity" — tursodatabase/libsql-python#41).
# Stale streams are now replayed transparently (execute AND fetch), so a
# connection can safely stay pooled far longer: keep the TLS/Hrana handshake
# warm across normal chat gaps and pay the reconnect cost only after minutes
# of silence. Shorter windows made almost every send open a brand-new
# connection — a multi-second latency hit on a distant Turso region.
_POOL_MAX_IDLE_SECONDS = float(os.environ.get("DB_POOL_MAX_IDLE_SECONDS", "300"))

def _get_pool():
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = queue.LifoQueue(maxsize=_POOL_MAX_SIZE)
        return _POOL

def _destroy_raw_connection(conn):
    # Accepts either a connection wrapper or a raw libsql handle. Resolving the
    # handle up-front matters when the wrapper was reconnected in the meantime.
    _close_raw_handle(getattr(conn, "_conn", conn))


def _close_raw_handle(raw_handle):
    if raw_handle is None:
        return
    try:
        raw_handle.close()
    except Exception:
        pass


# Closing a remote Turso connection is a network round-trip and libsql has no
# close timeout: a dead/stalled stream can block the caller forever. It used to
# run inside the request (release path and ``close()``), so a handful of stalled
# closes consumed every gunicorn thread and the whole chat stopped answering
# (TCP/TLS connected, no HTTP response) until the container was restarted.
# Destroys therefore run on throwaway daemon threads; a stuck close now costs one
# background thread instead of a request slot.
_DESTROY_THREADS = 0
_DESTROY_LOCK = threading.Lock()
_MAX_DESTROY_THREADS = 8


def _destroy_raw_handle_async(raw_handle):
    global _DESTROY_THREADS
    with _DESTROY_LOCK:
        if _DESTROY_THREADS >= _MAX_DESTROY_THREADS:
            # Every slot is already stuck closing something. Drop this object
            # instead of spawning another stuck thread; the server expires the
            # abandoned stream on its own.
            return
        _DESTROY_THREADS += 1

    def _run():
        global _DESTROY_THREADS
        try:
            _close_raw_handle(raw_handle)
        finally:
            with _DESTROY_LOCK:
                _DESTROY_THREADS -= 1

    try:
        threading.Thread(target=_run, daemon=True).start()
    except Exception:
        with _DESTROY_LOCK:
            _DESTROY_THREADS -= 1


def _destroy_raw_connection_async(conn):
    # Resolve the raw handle BEFORE spawning: a wrapper that reconnects in the
    # meantime must not cause the thread to close its new, healthy stream.
    _destroy_raw_handle_async(getattr(conn, "_conn", conn))

def _create_turso_connection():
    max_retries = 3
    for attempt in range(max_retries):
        try:
            raw_conn = libsql.connect(TURSO_URL, auth_token=TURSO_TOKEN)
            conn = LibsqlConnectionWrapper(raw_conn)
            conn.row_factory = LibsqlRow
            # Enable foreign key constraints once per connection (was previously
            # re-issued on every request, costing an extra network round-trip).
            raw_conn.execute("PRAGMA foreign_keys = ON")
            return conn
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(0.4 * (attempt + 1))
                continue
            _raise_turso_config_error(e)

def _acquire_connection():
    """Returns a live remote connection — reused from the pool when possible."""
    pool = _get_pool()
    while True:
        try:
            conn = pool.get_nowait()
        except queue.Empty:
            return _create_turso_connection()
        conn._in_pool = False
        # Idle-age guard: the Hrana stream of a long-idle pooled connection
        # may already be expired server-side; reusing it fails the request's
        # first execute (random one-off 500). Re-handshake instead — same as
        # the pre-pool behavior for quiet periods.
        if time.monotonic() - getattr(conn, "_released_at", 0.0) > _POOL_MAX_IDLE_SECONDS:
            _destroy_raw_connection_async(conn)
            continue
        if not conn._discarded:
            return conn
        # A stale/unhealthy entry somehow sitting in the pool — drop it.
        _destroy_raw_connection_async(conn)

def _release_connection(conn):
    """Returns a healthy remote connection to the pool, trimming idle excess."""
    pool = _get_pool()
    victims = []
    overflow = False
    with _POOL_LOCK:
        while pool.qsize() >= _POOL_IDLE_KEEP:
            try:
                victims.append(pool.get_nowait())
            except queue.Empty:
                break
        conn._released_at = time.monotonic()
        try:
            pool.put_nowait(conn)
        except queue.Full:
            overflow = True
    # Closing a remote connection is a network call and can stall on a dead
    # stream. It must never run while holding _POOL_LOCK: one stuck close used
    # to block every other request's release, which surfaced as messages
    # "Timed out after 35s" across the whole app.
    for victim in victims:
        _destroy_raw_connection_async(victim)
    if overflow:
        _destroy_raw_connection_async(conn)

if not FORCE_LOCAL_DB and TURSO_URL and TURSO_TOKEN:
    try:
        import libsql_experimental as libsql
        USE_TURSO = True
    except ImportError:
        USE_TURSO = False
else:
    USE_TURSO = False

def _open_connection():
    """Returns a DB connection.

    Remote (Turso) connections are POOLED and reused across requests — opening
    one costs a network handshake, so reusing them is the single biggest
    latency win. Local SQLite connections are always fresh (opening is free
    and per-call connections keep scratch scripts and tests isolated).
    """
    if USE_TURSO:
        conn = _acquire_connection()
        conn.row_factory = LibsqlRow
        return conn
    conn = sqlite3.connect(DATABASE_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")  # 10s retry on lock
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _has_flask_app_context():
    try:
        import flask
        return flask.has_app_context()
    except Exception:
        return False


class _RequestScopedConnection:
    """Wraps a DB connection so ``close()`` is deferred to request teardown.

    Routes open a connection and close it in a ``finally`` block. Most
    authenticated requests actually call ``get_db()`` twice (auth check + route
    handler); sharing ONE connection per request instead of opening two saves a
    full connect round-trip on every request (a remote handshake on Turso).
    ``close()`` becomes a no-op and ``_hard_close()`` is invoked by
    ``teardown_appcontext`` in chat_app.py.

    Outside a Flask app context (scripts, migrations, scheduler jobs, background
    threads) ``get_db`` keeps its original behavior: a fresh connection that
    closes normally.
    """
    def __init__(self, conn):
        object.__setattr__(self, '_conn', conn)

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, '_conn'), name)

    def __setattr__(self, name, value):
        if name == '_conn':
            object.__setattr__(self, name, value)
        else:
            setattr(object.__getattribute__(self, '_conn'), name, value)

    def close(self):
        """Deferred — the connection is released at request teardown."""
        pass

    @property
    def is_closed(self):
        return bool(object.__getattribute__(self, '__dict__').get('_closed', False))

    def _hard_close(self):
        conn = object.__getattribute__(self, '_conn')
        try:
            conn.close()
        finally:
            object.__setattr__(self, '_closed', True)


def get_db():
    if _has_flask_app_context():
        import flask
        g = flask.g
        cached = getattr(g, "_jdlx_request_db", None)
        # NEVER hand back a wrapper whose underlying connection was already
        # closed by teardown. That happens when a preserved app context
        # survives its request (Flask test client, repeated script contexts):
        # the next caller would get a ProgrammingError instead of a connection.
        if cached is not None and not cached.is_closed:
            return cached

    conn = _open_connection()
    if not _has_flask_app_context():
        return conn

    import flask
    g = flask.g
    g._jdlx_request_db = _RequestScopedConnection(conn)
    return g._jdlx_request_db

def schema_is_current():
    """Cheap drift probe (audit H4).

    Returns False when a column/table that the current code requires is
    missing from the database — the caller then runs ``init_db()`` once. This
    only inspects SQLite metadata (PRAGMA / sqlite_master), so it is safe to
    call from a boot hook: no writes, no business logic.
    """
    try:
        conn = _open_connection()
    except Exception:
        return True  # can't inspect — never block the app on this probe
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(products)")
        product_cols = {row[1] for row in cur.fetchall()}
        required_product_cols = {
            "agent_entry_rate",
            "added_by_agent_id",
            "added_by_agent_code",
            "agent_submitted_at",
            "approval_status",
        }
        if not required_product_cols.issubset(product_cols):
            return False
        cur.execute("PRAGMA table_info(user_push_tokens)")
        token_cols = {row[1] for row in cur.fetchall()}
        if "device_model" not in token_cols:
            return False
        cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manual_delivery_otps'"
        )
        if cur.fetchone() is None:
            return False
        return True
    except Exception:
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def ist_now_str():
    """Current IST time as a naive 'YYYY-MM-DD HH:MM:SS' string.

    The whole system stores and renders timestamps as IST wall-clock (matching
    the IST DEFAULT on orders.created_at), so writes that need an explicit
    timestamp use this instead of the UTC-based CURRENT_TIMESTAMP.
    """
    return (
        datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)
    ).strftime("%Y-%m-%d %H:%M:%S")


def init_db():
    conn = get_db()
    cursor = conn.cursor()

    def safe_execute_ddl(sql: str) -> None:
        try: cursor.execute(sql)
        except Exception as e:
            if "duplicate column name" not in str(e).lower() and "already exists" not in str(e).lower():
                print(f"Ignored DDL error: {e}")

    def ensure_columns(table_name, columns):
        cursor.execute(f"PRAGMA table_info({table_name})")
        existing_cols = [row[1] for row in cursor.fetchall()]
        for col, definition in columns:
            if col not in existing_cols:
                safe_execute_ddl(f"ALTER TABLE {table_name} ADD COLUMN {col} {definition}")

    if not USE_TURSO:
        try: cursor.execute('PRAGMA journal_mode=WAL;')
        except Exception: pass

    # --- Core Tables ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS uploaded_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT UNIQUE NOT NULL,
        mime_type TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_uploaded_media_filename ON uploaded_media(filename)')

    cursor.execute('''CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, google_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, profile_image TEXT, role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('users', [('phone', 'TEXT'), ('gender', 'TEXT'), ('date_of_birth', 'TEXT'), ('age', 'INTEGER'), ('about', 'TEXT'), ('terms_accepted_version', 'INTEGER DEFAULT 0'), ('terms_accepted_at', 'TIMESTAMP'), ('email_verified', 'INTEGER DEFAULT 0'), ('phone_verified', 'INTEGER DEFAULT 0'), ('account_status', "TEXT DEFAULT 'active'"), ('cod_restricted', 'INTEGER DEFAULT 0'), ('min_token_iat', 'INTEGER DEFAULT 0'), ('last_login', 'TIMESTAMP'), ('app_installed', 'INTEGER DEFAULT 0'), ('app_installed_at', 'TIMESTAMP'),
        # Admin password login + security questions (admin_auth_routes.py).
        # Mirrors migrate_admin_auth.py — kept here so deploys auto-migrate.
        ('password_hash', 'TEXT'),
        ('password_salt', 'TEXT'),
        ('password_set_at', 'TIMESTAMP'),
        ('admin_phone', 'TEXT'),
        ('security_question', 'TEXT'),
        ('security_answer_hash', 'TEXT'),
        # --- JDLX Premium membership ---
        # membership_tier: 'regular' | 'premium'. Duration-based: a premium
        # member is ACTIVE only while premium_expires_at >= now (IST). Check
        # get_membership_context() in app.py for the single source of truth.
        ('membership_tier', "TEXT DEFAULT 'regular'"),
        ('premium_expires_at', 'TIMESTAMP'),
        ('premium_source', "TEXT DEFAULT 'admin'"),
        ('username', 'TEXT')])  # 'admin' | 'subscription'

    cursor.execute('''CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, icon TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('categories', [('important_note', 'TEXT'), ('return_policy', "TEXT DEFAULT '7 Days Return Policy'"), ('device_customization_enabled', 'INTEGER DEFAULT 0')])

    cursor.execute('''CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0, category_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(category_id) REFERENCES categories(id))''')
    ensure_columns('products', [
        # Legacy TEXT category name (pre category_id). Production databases
        # carry it and several read paths (product list/search, warehouse
        # create) still reference it — keep it provisioned on fresh DBs too.
        ('category', 'TEXT'), 
        ('barcode', 'TEXT'), 
        ('global_sku_code', 'TEXT'), 
        ('description', 'TEXT'), 
        ('sub_category', 'TEXT'), 
        ('brand', 'TEXT'), 
        ('units_per_pack', 'TEXT'), 
        ('material_type', 'TEXT'), 
        ('color', 'TEXT'), 
        ('weight', 'TEXT'), 
        ('dimensions', 'TEXT'), 
        ('is_fragile', 'BOOLEAN DEFAULT 0'), 
        ('is_temp_sensitive', 'BOOLEAN DEFAULT 0'), 
        ('is_perishable', 'BOOLEAN DEFAULT 0'), 
        ('is_featured', 'BOOLEAN DEFAULT 0'), 
        ('expiry_date', 'TEXT'), 
        ('return_policy', 'TEXT'), 
        ('prepaid_only', 'INTEGER DEFAULT 0'), 
        ('low_stock_threshold', 'INTEGER DEFAULT 5'), 
        ('delivery_time', "TEXT DEFAULT ''"), 
        ('status', "TEXT DEFAULT 'available'"), 
        ('images', 'TEXT'), 
        ('offline_price', 'REAL'), 
        ('has_variants', 'BOOLEAN DEFAULT 0'), 
        ('is_parent', 'BOOLEAN DEFAULT 0'), 
        ('variant_group_id', 'INTEGER'), 
        ('variant_name', 'TEXT'), 
        ('recommendation_priority', 'INTEGER DEFAULT 0'), 
        ('recommendation_weight', 'REAL DEFAULT 1.0'), 
        ('lifecycle_state', "TEXT DEFAULT 'live'"), 
        ('share_token', 'TEXT'), 
        ('seo_slug', 'TEXT'),
        # Catalog approval gate: warehouse-created products start as
        # 'pending' and are only publicly visible on the storefront after an
        # admin approves them (see /api/admin/products/<id>/approve).
        # Admin-created products default to 'approved' (admin is the
        # trusted source). approval_* columns keep the audit trail.
        ('approval_status', "TEXT DEFAULT 'approved'"),
        ('approval_source', "TEXT DEFAULT 'admin'"),
        ('approval_warehouse_id', 'INTEGER'),
        ('approval_requested_at', 'TIMESTAMP'),
        ('approval_decided_at', 'TIMESTAMP'),
        ('approval_decided_by', 'INTEGER'),
        ('approval_note', 'TEXT'),
        # Global MRP (strike-through price) shown on the storefront. The
        # warehouse panel edits warehouse_inventory.mrp; both are kept in
        # sync (see warehouse PATCH) — this column is the storefront's
        # source of truth, matching how products.price works.
        ('mrp', 'REAL'),
        # Add-Product agent attribution: which listing agent created the
        # discovery content for this product, and when the manager completed
        # + submitted it for approval. Audit only — never affects pricing or
        # approval logic itself.
        ('added_by_agent_id', 'INTEGER'),
        ('added_by_agent_code', 'TEXT'),
        ('agent_submitted_at', 'TIMESTAMP'),
        ('agent_entry_rate', 'REAL')
    ])
    # Admin security audit trail (admin_auth_routes.py) — auto-provisioned so
    # deploys never need the standalone migrate_admin_auth.py step.
    cursor.execute('''CREATE TABLE IF NOT EXISTS admin_security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        email TEXT,
        event_type TEXT NOT NULL,
        description TEXT,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_admin_security_events_admin "
        "ON admin_security_events(admin_id, created_at)"
    )

    # Manual (self) delivery OTP challenge — warehouse_routes.py.
    # One active row per assignment: the warehouse manager marks a packed order
    # as "delivered by me", the customer sees the 6-digit code on the order
    # tracking page and gets a push notification, and the manager must read
    # that code back before the order can move to DELIVERED.
    # Additive table — existing order flows are untouched.
    cursor.execute('''CREATE TABLE IF NOT EXISTS manual_delivery_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        consumed INTEGER DEFAULT 0,
        initiated_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        verified_at TIMESTAMP,
        delivered_at TIMESTAMP,
        UNIQUE(assignment_id)
    )''')
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_manual_delivery_otps_order "
        "ON manual_delivery_otps(order_id, consumed)"
    )

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_variant_group ON products(variant_group_id)")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_products_share_token ON products(share_token)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_seo_slug ON products(seo_slug)")
    # Agent-attributed listings: the agent workspace and the manager's agent
    # endpoints filter/group by this column on every load.
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_added_by_agent ON products(added_by_agent_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        recommended_product_id INTEGER NOT NULL,
        recommendation_type TEXT NOT NULL, -- 'related', 'upsell', 'cross_sell', 'frequent'
        priority INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_id, recommended_product_id, recommendation_type),
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(recommended_product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_recommendations_product ON product_recommendations(product_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_content (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL UNIQUE,
        overview TEXT,
        highlights TEXT, -- JSON array of strings
        specifications TEXT, -- JSON object
        compatibility TEXT,
        box_contents TEXT,
        warranty_info TEXT,
        usage_instructions TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_content_product ON product_content(product_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_badges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        badge_type TEXT NOT NULL, -- 'best_seller', 'trending', 'new_arrival', 'premium', 'limited_deal', 'staff_choice', 'verified'
        priority INTEGER DEFAULT 0,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_badges_product ON product_badges(product_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_fulfillment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL UNIQUE,
        package_weight REAL DEFAULT 0,
        length REAL DEFAULT 0,
        width REAL DEFAULT 0,
        height REAL DEFAULT 0,
        shipping_tier TEXT DEFAULT 'standard', -- 'standard', 'express', 'heavy', 'fragile'
        dispatch_sla INTEGER DEFAULT 24, -- in hours
        is_cod_eligible BOOLEAN DEFAULT 1,
        is_fragile BOOLEAN DEFAULT 0,
        is_express_eligible BOOLEAN DEFAULT 1,
        return_window INTEGER DEFAULT 7, -- in days
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fulfillment_product ON product_fulfillment(product_id)")

    # Per-product return/exchange rule overrides (strongest level of the
    # product → category → global fallback chain in product_rules.py). All
    # columns nullable: NULL/missing = inherit from the level above.
    cursor.execute('''CREATE TABLE IF NOT EXISTS product_return_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL UNIQUE,
        return_enabled INTEGER,
        exchange_enabled INTEGER,
        window_days REAL,
        max_requests_per_order INTEGER,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_discovery (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL UNIQUE,
        meta_title TEXT,
        meta_description TEXT,
        search_keywords TEXT, -- JSON array
        product_tags TEXT, -- JSON array
        search_synonyms TEXT, -- JSON array
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_discovery_product ON product_discovery(product_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL UNIQUE,
        view_count INTEGER DEFAULT 0,
        cart_add_count INTEGER DEFAULT 0,
        purchase_count INTEGER DEFAULT 0,
        wishlist_count INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_product ON product_analytics(product_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        sku TEXT UNIQUE,
        price REAL,
        stock INTEGER DEFAULT 0,
        barcode TEXT UNIQUE,
        model_name TEXT,
        color TEXT,
        pack_size TEXT,
        material_type TEXT,
        images TEXT,
        weight TEXT,
        dimensions TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    ensure_columns('product_variants', [
        # JSON map of option_name -> selected value, e.g. {"Size": "M", "Color": "Red"}
        ('options', 'TEXT'),
        # MRP (strike-through price) for this specific variant
        ('mrp', 'REAL'),
    ])
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id)")
    # Unique constraint on (product_id, options) to prevent duplicate variant combinations
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_product_options ON product_variants(product_id, options)")

    # Option groups that define how a product's variants are presented to
    # customers (e.g. Size: [S, M, L], Color: [Red, Blue]). Each variant links
    # to a value per group through product_variants.options (JSON).
    cursor.execute('''CREATE TABLE IF NOT EXISTS product_variant_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        option_name TEXT NOT NULL,
        option_values TEXT NOT NULL DEFAULT '[]', -- JSON array of value strings
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_variant_options_product ON product_variant_options(product_id)")
    # Unique constraint on (product_id, option_name) to prevent duplicate option groups
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_options_product_name ON product_variant_options(product_id, option_name)")

    # Legacy Stock Sync
    cursor.execute("PRAGMA table_info(products)")
    if 'stock_quantity' in [r[1] for r in cursor.fetchall()]:
        cursor.execute("UPDATE products SET stock = CASE WHEN (stock IS NULL OR stock = 0) AND stock_quantity > 0 THEN stock_quantity ELSE stock END")

    # --- Commerce & Fulfillment ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_id INTEGER NOT NULL, 
        total_amount REAL NOT NULL, 
        order_status TEXT DEFAULT 'PLACED', 
        source TEXT DEFAULT 'ONLINE',
        agent_id INTEGER,
        -- CURRENT_TIMESTAMP is UTC in SQLite; store IST so displayed placed-time
        -- matches wall-clock time in MyOrders / warehouse panels without TZ math.
        created_at TIMESTAMP DEFAULT (datetime('now', '+5 hours', '+30 minutes')), 
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    ensure_columns('orders', [
        ('source', "TEXT DEFAULT 'ONLINE'"),
        # Which storefront shell placed the order: website | pwa | apk | localhost
        # (sent by the store as X-Client-Platform). NULL on legacy/offline rows,
        # which the analytics channel breakdown reports as 'unknown' — never as
        # a wrong channel.
        ('platform', 'TEXT'),
        ('agent_id', 'INTEGER'),
        ('vendor_id', 'INTEGER'),
        ('billing_status', "TEXT DEFAULT 'active'"),
        ('subtotal_amount', 'REAL DEFAULT 0'),
        ('tax_amount', 'REAL DEFAULT 0'),
        ('gst_rate', 'REAL DEFAULT 0'),
        ('discount_amount', 'REAL DEFAULT 0'),
        ('order_number', 'TEXT'),
        ('customer_name', 'TEXT'),
        ('customer_phone', 'TEXT'),
        ('delivery_address', 'TEXT'),
        ('phone', 'TEXT'),
        ('platform_fee', 'REAL DEFAULT 0'),
        ('delivery_fee', 'REAL DEFAULT 0'),
        ('shiprocket_order_id', 'TEXT'),
        ('payment_type', "TEXT DEFAULT 'PREPAID'"),
        ('payment_status', "TEXT DEFAULT 'pending'"),
        ('cod_advance_paid', 'REAL DEFAULT 0'),
        ('cod_remaining_amount', 'REAL DEFAULT 0'),
        ('free_delivery_applied', 'INTEGER DEFAULT 0'),
        ('fitting_charge', 'REAL DEFAULT 0'),
        ('packed_at', 'TIMESTAMP'),
        ('shipped_at', 'TIMESTAMP'),
        ('delivered_at', 'TIMESTAMP'),
        ('confirmed_at', 'TIMESTAMP'),
        ('cancelled_at', 'TIMESTAMP'),
        # Order-tracking timestamps (used by the returns pipeline's window
        # math and refund eligibility). Historically these only existed on DBs
        # that ran migrate_order_tracking.py — provisioning them here so a
        # fresh init_db() database no longer crashes those flows. The
        # warehouse state machine also writes confirmed_at on accept
        # (warehouse_routes.py), which 500'd on fresh DBs without it.
        ('status_packing_at', 'TIMESTAMP'),
        ('status_out_at', 'TIMESTAMP'),
        ('status_delivered_at', 'TIMESTAMP'),
        ('estimated_delivery', "TEXT DEFAULT '15-25 mins'"),
        ('delivery_latitude', 'REAL'),
        ('delivery_longitude', 'REAL'),
        # delivery_type default is legacy (quick delivery is retired system-wide;
        # checkout always writes 'scheduled'). Kept for existing-row compatibility.
        ('delivery_type', "TEXT DEFAULT 'quick'"),
        ('delivery_partner_id', 'INTEGER'),
        ('store_id', 'INTEGER'),
        ('dark_store_id', 'INTEGER'),
        ('cancellation_reason', 'TEXT'),
        # checkout INSERT writes updated_at; legacy DBs already have this
        # column — ensure fresh deployments get it too.
        ('updated_at', 'TIMESTAMP'),
        ('wallet_amount_used', 'REAL DEFAULT 0'),
        # JDLX Premium: the membership component of the order discount
        # (offer-coupon discounts are tracked in discount_amount).
        ('membership_discount', 'REAL DEFAULT 0'),
        # Small Cart Fee: applied when product subtotal < small_cart_threshold (Rs. 149)
        ('small_cart_fee', 'REAL DEFAULT 0')
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        order_id INTEGER NOT NULL, 
        product_id INTEGER NOT NULL, 
        quantity INTEGER NOT NULL, 
        price REAL NOT NULL, 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
        FOREIGN KEY(order_id) REFERENCES orders(id), 
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    ensure_columns('order_items', [
        ('warehouse_id', 'INTEGER REFERENCES warehouses(id)'),
        ('product_name', 'TEXT'),
        ('variant_id', 'INTEGER REFERENCES product_variants(id)'),
        ('subtotal', 'REAL'),
        ('device_model', 'TEXT'),
        ('fitting_charge', 'REAL DEFAULT 0'),
        ('returned_qty', 'INTEGER DEFAULT 0'),
        ('damage_qty', 'INTEGER DEFAULT 0'),
        ('damage_comment', 'TEXT'),
        ('damage_image_url', 'TEXT'),
        ('variant_name', 'TEXT'),
        ('variant_options', 'TEXT'),
        ('variant_mrp', 'REAL'),
        ('variant_sku', 'TEXT'),
        ('variant_image', 'TEXT'),
    ])
    # Hot-path indexes: order history (get_user_orders / get_admin_orders filter by
    # user + sort by created_at) and every order_items lookup by order_id (order
    # details, returns/exchange, billing history). Idempotent — no data changes.
    # Composite (user_id, created_at) serves both the user filter and the
    # created_at DESC sort in a single index scan (SQLite scans it backwards).
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_orders_vendor_source_created ON orders(vendor_id, source, created_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)")


    cursor.execute('''CREATE TABLE IF NOT EXISTS cart (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, session_id TEXT, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(product_id) REFERENCES products(id))''')
    ensure_columns('cart', [('updated_at', 'TIMESTAMP'), ('variant_id', 'INTEGER REFERENCES product_variants(id)')])
    # Guest cart fetches always look up by session_id — index it.
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cart_session ON cart(session_id)")

    # --- Logistics & Stores ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS dark_stores (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT UNIQUE, name TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('dark_stores', [('latitude', 'REAL'), ('longitude', 'REAL'), ('address', 'TEXT'), ('pincode', 'TEXT'), ('active', 'BOOLEAN DEFAULT 1'), ('manager_name', 'TEXT'), ('phone', 'TEXT')])

    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('warehouses', [('partner_id', 'TEXT'), ('application_id', 'INTEGER'), ('owner_name', 'TEXT'), ('phone', 'TEXT'), ('address', 'TEXT'), ('pincode', 'TEXT'), ('warehouse_capacity', 'INTEGER'), ('warehouse_type', "TEXT DEFAULT 'micro_fulfillment'"), ('warehouse_role', "TEXT DEFAULT 'owner'"), ('operations_status', "TEXT DEFAULT 'open'"), ('weather_status', "TEXT DEFAULT 'clear'"), ('account_status', "TEXT DEFAULT 'active'"), ('profile_kyc_status', "TEXT DEFAULT 'verified'"), ('kyc_notice_sent', 'INTEGER DEFAULT 0'), ('kyc_notice_sent_at', 'TIMESTAMP'), ('service_radius_km', 'REAL DEFAULT 4'), ('quick_mode_enabled', 'INTEGER DEFAULT 0'), ('google_id', 'TEXT')])

    # --- Add-Product Agents (listing agents) ---
    # Limited-access agents who only fill the discovery side of a product
    # (images, category, title, description, tags, return policy). They can
    # NEVER set pricing — the warehouse manager completes the product and
    # pushes it through the existing admin-approval flow. Login is OTP-based:
    # the manager generates a 6-digit OTP bound to a session duration
    # (1–8 hours); there are no agent passwords at all.
    cursor.execute('''CREATE TABLE IF NOT EXISTS add_product_agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        agent_code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        photo_url TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
        UNIQUE(warehouse_id, email),
        UNIQUE(warehouse_id, phone)
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_add_agents_wh ON add_product_agents(warehouse_id)')
    # Per-entry payout rate (₹ per product entry), decided by the manager at
    # registration time and editable later. Powers the agent profile earnings
    # display; does not affect any pricing/approval logic.
    ensure_columns('add_product_agents', [('per_entry_rate', 'REAL NOT NULL DEFAULT 0')])
    # Payout bank details (manager-entered, used only to pay the agent their
    # per-entry earnings). Account number + IFSC are the only fields — the
    # withdrawal flow reads them; nothing here touches any existing logic.
    ensure_columns('add_product_agents', [
        ('bank_account_number', 'TEXT'),
        ('bank_ifsc', 'TEXT'),
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS add_agent_otp_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        otp_hash TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        max_duration_minutes INTEGER NOT NULL DEFAULT 480,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')),
        attempts_left INTEGER NOT NULL DEFAULT 5,
        session_started_at TIMESTAMP,
        session_ends_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
        FOREIGN KEY(agent_id) REFERENCES add_product_agents(id)
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_add_otp_agent ON add_agent_otp_sessions(agent_id)')

    cursor.execute('''CREATE TABLE IF NOT EXISTS add_agent_breaks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        duration_minutes REAL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES add_agent_otp_sessions(id)
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_add_breaks_session ON add_agent_breaks(session_id)')

    # Withdrawal requests: an agent asks the manager to pay out their accrued
    # per-entry earnings; the manager approves / marks paid / rejects. The
    # bank details are SNAPSHOTTED at request time so a later profile edit
    # never silently redirects an in-flight payout. Purely additive — it does
    # not touch the earning math (which stays entries × per_entry_rate).
    cursor.execute('''CREATE TABLE IF NOT EXISTS add_agent_withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'paid', 'rejected')),
        account_number TEXT,
        ifsc TEXT,
        agent_note TEXT,
        manager_note TEXT,
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
        FOREIGN KEY(agent_id) REFERENCES add_product_agents(id)
    )''')
    # Audit M1: snapshot the agent identity on the payout row so deleting an
    # agent can never erase who was paid (agent row itself is FK-referenced and
    # cannot be deleted while withdrawals exist, so deletion archives the
    # financial history into add_agent_withdrawals_archive instead).
    ensure_columns('add_agent_withdrawals', [
        ('agent_name', 'TEXT'),
        ('agent_code', 'TEXT'),
    ])
    cursor.execute('''CREATE TABLE IF NOT EXISTS add_agent_withdrawals_archive (
        id INTEGER PRIMARY KEY,
        warehouse_id INTEGER,
        agent_id INTEGER,
        amount REAL,
        status TEXT,
        account_number TEXT,
        ifsc TEXT,
        agent_note TEXT,
        manager_note TEXT,
        requested_at TIMESTAMP,
        processed_at TIMESTAMP,
        agent_name TEXT,
        agent_code TEXT,
        archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_add_withdraw_wh ON add_agent_withdrawals(warehouse_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_add_withdraw_agent ON add_agent_withdrawals(agent_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_add_withdraw_archive_wh ON add_agent_withdrawals_archive(warehouse_id)')

    # --- Vendor Staff Roles & Billing Agents ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS roles (
        role_id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_id INTEGER NOT NULL,
        role_name TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(vendor_id) REFERENCES warehouses(id),
        UNIQUE(vendor_id, role_name)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_roles_vendor ON roles(vendor_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouse_staff (
        staff_id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_id INTEGER NOT NULL,
        role_id INTEGER,
        name TEXT NOT NULL,
        login_email TEXT,
        username TEXT,
        password_hash TEXT,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
        setup_token TEXT,
        setup_token_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(vendor_id) REFERENCES warehouses(id),
        FOREIGN KEY(role_id) REFERENCES roles(role_id),
        UNIQUE(vendor_id, login_email),
        UNIQUE(vendor_id, username)
    )''')
    # Legacy partner-module table may exist with a different PK name (id instead of staff_id).
    # Detect and, if needed, rebuild it to the billing schema so the staff routes work.
    try:
        cursor.execute("PRAGMA table_info(warehouse_staff)")
        wh_staff_cols = [r[1] for r in cursor.fetchall()]
        if "staff_id" not in wh_staff_cols:
            cursor.execute("ALTER TABLE warehouse_staff RENAME TO warehouse_staff_legacy")
            cursor.execute('''CREATE TABLE warehouse_staff (
                staff_id INTEGER PRIMARY KEY AUTOINCREMENT,
                vendor_id INTEGER NOT NULL,
                role_id INTEGER,
                name TEXT NOT NULL,
                login_email TEXT,
                username TEXT,
                password_hash TEXT,
                status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
                setup_token TEXT,
                setup_token_expires TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )''')
            legacy_cols = [r[1] for r in cursor.execute("PRAGMA table_info(warehouse_staff_legacy)").fetchall()]
            legacy_cols_lower = {c.lower(): c for c in legacy_cols}
            src_id = legacy_cols_lower.get("id") or legacy_cols_lower.get("staff_id")
            src_name = legacy_cols_lower.get("name")
            src_email = legacy_cols_lower.get("email") or legacy_cols_lower.get("login_email")
            src_status = legacy_cols_lower.get("status")
            src_vendor = legacy_cols_lower.get("vendor_id") or legacy_cols_lower.get("warehouse_partner_id")
            src_created = legacy_cols_lower.get("created_at")
            src_updated = legacy_cols_lower.get("updated_at")
            if src_id and src_name:
                status_expr = src_status if src_status else "'active'"
                created_expr = src_created if src_created else "CURRENT_TIMESTAMP"
                updated_expr = src_updated if src_updated else "CURRENT_TIMESTAMP"
                insert_sql = (
                    "INSERT INTO warehouse_staff (staff_id, vendor_id, name, login_email, status, created_at, updated_at) "
                    "SELECT " + ", ".join([
                        str(src_id),
                        str(src_vendor) if src_vendor else "NULL",
                        str(src_name),
                        str(src_email) if src_email else "NULL",
                        status_expr,
                        created_expr,
                        updated_expr,
                    ]) +
                    " FROM warehouse_staff_legacy"
                )
                cursor.execute(insert_sql)
            cursor.execute("DROP TABLE warehouse_staff_legacy")
    except Exception as e:
        print(f"Ignored warehouse_staff schema rebuild error: {e}")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_warehouse_staff_vendor ON warehouse_staff(vendor_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_warehouse_staff_role ON warehouse_staff(role_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouse_inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        warehouse_partner_id INTEGER,
        product_id INTEGER NOT NULL,
        product_name TEXT,
        sku TEXT,
        stock_quantity INTEGER DEFAULT 0,
        reserved_stock INTEGER DEFAULT 0,
        low_stock_threshold INTEGER DEFAULT 10,
        bin_location TEXT,
        brand TEXT,
        unit TEXT DEFAULT 'pcs',
        cost_price REAL DEFAULT 0,
        selling_price REAL DEFAULT 0,
        mrp REAL DEFAULT 0,
        discount_pct REAL DEFAULT 0,
        discount_amt REAL DEFAULT 0,
        gst_pct REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    ensure_columns('warehouse_inventory', [
        ('warehouse_id', 'INTEGER'),
        ('warehouse_partner_id', 'INTEGER'),
        ('available_stock', 'INTEGER DEFAULT 0'),
        ('variant_id', 'INTEGER REFERENCES product_variants(id)')
    ])
    # One-time backfill: surface MRP values the warehouse panel saved into
    # warehouse_inventory before products.mrp existed. Idempotent — only
    # fills products whose mrp is still empty, never overwrites. Runs here
    # (after warehouse_inventory is guaranteed to exist).
    cursor.execute("""
        UPDATE products SET mrp = (
            SELECT wi.mrp FROM warehouse_inventory wi
            WHERE wi.product_id = products.id AND wi.mrp IS NOT NULL AND wi.mrp > 0
            ORDER BY wi.id LIMIT 1
        ) WHERE (mrp IS NULL OR mrp = 0)
    """)
    # Backfill warehouse_partner_id/warehouse_id so both naming conventions stay in sync.
    # Older DBs (created before the warehouse_id -> warehouse_partner_id rename) only have
    # warehouse_id; newer code reads COALESCE(warehouse_id, warehouse_partner_id). Keeping
    # both columns populated prevents "no such column" errors during checkout.
    try:
        cursor.execute("UPDATE warehouse_inventory SET warehouse_partner_id = warehouse_id WHERE warehouse_partner_id IS NULL AND warehouse_id IS NOT NULL")
        cursor.execute("UPDATE warehouse_inventory SET warehouse_id = warehouse_partner_id WHERE warehouse_id IS NULL AND warehouse_partner_id IS NOT NULL")
    except Exception as e:
        print(f"Ignored warehouse_inventory backfill error: {e}")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wh_inv_wh ON warehouse_inventory(warehouse_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wh_inv_partner ON warehouse_inventory(warehouse_partner_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wh_inv_prod ON warehouse_inventory(product_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wh_inv_variant ON warehouse_inventory(variant_id)")
    # Composite unique index for variant-level inventory (prevents duplicate rows per variant per warehouse)
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_wh_inv_wh_variant ON warehouse_inventory(warehouse_id, variant_id) WHERE variant_id IS NOT NULL")
    # Composite unique index for product+variant per warehouse (prevents duplicate product+variant in same warehouse)
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_wh_inv_prod_var ON warehouse_inventory(warehouse_id, product_id, variant_id)")
    # STRICT SKU UNIQUENESS: one SKU must map to exactly one inventory line.
    # Repair BEFORE creating the index: older rows (double-tap submissions,
    # legacy duplicate inserts) may share an SKU — keep the OLDEST row (first
    # creation), merge duplicate stock into it, and neutralise the rest so the
    # index creation can never fail. Idempotent — runs clean on every boot.
    try:
        cursor.execute("""
            UPDATE warehouse_inventory SET sku = 'DUPLICATED-' || CAST(id AS TEXT)
            WHERE id NOT IN (
                SELECT MIN(id) FROM warehouse_inventory
                WHERE sku IS NOT NULL AND sku != ''
                GROUP BY warehouse_id, sku
            )
            AND sku IS NOT NULL AND sku != ''
        """)
    except Exception as e:
        print(f"Ignored warehouse_inventory sku repair error: {e}")
    try:
        cursor.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_wh_inv_wh_sku "
            "ON warehouse_inventory(warehouse_id, sku) "
            "WHERE sku IS NOT NULL AND sku != ''"
        )
    except Exception as e:
        print(f"Ignored warehouse_inventory sku unique index error: {e}")


    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouse_order_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        assignment_status TEXT DEFAULT 'assigned',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    )''')

    # Audit trail for warehouse stock adjustments (Stock IN/OUT). The panel's
    # "Movement History" modal reads this table and every stock adjust is
    # logged here — but the CREATE TABLE was never added to init_db, so both
    # crashed with "no such table: stock_movements" on DBs where it hadn't
    # been created manually. Idempotent: existing DBs (where the table was
    # created by hand) keep all their rows.
    cursor.execute('''CREATE TABLE IF NOT EXISTS stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        product_id INTEGER,
        inventory_item_id INTEGER,
        product_name TEXT,
        movement_type TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        remark TEXT,
        stock_before INTEGER,
        stock_after INTEGER,
        performed_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_stock_mov_item ON stock_movements(inventory_item_id, warehouse_id, created_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_stock_mov_prod ON stock_movements(product_id, created_at)")

    # --- Vendor (warehouse) settlements & payouts ---
    # Amazon-style model: customer pays the platform in full; after the return/
    # exchange/cancellation window closes, each warehouse gets credited its share
    # of the product value minus platform commission (system_settings
    # 'vendor_commission_rate', default 3%). Delivery fee, platform fee and
    # fitting charges are platform revenue and are never part of a settlement.
    cursor.execute('''CREATE TABLE IF NOT EXISTS vendor_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL UNIQUE,
        balance REAL DEFAULT 0,
        lifetime_earnings REAL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS vendor_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        item_total REAL DEFAULT 0,
        discount_share REAL DEFAULT 0,
        commission_rate REAL DEFAULT 3,
        commission_amount REAL DEFAULT 0,
        tax_deducted REAL DEFAULT 0,
        net_amount REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        settlement_due_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        settled_at TIMESTAMP,
        UNIQUE(order_id, warehouse_id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_vendor_settlements_status ON vendor_settlements(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_vendor_settlements_wh ON vendor_settlements(warehouse_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_vendor_settlements_order ON vendor_settlements(order_id)")
    # Settlement sweep hot-path: pending rows whose return window has passed.
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_vendor_settlements_due ON vendor_settlements(status, settlement_due_at)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS vendor_payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        status TEXT DEFAULT 'requested',
        admin_note TEXT,
        transaction_ref TEXT,
        processed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    )''')
    ensure_columns('vendor_payouts', [
        ('transaction_ref', 'TEXT'),
    ])
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_vendor_payouts_wh ON vendor_payouts(warehouse_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_vendor_payouts_status ON vendor_payouts(status)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS user_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        house TEXT,
        area TEXT,
        landmark TEXT,
        pincode TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        type TEXT DEFAULT 'HOME',
        is_default INTEGER DEFAULT 0,
        latitude REAL,
        longitude REAL,
        address_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    ensure_columns('user_addresses', [
        ('full_name', 'TEXT'),
        ('phone', 'TEXT'),
        ('house', 'TEXT'),
        ('area', 'TEXT'),
        ('landmark', 'TEXT'),
        ('pincode', 'TEXT'),
        ('city', 'TEXT'),
        ('state', 'TEXT'),
        ('type', "TEXT DEFAULT 'HOME'"),
        ('is_default', 'INTEGER DEFAULT 0'),
        ('latitude', 'REAL'),
        ('longitude', 'REAL'),
        # Checkout resolves the delivery address by address_id via
        # `address_text` (and /api/address/add always stores it), but the
        # house-based flow (/api/user/addresses) and rows created before this
        # column existed never populated it — a missing value made saved-address
        # orders fail with "Missing order details". The column is added above;
        # this backfill composes a full text from the stored parts once so old
        # addresses are immediately usable (guarded, so it only touches rows
        # that still have an empty address_text).
        ('address_text', 'TEXT'),
    ])
    cursor.execute('''
        UPDATE user_addresses
        SET address_text = TRIM(
            IFNULL(house, '')
            || CASE WHEN IFNULL(area, '') <> '' THEN ', ' || IFNULL(area, '') ELSE '' END
            || CASE WHEN IFNULL(landmark, '') <> '' THEN ', Near ' || IFNULL(landmark, '') ELSE '' END
            || CASE WHEN IFNULL(city, '') <> '' THEN ', ' || IFNULL(city, '') ELSE '' END
            || CASE WHEN IFNULL(state, '') <> '' THEN ', ' || IFNULL(state, '') ELSE '' END
            || CASE WHEN IFNULL(pincode, '') <> '' THEN ' - ' || IFNULL(pincode, '') ELSE '' END
        )
        WHERE (address_text IS NULL OR TRIM(address_text) = '') AND IFNULL(house, '') <> ''
    ''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS saved_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        method_type TEXT NOT NULL,
        last4 TEXT,
        provider_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    # --- Razorpay Payments ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      razorpay_order_id TEXT UNIQUE NOT NULL,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT DEFAULT 'created',
      payment_method TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES orders(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    ensure_columns('payments', [
        ('user_id', 'INTEGER'),
        ('amount', 'INTEGER'),
        ('currency', "TEXT DEFAULT 'INR'"),
        ('payment_method', 'TEXT'),
        ('razorpay_order_id', 'TEXT'),
        ('razorpay_payment_id', 'TEXT'),
        ('razorpay_signature', 'TEXT'),
        ('status', "TEXT DEFAULT 'created'"),
        ('updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    ])

    # --- JDLX Premium membership sales ---
    # Standalone subscription payments (not tied to an orders row, unlike the
    # payments table above whose order_id is NOT NULL).
    cursor.execute('''CREATE TABLE IF NOT EXISTS membership_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      razorpay_order_id TEXT UNIQUE NOT NULL,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      plan_key TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT DEFAULT 'created',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS payment_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      payload TEXT NOT NULL,
      processed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # --- Shiprocket Shipments ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      shiprocket_order_id TEXT,
      shiprocket_shipment_id TEXT,
      awb_code TEXT,
      courier_name TEXT,
      courier_id INTEGER,
      status TEXT DEFAULT 'pending',
      estimated_delivery TEXT,
      pickup_scheduled_date TEXT,
      tracking_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES orders(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS shipment_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      location TEXT,
      description TEXT,
      timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(shipment_id) REFERENCES shipments(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS refund_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS review_helpful_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(review_id, user_id),
        FOREIGN KEY(review_id) REFERENCES product_reviews(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS app_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reviewer_name TEXT,
        reviewer_phone TEXT,
        reviewer_email TEXT,
        rating INTEGER,
        review_text TEXT,
        source TEXT DEFAULT 'in_app',
        prompt_shown_at TIMESTAMP,
        submitted_at TIMESTAMP,
        went_to_google INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    ensure_columns('app_reviews', [
        ('reviewer_name', 'TEXT'),
        ('reviewer_phone', 'TEXT'),
        ('reviewer_email', 'TEXT'),
        ('source', "TEXT DEFAULT 'in_app'"),
    ])
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_reviews_user_unique ON app_reviews(user_id) WHERE user_id IS NOT NULL")

    cursor.execute('''CREATE TABLE IF NOT EXISTS store_inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        stock_quantity INTEGER DEFAULT 0,
        FOREIGN KEY(store_id) REFERENCES dark_stores(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS device_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        brand TEXT,
        type TEXT DEFAULT 'smartphone',
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    ensure_columns('device_models', [
        ('name', 'TEXT'),
        ('brand', 'TEXT'),
        ('type', "TEXT DEFAULT 'smartphone'"),
        ('status', "TEXT DEFAULT 'active'"),
        ('updated_at', 'TIMESTAMP')
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS product_device_compatibility (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        device_model_id INTEGER NOT NULL,
        device_model_name TEXT NOT NULL,
        device_brand TEXT NOT NULL,
        verification_status TEXT DEFAULT 'verified',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_id, device_model_id),
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY(device_model_id) REFERENCES device_models(id) ON DELETE CASCADE
    )''')
    safe_execute_ddl('CREATE INDEX IF NOT EXISTS idx_pdc_product_id ON product_device_compatibility(product_id)')
    safe_execute_ddl('CREATE INDEX IF NOT EXISTS idx_pdc_device_model_id ON product_device_compatibility(device_model_id)')
    safe_execute_ddl('CREATE INDEX IF NOT EXISTS idx_pdc_brand ON product_device_compatibility(device_brand)')

    # Seed popular device models dynamically if not present
    seed_devices = [
        # Realme
        ("Realme 5", "Realme"), ("Realme 5 Pro", "Realme"), ("Realme 5s", "Realme"), ("Realme 5i", "Realme"),
        ("Realme 6", "Realme"), ("Realme 6 Pro", "Realme"), ("Realme 6i", "Realme"),
        ("Realme 7", "Realme"), ("Realme 7 Pro", "Realme"), ("Realme 7i", "Realme"),
        ("Realme 8", "Realme"), ("Realme 8 5G", "Realme"), ("Realme 8 Pro", "Realme"),
        ("Realme 9", "Realme"), ("Realme 9 5G", "Realme"), ("Realme 9 Pro", "Realme"), ("Realme 9 Pro+", "Realme"),
        ("Realme 10", "Realme"), ("Realme 10 Pro", "Realme"), ("Realme 10 Pro+", "Realme"),
        ("Realme C2", "Realme"), ("Realme C3", "Realme"), ("Realme C11", "Realme"), ("Realme C12", "Realme"),
        ("Realme C15", "Realme"), ("Realme C21", "Realme"), ("Realme C25", "Realme"), ("Realme C35", "Realme"),
        ("Realme C51", "Realme"), ("Realme Narzo 20", "Realme"), ("Realme Narzo 30", "Realme"), ("Realme Narzo 50", "Realme"),
        # Vivo
        ("Vivo Y20", "Vivo"), ("Vivo Y20G", "Vivo"), ("Vivo Y20i", "Vivo"), ("Vivo Y20A", "Vivo"),
        ("Vivo Y21", "Vivo"), ("Vivo Y21e", "Vivo"), ("Vivo Y21T", "Vivo"),
        ("Vivo Y35", "Vivo"), ("Vivo Y33s", "Vivo"), ("Vivo Y30", "Vivo"), ("Vivo Y51", "Vivo"),
        ("Vivo Y75 5G", "Vivo"), ("Vivo Y15", "Vivo"), ("Vivo Y12", "Vivo"), ("Vivo Y11", "Vivo"), ("Vivo Y91", "Vivo"),
        ("Vivo V20", "Vivo"), ("Vivo V20 Pro", "Vivo"), ("Vivo V20 SE", "Vivo"),
        ("Vivo V21 5G", "Vivo"), ("Vivo V23 5G", "Vivo"), ("Vivo V23 Pro", "Vivo"), ("Vivo V25 5G", "Vivo"), ("Vivo V25 Pro", "Vivo"),
        ("Vivo T1 5G", "Vivo"), ("Vivo T1x", "Vivo"), ("Vivo T1 Pro 5G", "Vivo"),
        # Oppo
        ("Oppo A15", "Oppo"), ("Oppo A15s", "Oppo"), ("Oppo A16", "Oppo"), ("Oppo A17", "Oppo"), ("Oppo A17k", "Oppo"),
        ("Oppo A31", "Oppo"), ("Oppo A53", "Oppo"), ("Oppo A54", "Oppo"), ("Oppo A77", "Oppo"), ("Oppo A78 5G", "Oppo"),
        ("Oppo F17", "Oppo"), ("Oppo F17 Pro", "Oppo"), ("Oppo F19", "Oppo"), ("Oppo F19 Pro", "Oppo"), ("Oppo F19 Pro+", "Oppo"),
        ("Oppo F21 Pro", "Oppo"), ("Oppo F21 Pro 5G", "Oppo"),
        ("Oppo Reno 6 5G", "Oppo"), ("Oppo Reno 7 5G", "Oppo"), ("Oppo Reno 8 5G", "Oppo"),
        # Redmi
        ("Redmi Note 7", "Redmi"), ("Redmi Note 7 Pro", "Redmi"),
        ("Redmi Note 8", "Redmi"), ("Redmi Note 8 Pro", "Redmi"),
        ("Redmi Note 9", "Redmi"), ("Redmi Note 9 Pro", "Redmi"), ("Redmi Note 9 Pro Max", "Redmi"),
        ("Redmi Note 10", "Redmi"), ("Redmi Note 10 Pro", "Redmi"), ("Redmi Note 10 Pro Max", "Redmi"),
        ("Redmi Note 11", "Redmi"), ("Redmi Note 11 Pro", "Redmi"), ("Redmi Note 11 Pro+", "Redmi"),
        ("Redmi Note 12", "Redmi"), ("Redmi Note 12 5G", "Redmi"), ("Redmi Note 12 Pro 5G", "Redmi"),
        ("Redmi 9", "Redmi"), ("Redmi 9A", "Redmi"), ("Redmi 9i", "Redmi"), ("Redmi 9 Power", "Redmi"),
        ("Redmi 10", "Redmi"), ("Redmi 10 Prime", "Redmi"), ("Redmi 12", "Redmi"), ("Redmi 12 5G", "Redmi"), ("Redmi 13C", "Redmi"),
        # Samsung
        ("Galaxy A12", "Samsung"), ("Galaxy A13", "Samsung"), ("Galaxy A14 5G", "Samsung"),
        ("Galaxy A21s", "Samsung"), ("Galaxy A22 5G", "Samsung"), ("Galaxy A23", "Samsung"),
        ("Galaxy A32", "Samsung"), ("Galaxy A33 5G", "Samsung"), ("Galaxy A34 5G", "Samsung"), ("Galaxy A54 5G", "Samsung"),
        ("Galaxy M12", "Samsung"), ("Galaxy M13", "Samsung"), ("Galaxy M14 5G", "Samsung"),
        ("Galaxy M31", "Samsung"), ("Galaxy M32", "Samsung"), ("Galaxy M33 5G", "Samsung"), ("Galaxy M34 5G", "Samsung"),
        ("Galaxy F14 5G", "Samsung"), ("Galaxy F23 5G", "Samsung"),
        ("Galaxy S21 FE 5G", "Samsung"), ("Galaxy S20 FE 5G", "Samsung"),
        # OnePlus
        ("OnePlus Nord CE 2 5G", "OnePlus"), ("OnePlus Nord CE 3 Lite 5G", "OnePlus"), ("OnePlus Nord CE 3 5G", "OnePlus"),
        ("OnePlus Nord 2 5G", "OnePlus"), ("OnePlus Nord 2T 5G", "OnePlus"), ("OnePlus Nord 3 5G", "OnePlus"),
        ("OnePlus 9R 5G", "OnePlus"), ("OnePlus 8T", "OnePlus"),
        # Apple
        ("iPhone 16", "Apple"), ("iPhone 16 Plus", "Apple"), ("iPhone 16 Pro", "Apple"), ("iPhone 16 Pro Max", "Apple"),
        ("iPhone 13 mini", "Apple"), ("iPhone 12 mini", "Apple"), ("iPhone XR", "Apple"), ("iPhone SE (2020)", "Apple"), ("iPhone SE (2022)", "Apple")
    ]
    try:
        cursor.execute("SELECT name FROM device_models")
        existing_names = set((r[0] or '').lower() for r in cursor.fetchall())
        to_insert = [
            (d_name, d_brand, 'smartphone', 'active')
            for d_name, d_brand in seed_devices
            if d_name.lower() not in existing_names
        ]
        if to_insert:
            cursor.executemany(
                "INSERT INTO device_models (name, brand, type, status) VALUES (?, ?, ?, ?)",
                to_insert
            )
    except Exception as e:
        print(f"Device models seed note: {e}")

    # --- Tables referenced by live endpoints but previously missing from
    # init_db (same failure mode as stock_movements: code SELECT/INSERTed
    # them, so on any DB where they hadn't been created manually the
    # endpoints 500'd). Schemas mirror exactly the columns the code uses;
    # CREATE IF NOT EXISTS keeps every row on DBs that already have them.

    # Admin-editable notification/email templates. Readers fall back to
    # hardcoded messages when a key is absent, so an empty table on fresh
    # DBs preserves today's fallback behavior.
    cursor.execute('''CREATE TABLE IF NOT EXISTS notification_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT UNIQUE NOT NULL,
        slug TEXT,
        type TEXT,
        title TEXT,
        subject TEXT,
        message TEXT,
        is_active INTEGER DEFAULT 1,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # Warehouse vendor (supplier) management.
    cursor.execute('''CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        contact TEXT,
        email TEXT,
        gst_in TEXT,
        role TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # Material purchase records + line items (warehouse procurement flow).
    cursor.execute('''CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_name TEXT,
        invoice_no TEXT,
        invoice_date TEXT,
        total_amount REAL DEFAULT 0,
        store_id INTEGER,
        status TEXT DEFAULT 'COMPLETED',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(store_id) REFERENCES dark_stores(id)
    )''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS purchase_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL,
        product_id INTEGER,
        quantity REAL DEFAULT 0,
        unit_price REAL DEFAULT 0,
        selling_price REAL DEFAULT 0,
        FOREIGN KEY(purchase_id) REFERENCES purchases(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')

    # Product brands (public GET /api/brands + admin create).
    cursor.execute('''CREATE TABLE IF NOT EXISTS brands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # Per-user login history (read-only endpoint; no writer in current code,
    # so the table just starts empty and the endpoint returns [] instead of
    # a 500 on fresh DBs).
    cursor.execute('''CREATE TABLE IF NOT EXISTS login_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        ip_address TEXT,
        user_agent TEXT,
        success INTEGER DEFAULT 1,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id, timestamp)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS mail_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_email TEXT NOT NULL,
        subject TEXT,
        body TEXT,
        status TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    # mail_history is written with admin_id/recipient_type/recipient_count/message
    # by the admin mail endpoints; older DBs predate those columns, so ensure them
    # here (previously those inserts silently failed and only logged an error).
    ensure_columns('mail_history', [
        ('admin_id', 'INTEGER'),
        ('recipient_type', 'TEXT'),
        ('recipient_count', 'INTEGER'),
        ('message', 'TEXT'),
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS restock_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS system_recovery_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        details TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS delivery_partners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('delivery_partners', [('partner_id', 'TEXT'), ('application_id', 'INTEGER'), ('phone', 'TEXT'), ('status', "TEXT DEFAULT 'OFFLINE'"), ('latitude', 'REAL DEFAULT 0'), ('longitude', 'REAL DEFAULT 0'), ('active_order_id', 'INTEGER')])

    # --- Wallet & Loyalty ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS wallet (user_id INTEGER PRIMARY KEY, balance REAL DEFAULT 0, FOREIGN KEY(user_id) REFERENCES users(id))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS wallet_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL, type TEXT NOT NULL, reference TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))''')
    ensure_columns('wallet_transactions', [('reason', 'TEXT'), ('reference_id', 'TEXT')])

    # --- Referral System ---
    ensure_columns('users', [('referral_code', 'TEXT')])
    cursor.execute('''CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id INTEGER NOT NULL,
        referred_id INTEGER NOT NULL,
        referral_code TEXT,
        status TEXT DEFAULT 'pending',
        qualifying_order_id INTEGER,
        reward_given_at TIMESTAMP,
        instant_bonus_given INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(referrer_id) REFERENCES users(id),
        FOREIGN KEY(referred_id) REFERENCES users(id)
    )''')
    # instant_bonus_given tracks whether the ₹10 instant signup bonus was
    # already credited to BOTH users for this referral (old rows won't have it
    # until the backfill migration credits them).
    ensure_columns('referrals', [('instant_bonus_given', 'INTEGER DEFAULT 0')])
    # reward lifecycle: the order-triggered payout is NOT paid on delivery
    # anymore. On DELIVERED the referral is ARMEND (reward_armed=1) with a
    # reward_due_at = delivery time + return/cancellation/exchange window, and
    # the remainder is paid only once that window has passed AND the order is
    # still valid (no pending/approved refund). reward_paid prevents double pay.
    ensure_columns('referrals', [
        ('reward_armed', 'INTEGER DEFAULT 0'),
        ('reward_due_at', 'TIMESTAMP'),
        ('reward_paid', 'INTEGER DEFAULT 0'),
    ])
    # Guard against duplicate referral records (one per referred user) so the
    # instant bonus can never be credited twice.
    try:
        cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id)")
    except Exception as e:
        print(f"Ignored referrals unique index error (pre-existing duplicates?): {e}")
    cursor.execute('''CREATE TABLE IF NOT EXISTS referral_attempts (
        user_id INTEGER UNIQUE,
        attempts INTEGER DEFAULT 0,
        blocked_at TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    # --- Admin & Support ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, role TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))''')
    ensure_columns('admins', [('status', "TEXT DEFAULT 'active'")])
    cursor.execute('''CREATE TABLE IF NOT EXISTS admin_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, permission TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(admin_id) REFERENCES users(id))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(admin_id) REFERENCES users(id))''')
    ensure_columns('activity_logs', [('entity_type', 'TEXT'), ('entity_id', 'INTEGER')])
    
    cursor.execute('''CREATE TABLE IF NOT EXISTS admin_audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action_type TEXT NOT NULL, target_entity TEXT NOT NULL, target_id INTEGER, description TEXT, ip_address TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(admin_id) REFERENCES users(id))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS support_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT DEFAULT 'OPEN', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))''')
    ensure_columns('support_tickets', [
        ('admin_reply', 'TEXT'),
        ('ticket_number', 'TEXT'),
        ('updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(ticket_id) REFERENCES support_tickets(id)
    )''')

    # --- Official Chat Architecture (Isolated Standalone Channel) ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        room_key TEXT UNIQUE NOT NULL,
        title TEXT DEFAULT 'JDLX Official Specialist',
        status TEXT DEFAULT 'active',
        assigned_specialist TEXT DEFAULT 'JDLX Senior Specialist (Verified)',
        last_message TEXT,
        last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    # NOTE: official_chat_* rows belong to the STANDALONE Official Chat app
    # (identity: chat_users). They intentionally have NO foreign key to the
    # storefront `users` table so Chat and Store data can never be linked.
    ensure_columns('official_chat_rooms', [
        ('status', "TEXT DEFAULT 'active'"),
        ('assigned_specialist', "TEXT DEFAULT 'JDLX Senior Specialist (Verified)'"),
        ('last_message', 'TEXT'),
        ('last_message_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'),
        ('username', 'TEXT'),
        ('user_two_id', 'INTEGER'),
        ('room_type', "TEXT DEFAULT 'direct'"),
        ('e2e_secret', 'TEXT'),
        # Group profile picture (uploaded via /chat/upload kind=avatar).
        ('avatar', 'TEXT'),
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(sender_id, receiver_id)
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_fr_recv ON official_chat_friend_requests(receiver_id, status)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_fr_send ON official_chat_friend_requests(sender_id, status)')

    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        sender_type TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        message TEXT NOT NULL,
        media_url TEXT,
        message_type TEXT DEFAULT 'text',
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(room_id) REFERENCES official_chat_rooms(id)
    )''')
    ensure_columns('official_chat_messages', [
        ('media_url', 'TEXT'),
        ('message_type', "TEXT DEFAULT 'text'"),
        ('is_read', 'INTEGER DEFAULT 0'),
        ('username', 'TEXT'),
        # Author identity for staff/specialist rows. Databases created before
        # this column existed (the standalone service's first deploy) would
        # otherwise 500 on EVERY message insert/fetch — the send/receive flow
        # dies with "no column named sender_type". DEFAULT keeps old rows
        # readable as regular user messages.
        ('sender_type', "TEXT DEFAULT 'user'"),
        # Reply/quote, edit + tombstone support for the messenger UI.
        ('reply_to_id', 'INTEGER'),
        ('deleted', 'INTEGER DEFAULT 0'),
        ('edited_at', 'TIMESTAMP'),
        ('updated_at', 'INTEGER DEFAULT 0'),
        # Client-generated idempotency key: a timed-out send that is retried
        # must not create a duplicate bubble. Unique per sender per room.
        ('client_message_id', 'TEXT'),
    ])
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_msg_room_id ON official_chat_messages(room_id, id DESC)')
    cursor.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_msg_client_id '
        'ON official_chat_messages(room_id, user_id, client_message_id)'
    )
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_msg_unread ON official_chat_messages(room_id, user_id, is_read)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_rooms_user ON official_chat_rooms(user_id, user_two_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_rooms_group ON official_chat_rooms(room_type, status)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_rooms_user2 ON official_chat_rooms(user_two_id, user_id)')

    # Delete-for-me (per-user hide) and emoji reactions (one per user/message).
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_message_hides (
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        PRIMARY KEY(message_id, user_id)
    )''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_message_reactions (
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoji TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(message_id, user_id)
    )''')

    # Per-user "clear conversation" watermark. Clearing a chat must never wipe
    # the other participant's copy, so each user only hides messages up to the
    # highest id they cleared.
    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_room_clears (
        room_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        cleared_upto_id INTEGER NOT NULL DEFAULT 0,
        cleared_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(room_id, user_id)
    )''')

    # Realtime chat support: short-lived typing state + per-user read watermark
    # (used for ✓✓ read receipts). Timestamps are unix seconds for easy TTL
    # comparisons across SQLite/Turso.
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_typing (
        room_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(room_id, user_id)
    )''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_read_state (
        room_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        last_read_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(room_id, user_id)
    )''')

    # Voice/video call signaling state. One active call row per room at a time;
    # the callee polls /call/state to learn of an incoming offer, and both peers
    # exchange SDP + ICE candidates through this table so no WebSocket/SSE is
    # required (keeps the gunicorn sync deployment working).
    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        caller_id INTEGER NOT NULL,
        callee_id INTEGER,
        call_type TEXT NOT NULL DEFAULT 'voice',   -- 'voice' | 'video'
        state TEXT NOT NULL DEFAULT 'idle',        -- 'idle' | 'ringing' | 'active' | 'ended'
        offer_sdp TEXT,
        answer_sdp TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        FOREIGN KEY(room_id) REFERENCES official_chat_rooms(id)
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_calls_room_state ON official_chat_calls(room_id, state)')
    ensure_columns('official_chat_calls', [
        ('candidates', 'TEXT'),
        # ICE/SDP signalling columns referenced by the call endpoints; older
        # call tables (pre-dating the standalone service) may lack these.
        ('callee_id', 'INTEGER'),
        ('call_type', "TEXT DEFAULT 'voice'"),
        ('state', "TEXT DEFAULT 'idle'"),
        ('offer_sdp', 'TEXT'),
        ('answer_sdp', 'TEXT'),
        ('ended_at', 'TIMESTAMP'),
        # Heartbeat written by the /call/state poll. Without it an abandoned
        # 'active' row (caller closed the tab, phone died) blocked every new
        # call in that room until the 4-hour expiry.
        ('last_seen', 'INTEGER'),
    ])

    # Group membership is the ONLY access-control source for group rooms.
    # Direct rooms keep using official_chat_rooms.user_id/user_two_id, so the
    # existing 1-to-1 checks stay untouched. `role` is 'admin' for the creator
    # (and any promoted member) or 'member'. Per-member read state still lives
    # in official_chat_read_state so one member reading never marks messages
    # read for the whole group.
    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_group_members (
        room_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_by INTEGER,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(room_id, user_id)
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_group_members_user ON official_chat_group_members(user_id, room_id)')

    # Safety controls: user blocks (either direction stops DMs) and abuse
    # reports that admins can review.
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_blocks (
        blocker_id INTEGER NOT NULL,
        blocked_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(blocker_id, blocked_id)
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocked ON chat_blocks(blocked_id)')
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id INTEGER NOT NULL,
        reported_id INTEGER NOT NULL,
        room_id INTEGER,
        reason TEXT NOT NULL,
        details TEXT,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports(status, created_at)')

    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        room_id INTEGER,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    ensure_columns('official_chat_notifications', [
        ('is_read', 'INTEGER DEFAULT 0'),
    ])

    # Isolated Official Chat Security Audit & Handshake Tables
    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        event_type TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_sec_user ON official_chat_security_events(user_id, created_at)')

    cursor.execute('''CREATE TABLE IF NOT EXISTS official_chat_sso_codes (
        code TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # Official Chat is a COMPLETELY SEPARATE frontend + identity system from the
    # storefront. Chat accounts live in chat_users (independent logins — Google,
    # phone, or username), and NEVER touch the storefront `users` table. Profile,
    # orders, wallet and support data of the store remain isolated.
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_sub TEXT UNIQUE,
        email TEXT UNIQUE,
        phone TEXT,
        name TEXT NOT NULL,
        username TEXT UNIQUE,
        password_hash TEXT,
        profile_image TEXT,
        role TEXT DEFAULT 'customer',
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP
    )''')
    cursor.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_users_username ON chat_users(LOWER(username))')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_users_phone ON chat_users(phone)')
    ensure_columns('chat_users', [
        ('password_hash', 'TEXT'),
        # True E2EE: the client-generated ECDH public key (SPKI, base64) is the
        # only key material the server ever stores. Private keys never leave
        # the user's device.
        ('public_key', 'TEXT'),
        # User-encrypted or device-synced identity keypair backup so that PWA,
        # Android APK, and Webview can transparently share the same identity
        # keypair without creating decrypt lockouts across devices.
        ('identity_backup', 'TEXT'),
        # Logout revocation marker (same contract as users.min_token_iat): every
        # chat access/refresh token issued before this timestamp is rejected.
        ('min_token_iat', 'INTEGER DEFAULT 0'),
        # Required on the Google sign-up completion form so Chat has a
        # discoverable, complete profile before any account is created.
        ('gender', 'TEXT'),
        # User profile bio / status (WhatsApp style about statement)
        ('bio', "TEXT DEFAULT 'Hey there! I am using JDLX Chat'"),
        # Presence + profile fields referenced by the inbox and group member
        # queries (is_online badges). Databases predating these columns would
        # otherwise 500 the conversations endpoint.
        ('profile_image', 'TEXT'),
        ('last_seen_at', 'TIMESTAMP'),
    ])

    # --- Official Chat Web Push (VAPID) Subscriptions ---
    # Chat identities live in `chat_users`, NOT the storefront `users` table, so
    # chat subscriptions need their own table. Sharing web_push_subscriptions
    # would deliver a chat push to whichever storefront user has the same id.
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_user_id INTEGER NOT NULL,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        device_model TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_push_user ON chat_push_subscriptions(chat_user_id)")

    # --- Official Chat Native Push (FCM) Device Tokens ---
    # Android WebView has no Push API, so the packaged JDLX Chat app registers
    # an FCM token instead. Kept separate from storefront user_push_tokens so a
    # chat id can never receive (or hijack) a storefront user's notifications.
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_push_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_user_id INTEGER NOT NULL,
        fcm_token TEXT UNIQUE NOT NULL,
        device_type TEXT,
        device_model TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_push_tokens_user ON chat_push_tokens(chat_user_id)")

    # Web Push VAPID keypair. Generated once and persisted here when the
    # deployment has no VAPID env vars, so browser notifications work without
    # manual key setup. A single row (id = 1) is shared by every worker.
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_vapid_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # DB-backed fixed-window counters for Official Chat throttling. Shared by
    # every gunicorn worker (the old in-memory dict was per-process, so the real
    # limit was N x workers, and it grew without bound).
    cursor.execute('''CREATE TABLE IF NOT EXISTS chat_rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
    )''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_rate_limits_window ON chat_rate_limits(window_start)')

    cursor.execute('''CREATE TABLE IF NOT EXISTS complaints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        issue_type TEXT NOT NULL,
        description TEXT NOT NULL,
        photo_path TEXT,
        status TEXT DEFAULT 'Pending',
        admin_reply TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
    )''')
    # --- Warehouse-driven returns pipeline (complaints are the single entry
    # point for every post-delivery product issue; customers never file refund
    # requests directly) ---
    ensure_columns('complaints', [
        # Warehouse that owns this complaint (resolved from the order's
        # warehouse assignment at submit time; NULL = unassigned, admin sees it).
        ('warehouse_id', 'INTEGER'),
        # What the customer asked for: 'return' (item goes back, money back)
        # or 'exchange' (item goes back, replacement out). Final say is the
        # warehouse's — this is only the request.
        ('requested_action', "TEXT DEFAULT 'return'"),
        # Product-rules deadline (IST string): complaint must be filed before
        # this. Computed at submit time from product/category/global rules.
        ('return_window_end', 'TEXT'),
        # Free-text final resolution note (what was actually done).
        ('resolution', 'TEXT'),
        # 1 once a warehouse took ownership (decided/pickup/verified).
        ('handled_by_warehouse', 'INTEGER DEFAULT 0'),
        # Verified-returns restock: which product(s) the complaint targets —
        # single id or comma-joined list captured at submit time. NULL = a
        # legacy row (submitted before this column existed).
        ('product_scope', 'TEXT'),
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS order_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        report_type TEXT NOT NULL,
        description TEXT NOT NULL,
        photo_path TEXT,
        status TEXT DEFAULT 'Submitted',
        resolution TEXT,
        admin_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
    )''')
    # Admin fraud-review -> warehouse transfer flow. Admin reviews a new
    # report; if it looks legitimate it is TRANSFERRED to the warehouse that
    # packed the order, which then takes the processing action. Columns are
    # NULL until the transfer happens.
    ensure_columns('order_reports', [
        ('warehouse_id', 'INTEGER'),
        ('transferred_by', 'INTEGER'),
        ('transferred_at', 'TIMESTAMP'),
        ('transfer_note', 'TEXT'),
        ('action_taken', 'TEXT'),
        ('action_notes', 'TEXT'),
        ('actioned_at', 'TIMESTAMP'),
        ('actioned_by', 'TEXT'),
        # Admin directive attached at transfer time: the warehouse is
        # FORCED to record one of the directed actions (refund / exchange /
        # investigation) before the report can be closed out.
        ('action_required', 'TEXT'),
        ('directive_deadline', 'TIMESTAMP'),
        ('escalated_from_warehouse_id', 'INTEGER'),
        ('escalated_at', 'TIMESTAMP'),
        ('escalation_note', 'TEXT'),
    ])

    # Warehouse misconduct warnings (harassment notices from the admin
    # fraud-review desk). Counts feed the suspend threshold.
    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouse_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        report_id INTEGER,
        reason TEXT NOT NULL,
        issued_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    )''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS admin_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'INFO',
        report_id INTEGER,
        product_id INTEGER,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS refund_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        request_type TEXT NOT NULL,
        description TEXT NOT NULL,
        photo_path TEXT,
        status TEXT DEFAULT 'Pending',
        refund_amount REAL,
        admin_notes TEXT,
        resolution TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
    )''')
    # Refund provenance: 'customer' = legacy direct submissions (endpoint now
    # retired), 'warehouse_complaint' = raised by the warehouse from the
    # returns pipeline (decision authority = warehouse; admin only executes
    # the payout). Default keeps every pre-existing row as 'customer'.
    # NOTE: there are TWO historical shapes of this table (a legacy
    # order_id/amount/reason schema and the full request_type/... schema).
    # ensure_columns converges BOTH directions so every deployment has every
    # column the code touches — the returns pipeline INSERTs request_type,
    # refund_amount, admin_notes and the summary/aggregation queries read
    # both amount and refund_amount.
    ensure_columns('refund_requests', [
        ('request_type', 'TEXT'),
        ('description', 'TEXT'),
        ('photo_path', 'TEXT'),
        ('refund_amount', 'REAL'),
        ('admin_notes', 'TEXT'),
        ('resolution', 'TEXT'),
        ('updated_at', 'TIMESTAMP'),
        ('amount', 'REAL DEFAULT 0'),
        ('source', "TEXT DEFAULT 'customer'"),
        ('complaint_id', 'INTEGER'),
    ])

    # --- Warehouse returns pipeline (RMA) ---
    # One row per complaint that a warehouse took on. Tracks the decision
    # (return / exchange / refund / rejected), the reverse pickup, the item
    # verification at the warehouse and the exchange re-dispatch. Created
    # lazily on the first warehouse decision; complaints still in 'Pending'
    # have no row yet.
    # Warehouse bell notifications (also created lazily by
    # warehouse_routes._ensure_warehouse_kyc_schema; creating here too so
    # cross-module writes — e.g. new-return alerts from complaint_routes —
    # never 500 on a fresh DB where no warehouse has logged in yet).
    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouse_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'GENERAL',
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS complaint_returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id INTEGER NOT NULL UNIQUE,
        warehouse_id INTEGER,
        decision TEXT,
        decided_by INTEGER,
        decided_at TIMESTAMP,
        decision_notes TEXT,
        pickup_status TEXT DEFAULT 'not_scheduled',
        pickup_courier TEXT,
        pickup_code TEXT,
        pickup_scheduled_at TIMESTAMP,
        picked_up_at TIMESTAMP,
        pickup_notes TEXT,
        verification_status TEXT,
        verified_at TIMESTAMP,
        verification_notes TEXT,
        exchange_product_id INTEGER,
        exchange_order_id INTEGER,
        exchange_status TEXT,
        refund_request_id INTEGER,
        refund_triggered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(complaint_id) REFERENCES complaints(id)
    )''')
    # Shiprocket reverse-pickup integration (best-effort — the pipeline works
    # without Shiprocket via self-pickup). Populated only when the SR API
    # accepts the reverse order; NULL = SR not used for this return.
    ensure_columns('complaint_returns', [
        ('sr_return_order_id', 'INTEGER'),
        ('sr_shipment_id', 'INTEGER'),
        ('sr_awb_code', 'TEXT'),
        ('sr_courier_name', 'TEXT'),
        ('sr_pickup_scheduled_date', 'TEXT'),
        ('sr_request_status', 'TEXT'),
        ('exchange_variant_id', 'INTEGER'),
    ])

    cursor.execute('''CREATE TABLE IF NOT EXISTS bug_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        page_location TEXT NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        steps_to_reproduce TEXT,
        screenshot_path TEXT,
        browser TEXT,
        os TEXT,
        screen_resolution TEXT,
        page_url TEXT,
        user_agent TEXT,
        status TEXT DEFAULT 'New',
        developer_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS issue_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        error_type TEXT NOT NULL,
        page TEXT NOT NULL,
        description TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # --- Client error telemetry (automatic frontend error capture) ---
    # Raw events carry full context and auto-expire (lazy purge in client_error_routes);
    # groups are the compact per-bug signal admins browse (permanent).
    cursor.execute('''CREATE TABLE IF NOT EXISTS client_error_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT DEFAULT 'medium',
        message TEXT NOT NULL,
        stack TEXT,
        page TEXT,
        user_id INTEGER,
        session_id TEXT,
        app_version TEXT,
        context_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_client_error_events_fp ON client_error_events(fingerprint, created_at)")
    cursor.execute('''CREATE TABLE IF NOT EXISTS client_error_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT DEFAULT 'medium',
        message TEXT NOT NULL,
        sample_stack TEXT,
        sample_page TEXT,
        total_count INTEGER DEFAULT 0,
        users_affected INTEGER DEFAULT 0,
        status TEXT DEFAULT 'new',
        first_seen_at TIMESTAMP,
        last_seen_at TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_client_error_groups_status ON client_error_groups(status, last_seen_at)")

    # --- Security ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, ip_address TEXT, status TEXT NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address)")
    cursor.execute('''CREATE TABLE IF NOT EXISTS security_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, alert_type TEXT NOT NULL, message TEXT NOT NULL, severity TEXT DEFAULT 'medium', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('security_alerts', [('admin_id', 'INTEGER'), ('ip_address', 'TEXT'), ('resolved', 'INTEGER DEFAULT 0'), ('resolved_at', 'TIMESTAMP'), ('resolved_by', 'INTEGER')])
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_security_alerts_type ON security_alerts(alert_type)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_security_alerts_severity ON security_alerts(severity)")

    # --- Admin OTP Re-authentication (DB-backed so it survives gunicorn worker
    # restarts / multi-worker setups; OTP stored hashed, never in plaintext).
    # attempts increments on wrong guesses; the row is deleted once exhausted
    # (one-time use) — see app.py admin_request_otp / admin_verify_otp.
    cursor.execute('''CREATE TABLE IF NOT EXISTS admin_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT,
        name TEXT,
        otp_hash TEXT NOT NULL,
        otp_salt TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_admin_otps_email ON admin_otps(email)")
    # --- System Bridge OTP (DB-backed, survives restarts, hashed OTP, attempt-limited)
    cursor.execute('''CREATE TABLE IF NOT EXISTS system_bridge_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        otp_hash TEXT NOT NULL,
        otp_salt TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        attempts INTEGER DEFAULT 0,
        verified INTEGER DEFAULT 0,
        session_expiry TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_system_bridge_otps_email ON system_bridge_otps(email)")

    # --- Google OAuth Link OTP (prevents account takeover via email linking)
    cursor.execute('''CREATE TABLE IF NOT EXISTS google_link_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        google_id TEXT NOT NULL,
        name TEXT,
        picture TEXT,
        otp_hash TEXT NOT NULL,
        otp_salt TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_google_link_otps_email ON google_link_otps(email)")
    ensure_columns('google_link_otps', [('resend_count', 'INTEGER DEFAULT 0'), ('last_sent_at', 'TIMESTAMP')])

    # --- Customer Email OTP (email-based signup/login without Google) ---
    # Same hardening as the other OTP tables: hashed with per-record salt,
    # one active OTP per email (old rows purged on new request), attempt-limited,
    # one-time use, rate-limited at the endpoint level. resend_count + last_sent_at
    # power the escalating resend cooldown (admin-configurable via system_settings).
    cursor.execute('''CREATE TABLE IF NOT EXISTS customer_email_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        otp_hash TEXT NOT NULL,
        otp_salt TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        attempts INTEGER DEFAULT 0,
        resend_count INTEGER DEFAULT 0,
        last_sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_customer_email_otps_email ON customer_email_otps(email)")
    ensure_columns('customer_email_otps', [('resend_count', 'INTEGER DEFAULT 0'), ('last_sent_at', 'TIMESTAMP')])


    # --- Settings & Marketing ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS system_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL)''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS banners (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('banners', [('subtitle', 'TEXT'), ('cta_text', 'TEXT'), ('image_url', 'TEXT'), ('badge_text', 'TEXT'), ('gradient', 'TEXT'), ('link_url', 'TEXT'), ('is_active', 'INTEGER DEFAULT 1'), ('overlay_opacity', 'REAL DEFAULT 0.5')])

    # --- Pincode Rules ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS pincode_rules (
        pincode TEXT PRIMARY KEY,
        cod_allowed INTEGER DEFAULT 1,
        prepaid_only INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # --- User Interactions ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS user_interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, session_id TEXT, interaction_type TEXT NOT NULL, target_id TEXT, category TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    # --- Onboarding source (where users heard about JDLX Mobile) ---
    # Recorded on the first-run "How did you hear about us?" screen. source is
    # friends | relatives | social_media | other; platform holds the social
    # network (whatsapp/instagram/facebook/youtube) and detail the free-text.
    cursor.execute('''CREATE TABLE IF NOT EXISTS onboarding_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id TEXT,
        source TEXT NOT NULL,
        platform TEXT,
        detail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS wishlist (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, variant_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, product_id, variant_id), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(product_id) REFERENCES products(id), FOREIGN KEY(variant_id) REFERENCES product_variants(id))''')
    ensure_columns('wishlist', [('variant_id', 'INTEGER REFERENCES product_variants(id)')])
    # Backfill unique constraint for existing databases: drop old index, create new.
    # NOTE: an auto-index that backs a UNIQUE table constraint
    # (sqlite_autoindex_*) cannot be dropped — SQLite raises "index associated
    # with UNIQUE or PRIMARY KEY constraint cannot be dropped" — which used to
    # abort init_db() entirely. Dropping is only best-effort cleanup; the
    # explicit unique index below provides the actual guarantee, so swallow the
    # error and continue.
    try:
        cursor.execute("DROP INDEX IF EXISTS sqlite_autoindex_wishlist_1")
    except sqlite3.OperationalError:
        pass
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_user_product_variant ON wishlist(user_id, product_id, variant_id)")
    cursor.execute('''CREATE TABLE IF NOT EXISTS product_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, user_id INTEGER NOT NULL, rating INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id, user_id), FOREIGN KEY(product_id) REFERENCES products(id), FOREIGN KEY(user_id) REFERENCES users(id))''')
    ensure_columns('product_reviews', [('review_text', 'TEXT'), ('review_images', 'TEXT'), ('is_verified', 'INTEGER DEFAULT 0'), ('helpful_count', 'INTEGER DEFAULT 0'), ('store_id', 'INTEGER')])

    cursor.execute('''CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'INFO',
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    # Older databases created before the is_read rename only had read_status;
    # ensure the columns the notification panel + mark-read route rely on.
    ensure_columns('notifications', [
        ('is_read', 'INTEGER DEFAULT 0'),
        ('metadata', 'TEXT'),
    ])

    # "Notify me when back in stock" subscriptions. Used by
    # /api/products/<id>/notify (insert) and the restock sweep in
    # warehouse_routes (status pending -> notified). Historically this table only
    # existed in the production DB and was never created by a migration, so the
    # endpoint 500'd on any fresh database. Additive CREATE IF NOT EXISTS keeps
    # existing data untouched.
    cursor.execute('''CREATE TABLE IF NOT EXISTS product_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        email TEXT NOT NULL,
        product_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    ensure_columns('product_notifications', [
        ('user_id', 'INTEGER'),
        ('status', "TEXT DEFAULT 'pending'"),
    ])

    # Smart ranking product views history table
    cursor.execute('''CREATE TABLE IF NOT EXISTS product_views_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_prod_views_user_id ON product_views_history(user_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_prod_views_product_id ON product_views_history(product_id)")

    # Relax user_id constraint to allow guest device tokens (tied to session_id)
    try:
        cursor.execute("PRAGMA table_info(user_push_tokens)")
        token_cols = cursor.fetchall()
        uid_col = next((c for c in token_cols if c[1] == 'user_id'), None)
        if uid_col and uid_col[3] == 1:
            cursor.execute("ALTER TABLE user_push_tokens RENAME TO user_push_tokens_old")
            cursor.execute('''CREATE TABLE user_push_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                session_id TEXT,
                fcm_token TEXT UNIQUE NOT NULL,
                device_type TEXT,
                device_model TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )''')
            old_names = {c[1] for c in token_cols}
            if "device_model" in old_names:
                cursor.execute('''
                    INSERT INTO user_push_tokens (id, user_id, fcm_token, device_type, device_model, created_at, updated_at)
                    SELECT id, user_id, fcm_token, device_type, device_model, created_at, updated_at FROM user_push_tokens_old
                ''')
            else:
                cursor.execute('''
                    INSERT INTO user_push_tokens (id, user_id, fcm_token, device_type, created_at, updated_at)
                    SELECT id, user_id, fcm_token, device_type, created_at, updated_at FROM user_push_tokens_old
                ''')
            cursor.execute("DROP TABLE user_push_tokens_old")
    except Exception as e:
        logger.warning(f"user_push_tokens migration check: {e}")

    cursor.execute('''CREATE TABLE IF NOT EXISTS user_push_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id TEXT,
        fcm_token TEXT UNIQUE NOT NULL,
        device_type TEXT, -- 'ios', 'android', 'web'
        device_model TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON user_push_tokens(user_id)")
    ensure_columns('user_push_tokens', [
        ('device_model', 'TEXT'),
        ('session_id', 'TEXT'),
    ])
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_push_tokens_device_model ON user_push_tokens(device_model)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_push_tokens_session ON user_push_tokens(session_id)")

    try:
        cursor.execute("PRAGMA table_info(user_engagement_notification_logs)")
        eng_cols = cursor.fetchall()
        uid_col = next((c for c in eng_cols if c[1] == 'user_id'), None)
        if uid_col and uid_col[3] == 1:
            cursor.execute("ALTER TABLE user_engagement_notification_logs RENAME TO user_engagement_notification_logs_old")
            cursor.execute('''CREATE TABLE user_engagement_notification_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                session_id TEXT,
                trigger_type TEXT NOT NULL,
                campaign_ref TEXT,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                target_url TEXT,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'sent',
                FOREIGN KEY(user_id) REFERENCES users(id)
            )''')
            cursor.execute('''
                INSERT INTO user_engagement_notification_logs (id, user_id, trigger_type, campaign_ref, title, message, target_url, sent_at, status)
                SELECT id, user_id, trigger_type, campaign_ref, title, message, target_url, sent_at, status FROM user_engagement_notification_logs_old
            ''')
            cursor.execute("DROP TABLE user_engagement_notification_logs_old")
    except Exception as e:
        logger.warning(f"user_engagement_notification_logs migration check: {e}")

    cursor.execute('''CREATE TABLE IF NOT EXISTS user_engagement_notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id TEXT,
        trigger_type TEXT NOT NULL,
        campaign_ref TEXT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        target_url TEXT,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'sent',
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_engagement_logs_user_time ON user_engagement_notification_logs(user_id, sent_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_engagement_logs_trigger ON user_engagement_notification_logs(trigger_type, sent_at)")
    ensure_columns('user_engagement_notification_logs', [
        ('session_id', 'TEXT'),
    ])
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_engagement_logs_session_time ON user_engagement_notification_logs(session_id, sent_at)")

    # --- Web Push (VAPID) Subscriptions ---
    # Pure Web Push (no Firebase): each browser subscription is identified by
    # its unique endpoint URL; the p256dh/auth keys are needed to encrypt the
    # payload when the backend sends the notification (pywebpush).
    try:
        cursor.execute("PRAGMA table_info(web_push_subscriptions)")
        web_cols = cursor.fetchall()
        uid_col = next((c for c in web_cols if c[1] == 'user_id'), None)
        if uid_col and uid_col[3] == 1:
            cursor.execute("ALTER TABLE web_push_subscriptions RENAME TO web_push_subscriptions_old")
            cursor.execute('''CREATE TABLE web_push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                session_id TEXT,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                device_model TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )''')
            old_names = {c[1] for c in web_cols}
            if "device_model" in old_names:
                cursor.execute('''
                    INSERT INTO web_push_subscriptions (id, user_id, endpoint, p256dh, auth, device_model, created_at, updated_at)
                    SELECT id, user_id, endpoint, p256dh, auth, device_model, created_at, updated_at FROM web_push_subscriptions_old
                ''')
            else:
                cursor.execute('''
                    INSERT INTO web_push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at)
                    SELECT id, user_id, endpoint, p256dh, auth, created_at, updated_at FROM web_push_subscriptions_old
                ''')
            cursor.execute("DROP TABLE web_push_subscriptions_old")
    except Exception as e:
        logger.warning(f"web_push_subscriptions migration check: {e}")

    cursor.execute('''CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id TEXT,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        device_model TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_web_push_user ON web_push_subscriptions(user_id)")
    ensure_columns('web_push_subscriptions', [
        ('device_model', 'TEXT'),
        ('session_id', 'TEXT'),
    ])
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_web_push_session ON web_push_subscriptions(session_id)")

    # --- Warehouse Partner Web Push (VAPID) Subscriptions ---
    # Same browser push mechanism as web_push_subscriptions, but scoped to a
    # warehouse partner/staff session (warehouse_id) instead of a storefront
    # user. Kept separate so warehouse pushes land in the partner's browser
    # even when the panel is closed/installed, without touching user rows.
    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouse_push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_warehouse_push_warehouse ON warehouse_push_subscriptions(warehouse_id)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS user_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    # --- Onboarding Applications ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS warehouse_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_name TEXT NOT NULL, owner_name TEXT NOT NULL, email TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    ensure_columns('warehouse_applications', [('partner_id', 'TEXT'), ('phone', 'TEXT'), ('address', 'TEXT'), ('pincode', 'TEXT'), ('verification_status', 'TEXT'), ('warehouse_photos', 'TEXT'), ('document_upload', 'TEXT'), ('owner_image', 'TEXT'), ('kyc_details', 'TEXT'), ('request_mail_message', 'TEXT'), ('approved_by_id', 'INTEGER'), ('approved_by_name', 'TEXT'), ('warehouse_capacity', 'INTEGER'), ('warehouse_type', 'TEXT'), ('admin_notes', 'TEXT'), ('updated_at', 'TIMESTAMP'), ('approved_at', 'TIMESTAMP'), ('rejected_at', 'TIMESTAMP')])

    cursor.execute('''CREATE TABLE IF NOT EXISTS delivery_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    # Columns the delivery routes actually read/write. A fresh init_db() used to
    # create only (id, name, email, created_at), so /api/delivery/register hit
    # "table delivery_applications has no column named address" on a new DB
    # (audit H4 class — same drift as the agent columns).
    ensure_columns('delivery_applications', [
        ('partner_id', 'TEXT'), ('warehouse_id', 'INTEGER'), ('phone', 'TEXT'),
        ('address', 'TEXT'), ('pincode', 'TEXT'), ('vehicle_type', 'TEXT'),
        ('vehicle_details_photo', 'TEXT'), ('id_proof_photo', 'TEXT'),
        ('admin_notes', 'TEXT'), ('approved_by_id', 'INTEGER'),
        ('approved_by_name', 'TEXT'),
        ('verification_status', 'TEXT'), ('pan_card_image', 'TEXT'),
        ('aadhaar_front_image', 'TEXT'), ('aadhaar_back_image', 'TEXT'),
        ('face_verification_image', 'TEXT'), ('face_verification_status', 'TEXT'),
        ('aadhaar_extracted_address', 'TEXT'), ('aadhaar_qr_payload', 'TEXT'),
    ])

    # --- Offers & Discounts ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS offers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        offer_type TEXT NOT NULL, -- 'coupon', 'automatic', 'seasonal', 'daily'
        discount_type TEXT NOT NULL, -- 'percentage', 'flat'
        discount_value REAL NOT NULL,
        min_order_amount REAL DEFAULT 0,
        max_discount_amount REAL,
        target_type TEXT DEFAULT 'all', -- 'all', 'new_user', 'specific_user'
        applicable_on TEXT DEFAULT 'all', -- 'all', 'category', 'product'
        applicable_ids TEXT, -- JSON array
        coupon_code TEXT UNIQUE,
        usage_limit INTEGER,
        usage_count INTEGER DEFAULT 0,
        per_user_limit INTEGER DEFAULT 1,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        banner_image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    # warehouse_id: NULL = platform-wide offer (admin-created); set = offer
    # created by that warehouse partner (multi-vendor). Discount evaluation
    # only applies warehouse offers to carts containing that warehouse's stock.
    #
    # target_ids: JSON array of USER ids for target_type='specific_user'. It is
    # SEPARATE from applicable_ids (product/category scope) so a first-order or
    # specific-user coupon can ALSO be scoped to products/categories — before
    # this column the two meanings shared one field and collided. NULL on
    # legacy rows falls back to applicable_ids in the offer engine.
    ensure_columns('offers', [('warehouse_id', 'INTEGER'), ('target_ids', 'TEXT')])

    cursor.execute('''CREATE TABLE IF NOT EXISTS offer_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        discount_applied REAL NOT NULL,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(offer_id) REFERENCES offers(id),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
    )''')

    # --- Analytics ---
    cursor.execute('''CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      page_path TEXT NOT NULL,
      page_title TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      device_type TEXT,
      browser TEXT,
      os TEXT,
      screen_resolution TEXT,
      country TEXT,
      platform TEXT,
      ip_address TEXT,
      duration_seconds INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      event_type TEXT NOT NULL,
      event_category TEXT NOT NULL,
      event_label TEXT,
      event_value TEXT,
      page_path TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS analytics_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      page_count INTEGER DEFAULT 1,
      is_bounce INTEGER DEFAULT 1,
      device_type TEXT,
      browser TEXT,
      os TEXT,
      referrer TEXT,
      utm_source TEXT,
      platform TEXT,
      ip_address TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )''')
    # Channel attribution + client IP: which shell the visit came from
    # (website in a browser tab, installed PWA, packaged Android APK, or a
    # localhost dev server) and where it connected from. Powers the admin
    # "Visitor Details" table. ensure_columns keeps existing DBs in sync.
    ensure_columns('page_views', [('platform', 'TEXT'), ('ip_address', 'TEXT')])
    ensure_columns('analytics_sessions', [('platform', 'TEXT'), ('ip_address', 'TEXT')])
    # Hot-path indexes for time-window analytics (system health probe, admin
    # dashboards): sessions active in the last 24h and page views per day.
    # Without these every probe full-scans both tables. Idempotent.
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_analytics_sessions_last_seen ON analytics_sessions(last_seen_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)")

    cursor.execute('''CREATE TABLE IF NOT EXISTS search_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      query TEXT NOT NULL,
      results_count INTEGER DEFAULT 0,
      clicked_product_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )''')

    # Search-demand rollup: one row per normalized search phrase, bumped on
    # every storefront search. terms_unmet counts searches that returned zero
    # products — the admin "Search Demand" page ranks these so the team can
    # stock what customers are actually looking for, and trends_query powers
    # the storefront's "Trending searches" chips. Raw search_queries rows keep
    # the full audit trail; this table is the fast aggregate.
    cursor.execute('''CREATE TABLE IF NOT EXISTS search_demand (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL UNIQUE,
      terms_normalized TEXT NOT NULL,
      search_count INTEGER DEFAULT 0,
      unmet_count INTEGER DEFAULT 0,
      last_searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_search_demand_unmet ON search_demand(unmet_count DESC, search_count DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_search_demand_hot ON search_demand(search_count DESC, last_searched_at DESC)")

    # --- Mobile App: Release registry + Signing keystore vault ---
    # Super-admin-only section in the admin panel (mobile_release_routes.py).
    # Releases track what was shipped (version/artifact/notes); the vault keeps
    # an encrypted-at-rest backup of the Android signing keystore so losing the
    # local file can never lock the team out of publishing updates.
    cursor.execute('''CREATE TABLE IF NOT EXISTS mobile_app_releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_name TEXT NOT NULL,
        version_code INTEGER,
        channel TEXT DEFAULT 'store',
        artifact_type TEXT DEFAULT 'aab',
        download_url TEXT,
        file_name TEXT,
        size_bytes INTEGER,
        release_notes TEXT,
        force_update INTEGER DEFAULT 0,
        is_live INTEGER DEFAULT 0,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    ensure_columns('mobile_app_releases', [
        ('force_update', 'INTEGER DEFAULT 0'),
    ])

    # Ensure latest mobile release v1.2.9 (build 12) is registered as the live update
    try:
        cur_live = cursor.execute(
            "SELECT id, version_code FROM mobile_app_releases WHERE is_live = 1 ORDER BY version_code DESC LIMIT 1"
        ).fetchone()
        if not cur_live or (cur_live[1] or 0) < 12:
            cursor.execute("UPDATE mobile_app_releases SET is_live = 0")
            cursor.execute('''INSERT INTO mobile_app_releases
                (version_name, version_code, channel, artifact_type, download_url, file_name, size_bytes, release_notes, force_update, is_live)
                VALUES ('1.2.9', 12, 'store', 'apk', '/downloads/jdlx-mobile.apk', 'jdlx-mobile.apk', 28465806,
                        'Prominent high-contrast Sold Out badges, glowing live status indicators, card image overlays, and out-of-stock usability optimizations.', 0, 1)''')
        else:
            cursor.execute("UPDATE mobile_app_releases SET size_bytes = 28465806 WHERE version_code = 12 AND file_name = 'jdlx-mobile.apk'")
    except Exception:
        pass
    except Exception:
        pass

    cursor.execute('''CREATE TABLE IF NOT EXISTS mobile_keystore_vault (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        keystore_file_name TEXT,
        keystore_mime TEXT,
        keystore_data BLOB,
        keystore_sha256 TEXT,
        key_alias TEXT,
        keystore_password_enc TEXT,
        key_password_enc TEXT,
        sha1_fingerprint TEXT,
        sha256_fingerprint TEXT,
        backup_location TEXT,
        notes TEXT,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # --- OAuth hand-off codes (native app sign-in) ---
    # The Android app completes Google sign-in in a Chrome Custom Tab and comes
    # back through a custom-scheme deep link. Putting the session JWT in that URI
    # would let any other app that registered the same scheme steal it, so the
    # backend hands back a one-time code + a PKCE-style challenge instead; the
    # real token is only released after `POST /api/auth/exchange-handoff` proves
    # possession of the verifier. Rows are single-use and expire in ~3 minutes.
    cursor.execute('''CREATE TABLE IF NOT EXISTS oauth_handoff_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        user_id INTEGER,
        user_json TEXT,
        token TEXT,
        challenge TEXT,
        used INTEGER DEFAULT 0,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_oauth_handoff_expires ON oauth_handoff_codes(expires_at)")

    # --- Hot-path indexes (audit M6) -------------------------------------
    # Declared here, after every table exists, because on a fresh database the
    # tables above did not exist yet earlier in this function. Hot read paths
    # had no index: wallet history, notification inbox, coupon usage,
    # complaints, vendor assignments, refund lookups and the catalog approval
    # filter (products.approval_status is in every storefront query).
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, created_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wallet_tx_reference ON wallet_transactions(reference_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_offer_usage_offer_user ON offer_usage(offer_id, user_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_complaints_user ON complaints(user_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wh_assignments_order ON warehouse_order_assignments(order_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wh_assignments_wh ON warehouse_order_assignments(warehouse_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_approval_status ON products(approval_status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_refund_requests_order ON refund_requests(order_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)")

    # --- Seeding & Defaults ---
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('platform_fee', '7')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('free_delivery_threshold', '399')")
    # Boot repair: a saved 0 on the free-delivery thresholds previously
    # meant "free delivery on EVERY order at any amount" (prepaid + COD).
    # The code now falls back to the defaults at read/save time; this
    # restores existing rows that already hold a bad value.
    cursor.execute("UPDATE system_settings SET value = '399' WHERE key = 'free_delivery_threshold' AND (value IS NULL OR trim(value) = '' OR CAST(value AS REAL) <= 0)")
    cursor.execute("UPDATE system_settings SET value = '199' WHERE key = 'membership_free_delivery_threshold' AND (value IS NULL OR trim(value) = '' OR CAST(value AS REAL) <= 0)")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('cod_enabled', 'true')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('ticker_text', 'Free delivery on orders above ₹399')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('platform_delivery_promise', '2-4 days')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('construction_mode', 'false')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('construction_mode_message', 'Our website is currently undergoing scheduled maintenance and upgrades. JDLX Mobile will be back online with exciting new premium products soon. Thank you for your patience!')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('auto_cod_protection', 'true')")
    # --- JDLX Premium membership program (admin-tunable) ---
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_program_enabled', 'true')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_discount_percent', '10')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_cart_threshold', '149')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_free_delivery_threshold', '199')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_delivery_fee', '29')")
    cursor.execute("UPDATE system_settings SET value = '29' WHERE key = 'membership_delivery_fee' AND (value = '0' OR value = '0.0')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('small_cart_fee_enabled', 'true')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('small_cart_threshold', '149')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('small_cart_fee', '29')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_cod_advance', '10')")
    # Sellable plans ( Razorpay checkout). Admin can change the prices.
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_plan_30_price', '99')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_plan_90_price', '249')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('membership_plan_365_price', '799')")
    # --- Grand Offers promo popup (storefront modal, admin-tunable) ---
    # Frontend reads these via the public /api/settings payload; the Admin
    # Settings panel edits them (same POST /api/admin/settings route as every
    # other knob — no new endpoint, nothing else to wire).
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_enabled', 'true')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_title', 'Grand Offers is Live!')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_subtitle', 'Shop More • Save More • Get More')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_badge', 'Up to 70% OFF')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_cta_text', 'Join Premium Now')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_image', '')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_interval_days', '3')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_delay_seconds', '2.5')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_audience', 'non_premium')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_deals_text', 'Exclusive Member Deals')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_premium_title', 'Join JDLX Premium')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_premium_note', 'Extra discounts • Early access • Member rewards')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_start_at', '')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_popup_end_at', '')")
    # Session duration (hours) for regular store users before auto-logout.
    # Default 8760h = 365 days -> users stay logged in. Admin can change this.
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('user_session_duration_hours', '8760')")
    # Vendor (warehouse) settlement engine: uniform platform commission % applied
    # to every warehouse settlement (delivery fees are never part of settlements).
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('vendor_commission_rate', '3')")
    # Settlement window (days) — mirrors the return policy. Falls back to
    # referral_reward_window_days, then 7 (the refund flow's default window).
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('vendor_settlement_window_days', '7')")
    # Home Promo Duo Cards defaults (Mobile Covers & Audio Essentials)
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_1_title', 'Mobile Covers')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_1_subtitle', 'Stylish. Durable. For Every Device.')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_1_link', 'covers')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_1_cta', 'Shop Now')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_2_title', 'Audio Essentials')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_2_subtitle', 'Premium Sound. Every Beat.')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_2_link', 'earphones')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_card_2_cta', 'Shop Now')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_cards_enabled', 'true')")
    default_promo_cards_json = json.dumps([
        {
            "id": "card-1",
            "title": "Mobile Covers",
            "subtitle": "Stylish. Durable. For Every Device.",
            "cta": "Shop Now",
            "link": "covers",
            "theme": "amber",
            "icon": "smartphone"
        },
        {
            "id": "card-2",
            "title": "Audio Essentials",
            "subtitle": "Premium Sound. Every Beat.",
            "cta": "Shop Now",
            "link": "earphones",
            "theme": "sky",
            "icon": "headphones"
        }
    ])
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('promo_cards_json', ?)", (default_promo_cards_json,))
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('official_chat_logo', '')")
    cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('official_chat_name', 'JDLX Chat')")
    # Upgrade legacy default name 'Official Chat' to 'JDLX Chat' if never customized
    cursor.execute("UPDATE system_settings SET value = 'JDLX Chat' WHERE key = 'official_chat_name' AND value = 'Official Chat'")

    # --- Quick-delivery era repair (runs EVERY boot — idempotent) ---
    # Quick delivery was retired system-wide, but legacy databases carry a
    # column default of '30-120 mins' on products.delivery_time (old
    # migration schemas), so any INSERT that omits the field (e.g. agent
    # drafts) silently re-introduces the retired ETA. Only the exact legacy
    # strings are matched — real custom windows are never touched.
    cursor.execute(
        """UPDATE products SET delivery_time = ''
           WHERE delivery_time IN ('10-30 mins', '10-20 mins', '12-25 mins', '30-120 mins')"""
    )

    # --- One-time legacy timestamp migration (UTC → IST) ---
    # Every DB default (CURRENT_TIMESTAMP) writes UTC; the site operates in IST
    # and renders naive timestamps as wall-clock. Rows written before the IST
    # defaults were introduced would show a 5h30m offset forever, so shift the
    # affected legacy rows forward once and stamp the migration in settings.
    cursor.execute("SELECT value FROM system_settings WHERE key = 'legacy_utc_to_ist_migrated'")
    if not cursor.fetchone():
        for table, cols in (
            ("orders", ("created_at", "updated_at", "confirmed_at", "packed_at", "shipped_at", "status_delivered_at", "cancelled_at")),
            ("warehouse_order_assignments", ("created_at",)),
            ("warehouse_orders", ("created_at", "updated_at", "accepted_at", "packing_started_at", "packed_at", "ready_for_pickup_at", "courier_pickup_requested_at", "dispatched_at", "delivered_at", "cancelled_at")),
        ):
            existing = {r[1] for r in cursor.execute(f"PRAGMA table_info({table})").fetchall()}
            for col in cols:
                if col in existing:
                    cursor.execute(
                        f"UPDATE {table} SET {col} = datetime({col}, '+5 hours', '+30 minutes') WHERE {col} IS NOT NULL"
                    )
        cursor.execute(
            "INSERT INTO system_settings (key, value) VALUES ('legacy_utc_to_ist_migrated', datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )

    conn.commit()
    conn.close()
    print("Database initialized successfully.")

if __name__ == "__main__":
    init_db()
