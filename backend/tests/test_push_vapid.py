"""A VAPID key rotation must not leave dead push subscriptions behind.

Production logs showed `400 VapidPkHashMismatch` and `403 ... VAPID credentials
do not correspond to the credentials used to create the subscriptions`. Only
404/410 were pruned, so those rows were retried forever and the device never
received another push — including incoming-call notifications.
"""


def _web_push_error(status_code, body):
    from notifications import notification_service as ns

    class Response:
        def __init__(self):
            self.status_code = status_code
            self.text = body

    class Error(ns.WebPushException):
        # pywebpush's WebPushException carries the HTTP response; the fallback
        # (when the package is absent) is plain Exception, so attach it here
        # instead of relying on a constructor kwarg.
        def __init__(self, message):
            super().__init__(message)
            self.response = Response()

    return Error(f"Push failed: {status_code}")


def _patch_push(monkeypatch, error):
    from notifications import notification_service as ns

    deleted = []
    monkeypatch.setattr(ns, "_WEBPUSH_AVAILABLE", True)
    monkeypatch.setattr(ns, "_resolve_vapid_keys", lambda: ("public", "private"))
    monkeypatch.setattr(
        ns,
        "_load_push_subscriptions",
        lambda user_id, limit=10: [
            {
                "id": 7,
                "endpoint": "https://push.example/abc",
                "p256dh": "key",
                "auth": "auth",
            }
        ],
    )
    monkeypatch.setattr(ns, "_delete_push_subscription", lambda sub_id: deleted.append(sub_id))

    def reject(**kwargs):
        raise error

    monkeypatch.setattr(ns, "webpush", reject)
    return ns, deleted


def test_vapid_key_mismatch_is_detected():
    from notifications import notification_service as ns

    assert ns._is_vapid_key_mismatch(
        _web_push_error(400, '{"reason":"VapidPkHashMismatch"}')
    ) is True
    assert ns._is_vapid_key_mismatch(
        _web_push_error(
            403,
            "the VAPID credentials in the authorization header do not correspond "
            "to the credentials used to create the subscriptions.",
        )
    ) is True
    assert ns._is_vapid_key_mismatch(_web_push_error(500, "internal error")) is False


def test_vapid_key_mismatch_prunes_the_subscription(monkeypatch):
    ns, deleted = _patch_push(
        monkeypatch, _web_push_error(400, '{"reason":"VapidPkHashMismatch"}')
    )

    assert ns.send_chat_push(1, "Incoming call", "Someone is calling…") == 0
    assert deleted == [7]


def test_other_push_errors_keep_the_subscription(monkeypatch):
    ns, deleted = _patch_push(monkeypatch, _web_push_error(500, "internal error"))

    assert ns.send_chat_push(1, "Incoming call", "Someone is calling…") == 0
    assert deleted == []
