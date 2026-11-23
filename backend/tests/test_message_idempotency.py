"""A retried send must never become a second message.

Production stored one "IHU" twice, with client message ids 18.5s apart: the
request deadline fired after the first POST had already committed, and the
retry generated a fresh idempotency key. The client now resends the original
key, so this pins the backend contract that fix depends on.
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
    # Direct rooms only accept messages between accepted friends.
    db.execute(
        """INSERT INTO official_chat_friend_requests (sender_id, receiver_id, status)
           VALUES (?, ?, 'accepted')""",
        (user_a, user_b),
    )
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


def test_same_client_message_id_is_stored_once(client, db):
    alice, bob = _chat_user(db, "Alice"), _chat_user(db, "Bob")
    room_id = _direct_room(db, alice, bob)
    payload = {"message": "IHU", "client_message_id": "c_retry_same_key"}

    first = client.post(f"/api/chat/rooms/{room_id}/messages", headers=_headers(alice), json=payload)
    retry = client.post(f"/api/chat/rooms/{room_id}/messages", headers=_headers(alice), json=payload)

    assert first.status_code == 200
    assert retry.status_code == 200

    rows = db.execute(
        "SELECT id FROM official_chat_messages WHERE room_id = ? AND user_id = ?",
        (room_id, alice),
    ).fetchall()
    assert len(rows) == 1, "the retry stored a second copy of the same send"

    # The retry must answer with the row that already exists, so the client can
    # reconcile its bubble instead of appending a duplicate.
    assert retry.get_json()["data"][0]["id"] == first.get_json()["data"][0]["id"]


def test_different_client_message_ids_are_both_stored(client, db):
    alice, bob = _chat_user(db, "Alice"), _chat_user(db, "Bob")
    room_id = _direct_room(db, alice, bob)
    headers = _headers(alice)

    for key in ("c_first", "c_second"):
        res = client.post(
            f"/api/chat/rooms/{room_id}/messages",
            headers=headers,
            json={"message": "ok", "client_message_id": key},
        )
        assert res.status_code == 200

    count = db.execute(
        "SELECT COUNT(*) AS c FROM official_chat_messages WHERE room_id = ? AND user_id = ?",
        (room_id, alice),
    ).fetchone()["c"]
    assert count == 2, "two deliberate sends of the same text must both be stored"
