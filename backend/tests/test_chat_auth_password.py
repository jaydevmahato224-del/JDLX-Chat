import pytest

def test_chat_auth_check_username_and_email_stripping(client, db):
    # 1. Clean handle check
    res = client.get('/api/chat/auth/check-username?username=rohit_99')
    assert res.status_code == 200
    data = res.get_json()
    assert data['available'] is True
    assert data['sanitized'] == 'rohit_99'

    # 2. Email handle check (strips domain)
    res = client.get('/api/chat/auth/check-username?username=jaydevmahato52964@gmail.com')
    assert res.status_code == 200
    data = res.get_json()
    assert data['available'] is True
    assert data['sanitized'] == 'jaydevmahato52964'

    # 3. Concatenated email domain (autofill artifact)
    res = client.get('/api/chat/auth/check-username?username=jaydevmahato52964gmailcom')
    assert res.status_code == 200
    data = res.get_json()
    assert data['available'] is True
    assert data['sanitized'] == 'jaydevmahato52964'

    # 4. Purely numeric username rejected (reserved for mobile login)
    res = client.get('/api/chat/auth/check-username?username=9876543210')
    assert res.status_code == 200
    data = res.get_json()
    assert data['available'] is False
    assert "at least one letter" in data['message']


def test_chat_registration_and_password_login_flow(client, db):
    # 1. Register user A with handle, phone, password
    reg_payload = {
        'full_name': 'Aarav Patel',
        'username': 'aarav_patel',
        'phone': '9812345678',
        'password': 'SecurePassword123'
    }
    reg_res = client.post('/api/chat/auth/register', json=reg_payload)
    assert reg_res.status_code == 201
    reg_data = reg_res.get_json()
    assert reg_data['success'] is True
    assert reg_data['data']['user']['username'] == 'aarav_patel'
    assert 'password_hash' not in reg_data['data']['user']
    assert reg_data['data']['chat_token'] is not None

    # 2. Register again with same username should return 409 Conflict
    dup_u_res = client.post('/api/chat/auth/register', json={
        'full_name': 'Another User',
        'username': 'aarav_patel',
        'phone': '9899999999',
        'password': 'Password999'
    })
    assert dup_u_res.status_code == 409
    assert "already taken" in dup_u_res.get_json()['message']

    # 3. Register again with same mobile should return 409 Conflict
    dup_p_res = client.post('/api/chat/auth/register', json={
        'full_name': 'Another User 2',
        'username': 'different_handle',
        'phone': '9812345678',
        'password': 'Password999'
    })
    assert dup_p_res.status_code == 409
    assert "already exists" in dup_p_res.get_json()['message']

    # 4. Short password should fail with 400
    short_pw_res = client.post('/api/chat/auth/register', json={
        'full_name': 'Short PW User',
        'username': 'short_pw_user',
        'phone': '9888888888',
        'password': '123'
    })
    assert short_pw_res.status_code == 400
    # The policy was strengthened to 8+ characters with mixed case and a digit.
    assert "at least 8 characters" in short_pw_res.get_json()['message']

    # 5. Check username availability for taken username
    chk_res = client.get('/api/chat/auth/check-username?username=aarav_patel')
    assert chk_res.status_code == 200
    assert chk_res.get_json()['available'] is False

    # 6. Login using USERNAME + PASSWORD
    login_u_res = client.post('/api/chat/auth/login', json={
        'identifier': '@aarav_patel',
        'password': 'SecurePassword123'
    })
    assert login_u_res.status_code == 200
    login_u_data = login_u_res.get_json()
    assert login_u_data['success'] is True
    assert login_u_data['data']['user']['username'] == 'aarav_patel'
    assert 'password_hash' not in login_u_data['data']['user']

    # 7. Login using MOBILE NUMBER + PASSWORD
    login_p_res = client.post('/api/chat/auth/login', json={
        'identifier': '9812345678',
        'password': 'SecurePassword123'
    })
    assert login_p_res.status_code == 200
    login_p_data = login_p_res.get_json()
    assert login_p_data['success'] is True
    assert login_p_data['data']['user']['username'] == 'aarav_patel'

    # 8. Login with WRONG PASSWORD should return 401
    bad_pw_res = client.post('/api/chat/auth/login', json={
        'identifier': 'aarav_patel',
        'password': 'WrongPasswordXYZ'
    })
    assert bad_pw_res.status_code == 401
    assert "Incorrect password" in bad_pw_res.get_json()['message']

    # 9. Login with NON-EXISTENT USERNAME should return 404
    no_u_res = client.post('/api/chat/auth/login', json={
        'identifier': 'nobody_here_xyz',
        'password': 'SomePassword123'
    })
    assert no_u_res.status_code == 404

    # 10. Login with NON-EXISTENT PHONE should return 404
    no_p_res = client.post('/api/chat/auth/login', json={
        'identifier': '9999900000',
        'password': 'SomePassword123'
    })
    assert no_p_res.status_code == 404
