import uuid
from urllib.parse import parse_qs, urlparse

import pytest
from jwt_config import get_jwt_secret
import jwt

def test_chat_sso_and_messaging(client, db):
    # Storefront identity is irrelevant to chat now, but keep a user row so the
    # isolation check below still exercises a real storefront session.
    user_row = db.execute("SELECT id, email FROM users LIMIT 1").fetchone()
    if not user_row:
        db.execute(
            "INSERT INTO users (google_id, name, email, role) VALUES ('test_gid', 'Test Customer', 'customer@example.com', 'user')"
        )
        db.commit()
        user_row = db.execute("SELECT id, email FROM users LIMIT 1").fetchone()

    user_id = user_row['id']
    email = user_row['email']

    secret = get_jwt_secret()
    user_token = jwt.encode({"user_id": user_id, "email": email, "role": "user"}, secret, algorithm="HS256")

    # 1. Storefront-SSO endpoints were removed with the chat/store separation
    res = client.post('/api/chat/auth/sso', headers={
        'Authorization': f'Bearer {user_token}'
    })
    assert res.status_code == 410

    # 2. Chat identity is created directly in chat_users (independent table) via
    #    the standalone phone/username login.
    res = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9811100001',
        'full_name': 'Support Flow One',
        'username': 'support_flow_1'
    })
    assert res.status_code == 200
    data = res.get_json()
    assert data['success'] is True
    chat_token = data['data']['chat_token']
    assert chat_token is not None
    chat_user_id = data['data']['user']['id']
    # Chat identity went into chat_users — the storefront users table stays
    # untouched (no row with this phone, count is unchanged).
    storefront_rows = db.execute("SELECT COUNT(*) AS c FROM users").fetchone()['c']
    store_phone_rows = db.execute(
        "SELECT COUNT(*) AS c FROM users WHERE phone = ?", ('9811100001',)
    ).fetchone()['c']
    assert store_phone_rows == 0
    del storefront_rows
    assert 'room' in data['data']
    room_id = data['data']['room']['id']

    # 2. Test fetching room messages (initially empty before chatting)
    res_msgs = client.get('/api/chat/messages', headers={
        'Authorization': f'Bearer {chat_token}'
    })
    assert res_msgs.status_code == 200
    msgs_data = res_msgs.get_json()
    assert msgs_data['success'] is True
    assert isinstance(msgs_data['data'], list)

    # 3. Test sending a message
    res_send = client.post('/api/chat/messages', headers={
        'Authorization': f'Bearer {chat_token}'
    }, json={
        'message': 'Where is my order? Need delivery tracking update.'
    })
    assert res_send.status_code == 200
    send_data = res_send.get_json()
    assert send_data['success'] is True
    # Should include user message and auto-reply from specialist
    assert any(m['sender_type'] == 'user' for m in send_data['data'])
    assert any(m['sender_type'] == 'specialist' for m in send_data['data'])

    # 4. Test notification isolation:
    # Isolated chat notifications should have rows
    res_chat_notifs = client.get('/api/chat/notifications', headers={
        'Authorization': f'Bearer {chat_token}'
    })
    assert res_chat_notifs.status_code == 200
    chat_notifs = res_chat_notifs.get_json()['data']
    assert len(chat_notifs) >= 1

    # Storefront notifications endpoint should NOT contain chat messages
    res_store_notifs = client.get('/api/notifications', headers={
        'Authorization': f'Bearer {user_token}'
    })
    assert res_store_notifs.status_code == 200
    store_notifs = res_store_notifs.get_json()['data']
    for notif in store_notifs:
        assert notif.get('type') != 'OFFICIAL_CHAT'

    # Test unread count endpoint
    res_unread = client.get('/api/chat/unread-count', headers={
        'Authorization': f'Bearer {chat_token}'
    })
    assert res_unread.status_code == 200
    assert 'unread_messages' in res_unread.get_json()['data']

    # Test mark notification as read
    first_nid = chat_notifs[0]['id']
    res_mark = client.post(f'/api/chat/notifications/{first_nid}/read', headers={
        'Authorization': f'Bearer {chat_token}'
    })
    assert res_mark.status_code == 200

    # Test delete notification
    res_del = client.delete(f'/api/chat/notifications/{first_nid}', headers={
        'Authorization': f'Bearer {chat_token}'
    })
    assert res_del.status_code == 200


def test_chat_login_mobile_mandatory_fields_and_search(client, db):
    # 1. Missing full name should fail with 400
    res1 = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9876543210',
        'username': 'rahul_sharma'
    })
    assert res1.status_code == 400
    assert "Full Name is mandatory" in res1.get_json()['message']

    # 2. Missing username should fail with 400 (regex check runs first)
    res2 = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9876543210',
        'full_name': 'Rahul Sharma'
    })
    assert res2.status_code == 400
    assert "Username must be 3-30 characters" in res2.get_json()['message']

    # 3. Invalid characters in username should fail with 400
    res3 = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9876543210',
        'full_name': 'Rahul Sharma',
        'username': 'rahul sharma!'
    })
    assert res3.status_code == 400
    assert "Username must be 3-30 characters" in res3.get_json()['message']

    # 4. Successful registration with full name, username, and mobile
    res4 = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9876543210',
        'full_name': 'Rahul Sharma',
        'username': '@rahul_dev'
    })
    assert res4.status_code == 200
    data4 = res4.get_json()
    assert data4['success'] is True
    assert data4['data']['user']['name'] == 'Rahul Sharma'
    assert data4['data']['user']['username'] == 'rahul_dev'
    token_rahul = data4['data']['chat_token']

    # 5. Duplicate username from a different phone number should fail with 409
    res5 = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9123456789',
        'full_name': 'Another Rahul',
        'username': 'rahul_dev'
    })
    assert res5.status_code == 409
    assert "already taken" in res5.get_json()['message']

    # 6. Create a second user and test search functionality
    res6 = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9123456789',
        'full_name': 'Pooja Verma',
        'username': 'pooja_v'
    })
    assert res6.status_code == 200

    # Search for Pooja using Rahul's token
    res_search = client.get('/api/chat/users/search?q=pooja', headers={
        'Authorization': f'Bearer {token_rahul}'
    })
    assert res_search.status_code == 200
    users_found = res_search.get_json()['data']
    assert any(u['username'] == 'pooja_v' for u in users_found)

    # Search by @handle
    res_search_handle = client.get('/api/chat/users/search?q=@pooja_v', headers={
        'Authorization': f'Bearer {token_rahul}'
    })
    assert res_search_handle.status_code == 200
    users_found_handle = res_search_handle.get_json()['data']
    assert any(u['username'] == 'pooja_v' for u in users_found_handle)


def test_refresh_rotation_and_legacy_sso_gone(client, db):
    # Register a standalone chat identity (chat_users — separate from users)
    res_reg = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9811100002',
        'full_name': 'Refresh Flow One',
        'username': 'refresh_flow_1'
    })
    assert res_reg.status_code == 200
    reg_data = res_reg.get_json()['data']
    chat_token = reg_data['chat_token']
    chat_user_id = reg_data['user']['id']

    # 1-3. Legacy storefront-profile SSO endpoints are permanently removed
    for legacy_path in ('/api/chat/auth/profile-preview', '/api/chat/auth/sso', '/api/chat/auth/sso/grant-code'):
        res_legacy = client.post(legacy_path, headers={
            'Authorization': f'Bearer {chat_token}'
        })
        assert res_legacy.status_code == 410, legacy_path

    # 4. Test Short-Lived Token Refresh & Rotation (still active for chat identity)
    refresh_token = reg_data['refresh_token']
    res_refresh = client.post('/api/chat/auth/refresh', json={
        'refresh_token': refresh_token
    })
    assert res_refresh.status_code == 200
    refreshed_data = res_refresh.get_json()['data']
    assert refreshed_data['chat_token'] is not None
    assert refreshed_data['refresh_token'] is not None
    assert refreshed_data['user']['id'] == chat_user_id


def test_user_to_user_chat_and_friends(client, db):
    # 1. Register User A (Alice Suite)
    res_a = client.post('/api/chat/auth/login-mobile', json={
        'phone': '8881112222',
        'full_name': 'Alice Suite',
        'username': 'alice_suite_1'
    })
    assert res_a.status_code == 200
    token_a = res_a.get_json()['data']['chat_token']
    user_a = res_a.get_json()['data']['user']

    # 2. Register User B (Bob Suite)
    res_b = client.post('/api/chat/auth/login-mobile', json={
        'phone': '8883334444',
        'full_name': 'Bob Suite',
        'username': 'bob_suite_1'
    })
    assert res_b.status_code == 200
    token_b = res_b.get_json()['data']['chat_token']
    user_b = res_b.get_json()['data']['user']

    # 3. Alice searches for Bob globally
    res_search = client.get('/api/chat/users/search?q=bob_suite', headers={'Authorization': f'Bearer {token_a}'})
    assert res_search.status_code == 200
    search_data = res_search.get_json()['data']
    assert any(u['username'] == 'bob_suite_1' for u in search_data)
    bob_found = next(u for u in search_data if u['username'] == 'bob_suite_1')
    assert bob_found['friend_status'] == 'none'

    # 4. Alice sends friend request to Bob
    res_freq = client.post('/api/chat/friends/request', headers={'Authorization': f'Bearer {token_a}'}, json={
        'target_user_id': user_b['id']
    })
    assert res_freq.status_code == 200
    assert res_freq.get_json()['success'] is True

    # 5. Bob checks friends: should see Alice in incoming_requests
    res_b_friends = client.get('/api/chat/friends', headers={'Authorization': f'Bearer {token_b}'})
    assert res_b_friends.status_code == 200
    friends_b_data = res_b_friends.get_json()['data']
    assert len(friends_b_data['incoming_requests']) >= 1
    incoming_req = next(r for r in friends_b_data['incoming_requests'] if r['username'] == 'alice_suite_1')

    # 6. Bob accepts friend request
    res_accept = client.post('/api/chat/friends/respond', headers={'Authorization': f'Bearer {token_b}'}, json={
        'request_id': incoming_req['request_id'],
        'action': 'accept'
    })
    assert res_accept.status_code == 200
    room_id = res_accept.get_json()['data']['room_id']

    # 7. Alice and Bob now have an active direct conversation thread in their WhatsApp-style inbox
    res_a_convs = client.get('/api/chat/conversations', headers={'Authorization': f'Bearer {token_a}'})
    assert res_a_convs.status_code == 200
    convs_a = res_a_convs.get_json()['data']
    assert any(c['id'] == room_id for c in convs_a)
    alice_thread = next(c for c in convs_a if c['id'] == room_id)
    assert alice_thread['contact_username'] == 'bob_suite_1'

    # 8. Alice sends message to Bob in this 1-to-1 direct room
    res_msg_a = client.post(f'/api/chat/rooms/{room_id}/messages', headers={'Authorization': f'Bearer {token_a}'}, json={
        'message': 'Hey Bob! Welcome to Official Chat like WhatsApp!'
    })
    assert res_msg_a.status_code == 200
    msgs = res_msg_a.get_json()['data']
    assert any(m['message'] == 'Hey Bob! Welcome to Official Chat like WhatsApp!' for m in msgs)

    # 9. Bob retrieves messages from this direct room
    res_msg_b = client.get(f'/api/chat/rooms/{room_id}/messages', headers={'Authorization': f'Bearer {token_b}'})
    assert res_msg_b.status_code == 200
    msgs_b = res_msg_b.get_json()['data']
    assert any(m['message'] == 'Hey Bob! Welcome to Official Chat like WhatsApp!' for m in msgs_b)

    # 10. Test invite info
    res_invite = client.get('/api/chat/invite-info', headers={'Authorization': f'Bearer {token_a}'})
    assert res_invite.status_code == 200
    invite_data = res_invite.get_json()['data']
    assert invite_data['username'] == 'alice_suite_1'
    assert 'invite_url' in invite_data
    assert 'share_text' in invite_data


def test_login_mobile_cannot_take_over_existing_account(client, db):
    """Regression: knowing a mobile number must never let somebody overwrite
    that account's name/username/password and receive a chat token."""
    # Real registration (password checked on login)
    res_reg = client.post('/api/chat/auth/register', json={
        'full_name': 'Victim User',
        'username': 'victim_user',
        'phone': '9865000001',
        'password': 'realpass123'
    })
    assert res_reg.status_code == 201
    victim_id = res_reg.get_json()['data']['user']['id']

    # Attacker knows only the phone number and posts a takeover payload
    res_attack = client.post('/api/chat/auth/login-mobile', json={
        'full_name': 'Attacker Name',
        'username': 'attacker_x',
        'phone': '9865000001',
        'password': 'attackerpass'
    })
    assert res_attack.status_code == 409
    assert not (res_attack.get_json().get('data') or {}).get('chat_token')

    # Victim's account is untouched and the attacker's password does not work
    res_login = client.post('/api/chat/auth/login', json={
        'identifier': '9865000001',
        'password': 'realpass123'
    })
    assert res_login.status_code == 200
    logged_in = res_login.get_json()['data']['user']
    assert logged_in['id'] == victim_id
    assert logged_in['username'] == 'victim_user'
    assert logged_in['name'] == 'Victim User'

    res_attacker_login = client.post('/api/chat/auth/login', json={
        'identifier': '9865000001',
        'password': 'attackerpass'
    })
    assert res_attacker_login.status_code == 401


def test_cross_realm_tokens_rejected_by_chat(client, db):
    """Chat and Store share one JWT secret; only type=official_chat may pass."""
    res_reg = client.post('/api/chat/auth/register', json={
        'full_name': 'Realm Guard',
        'username': 'realm_guard',
        'phone': '9865000002',
        'password': 'realmrealm'
    })
    assert res_reg.status_code == 201
    reg = res_reg.get_json()['data']
    chat_token = reg['chat_token']
    refresh_token = reg['refresh_token']
    chat_user_id = reg['user']['id']

    # Genuine chat access token still works
    res_ok = client.get('/api/chat/conversations', headers={'Authorization': f'Bearer {chat_token}'})
    assert res_ok.status_code == 200

    # Storefront-style token for the same numeric id must not authenticate
    secret = get_jwt_secret()
    store_token = jwt.encode(
        {'user_id': chat_user_id, 'email': 'realm@example.com', 'role': 'user',
         # Admin endpoints now require exp; this token is validly signed but
         # still must lose on role, not on expiry.
         'exp': 9999999999},
        secret,
        algorithm='HS256'
    )
    res_store = client.get('/api/chat/conversations', headers={'Authorization': f'Bearer {store_token}'})
    assert res_store.status_code == 401

    # A refresh token cannot be replayed as an access token
    res_refresh = client.get('/api/chat/conversations', headers={'Authorization': f'Bearer {refresh_token}'})
    assert res_refresh.status_code == 401

    # Chat tokens (and typeless store tokens) never reach admin endpoints
    res_admin_chat = client.get('/api/chat/admin/stats', headers={'Authorization': f'Bearer {chat_token}'})
    assert res_admin_chat.status_code == 403
    res_admin_store = client.get('/api/chat/admin/stats', headers={'Authorization': f'Bearer {store_token}'})
    assert res_admin_store.status_code == 403


def test_search_and_conversations_do_not_leak_email_or_phone(client, db):
    """Search, inbox and friend list must never expose another user's PII."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'privacypass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    searcher = register('Privacy Searcher', 'privacy_searcher', '9865000011')
    target = register('Privacy Target', 'privacy_target', '9865000012')

    auth_searcher = {'Authorization': f"Bearer {searcher['chat_token']}"}
    auth_target = {'Authorization': f"Bearer {target['chat_token']}"}

    # 1. Name/username search returns no email or phone
    res = client.get('/api/chat/users/search?q=privacy_target', headers=auth_searcher)
    assert res.status_code == 200
    found = next(u for u in res.get_json()['data'] if u['username'] == 'privacy_target')
    assert 'email' not in found
    assert 'phone' not in found

    # 2. Exact full-number lookup still works, but stays PII-free
    res_phone = client.get('/api/chat/users/search?q=9865000012', headers=auth_searcher)
    assert res_phone.status_code == 200
    phone_hits = res_phone.get_json()['data']
    assert any(u['username'] == 'privacy_target' for u in phone_hits)
    assert all('phone' not in u and 'email' not in u for u in phone_hits)

    # 3. Phone PREFIX search must not reveal the account (no enumeration)
    res_prefix = client.get('/api/chat/users/search?q=986500', headers=auth_searcher)
    assert res_prefix.status_code == 200
    assert not any(u['username'] == 'privacy_target' for u in res_prefix.get_json()['data'])

    # 4. A DM now requires an accepted friend request; connect first
    res_req = client.post('/api/chat/friends/request', headers=auth_target, json={'username': 'privacy_searcher'})
    request_id = res_req.get_json()['data']['request_id']
    res_acc = client.post('/api/chat/friends/respond', headers=auth_searcher, json={
        'request_id': request_id, 'action': 'accept'
    })
    assert res_acc.status_code == 200

    # 5. Inbox payload hides the other participant's email/phone
    res_open = client.post(f"/api/chat/direct-chat/{target['user']['id']}", headers=auth_searcher)
    assert res_open.status_code == 200
    convs = client.get('/api/chat/conversations', headers=auth_searcher).get_json()['data']
    other_user = next(c['other_user'] for c in convs if c['other_user']['id'] == target['user']['id'])
    assert 'email' not in other_user
    assert 'phone' not in other_user

    # 6. Friends list hides phone numbers
    friends = client.get('/api/chat/friends', headers=auth_searcher).get_json()['data']['friends']
    assert any(f['friend_id'] == target['user']['id'] for f in friends)
    assert all('phone' not in f and 'email' not in f for f in friends)


def test_direct_chat_requires_accepted_friend_request(client, db):
    """Nobody can force a DM on a stranger: a new thread needs an accepted
    friend request (the endpoint used to auto-accept it itself)."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'consentpass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    sender = register('Consent Sender', 'consent_sender', '9865000021')
    stranger = register('Consent Stranger', 'consent_stranger', '9865000022')
    auth = {'Authorization': f"Bearer {sender['chat_token']}"}

    # Direct chat before consent -> 403, and nothing is silently connected
    res = client.post(f"/api/chat/direct-chat/{stranger['user']['id']}", headers=auth)
    assert res.status_code == 403
    assert 'friend request' in res.get_json()['message'].lower()

    friends = client.get('/api/chat/friends', headers=auth).get_json()['data']['friends']
    assert not any(f['friend_id'] == stranger['user']['id'] for f in friends)
    convs = client.get('/api/chat/conversations', headers=auth).get_json()['data']
    assert not convs

    # After acceptance the thread opens
    req = client.post('/api/chat/friends/request', headers=auth, json={
        'target_user_id': stranger['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    client.post('/api/chat/friends/respond', headers={
        'Authorization': f"Bearer {stranger['chat_token']}"
    }, json={'request_id': req_id, 'action': 'accept'})

    res_ok = client.post(f"/api/chat/direct-chat/{stranger['user']['id']}", headers=auth)
    assert res_ok.status_code == 200


def test_chat_logout_revokes_access_and_refresh_tokens(client, db):
    """Logout must revoke the 1-hour access token AND the 14-day refresh token."""
    import time as _time

    res_reg = client.post('/api/chat/auth/register', json={
        'full_name': 'Logout User', 'username': 'logout_user',
        'phone': '9865000031', 'password': 'logoutpass'
    })
    assert res_reg.status_code == 201
    data = res_reg.get_json()['data']
    token, refresh = data['chat_token'], data['refresh_token']
    auth = {'Authorization': f'Bearer {token}'}

    assert client.get('/api/chat/auth/session', headers=auth).status_code == 200

    # iat has second precision: step past the issue second so the revocation
    # timestamp is strictly newer than the token.
    _time.sleep(1.1)
    res_out = client.post('/api/chat/auth/logout', headers=auth, json={'refresh_token': refresh})
    assert res_out.status_code == 200

    # Access token dead
    assert client.get('/api/chat/auth/session', headers=auth).status_code == 401
    assert client.get('/api/chat/conversations', headers=auth).status_code == 401

    # Refresh token dead too
    res_refresh = client.post('/api/chat/auth/refresh', json={'refresh_token': refresh})
    assert res_refresh.status_code == 401

    # A fresh login works again
    res_login = client.post('/api/chat/auth/login', json={
        'identifier': '9865000031', 'password': 'logoutpass'
    })
    assert res_login.status_code == 200
    new_auth = {'Authorization': f"Bearer {res_login.get_json()['data']['chat_token']}"}
    assert client.get('/api/chat/auth/session', headers=new_auth).status_code == 200


def test_chat_rate_limit_is_enforced(client, db):
    """The limiter counts per user in the DB and returns 429 past the cap."""
    import os

    res_reg = client.post('/api/chat/auth/register', json={
        'full_name': 'Rate User', 'username': 'rate_user',
        'phone': '9865000041', 'password': 'ratepass123'
    })
    assert res_reg.status_code == 201
    auth = {'Authorization': f"Bearer {res_reg.get_json()['data']['chat_token']}"}

    # conftest disables the limiter for the rest of the suite; enable it for
    # this one check only (the app-wide shield stays bypassed: it reads the
    # value once at import time).
    os.environ.pop('DISABLE_RATE_LIMIT', None)
    try:
        statuses = [
            client.post('/api/chat/direct-chat/999999', headers=auth).status_code
            for _ in range(31)
        ]
    finally:
        os.environ['DISABLE_RATE_LIMIT'] = '1'

    # 30 allowed attempts (unknown user -> 404), then the limiter kicks in.
    assert statuses[:30] == [404] * 30
    assert statuses[-1] == 429


def test_invite_link_ignores_spoofed_origin(client, db):
    """Invite links must never be built from an attacker-controlled Origin."""
    res_reg = client.post('/api/chat/auth/register', json={
        'full_name': 'Invite User', 'username': 'invite_user',
        'phone': '9865000051', 'password': 'invitepass'
    })
    assert res_reg.status_code == 201
    auth = {'Authorization': f"Bearer {res_reg.get_json()['data']['chat_token']}"}

    evil = client.get('/api/chat/invite-info', headers={**auth, 'Origin': 'https://evil.example'})
    assert evil.status_code == 200
    evil_url = evil.get_json()['data']['invite_url']
    assert 'evil.example' not in evil_url

    trusted = client.get('/api/chat/invite-info', headers={
        **auth, 'Origin': 'https://jdlx-chat.vercel.app'
    })
    trusted_url = trusted.get_json()['data']['invite_url']

    # A spoofed Origin must not change what we hand out.
    assert evil_url == trusted_url
    assert evil_url.endswith('/chat/login?ref=@invite_user')


def test_chat_upload_validates_content_and_room(client, db):
    """Uploads: real image bytes only, canonical MIME, caller's own room."""
    import io

    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'uploadpass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    uploader = register('Upload Owner', 'upload_owner', '9865000061')
    other = register('Upload Other', 'upload_other', '9865000062')
    auth = {'Authorization': f"Bearer {uploader['chat_token']}"}
    other_auth = {'Authorization': f"Bearer {other['chat_token']}"}

    own_room = client.get('/api/chat/room', headers=auth).get_json()['data']['id']
    other_room = client.get('/api/chat/room', headers=other_auth).get_json()['data']['id']

    png_bytes = b'\x89PNG\r\n\x1a\n' + b'0' * 32

    def upload(payload, name, room_id=None):
        data = {'file': (io.BytesIO(payload), name)}
        if room_id is not None:
            data['room_id'] = str(room_id)
        return client.post(
            '/api/chat/upload', headers=auth, data=data, content_type='multipart/form-data'
        )

    # 1. room_id is mandatory
    assert upload(png_bytes, 'photo.png').status_code == 400

    # 2. Cannot upload into someone else's room
    assert upload(png_bytes, 'photo.png', other_room).status_code == 403

    # 3. HTML/JS disguised as an image is rejected by the magic-byte check
    assert upload(b'<script>alert(1)</script>', 'evil.png', own_room).status_code == 400

    # 4. A real PNG is accepted and stored with the canonical server-side MIME
    ok = upload(png_bytes, 'photo.png', own_room)
    assert ok.status_code == 200
    stored = ok.get_json()['data']['filename']
    row = db.execute("SELECT mime_type FROM uploaded_media WHERE filename = ?", (stored,)).fetchone()
    assert row['mime_type'] == 'image/png'


def test_chat_media_upload_audio_video_and_kind_validation(client, db):
    """Voice/audio/video uploads use magic-byte validation + per-kind limits."""
    import io

    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'mediapass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Media Alice', 'media_alice', '9865000161')
    bob = register('Media Bob', 'media_bob', '9865000162')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    def upload(payload, name, kind):
        return client.post(
            '/api/chat/upload',
            headers=auth_a,
            data={'file': (io.BytesIO(payload), name), 'room_id': str(room_id), 'kind': kind},
            content_type='multipart/form-data'
        )

    # OGG audio (voice note)
    ogg = upload(b'OggS' + b'\x00' * 64, 'voice.ogg', 'audio')
    assert ogg.status_code == 200
    ogg_data = ogg.get_json()['data']
    assert ogg_data['mime_type'] == 'audio/ogg'
    assert ogg_data['media_kind'] == 'audio'
    row = db.execute(
        "SELECT mime_type FROM uploaded_media WHERE filename = ?", (ogg_data['filename'],)
    ).fetchone()
    assert row['mime_type'] == 'audio/ogg'

    # M4A audio (iOS Safari voice note / AAC)
    m4a = upload(b'\x00\x00\x00\x18ftypM4A ' + b'\x00' * 32, 'voice.m4a', 'audio')
    assert m4a.status_code == 200
    m4a_data = m4a.get_json()['data']
    assert m4a_data['mime_type'] == 'audio/mp4'
    assert m4a_data['media_kind'] == 'audio'

    # iOS Safari recorded voice note in MP4 container declared as audio
    safari_voice = upload(b'\x00\x00\x00\x18ftypisom' + b'\x00' * 32, 'voice.m4a', 'audio')
    assert safari_voice.status_code == 200
    assert safari_voice.get_json()['data']['mime_type'] == 'audio/mp4'

    # MP4 video
    mp4 = upload(b'\x00\x00\x00\x18ftypisom' + b'\x00' * 32, 'clip.mp4', 'video')
    assert mp4.status_code == 200
    assert mp4.get_json()['data']['mime_type'] == 'video/mp4'

    # PDF document
    pdf = upload(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n' + b'\x00' * 32, 'contract.pdf', 'document')
    assert pdf.status_code == 200
    assert pdf.get_json()['data']['mime_type'] == 'application/pdf'
    assert pdf.get_json()['data']['media_kind'] == 'document'
    # Fake PDF rejected
    assert upload(b'<script>alert(1)</script>', 'fake.pdf', 'document').status_code == 400

    # Content must match the declared kind (no HTML/executable disguised as media)
    assert upload(b'<script>alert(1)</script>', 'fake.mp4', 'video').status_code == 400
    assert upload(b'\x00\x00\x00\x18ftypisom' + b'\x00' * 32, 'clip.mp4', 'image').status_code == 400
    assert upload(b'OggS' + b'\x00' * 16, 'voice.mp3', 'audio').status_code == 400
    # MP4/EBML content counts as video, never audio
    assert upload(b'\x1aE\xdf\xa3' + b'\x00' * 16, 'voice.webm', 'audio').status_code == 400


def test_admin_room_status_validates_input(client, db, make_user, mint_token):
    """Unknown room -> 404 (was a 500), bad status -> 400, valid -> persisted."""
    admin_id = make_user(email='chat_status_admin@example.com', role='admin', name='Status Admin')
    admin_token = mint_token(admin_id, role='admin')
    auth = {'Authorization': f'Bearer {admin_token}'}

    # 1. Missing room: clean 404 instead of the old dict(None) crash
    res = client.patch('/api/chat/admin/rooms/999999/status', headers=auth, json={'status': 'closed'})
    assert res.status_code == 404

    # Real room to update
    reg = client.post('/api/chat/auth/register', json={
        'full_name': 'Status Target', 'username': 'status_target',
        'phone': '9865000071', 'password': 'statuspass'
    })
    assert reg.status_code == 201
    user_auth = {'Authorization': f"Bearer {reg.get_json()['data']['chat_token']}"}
    room_id = client.get('/api/chat/room', headers=user_auth).get_json()['data']['id']

    # 2. Empty payload and unknown status are rejected
    assert client.patch(f'/api/chat/admin/rooms/{room_id}/status', headers=auth, json={}).status_code == 400
    bad = client.patch(f'/api/chat/admin/rooms/{room_id}/status', headers=auth, json={'status': 'deleted'})
    assert bad.status_code == 400

    # 3. Valid status persists
    ok = client.patch(f'/api/chat/admin/rooms/{room_id}/status', headers=auth, json={'status': 'closed'})
    assert ok.status_code == 200
    assert ok.get_json()['data']['status'] == 'closed'

    # 4. Over-long specialist name rejected, empty clears the assignment
    long_name = 'x' * 200
    assert client.patch(
        f'/api/chat/admin/rooms/{room_id}/status', headers=auth,
        json={'assigned_specialist': long_name}
    ).status_code == 400
    cleared = client.patch(
        f'/api/chat/admin/rooms/{room_id}/status', headers=auth,
        json={'assigned_specialist': ''}
    )
    assert cleared.status_code == 200


def test_admin_token_requires_live_unexpired_admin(client, db, make_user, mint_token):
    """Admin auth: Bearer-only, exp required, and DB role/status re-checked."""
    admin_id = make_user(email='chat_live_admin@example.com', role='admin', name='Live Admin')
    good = mint_token(admin_id, role='admin')
    auth = {'Authorization': f'Bearer {good}'}
    assert client.get('/api/chat/admin/settings', headers=auth).status_code == 200

    # 1. Cookie-only sessions are not accepted (CSRF protection)
    cookie_only = client.get(
        '/api/chat/admin/settings', headers={'Cookie': f'admin_token={good}'}
    )
    assert cookie_only.status_code == 401

    # 2. Tokens without an expiry are rejected outright
    no_exp = jwt.encode(
        {'user_id': admin_id, 'role': 'admin'}, get_jwt_secret(), algorithm='HS256'
    )
    assert client.get(
        '/api/chat/admin/settings', headers={'Authorization': f'Bearer {no_exp}'}
    ).status_code == 401

    # 3. Other token realms (chat/warehouse) never reach the admin panel
    chat_realm = mint_token(admin_id, role='admin', type='official_chat_access')
    assert client.get(
        '/api/chat/admin/settings', headers={'Authorization': f'Bearer {chat_realm}'}
    ).status_code == 403

    # 4. Unknown subject -> 403 even with a valid signature/role claim
    ghost = mint_token(999999, role='admin')
    assert client.get(
        '/api/chat/admin/settings', headers={'Authorization': f'Bearer {ghost}'}
    ).status_code == 403

    # 5. Demotion takes effect immediately for already-issued tokens
    db.execute("UPDATE users SET role = 'user' WHERE id = ?", (admin_id,))
    db.commit()
    assert client.get('/api/chat/admin/settings', headers=auth).status_code == 403


def test_unread_count_includes_direct_and_support_messages(client, db):
    """Badge counts DMs for BOTH participants and specialist replies."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'unreadpass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Unread Alice', 'unread_alice', '9865000081')
    bob = register('Unread Bob', 'unread_bob', '9865000082')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}

    # Connect (accepting creates the DM room); Bob ends up as user_two_id
    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    for text in ('first ping', 'second ping'):
        res = client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={'message': text})
        assert res.status_code == 200

    bob_unread = client.get('/api/chat/unread-count', headers=auth_b).get_json()['data']
    assert bob_unread['unread_messages'] == 2

    # My own outgoing messages are never unread for me
    alice_unread = client.get('/api/chat/unread-count', headers=auth_a).get_json()['data']
    assert alice_unread['unread_messages'] == 0

    # Legacy support room: the auto specialist reply counts for the customer
    client.post('/api/chat/messages', headers=auth_a, json={'message': 'order status please'})
    support_unread = client.get('/api/chat/unread-count', headers=auth_a).get_json()['data']
    assert support_unread['unread_messages'] >= 1


def test_room_messages_pagination_and_incremental_polling(client, db):
    """Polling fetches only new messages; history is paged, never re-sent whole."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'pagepass123'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Page Alice', 'page_alice', '9865000091')
    bob = register('Page Bob', 'page_bob', '9865000092')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    sent_ids = []
    for text in ('msg0', 'msg1', 'msg2'):
        res = client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={'message': text})
        assert res.status_code == 200
        payload = res.get_json()['data']
        # Send responds with ONLY the new message (not the whole history)
        assert len(payload) == 1
        assert payload[0]['message'] == text
        sent_ids.append(payload[0]['id'])

    # Incremental poll: only messages newer than the client's newest id
    inc = client.get(
        f'/api/chat/rooms/{room_id}/messages?after_id={sent_ids[0]}', headers=auth_b
    ).get_json()['data']
    assert [m['message'] for m in inc] == ['msg1', 'msg2']

    # Initial page = newest N (ascending); older page = before_id
    page = client.get(f'/api/chat/rooms/{room_id}/messages?limit=2', headers=auth_b).get_json()['data']
    assert [m['message'] for m in page] == ['msg1', 'msg2']

    older = client.get(
        f'/api/chat/rooms/{room_id}/messages?before_id={sent_ids[1]}', headers=auth_b
    ).get_json()['data']
    assert [m['message'] for m in older] == ['msg0']


def test_realtime_events_typing_presence_and_read_receipts(client, db):
    """Long-poll returns new messages, typing state and ✓✓ read receipts."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'realtimepass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('RT Alice', 'rt_alice', '9865000131')
    bob = register('RT Bob', 'rt_bob', '9865000132')
    carol = register('RT Carol', 'rt_carol', '9865000133')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}
    auth_c = {'Authorization': f"Bearer {carol['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    # Outsiders cannot read events or fake typing in this room
    assert client.get(f'/api/chat/rooms/{room_id}/events?timeout=1', headers=auth_c).status_code == 403
    assert client.post(f'/api/chat/rooms/{room_id}/typing', headers=auth_c).status_code == 403
    assert client.get(
        f'/api/chat/rooms/{room_id}/events?timeout=1', headers=auth_c
    ).status_code == 403

    # Typing indicator reaches the peer on the next long-poll
    assert client.post(f'/api/chat/rooms/{room_id}/typing', headers=auth_b).status_code == 200
    typing_ev = client.get(
        f'/api/chat/rooms/{room_id}/events?after_message_id=0&timeout=1', headers=auth_a
    ).get_json()['data']
    assert typing_ev['peer_typing'] is True

    # A message arrives through the event stream; reading it updates the receipt
    sent = client.post(
        f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={'message': 'realtime hi'}
    ).get_json()['data'][0]
    bob_ev = client.get(
        f'/api/chat/rooms/{room_id}/events?after_message_id=0&timeout=1', headers=auth_b
    ).get_json()['data']
    assert sent['id'] in [m['id'] for m in bob_ev['messages']]

    alice_ev = client.get(
        f'/api/chat/rooms/{room_id}/events?after_message_id={sent["id"]}'
        f'&typing=1&last_read_id=0&timeout=1',
        headers=auth_a
    ).get_json()['data']
    assert alice_ev['peer_last_read_id'] == sent['id']
    assert alice_ev['peer_online'] is True


def test_clear_conversation_is_room_scoped_and_per_user(client, db):
    """Clear must hit the open room and only hide history for the caller."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'clearpass123'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Clear Alice', 'clear_alice', '9865000101')
    bob = register('Clear Bob', 'clear_bob', '9865000102')
    carol = register('Clear Carol', 'clear_carol', '9865000103')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}
    auth_c = {'Authorization': f"Bearer {carol['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    for text in ('hello bob', 'second line'):
        assert client.post(
            f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={'message': text}
        ).status_code == 200

    # Bob has 2 unread DMs before clearing
    assert client.get('/api/chat/unread-count', headers=auth_b).get_json()['data']['unread_messages'] == 2

    # Outsider cannot clear somebody else's room; missing room is a clean 404
    assert client.post(f'/api/chat/rooms/{room_id}/clear', headers=auth_c).status_code == 403
    assert client.post('/api/chat/rooms/999999/clear', headers=auth_a).status_code == 404

    # Bob clears: his view empties, unread resets, Alice's copy is untouched
    assert client.post(f'/api/chat/rooms/{room_id}/clear', headers=auth_b).status_code == 200
    bob_msgs = client.get(f'/api/chat/rooms/{room_id}/messages', headers=auth_b).get_json()['data']
    assert bob_msgs == []
    assert client.get('/api/chat/unread-count', headers=auth_b).get_json()['data']['unread_messages'] == 0

    alice_msgs = client.get(f'/api/chat/rooms/{room_id}/messages', headers=auth_a).get_json()['data']
    assert [m['message'] for m in alice_msgs] == ['hello bob', 'second line']

    # A later message is visible to Bob again (watermark is not a block)
    assert client.post(
        f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={'message': 'after clear'}
    ).status_code == 200
    bob_after = client.get(f'/api/chat/rooms/{room_id}/messages', headers=auth_b).get_json()['data']
    assert [m['message'] for m in bob_after] == ['after clear']


def test_username_enumeration_is_throttled(client, db):
    """Unauthenticated handle lookups stop at the per-IP cap instead of scanning."""
    import os

    os.environ.pop('DISABLE_RATE_LIMIT', None)
    try:
        statuses = [
            client.get(
                '/api/chat/auth/check-username',
                query_string={'username': f'scan_user_{i}'}
            ).status_code
            for i in range(21)
        ]
    finally:
        os.environ['DISABLE_RATE_LIMIT'] = '1'

    assert statuses[:20] == [200] * 20
    assert statuses[-1] == 429


def test_e2ee_v2_public_keys_and_server_blind_messages(client, db):
    """v2 E2EE: server stores only public keys and never gets a DM key."""
    # Valid P-256 SPKI public keys (91-byte DER, base64). Public keys only.
    pub_a = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjrdfsb7+1lgQkfXNZ1JkUt+bVz8eUeSi4Kh3e3Q63rWB6LMSmP9kizygHpVcDvMkyA+y+ieeABaTUYVoOZpieQ=='
    pub_b = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUAGj5oIUwKaA7q3Au1y8hdz6youS6wQWLMeOyNbBqSjAyLhXTSyyWMdP7DdiBDI2IZWMQv43VTWI4W/uGQNgEQ=='

    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'e2epass123'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('E2E Alice', 'e2e_alice_v2', '9865000121')
    bob = register('E2E Bob', 'e2e_bob_v2', '9865000122')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    # 1. Each device publishes its PUBLIC key; garbage is rejected
    assert client.post('/api/chat/keys', headers=auth_a, json={'public_key': pub_a}).status_code == 200
    assert client.post('/api/chat/keys', headers=auth_b, json={'public_key': pub_b}).status_code == 200
    assert client.post(
        '/api/chat/keys', headers=auth_a, json={'public_key': 'not-a-key'}
    ).status_code == 400

    # 2. Server stores only the public key, nothing private/derivable
    stored = db.execute(
        "SELECT public_key FROM chat_users WHERE id = ?", (alice['user']['id'],)
    ).fetchone()['public_key']
    assert stored == pub_a

    # 3. The peer's public key is exposed to the other participant
    convs = client.get('/api/chat/conversations', headers=auth_a).get_json()['data']
    conv = next(c for c in convs if c['id'] == room_id)
    assert conv['contact_public_key'] == pub_b

    # 4. v2 ciphertext is stored verbatim and no server key is echoed
    cipher = 'enc:v2:00112233445566778899aabb:deadbeefcafebabe'
    sent = client.post(
        f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={'message': cipher}
    ).get_json()['data'][0]
    assert sent['message'] == cipher
    assert sent['e2e_secret'] is None

    fetched = client.get(f'/api/chat/rooms/{room_id}/messages', headers=auth_b).get_json()['data']
    last = next(m for m in fetched if m['id'] == sent['id'])
    assert last['message'] == cipher
    assert last['e2e_secret'] is None
    assert 'Alice' not in last['message']

    # The inbox preview stores the ciphertext (never plaintext); only the two
    # clients can decrypt it into readable text.
    preview = db.execute(
        "SELECT last_message FROM official_chat_rooms WHERE id = ?", (room_id,)
    ).fetchone()['last_message']
    assert preview == cipher
    assert 'Alice' not in preview

    # 5. Legacy v1 messages still receive the (server-known) room secret
    legacy = client.post(
        f'/api/chat/rooms/{room_id}/messages', headers=auth_a,
        json={'message': 'enc:v1:00112233445566778899aabb:deadbeef'}
    ).get_json()['data'][0]
    assert legacy['e2e_secret']


def test_duplicate_phone_registration_does_not_leak_handle(client, db):
    """A duplicate-phone 409 must not reveal the existing account's @handle."""
    first = client.post('/api/chat/auth/register', json={
        'full_name': 'Existing Owner', 'username': 'privatehandle',
        'phone': '9865000111', 'password': 'ownerpass123'
    })
    assert first.status_code == 201

    dup = client.post('/api/chat/auth/register', json={
        'full_name': 'Attacker Probe', 'username': 'probe_handle',
        'phone': '9865000111', 'password': 'probepass123'
    })
    assert dup.status_code == 409
    body = dup.get_data(as_text=True)
    assert 'privatehandle' not in body
    assert 'already exists' in body


def test_message_reply_edit_delete_and_reactions(client, db):
    """Reply/quote, edit window, delete (me/everyone) and emoji reactions."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'actionpass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Act Alice', 'act_alice', '9865000151')
    bob = register('Act Bob', 'act_bob', '9865000152')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    def send(text, reply_to_id=None):
        payload = {'message': text}
        if reply_to_id is not None:
            payload['reply_to_id'] = reply_to_id
        return client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json=payload)

    first = send('original message').get_json()['data'][0]
    # Reply target must exist inside the same room
    assert send('bad reply', 999999).status_code == 400
    second = send('quoted reply', first['id']).get_json()['data'][0]
    assert second['reply_to_id'] == first['id']

    # 1. Reactions toggle per user
    react = client.post(f"/api/chat/messages/{first['id']}/reaction", headers=auth_b, json={'emoji': '👍'})
    assert react.status_code == 200
    assert react.get_json()['data']['reactions'][0]['count'] == 1
    assert client.post(
        f"/api/chat/messages/{first['id']}/reaction", headers=auth_b, json={'emoji': '🔥'}
    ).status_code == 400
    unreact = client.post(
        f"/api/chat/messages/{first['id']}/reaction", headers=auth_b, json={'emoji': '👍'}
    )
    assert unreact.get_json()['data']['reactions'] == []

    # 2. Edit: own text only, and the edit is persisted
    edit = client.patch(
        f"/api/chat/messages/{first['id']}", headers=auth_a, json={'message': 'edited text'}
    )
    assert edit.status_code == 200
    updated = edit.get_json()['data'][0]
    assert updated['message'] == 'edited text'
    assert updated['edited_at']
    assert client.patch(
        f"/api/chat/messages/{first['id']}", headers=auth_b, json={'message': 'hacked'}
    ).status_code == 403

    # 3. Delete for me hides it only for that user
    assert client.delete(
        f"/api/chat/messages/{first['id']}?scope=me", headers=auth_b
    ).status_code == 200
    bob_ids = [m['id'] for m in client.get(
        f'/api/chat/rooms/{room_id}/messages', headers=auth_b
    ).get_json()['data']]
    assert first['id'] not in bob_ids
    alice_ids = [m['id'] for m in client.get(
        f'/api/chat/rooms/{room_id}/messages', headers=auth_a
    ).get_json()['data']]
    assert first['id'] in alice_ids

    # 4. Delete for everyone is sender-only and leaves a tombstone
    assert client.delete(
        f"/api/chat/messages/{second['id']}?scope=everyone", headers=auth_b
    ).status_code == 403
    assert client.delete(
        f"/api/chat/messages/{second['id']}?scope=everyone", headers=auth_a
    ).status_code == 200
    tombstone = next(
        m for m in client.get(f'/api/chat/rooms/{room_id}/messages', headers=auth_b).get_json()['data']
        if m['id'] == second['id']
    )
    assert tombstone['deleted'] == 1
    assert tombstone['message'] == ''
    assert tombstone['message_type'] == 'deleted'


def test_block_and_report_controls(client, db):
    """Blocks stop DMs/requests both ways; reports are validated and stored."""
    def register(name, username, phone):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username, 'phone': phone, 'password': 'safetypass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Safe Alice', 'safe_alice', '9865000141')
    bob = register('Safe Bob', 'safe_bob', '9865000142')
    carol = register('Safe Carol', 'safe_carol', '9865000143')
    auth_a = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_b = {'Authorization': f"Bearer {bob['chat_token']}"}
    auth_c = {'Authorization': f"Bearer {carol['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_a, json={
        'target_user_id': bob['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_b, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    # 1. Reports: reason whitelist, self-report rejected, outsider room rejected
    assert client.post('/api/chat/reports', headers=auth_a, json={
        'reported_user_id': bob['user']['id'], 'reason': 'nonsense'
    }).status_code == 400
    assert client.post('/api/chat/reports', headers=auth_a, json={
        'reported_user_id': alice['user']['id'], 'reason': 'spam'
    }).status_code == 400
    assert client.post('/api/chat/reports', headers=auth_c, json={
        'reported_user_id': bob['user']['id'], 'room_id': room_id, 'reason': 'spam'
    }).status_code == 403

    report = client.post('/api/chat/reports', headers=auth_a, json={
        'reported_user_id': bob['user']['id'], 'room_id': room_id,
        'reason': 'spam', 'details': 'repeated ads'
    })
    assert report.status_code == 200
    report_row = db.execute(
        "SELECT reason, room_id FROM chat_reports WHERE id = ?",
        (report.get_json()['data']['report_id'],)
    ).fetchone()
    assert report_row['reason'] == 'spam'
    assert report_row['room_id'] == room_id

    # 2. Block: stops messages in BOTH directions + direct chat + requests
    assert client.post(
        f"/api/chat/users/{bob['user']['id']}/block", headers=auth_a
    ).status_code == 200
    assert client.post(
        f"/api/chat/users/{alice['user']['id']}/block", headers=auth_a
    ).status_code == 400

    assert client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={
        'message': 'blocked by me'
    }).status_code == 403
    assert client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_b, json={
        'message': 'blocked by them'
    }).status_code == 403
    assert client.post(
        f"/api/chat/direct-chat/{bob['user']['id']}", headers=auth_a
    ).status_code == 403
    assert client.post('/api/chat/friends/request', headers=auth_b, json={
        'target_user_id': alice['user']['id']
    }).status_code == 403

    # 3. Search hides the blocked pair; conversations expose both flags
    search = client.get('/api/chat/users/search', headers=auth_a, query_string={
        'q': bob['user']['username']
    }).get_json()['data']
    assert search == []

    conv_a = next(c for c in client.get('/api/chat/conversations', headers=auth_a).get_json()['data'] if c['id'] == room_id)
    assert conv_a['blocked_by_me'] is True
    conv_b = next(c for c in client.get('/api/chat/conversations', headers=auth_b).get_json()['data'] if c['id'] == room_id)
    assert conv_b['blocked_me'] is True

    blocks = client.get('/api/chat/blocks', headers=auth_a).get_json()['data']
    assert [b['id'] for b in blocks] == [bob['user']['id']]

    # 4. Unblock restores messaging
    assert client.delete(
        f"/api/chat/users/{bob['user']['id']}/block", headers=auth_a
    ).status_code == 200
    assert client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_a, json={
        'message': 'unblocked now'
    }).status_code == 200


def test_chat_signup_login_and_search_by_email(client, db):
    """Chat accounts can be created with just an email, signed into with that
    email, and found by an exact email search - without exposing the address."""
    res = client.post('/api/chat/auth/register', json={
        'full_name': 'Email Only User',
        'username': 'email_only_user',
        'email': 'Email.Only@Example.com',
        'password': 'emailpass123'
    })
    assert res.status_code == 201
    data = res.get_json()['data']
    assert data['user']['email'] == 'email.only@example.com'
    token = data['chat_token']
    auth = {'Authorization': f'Bearer {token}'}

    # Sign in using the email address as the identifier.
    login = client.post('/api/chat/auth/login', json={
        'identifier': 'email.only@example.com', 'password': 'emailpass123'
    })
    assert login.status_code == 200
    assert login.get_json()['data']['user']['id'] == data['user']['id']

    # Another user finds them by exact email; the address stays private.
    other = client.post('/api/chat/auth/register', json={
        'full_name': 'Email Searcher',
        'username': 'email_searcher',
        'email': 'email.searcher@example.com',
        'password': 'searchpass123'
    })
    assert other.status_code == 201
    other_auth = {'Authorization': f"Bearer {other.get_json()['data']['chat_token']}"}

    found = client.get('/api/chat/users/search', headers=other_auth, query_string={
        'q': 'email.only@example.com'
    }).get_json()['data']
    assert any(u['username'] == 'email_only_user' for u in found)
    assert all('email' not in u and 'phone' not in u for u in found)

    # Partial email is not an enumeration oracle.
    partial = client.get('/api/chat/users/search', headers=other_auth, query_string={
        'q': 'email.only@'
    }).get_json()['data']
    assert not any(u['username'] == 'email_only_user' for u in partial)


    # Missing email AND phone is rejected at signup.
    assert client.post('/api/chat/auth/register', json={
        'full_name': 'No Contact User', 'username': 'no_contact_user', 'password': 'contactpass'
    }).status_code == 400


def test_clear_does_not_delete_direct_chat_history(client, db):
    """Legacy /chat/clear must only touch the support room. It used to resolve
    a DM room from user_id (the lower-id participant) and delete BOTH sides'
    history - the reason conversations appeared to vanish."""
    def register(name, username):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username,
            'email': f'{username}@example.com', 'password': 'clearpass123'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    first = register('Clear First', 'clear_first')
    second = register('Clear Second', 'clear_second')
    auth_first = {'Authorization': f"Bearer {first['chat_token']}"}
    auth_second = {'Authorization': f"Bearer {second['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_first, json={
        'target_user_id': second['user']['id']
    })
    room_id = client.post('/api/chat/friends/respond', headers=auth_second, json={
        'request_id': req.get_json()['data']['request_id'], 'action': 'accept'
    }).get_json()['data']['room_id']

    sent = client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_first, json={
        'message': 'this direct message must survive'
    })
    assert sent.status_code == 200

    # The lower-id participant is the room's user_id; that is exactly the
    # account whose legacy clear used to delete the DM room.
    lower_auth = auth_first if first['user']['id'] < second['user']['id'] else auth_second
    assert client.post('/api/chat/clear', headers=lower_auth).status_code == 200

    for auth in (auth_first, auth_second):
        msgs = client.get(f'/api/chat/rooms/{room_id}/messages', headers=auth).get_json()['data']
        assert any((m.get('sender_type') == 'user') for m in msgs)


def test_friend_request_can_be_resent_after_decline(client, db):
    """A declined request must not block the pair forever."""
    def register(name, username):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username,
            'email': f'{username}@example.com', 'password': 'declinepass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    sender = register('Decline Sender', 'decline_sender')
    receiver = register('Decline Receiver', 'decline_receiver')
    auth_sender = {'Authorization': f"Bearer {sender['chat_token']}"}
    auth_receiver = {'Authorization': f"Bearer {receiver['chat_token']}"}

    first = client.post('/api/chat/friends/request', headers=auth_sender, json={
        'target_user_id': receiver['user']['id']
    })
    assert first.status_code == 200
    client.post('/api/chat/friends/respond', headers=auth_receiver, json={
        'request_id': first.get_json()['data']['request_id'], 'action': 'decline'
    })

    # Re-request succeeds instead of claiming a request is already pending.
    again = client.post('/api/chat/friends/request', headers=auth_sender, json={
        'target_user_id': receiver['user']['id']
    })
    assert again.status_code == 200
    assert again.get_json()['data']['status'] == 'pending'

    accepted = client.post('/api/chat/friends/respond', headers=auth_receiver, json={
        'request_id': again.get_json()['data']['request_id'], 'action': 'accept'
    })
    assert accepted.status_code == 200
    friends = client.get('/api/chat/friends', headers=auth_sender).get_json()['data']['friends']
    assert any(f['friend_id'] == receiver['user']['id'] for f in friends)


def test_google_chat_signup_requires_completion_form(client, db):
    """Google only proves the email. The chat account must not exist until the
    user supplies username, password, gender and mobile number."""
    secret = get_jwt_secret()
    ticket = jwt.encode({
        'type': 'official_chat_google_signup',
        'google_sub': 'google-sub-complete-1',
        'email': 'google.complete@example.com',
        'name': 'Google Complete',
        'picture': '',
        'exp': 9999999999,
    }, secret, algorithm='HS256')

    def count_accounts():
        return db.execute(
            "SELECT COUNT(*) AS c FROM chat_users WHERE LOWER(email) = ?",
            ('google.complete@example.com',)
        ).fetchone()['c']

    # 1. Google alone creates nothing.
    assert count_accounts() == 0

    # 2. Gender is mandatory on the completion form.
    missing = client.post('/api/chat/auth/google/complete', json={
        'ticket': ticket,
        'full_name': 'Google Complete',
        'username': 'google_complete',
        'gender': '',
        'password': 'googlepass'
    })
    assert missing.status_code == 400
    assert count_accounts() == 0

    # 3. Complete details create the account + chat tokens.
    ok = client.post('/api/chat/auth/google/complete', json={
        'ticket': ticket,
        'full_name': 'Google Complete',
        'username': 'google_complete',
        'phone': '9876500123',
        'gender': 'male',
        'password': 'googlepass'
    })
    assert ok.status_code == 201
    data = ok.get_json()['data']
    assert data['chat_token']
    assert data['user']['username'] == 'google_complete'
    assert data['user']['gender'] == 'male'

    # 4. The account can sign in later without Google.
    login = client.post('/api/chat/auth/login', json={
        'identifier': 'google.complete@example.com',
        'password': 'googlepass'
    })
    assert login.status_code == 200
    assert login.get_json()['data']['user']['id'] == data['user']['id']

    # 5. Replaying the ticket cannot create a second account.
    replay = client.post('/api/chat/auth/google/complete', json={
        'ticket': ticket,
        'full_name': 'Google Complete',
        'username': 'google_complete_2',
        'gender': 'male',
        'password': 'googlepass'
    })
    assert replay.status_code == 409


def test_social_events_push_friend_requests_and_accepts(client, db):
    """The realtime social poll must return a new request, then the accepted
    friendship, as soon as its revision changes (no 30s wait)."""
    def register(name, username):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username,
            'email': f'{username}@example.com', 'password': 'socialpass'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Social Alice', 'social_alice')
    bob = register('Social Bob', 'social_bob')
    auth_alice = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_bob = {'Authorization': f"Bearer {bob['chat_token']}"}

    baseline = client.get('/api/chat/social/events', headers=auth_alice, query_string={
        'timeout': 1
    }).get_json()['data']
    assert baseline['incoming_requests'] == []
    revision = baseline['revision']

    # Bob sends a request; Alice's next poll with the old revision returns
    # immediately with the pending request.
    sent = client.post('/api/chat/friends/request', headers=auth_bob, json={
        'target_user_id': alice['user']['id']
    })
    assert sent.status_code == 200

    pushed = client.get('/api/chat/social/events', headers=auth_alice, query_string={
        'since': revision, 'timeout': 3
    })
    assert pushed.status_code == 200
    data = pushed.get_json()['data']
    assert data['revision'] != revision
    assert data['pending_count'] == 1
    incoming = data['incoming_requests']
    assert any(r['user_id'] == bob['user']['id'] for r in incoming)

    # Alice accepts; the next poll immediately exposes the friendship.
    accepted_req = client.post('/api/chat/friends/respond', headers=auth_alice, json={
        'request_id': incoming[0]['request_id'], 'action': 'accept'
    })
    assert accepted_req.status_code == 200

    accepted = client.get('/api/chat/social/events', headers=auth_alice, query_string={
        'since': data['revision'], 'timeout': 3
    }).get_json()['data']
    assert accepted['pending_count'] == 0
    assert any(f['friend_id'] == bob['user']['id'] for f in accepted['friends'])
    assert accepted['revision'] != data['revision']


def test_chat_push_subscription_and_friend_request_delivery(client, db, monkeypatch):
    """Push subscriptions are scoped to chat_users, and a friend request
    triggers an OS push for the recipient (when configured)."""
    def register(name, username):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username,
            'email': f'{username}@example.com', 'password': 'pushpass123'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    sender = register('Push Sender', 'push_sender')
    receiver = register('Push Receiver', 'push_receiver')
    auth_receiver = {'Authorization': f"Bearer {receiver['chat_token']}"}
    auth_sender = {'Authorization': f"Bearer {sender['chat_token']}"}

    # 1. Public key endpoint always answers; enabled depends on VAPID config.
    key_res = client.get('/api/chat/push/public-key')
    assert key_res.status_code == 200
    assert 'enabled' in key_res.get_json()['data']

    # 2. Subscription is stored against the CHAT user (not a storefront id).
    endpoint = 'https://push.example.test/sub/abc123'
    subscribed = client.post('/api/chat/push/subscribe', headers=auth_receiver, json={
        'endpoint': endpoint,
        'keys': {'p256dh': 'BExamplePublicKey', 'auth': 'exampleAuthSecret'}
    })
    assert subscribed.status_code == 200
    row = db.execute(
        "SELECT chat_user_id FROM chat_push_subscriptions WHERE endpoint = ?", (endpoint,)
    ).fetchone()
    assert row['chat_user_id'] == receiver['user']['id']

    # Missing keys are rejected.
    assert client.post('/api/chat/push/subscribe', headers=auth_receiver, json={
        'endpoint': endpoint, 'keys': {}
    }).status_code == 400

    # 3. Sending a friend request fires the chat push in the background.
    from notifications import notification_service
    calls = []
    monkeypatch.setattr(
        notification_service, 'send_chat_push',
        lambda *args, **kwargs: calls.append(args)
    )
    sent = client.post('/api/chat/friends/request', headers=auth_sender, json={
        'target_user_id': receiver['user']['id']
    })
    assert sent.status_code == 200

    import time as _time
    for _ in range(40):
        if calls:
            break
        _time.sleep(0.05)
    assert calls, 'friend request did not trigger a chat push'
    assert calls[0][0] == receiver['user']['id']
    assert '/chat?open=requests' in calls[0]

    # 4. Unsubscribe removes only the caller's row.
    unsub = client.delete('/api/chat/push/subscribe', headers=auth_receiver, json={
        'endpoint': endpoint
    })
    assert unsub.status_code == 200
    assert db.execute(
        "SELECT COUNT(*) AS c FROM chat_push_subscriptions WHERE endpoint = ?", (endpoint,)
    ).fetchone()['c'] == 0


def test_chat_native_device_push_registration_and_message_delivery(client, db, monkeypatch):
    """FCM tokens are scoped to chat_users and a new DM triggers device push."""
    def register(name, username):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username,
            'email': f'{username}@example.com', 'password': 'devicepass123'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    sender = register('Device Sender', 'device_sender')
    receiver = register('Device Receiver', 'device_receiver')
    auth_sender = {'Authorization': f"Bearer {sender['chat_token']}"}
    auth_receiver = {'Authorization': f"Bearer {receiver['chat_token']}"}

    req = client.post('/api/chat/friends/request', headers=auth_sender, json={
        'target_user_id': receiver['user']['id']
    })
    req_id = req.get_json()['data']['request_id']
    room_id = client.post('/api/chat/friends/respond', headers=auth_receiver, json={
        'request_id': req_id, 'action': 'accept'
    }).get_json()['data']['room_id']

    token = 'fcm_chat_device_token_1'
    registered = client.post('/api/chat/push/device', headers=auth_receiver, json={
        'token': token,
        'device_type': 'android',
        'device_model': 'Test Phone'
    })
    assert registered.status_code == 200
    row = db.execute(
        "SELECT chat_user_id, device_type FROM chat_push_tokens WHERE fcm_token = ?", (token,)
    ).fetchone()
    assert row['chat_user_id'] == receiver['user']['id']
    assert row['device_type'] == 'android'

    # Another account must not be able to delete this device token.
    assert client.delete('/api/chat/push/device', headers=auth_sender, json={
        'token': token
    }).status_code == 200
    assert db.execute(
        "SELECT COUNT(*) AS c FROM chat_push_tokens WHERE fcm_token = ?", (token,)
    ).fetchone()['c'] == 1

    from notifications import notification_service
    web_calls, device_calls = [], []
    monkeypatch.setattr(notification_service, 'send_chat_push',
                        lambda *args, **kwargs: web_calls.append(args))
    monkeypatch.setattr(notification_service, 'send_chat_device_push',
                        lambda *args, **kwargs: device_calls.append(args))

    sent = client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_sender, json={
        'message': 'Hello from the device push test'
    })
    assert sent.status_code == 200

    import time as _time
    for _ in range(40):
        if device_calls and web_calls:
            break
        _time.sleep(0.05)
    assert device_calls, 'message did not trigger an FCM device push'
    assert device_calls[0][0] == receiver['user']['id']
    assert device_calls[0][3] == f'/chat?room={room_id}'
    assert web_calls, 'message did not trigger a web push'

    removed = client.delete('/api/chat/push/device', headers=auth_receiver, json={
        'token': token
    })
    assert removed.status_code == 200
    assert db.execute(
        "SELECT COUNT(*) AS c FROM chat_push_tokens WHERE fcm_token = ?", (token,)
    ).fetchone()['c'] == 0


def test_chat_device_push_sends_on_chat_channel(db, monkeypatch):
    """The FCM sender reads chat_push_tokens and uses the app's chat channel."""
    from notifications import notification_service as ns

    db.execute(
        "INSERT INTO chat_push_tokens (chat_user_id, fcm_token, device_type, device_model) "
        "VALUES (?, ?, 'android', 'Unit Test Phone')",
        (424242, 'fcm-chat-unit-token')
    )
    db.commit()

    monkeypatch.setattr(ns, '_load_fcm_service_account', lambda: {'project_id': 'test-proj'})
    calls = []

    def fake_send(*args, **kwargs):
        calls.append((args, kwargs))
        return 'sent'

    monkeypatch.setattr(ns, '_send_fcm_message', fake_send)
    sent = ns.send_chat_device_push(424242, 'New message', 'Hello', '/chat?room=1')

    assert sent == 1
    assert calls
    args, kwargs = calls[0]
    assert args[2] == 'fcm-chat-unit-token'
    assert kwargs.get('channel_id') == 'chat'
    assert db.execute(
        "SELECT COUNT(*) AS c FROM chat_push_tokens WHERE fcm_token = 'fcm-chat-unit-token'"
    ).fetchone()['c'] == 1


def test_main_app_chat_web_oauth_handoff_returns_code(client, db, app_module):
    """The main backend must not put chat session tokens in the web URL."""
    from auth.oauth_handoff import challenge_for_verifier

    suffix = uuid.uuid4().hex[:10]
    email = f"main-web-oauth-{suffix}@example.com"
    registered = client.post('/api/chat/auth/register', json={
        'full_name': 'Main Web OAuth',
        'username': f"mainweb_{suffix}",
        'email': email,
        'password': 'mainwebpass123',
        'gender': 'male',
    })
    assert registered.status_code == 201

    verifier = 'main-web-verifier-0123456789abcdefghijklmnopqrstuvwxyz'
    challenge = challenge_for_verifier(verifier)
    with app_module.app.test_request_context('/google/callback?flow=chat'):
        response = app_module._chat_google_oauth_handoff(
            f"google-{suffix}",
            email,
            'Main Web OAuth',
            '',
            'https://jdlx-chat.vercel.app',
            challenge,
        )

    assert response.status_code == 302
    location = urlparse(response.headers['Location'])
    query = parse_qs(location.query)
    assert location.path == '/login'
    assert 'token' not in query
    assert 'refresh' not in query
    assert 'user' not in query
    assert query['code'][0]
    assert 'chat_token' not in response.headers.get('Set-Cookie', '')

    exchanged = client.post('/api/chat/auth/exchange-handoff', json={
        'code': query['code'][0],
        'verifier': verifier,
    })
    assert exchanged.status_code == 200, exchanged.get_json()
    data = exchanged.get_json()['data']
    assert data['chat_token']
    assert data['refresh_token']


def test_chat_native_oauth_handoff_exchange(client, db):
    """The APK redeems a one-time code for chat tokens (never in the URI)."""
    from auth.oauth_handoff import issue_handoff_code, challenge_for_verifier

    res = client.post('/api/chat/auth/register', json={
        'full_name': 'Handoff User', 'username': 'handoff_user',
        'email': 'handoff_user@example.com', 'password': 'handoffpass123'
    })
    assert res.status_code == 201
    user = res.get_json()['data']['user']

    verifier = 'handoff-verifier-0123456789abcdefghijklmnopqrstuvwxyz'
    challenge = challenge_for_verifier(verifier)
    cursor = db.cursor()
    payload = dict(user)
    payload['refresh_token'] = 'refresh-token-for-test'
    code = issue_handoff_code(cursor, user['id'], payload, 'access-token-for-test', challenge)
    db.commit()

    exchanged = client.post('/api/chat/auth/exchange-handoff', json={
        'code': code, 'verifier': verifier
    })
    assert exchanged.status_code == 200
    data = exchanged.get_json()['data']
    assert data['chat_token'] == 'access-token-for-test'
    assert data['refresh_token'] == 'refresh-token-for-test'
    assert data['user']['id'] == user['id']
    assert 'refresh_token' not in data['user']

    # Single-use: replaying the same code fails.
    replay = client.post('/api/chat/auth/exchange-handoff', json={
        'code': code, 'verifier': verifier
    })
    assert replay.status_code == 401


def test_no_messaging_without_accepted_friendship(client, db):
    """A direct room alone is NOT permission to talk. Sending (and opening)
    must require an accepted friend request, even when a stale room exists."""
    def register(name, username):
        res = client.post('/api/chat/auth/register', json={
            'full_name': name, 'username': username,
            'email': f'{username}@example.com', 'password': 'gatepass123'
        })
        assert res.status_code == 201
        return res.get_json()['data']

    alice = register('Gate Alice', 'gate_alice')
    bob = register('Gate Bob', 'gate_bob')
    auth_alice = {'Authorization': f"Bearer {alice['chat_token']}"}
    auth_bob = {'Authorization': f"Bearer {bob['chat_token']}"}

    # Simulate a stale/legacy direct room with NO accepted friendship.
    u_min = min(alice['user']['id'], bob['user']['id'])
    u_max = max(alice['user']['id'], bob['user']['id'])
    room_key = f"DM-STALE-{u_min}-{u_max}"
    db.execute(
        """INSERT INTO official_chat_rooms
           (user_id, user_two_id, room_key, title, status, room_type, e2e_secret)
           VALUES (?, ?, ?, 'stale room', 'active', 'direct', ?)""",
        (u_min, u_max, room_key, 'stalesecret')
    )
    db.commit()
    room_id = db.execute(
        "SELECT id FROM official_chat_rooms WHERE room_key = ?", (room_key,)
    ).fetchone()['id']

    # Existing room is not consent: sending and opening are rejected.
    assert client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_alice, json={
        'message': 'hello?'
    }).status_code == 403
    assert client.post(
        f"/api/chat/direct-chat/{bob['user']['id']}", headers=auth_alice
    ).status_code == 403

    # A PENDING request is still not enough.
    request = client.post('/api/chat/friends/request', headers=auth_alice, json={
        'target_user_id': bob['user']['id']
    })
    request_id = request.get_json()['data']['request_id']
    assert client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_alice, json={
        'message': 'still there?'
    }).status_code == 403

    # Only after Bob accepts does the same room work.
    assert client.post('/api/chat/friends/respond', headers=auth_bob, json={
        'request_id': request_id, 'action': 'accept'
    }).status_code == 200
    assert client.post(f'/api/chat/rooms/{room_id}/messages', headers=auth_alice, json={
        'message': 'now allowed'
    }).status_code == 200


def test_email_only_registration_does_not_conflict_on_empty_phone(client, db):
    """Email-only registrations (without a mobile number) must succeed and never
    trigger a 409 duplicate phone conflict against existing null/empty phone records."""
    # User 1 registers with email and no phone
    res1 = client.post('/api/chat/auth/register', json={
        'full_name': 'Email User One',
        'username': 'email_user_one',
        'email': 'email_user_one@example.com',
        'password': 'password123',
        'phone': ''
    })
    assert res1.status_code == 201
    assert res1.get_json()['success'] is True

    # User 2 also registers with email and no phone (or omitted phone)
    res2 = client.post('/api/chat/auth/register', json={
        'full_name': 'Email User Two',
        'username': 'email_user_two',
        'email': 'email_user_two@example.com',
        'password': 'password123'
    })
    assert res2.status_code == 201
    assert res2.get_json()['success'] is True


def test_chat_profile_get_and_update(client, db):
    """GET /api/chat/profile retrieves current user profile, PUT updates name, username, bio, gender."""
    res_reg = client.post('/api/chat/auth/register', json={
        'full_name': 'Profile Tester',
        'username': 'profile_tester',
        'phone': '9899887766',
        'password': 'password123'
    })
    assert res_reg.status_code == 201
    token = res_reg.get_json()['data']['chat_token']
    auth = {'Authorization': f'Bearer {token}'}

    # 1. GET profile
    res_get = client.get('/api/chat/profile', headers=auth)
    assert res_get.status_code == 200
    p = res_get.get_json()['data']['profile']
    assert p['name'] == 'Profile Tester'
    assert p['username'] == 'profile_tester'

    # 2. PUT profile: update name, username, bio, gender
    res_put = client.put('/api/chat/profile', headers=auth, json={
        'name': 'Updated Profile Tester',
        'username': 'profile_tester_v2',
        'bio': '🌟 Available for chats',
        'gender': 'male'
    })
    assert res_put.status_code == 200
    updated = res_put.get_json()['data']['user']
    assert updated['name'] == 'Updated Profile Tester'
    assert updated['username'] == 'profile_tester_v2'
    assert updated['bio'] == '🌟 Available for chats'
    assert updated['gender'] == 'male'

    # 3. Conflict validation: duplicate username
    res_other = client.post('/api/chat/auth/register', json={
        'full_name': 'Other User',
        'username': 'other_unique_user',
        'phone': '9899887767',
        'password': 'password123'
    })
    assert res_other.status_code == 201
    other_token = res_other.get_json()['data']['chat_token']
    other_auth = {'Authorization': f'Bearer {other_token}'}

    res_conflict = client.put('/api/chat/profile', headers=other_auth, json={
        'username': 'profile_tester_v2'
    })
    assert res_conflict.status_code == 409






