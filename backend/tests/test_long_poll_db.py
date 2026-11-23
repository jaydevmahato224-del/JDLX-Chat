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
