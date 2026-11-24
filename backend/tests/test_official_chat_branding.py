import pytest
import io
import jwt
from jwt_config import get_jwt_secret

def test_chat_branding_and_logo_upload(client, db, make_user, mint_token):
    # Admin auth now re-checks the live users row, so use a real admin account
    # with a normal exp-bearing token (instead of a bare signed payload).
    admin_id = make_user(email='chat_branding_admin@example.com', role='super_admin', name='Branding Admin')
    admin_token = mint_token(admin_id, role='super_admin')

    # 1. Fetch chat settings
    res = client.get('/api/chat/admin/settings', headers={
        'Authorization': f'Bearer {admin_token}'
    })
    assert res.status_code == 200
    data = res.get_json()
    assert data['success'] is True
    assert 'official_chat_logo' in data['data']
    assert 'official_chat_name' in data['data']

    # 2. Upload a new logo image
    fake_png = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
    data_payload = {
        'file': (io.BytesIO(fake_png), 'test_chat_icon.png', 'image/png')
    }
    upload_res = client.post('/api/chat/admin/upload-logo', headers={
        'Authorization': f'Bearer {admin_token}'
    }, data=data_payload, content_type='multipart/form-data')

    assert upload_res.status_code == 200
    upload_data = upload_res.get_json()
    assert upload_data['success'] is True
    logo_url = upload_data['data']['url']
    # Cloud mirror may replace `url` with a hosted (http) URL — the stable
    # identity of the stored file lives in `filename` (always chat_logo_ fixed).
    assert 'chat_logo_' in upload_data['data']['filename']

    # 3. Verify the public branding endpoint reflects the new logo. The
    # storefront `/api/settings` route lives in a different repository; this
    # standalone backend publishes the same two display fields at
    # /api/chat/branding.
    pub_res = client.get('/api/chat/branding')
    assert pub_res.status_code == 200
    pub_settings = pub_res.get_json()['data']
    assert pub_settings.get('official_chat_logo') == logo_url

    # 4. Update chat settings (e.g. app name and custom url or reset)
    update_res = client.post('/api/chat/admin/settings', headers={
        'Authorization': f'Bearer {admin_token}'
    }, json={
        'official_chat_name': 'JDLX VIP Concierge',
        'official_chat_logo': ''
    })
    assert update_res.status_code == 200

    # Verify updated settings
    verify_res = client.get('/api/chat/admin/settings', headers={
        'Authorization': f'Bearer {admin_token}'
    })
    assert verify_res.status_code == 200
    verify_data = verify_res.get_json()['data']
    assert verify_data['official_chat_name'] == 'JDLX VIP Concierge'
    assert verify_data['official_chat_logo'] == ''
