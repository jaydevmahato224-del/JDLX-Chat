"""A dead 'active' call row must not block a room for hours.

Reported symptom: tapping call turned the microphone on but the call never
started, and answer did nothing. The room still held an 'active' row from a
call whose peers were gone, so every offer got 409 "A call is already in
progress" until the 4-hour expiry. These tests pin the heartbeat behaviour that
fixes it.
"""

import time
import uuid

import pytest

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


def _insert_call(db, room_id, caller_id, callee_id, state, started_at, last_seen):
    cursor = db.execute(
        """INSERT INTO official_chat_calls
           (room_id, caller_id, callee_id, call_type, state, offer_sdp, candidates,
            started_at, last_seen)
           VALUES (?, ?, ?, 'voice', ?, 'v=0', '[]', ?, ?)""",
        (room_id, caller_id, callee_id, state, started_at, last_seen),
    )
    db.commit()
    return cursor.lastrowid


def _offer(client, room_id, headers):
    return client.post(
        f"/api/chat/rooms/{room_id}/call/offer",
        headers=headers,
        json={"call_type": "voice", "offer_sdp": "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n"},
    )


def test_abandoned_active_call_does_not_block_a_new_offer(client, db):
    alice = _chat_user(db, "Alice")
    bob = _chat_user(db, "Bob")
    room = _direct_room(db, alice, bob)
    now = int(time.time())

    stale_id = _insert_call(
        db, room, alice, bob, "active", started_at=now - 600, last_seen=now - 600
    )

    res = _offer(client, room, _headers(alice))
    assert res.status_code == 200, res.get_json()

    stale = db.execute(
        "SELECT state, ended_at FROM official_chat_calls WHERE id = ?", (stale_id,)
    ).fetchone()
    assert stale["state"] == "ended"
    assert stale["ended_at"] is not None

    ringing = db.execute(
        "SELECT state FROM official_chat_calls WHERE room_id = ? AND state = 'ringing'",
        (room,),
    ).fetchone()
    assert ringing is not None


def test_offer_wakes_the_callee_even_when_the_profile_has_no_name(client, db, monkeypatch):
    """The offer no longer SELECTs the caller's name (it comes from the token),
    and it wakes the callee's watcher instead of waiting out its 2s poll."""
    import chat_routes

    alice = _chat_user(db, "Alice")
    bob = _chat_user(db, "Bob")
    db.execute("UPDATE chat_users SET name = '', username = '' WHERE id = ?", (alice,))
    db.commit()
    room = _direct_room(db, alice, bob)

    sent = []
    monkeypatch.setattr(
        chat_routes, "broadcast_supabase_chat_event", lambda messages: sent.extend(messages)
    )

    assert _offer(client, room, _headers(alice)).status_code == 200

    assert sent, "the callee was never woken for the ringing call"
    topic, event, payload = sent[0]
    assert topic == f"chat_user_{bob}"
    assert event == "incoming_call"
    assert payload["room_id"] == room
    # Falls back to the verified token payload when the profile has no name.
    assert payload["caller_name"] == f"User {alice}"


def test_live_call_still_blocks_a_second_offer(client, db):
    alice = _chat_user(db, "Alice")
    bob = _chat_user(db, "Bob")
    room = _direct_room(db, alice, bob)
    now = int(time.time())

    _insert_call(db, room, alice, bob, "active", started_at=now - 30, last_seen=now)

    res = _offer(client, room, _headers(alice))
    assert res.status_code == 409, res.get_json()


def test_state_poll_refreshes_the_heartbeat(client, db):
    alice = _chat_user(db, "Alice")
    bob = _chat_user(db, "Bob")
    room = _direct_room(db, alice, bob)
    now = int(time.time())

    call_id = _insert_call(
        db, room, alice, bob, "active", started_at=now - 300, last_seen=now - 300
    )

    res = client.get(f"/api/chat/rooms/{room}/call/state", headers=_headers(alice))
    assert res.status_code == 200, res.get_json()
    assert res.get_json()["data"]["state"] == "active"

    refreshed = db.execute(
        "SELECT last_seen FROM official_chat_calls WHERE id = ?", (call_id,)
    ).fetchone()["last_seen"]
    assert int(refreshed) >= now - 5

    # The refreshed heartbeat keeps the room blocked for a second caller, i.e.
    # a running call is not ended by the next offer.
    assert _offer(client, room, _headers(alice)).status_code == 409
