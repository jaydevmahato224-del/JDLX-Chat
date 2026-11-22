"""Tests for /api/chat/ice-servers.

Covers the three ways a deployment can be configured:

* STUN only (default) — the old behaviour, which silently cannot connect two
  phones behind carrier-grade NAT.
* Static TURN credentials (TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL).
* Rotating credentials for a self-hosted coturn (TURN_URLS + TURN_SECRET), which
  is what keeps a public relay from needing a shared password in the client.
"""

import base64
import hashlib
import hmac
import time
import uuid

import pytest

TURN_ENV_KEYS = (
    'TURN_URLS',
    'TURN_URL',
    'TURN_USERNAME',
    'TURN_CREDENTIAL',
    'TURN_PASSWORD',
    'TURN_SECRET',
    'TURN_STATIC_AUTH_SECRET',
    'TURN_TTL',
    'ICE_SERVERS_JSON',
    'STUN_URLS',
)


@pytest.fixture()
def chat_auth(client, monkeypatch):
    """A signed-in chat user, with every ICE/TURN env var cleared first so the
    developer's own .env cannot influence the assertions."""
    for key in TURN_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    suffix = uuid.uuid4().hex[:8]
    res = client.post('/api/chat/auth/login-mobile', json={
        'phone': '9' + str(uuid.uuid4().int)[:9],
        'full_name': 'TURN Tester',
        'username': f'turn_tester_{suffix}',
    })
    assert res.status_code == 200, res.get_json()
    data = res.get_json()['data']
    return {'Authorization': f"Bearer {data['chat_token']}"}, data['user']['id']


def _ice_servers(client, headers):
    res = client.get('/api/chat/ice-servers', headers=headers)
    assert res.status_code == 200, res.get_json()
    return res.get_json()['data']['ice_servers']


def test_requires_auth(client):
    assert client.get('/api/chat/ice-servers').status_code == 401


def test_defaults_to_stun_only(client, chat_auth):
    headers, _ = chat_auth
    servers = _ice_servers(client, headers)

    assert servers, 'at least the STUN entries must be returned'
    assert all(str(s['urls']).startswith('stun:') for s in servers)
    assert all('username' not in s for s in servers)


def test_static_turn_credentials(client, chat_auth, monkeypatch):
    headers, _ = chat_auth
    monkeypatch.setenv(
        'TURN_URLS',
        'turn:relay.example.com:3478?transport=udp,turns:relay.example.com:5349',
    )
    monkeypatch.setenv('TURN_USERNAME', 'static-user')
    monkeypatch.setenv('TURN_CREDENTIAL', 'static-pass')

    servers = _ice_servers(client, headers)
    turn = [s for s in servers if 'turn:' in str(s['urls'])]
    assert len(turn) == 1
    assert turn[0]['urls'] == [
        'turn:relay.example.com:3478?transport=udp',
        'turns:relay.example.com:5349',
    ]
    assert turn[0]['username'] == 'static-user'
    assert turn[0]['credential'] == 'static-pass'


def test_rotating_turn_credentials(client, chat_auth, monkeypatch):
    headers, user_id = chat_auth
    monkeypatch.setenv('TURN_URLS', 'turn:relay.example.com:3478')
    monkeypatch.setenv('TURN_SECRET', 'shared-secret')

    before = int(time.time())
    servers = _ice_servers(client, headers)
    after = int(time.time())

    turn = [s for s in servers if str(s['urls']).startswith('turn:')]
    assert len(turn) == 1
    username, credential = turn[0]['username'], turn[0]['credential']

    expiry_text, _, name = username.partition(':')
    assert name == str(user_id)
    expiry = int(expiry_text)
    # Default TTL is one hour, and it must not be a long-lived credential.
    assert before + 3600 <= expiry <= after + 3600

    expected = base64.b64encode(
        hmac.new(b'shared-secret', username.encode('utf-8'), hashlib.sha1).digest()
    ).decode('ascii')
    assert credential == expected
    assert credential != 'shared-secret', 'the shared secret must never be sent'


def test_rotating_credentials_honour_and_clamp_ttl(client, chat_auth, monkeypatch):
    headers, _ = chat_auth
    monkeypatch.setenv('TURN_URLS', 'turn:relay.example.com:3478')
    monkeypatch.setenv('TURN_SECRET', 'shared-secret')

    monkeypatch.setenv('TURN_TTL', '900')
    before = int(time.time())
    servers = _ice_servers(client, headers)
    expiry = int(servers[-1]['username'].split(':', 1)[0])
    assert before + 900 <= expiry <= before + 910

    # A too-short TTL is raised to the 5 minute floor so a call cannot start
    # with credentials that die while it is still ringing.
    monkeypatch.setenv('TURN_TTL', '30')
    before = int(time.time())
    servers = _ice_servers(client, headers)
    expiry = int(servers[-1]['username'].split(':', 1)[0])
    assert expiry >= before + 300

    # Garbage falls back to the default instead of erroring the call.
    monkeypatch.setenv('TURN_TTL', 'not-a-number')
    before = int(time.time())
    servers = _ice_servers(client, headers)
    expiry = int(servers[-1]['username'].split(':', 1)[0])
    assert before + 3600 <= expiry <= before + 3610


def test_secret_without_urls_adds_no_turn(client, chat_auth, monkeypatch):
    headers, _ = chat_auth
    monkeypatch.setenv('TURN_SECRET', 'shared-secret')

    servers = _ice_servers(client, headers)
    assert all(str(s['urls']).startswith('stun:') for s in servers)


def test_ice_servers_json_override_wins(client, chat_auth, monkeypatch):
    headers, _ = chat_auth
    monkeypatch.setenv('TURN_URLS', 'turn:ignored.example.com:3478')
    monkeypatch.setenv('TURN_SECRET', 'shared-secret')
    monkeypatch.setenv('ICE_SERVERS_JSON', (
        '[{"urls": ["turn:managed.example.com:443?transport=tcp"],'
        ' "username": "managed-user", "credential": "managed-pass"}]'
    ))

    servers = _ice_servers(client, headers)
    assert servers == [{
        'urls': ['turn:managed.example.com:443?transport=tcp'],
        'username': 'managed-user',
        'credential': 'managed-pass',
    }]


def test_response_is_not_cacheable(client, chat_auth, monkeypatch):
    headers, _ = chat_auth
    monkeypatch.setenv('TURN_URLS', 'turn:relay.example.com:3478')
    monkeypatch.setenv('TURN_SECRET', 'shared-secret')

    res = client.get('/api/chat/ice-servers', headers=headers)
    assert res.status_code == 200
    # Expiring credentials must never be replayed from a browser/proxy cache.
    assert res.headers.get('Cache-Control') == 'no-store'
