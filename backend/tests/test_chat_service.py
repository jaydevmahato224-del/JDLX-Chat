import json
import uuid
from urllib.parse import parse_qs, urlparse

import jwt


def _chat_client(app_module):
    import chat_app

    chat_app.app.config.update(TESTING=True)
    return chat_app


def test_chat_service_is_chat_only(app_module):
    chat_app = _chat_client(app_module)
    with chat_app.app.test_client() as client:
        assert client.get("/").status_code == 200
        assert client.get("/api/health").get_json()["service"] == "jdlx-chat"

        # Storefront/warehouse/admin blueprints must not leak into this service.
        assert client.get("/api/products").status_code == 404
        assert client.get("/api/warehouse/orders").status_code == 404

        # Chat blueprint itself is present.
        response = client.post(
            "/api/chat/auth/login-mobile",
            json={
                "phone": f"99{uuid.uuid4().int % 10**8:08d}",
                "full_name": "Separate Chat User",
                "username": f"separate_{uuid.uuid4().hex[:10]}",
            },
        )
        assert response.status_code == 200
        assert response.get_json()["success"] is True


def test_chat_service_serves_db_backed_upload(app_module, db, monkeypatch, tmp_path):
    chat_app = _chat_client(app_module)
    monkeypatch.setitem(chat_app.app.config, "UPLOAD_FOLDER", str(tmp_path))
    filename = f"chat-service-{uuid.uuid4().hex}.png"
    payload = b"\x89PNG\r\n\x1a\nchat-service"
    db.execute(
        "INSERT OR REPLACE INTO uploaded_media (filename, mime_type, data) VALUES (?, ?, ?)",
        (filename, "image/png", payload),
    )
    db.commit()

    with chat_app.app.test_client() as client:
        response = client.get(f"/static/uploads/{filename}")
        assert response.status_code == 200
        assert response.data == payload
        assert response.mimetype == "image/png"
        assert (tmp_path / filename).read_bytes() == payload


def test_chat_web_oauth_handoff_returns_code_not_url_tokens(
    app_module, db, monkeypatch
):
    """Web/PWA uses PKCE too: the redirect carries only a one-time code."""
    from auth.oauth_handoff import challenge_for_verifier
    import chat_oauth

    chat_app = _chat_client(app_module)
    email = f"web-oauth-{uuid.uuid4().hex[:8]}@example.com"
    verifier = "web-verifier-0123456789abcdefghijklmnopqrstuvwxyz"
    challenge = challenge_for_verifier(verifier)

    class FakeGoogleResponse:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    monkeypatch.setattr(
        chat_oauth.requests,
        "post",
        lambda *args, **kwargs: FakeGoogleResponse({"access_token": "google-access"}),
    )
    monkeypatch.setattr(
        chat_oauth.requests,
        "get",
        lambda *args, **kwargs: FakeGoogleResponse({
            "sub": f"google-{email}",
            "email": email,
            "name": "Web OAuth User",
            "picture": "",
        }),
    )

    with chat_app.app.test_client() as client:
        registered = client.post("/api/chat/auth/register", json={
            "full_name": "Web OAuth User",
            "username": f"weboauth_{uuid.uuid4().hex[:10]}",
            "email": email,
            "password": "weboauthpass123",
        })
        assert registered.status_code == 201

        response = client.get("/google/callback", query_string={
            "state": f"chat|https://jdlx-chat.vercel.app|ref|nonce|{challenge}",
            "code": "google-auth-code",
        })
        assert response.status_code == 302
        location = urlparse(response.headers["Location"])
        query = parse_qs(location.query)
        assert location.path == "/login"
        assert "token" not in query
        assert "refresh" not in query
        assert "user" not in query
        assert query["code"][0]
        assert "official_chat_token" not in response.headers.get("Set-Cookie", "")

        exchanged = client.post("/api/chat/auth/exchange-handoff", json={
            "code": query["code"][0],
            "verifier": verifier,
        })
        assert exchanged.status_code == 200, exchanged.get_json()
        data = exchanged.get_json()["data"]
        assert data["chat_token"]
        assert data["refresh_token"]


def test_chat_google_start_is_chat_only_and_uses_configured_callback(
    app_module, monkeypatch
):
    chat_app = _chat_client(app_module)
    monkeypatch.setenv("CHAT_GOOGLE_CLIENT_ID", "chat-client-id")
    monkeypatch.setenv(
        "CHAT_GOOGLE_REDIRECT_URI",
        "https://jdlx-chat-backend.onrender.com/google/callback",
    )
    with chat_app.app.test_client() as client:
        response = client.get(
            "/login/google?flow=chat"
            "&frontend_url=https://jdlx-chat.vercel.app"
            "&state_challenge=challenge-123"
        )
        assert response.status_code == 302
        location = urlparse(response.headers["Location"])
        query = parse_qs(location.query)
        assert location.netloc == "accounts.google.com"
        assert query["client_id"] == ["chat-client-id"]
        assert query["redirect_uri"] == [
            "https://jdlx-chat-backend.onrender.com/google/callback"
        ]
        assert query["state"][0].startswith(
            "chat|https://jdlx-chat.vercel.app|"
        )
        assert query["state"][0].endswith("|challenge-123")

        rejected = client.get("/login/google?flow=store")
        assert rejected.status_code == 400


def test_chat_realtime_token_is_scoped_to_user_and_rooms(app_module, monkeypatch):
    """Private-channel JWTs must not grant access to another user's topics."""
    import chat_routes

    chat_app = _chat_client(app_module)
    monkeypatch.setattr(chat_routes, "broadcast_supabase_chat_event", lambda messages: None)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)

    def sign_in(client, label):
        response = client.post("/api/chat/auth/login-mobile", json={
            "phone": f"99{uuid.uuid4().int % 10**8:08d}",
            "full_name": f"{label} Realtime",
            "username": f"{label.lower()}_{uuid.uuid4().hex[:8]}",
        })
        assert response.status_code == 200, response.get_json()
        return response.get_json()["data"]

    with chat_app.app.test_client() as client:
        alice = sign_in(client, "Alice")
        headers = {"Authorization": f"Bearer {alice['chat_token']}"}
        unavailable = client.get("/api/chat/realtime-token", headers=headers)
        assert unavailable.status_code == 503

        monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-realtime-secret-0123456789abcdef")
        bob = sign_in(client, "Bob")
        request = client.post(
            "/api/chat/friends/request",
            headers=headers,
            json={"target_user_id": bob["user"]["id"]},
        )
        assert request.status_code == 200
        accepted = client.post(
            "/api/chat/friends/respond",
            headers={"Authorization": f"Bearer {bob['chat_token']}"},
            json={"request_id": request.get_json()["data"]["request_id"], "action": "accept"},
        )
        assert accepted.status_code == 200
        room_id = accepted.get_json()["data"]["room_id"]

        response = client.get("/api/chat/realtime-token", headers=headers)
        assert response.status_code == 200
        data = response.get_json()["data"]
        claims = jwt.decode(
            data["token"],
            "test-realtime-secret-0123456789abcdef",
            algorithms=["HS256"],
            audience="authenticated",
        )
        assert claims["chat_user_id"] == alice["user"]["id"]
        assert claims["role"] == "authenticated"
        assert f"chat_user_{alice['user']['id']}" in claims["allowed_topics"]
        assert f"chat_room_{room_id}" in claims["allowed_topics"]
        assert f"chat_user_{bob['user']['id']}" not in claims["allowed_topics"]


def test_broadcast_worker_marks_messages_private_when_configured(monkeypatch):
    """A private Supabase channel ignores broadcasts without private=true."""
    import chat_routes

    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(request, timeout):
        captured["body"] = json.loads(request.data)
        captured["authorization"] = request.get_header("Authorization")
        return FakeResponse()

    monkeypatch.setattr(chat_routes.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-realtime-secret-0123456789abcdef")
    chat_routes._dispatch_supabase_broadcast_worker([
        {"topic": "chat_room_7", "event": "new_message", "payload": {"id": 9}}
    ])
    assert captured["body"]["messages"][0]["private"] is True
    service_claims = jwt.decode(
        captured["authorization"].split(" ", 1)[1],
        "test-realtime-secret-0123456789abcdef",
        algorithms=["HS256"],
        audience="authenticated",
    )
    assert service_claims["role"] == "service_role"

    monkeypatch.delenv("SUPABASE_JWT_SECRET")
    chat_routes._dispatch_supabase_broadcast_worker([
        {"topic": "chat_room_7", "event": "new_message", "payload": {"id": 9}}
    ])
    assert "private" not in captured["body"]["messages"][0]
