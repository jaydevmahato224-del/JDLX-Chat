import pytest
import jwt
from database import get_db
from jwt_config import get_jwt_secret

def test_e2ee_message_storage_and_secrecy(client):
    # Chat identity lives in chat_users now — register both peers via the
    # standalone login (no storefront users, no SSO).

    # Alice (chat-only identity)
    res_a = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9722200001',
        'full_name': 'Alice E2E',
        'username': 'alice_e2e'
    })
    assert res_a.status_code == 200
    alice_data = res_a.get_json()['data']
    alice_chat_token = alice_data['chat_token']
    alice_id = alice_data['user']['id']

    # Bob (chat-only identity)
    res_b = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9722200002',
        'full_name': 'Bob E2E',
        'username': 'bob_e2e'
    })
    assert res_b.status_code == 200
    bob_data = res_b.get_json()['data']
    bob_chat_token = bob_data['chat_token']
    bob_id = bob_data['user']['id']
    assert bob_id > alice_id

    # Direct messaging needs an accepted connection first (consent gate)
    res_fr = client.post('/api/chat/friends/request', headers={'Authorization': f'Bearer {alice_chat_token}'}, json={
        'target_user_id': bob_id
    })
    assert res_fr.status_code == 200
    fr_id = res_fr.get_json()['data']['request_id']
    res_accept = client.post('/api/chat/friends/respond', headers={'Authorization': f'Bearer {bob_chat_token}'}, json={
        'request_id': fr_id, 'action': 'accept'
    })
    assert res_accept.status_code == 200

    # Alice opens direct chat with Bob
    res_open = client.post(f'/api/chat/direct-chat/{bob_id}', headers={'Authorization': f'Bearer {alice_chat_token}'})
    assert res_open.status_code == 200
    room_data = res_open.get_json()['data']['conversation']
    room_id = room_data['id']
    e2e_secret = room_data.get('e2e_secret')
    assert e2e_secret and len(e2e_secret) >= 32

    # Alice sends an E2EE encrypted ciphertext payload
    ciphertext_payload = "enc:v1:0102030405060708090a0b0c:deadbeefcafebabe8899aabbccddeeff"
    res_send = client.post(f'/api/chat/rooms/{room_id}/messages', headers={'Authorization': f'Bearer {alice_chat_token}'}, json={
        'message': ciphertext_payload
    })
    assert res_send.status_code == 200
    msgs = res_send.get_json()['data']
    assert msgs[-1]['message'] == ciphertext_payload
    assert msgs[-1]['e2e_secret'] == e2e_secret

    # Verify directly in Database: ONLY ciphertext is stored!
    conn2 = get_db()
    c2 = conn2.cursor()
    c2.execute("SELECT message FROM official_chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 1", (room_id,))
    stored_msg = c2.fetchone()['message']
    assert stored_msg == ciphertext_payload
    assert "Alice" not in stored_msg and "Hey" not in stored_msg

    # The inbox preview intentionally keeps the ciphertext so the two clients
    # can decrypt it into a real preview. The server still must never store or
    # receive plaintext; assert that here.
    c2.execute("SELECT last_message FROM official_chat_rooms WHERE id = ?", (room_id,))
    room_preview = c2.fetchone()['last_message']
    assert room_preview == ciphertext_payload
    assert "Alice" not in room_preview and "Hey" not in room_preview

    # Verify Bob's notification does not leak plaintext
    c2.execute("SELECT message FROM official_chat_notifications WHERE room_id = ? AND user_id = ?", (room_id, bob_id))
    notif = c2.fetchone()['message']
    assert notif == "Sent an encrypted message"

    conn2.close()
