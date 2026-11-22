# TURN relay (self-hosted coturn)

Voice/video calls use WebRTC. ICE tries the cheapest path first — a direct
device-to-device connection — and that only works when both phones can reach
each other. Two phones on mobile data sit behind carrier-grade NAT, where the
direct path does not exist: the call shows "active", the timer runs, and both
sides hear nothing. A TURN relay is the fallback that makes those calls work.

Direct calls still bypass the relay, so only the calls that need it consume
bandwidth (~0.5–1 MB per minute for voice).

## 1. Server

Any Linux VPS with a public IPv4 works; 1 vCPU / 1 GB is plenty.

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
# or: curl -fsSL https://get.docker.com | sh
```

Copy this directory (`docker-compose.yml`, `turnserver.conf`, `example.env`) to
the server, then:

```bash
cd deploy/turn
cp example.env .env
openssl rand -hex 32          # paste this into TURN_SECRET
nano .env                     # PUBLIC_IP=<server public ip>, TURN_SECRET=<secret>
```

## 2. Firewall

Open exactly these ports (matching `min-port`/`max-port` in
`turnserver.conf`):

```bash
sudo ufw allow 3478/udp        # TURN/STUN over UDP
sudo ufw allow 3478/tcp        # TURN over TCP (networks that block UDP)
sudo ufw allow 49160:49200/udp # media relay range
sudo ufw allow 5349/tcp        # only if you enable TLS (step 5)
```

If the VPS has its own cloud firewall/security group, open the same ports there
too.

## 3. Start

```bash
docker compose up -d
docker logs -f jdlx-coturn     # look for "Default realm" and no TLS error spam
```

A single `401` when a client first connects is normal (the client is being
challenged). An endless stream of `401`s is not — see troubleshooting.

## 4. Point the chat backend at it

Set these on the backend (Railway → Variables) and restart:

| Variable | Value |
|---|---|
| `TURN_URLS` | `turn:203.0.113.10:3478?transport=udp,turn:203.0.113.10:3478?transport=tcp` |
| `TURN_SECRET` | the same secret from `.env` |
| `TURN_TTL` | optional, credential lifetime in seconds (default `3600`, clamped 300–86400) |

Use the public IP or a DNS name that resolves to it. With `TURN_SECRET` set the
backend mints a short-lived credential per call
(`<expiry>:<user id>` + HMAC-SHA1), so the secret itself never reaches a
browser or the APK. A static provider instead uses `TURN_USERNAME` +
`TURN_CREDENTIAL`, and `ICE_SERVERS_JSON` overrides everything.

No frontend rebuild is needed: the client fetches `/api/chat/ice-servers` on
every call.

## 5. TLS (only if a network blocks UDP/TCP 3478)

Strict corporate/hotel Wi-Fi often allows only 443/tcp. Point a DNS record at
the server, issue a certificate, and add the TLS flags:

```bash
sudo certbot certonly --standalone -d turn.example.com
```

In `docker-compose.yml` mount the certificate directory and extend `command`:

```yaml
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt:ro
    command:
      # ...existing flags...
      - --cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
      - --pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

Then add `turns:turn.example.com:5349?transport=tcp` to `TURN_URLS` (or use
`--tls-listening-port=443` and `turns:turn.example.com:443` when even 5349 is
blocked).

## 6. Verify

```bash
# The backend must now return a TURN entry with a rotating username.
curl -s -H "Authorization: Bearer $CHAT_TOKEN" \
  https://<backend>/api/chat/ice-servers
```

Expected:

```json
{"urls": "turn:203.0.113.10:3478?transport=udp",
 "username": "1760000000:42",
 "credential": "..."}
```

Then place a real call between two phones on mobile data (Wi-Fi off) and check
`chrome://webrtc-internals` on the web build: the selected candidate pair should
include a `relay` candidate. On the APK, a successful call from mobile data is
the proof.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No `turn:` entry in `/api/chat/ice-servers` | `TURN_URLS`/`TURN_SECRET` not set on the backend, or it was not restarted |
| Relay candidate gathered, call still fails | UDP relay range blocked, or `--external-ip` wrong (behind 1:1 NAT use `PUBLIC_IP/PRIVATE_IP`) |
| Logs show a 401 for every request | Clock skew (install/enable NTP) or `TURN_SECRET` mismatch — a trailing space or quotes in `.env` is the usual culprit |
| Works on Wi-Fi, silent on mobile data | The relay is unreachable over UDP — add the TCP/TLS URL, or open the firewall |
| Calls drop when many run at once | `min-port`/`max-port` range too small; widen it and the firewall together |

## Cost

Voice/video relaying is cheap: roughly 0.5–1 MB per minute per relayed call.
Most calls connect directly and never touch the server.
