"""The login page must be able to read the chat name without a session.

It used to call `/settings`, a storefront route that does not exist on the chat
backend: every login visit paid a 404 preflight and logged "Failed to load chat
branding". The public `/chat/branding` route now serves only the two display
fields that the login screen needs.
"""


def test_branding_is_public_and_only_exposes_display_fields(client):
    res = client.get('/api/chat/branding')
    assert res.status_code == 200
    body = res.get_json()
    assert body['success'] is True
    assert set(body['data']) == {'official_chat_name', 'official_chat_logo'}
    assert body['data']['official_chat_name']


def test_branding_preflight_is_allowed_from_the_app_origin(client):
    res = client.options(
        '/api/chat/branding',
        headers={
            'Origin': 'https://jdlx-chat.vercel.app',
            'Access-Control-Request-Method': 'GET',
        },
    )
    assert res.status_code < 300
    assert res.headers.get('Access-Control-Allow-Origin') == 'https://jdlx-chat.vercel.app'
