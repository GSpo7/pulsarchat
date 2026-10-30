# PulsarChat

**Encrypted chat with no accounts.** Disposable peer-to-peer *ghost rooms*, plus *permanent rooms* you can reopen any time with a code you choose.

This is a self-hosted deployment of [munroo/pulsarchat](https://github.com/munroo/pulsarchat) (AGPL-3.0, by //tedDev) with one added feature: permanent rooms.

---

## ✦ Features

- End-to-end encryption (ECDH + AES-256-GCM)
- **Ghost rooms** peer-to-peer via WebRTC, nothing stored anywhere
- **Permanent rooms** *(new)* pick any code (text or digits, 1–2 048 characters); everyone who enters it shares one chat that is kept on the server and can be reopened from any device
- Live typing indicator, emoji, encrypted image sharing, replies
- Contacts with ping-to-chat, saved chats (history kept on your device)
- Security fingerprint verification (ghost rooms)

## ✦ How permanent rooms work

1. Your browser stretches the code with PBKDF2-SHA256 (600 000 iterations) into a **room ID** and an **AES-256-GCM key**.
2. Only the room ID is sent to the server. **The code and the key never leave your browser.**
3. Messages are encrypted before sending; the server stores ciphertext and relays it live to everyone in the room. It cannot read anything.
4. Re-enter the same code on any device → same room, full history.

Things to know
- **Lose the code, lose the chat.** There is no recovery.
- Anyone with the code can read and write. Short codes can be guessed — use *generate* or a long passphrase.
- Rooms never expire and there is no "delete for everyone". The operator can purge a room.
- The operator can see metadata (timing, sizes, IPs in infrastructure logs), not content.

Details: [PLAN.md](PLAN.md). Hosting: [DEPLOYMENT.md](DEPLOYMENT.md).

## ✦ Tech stack

React + Vite · PeerJS/WebRTC · Web Crypto API · Node + Express + `ws` · SQLite (`better-sqlite3`)

## ✦ Run locally

```bash
npm install
cp .env.example .env        # for local dev you can leave most values as they are
npm run dev:server          # terminal 1 — server on :9000 (no dist/ needed in dev)
npm run dev                 # terminal 2 — Vite dev server with proxy to :9000
```

Open the HTTPS address Vite prints (accept the self-signed certificate). Ghost mode needs TURN credentials only for strict networks.

```bash
npm test                    # database, WebSocket, crypto and end-to-end tests
npm run build && npm start  # production build served by the Node server
```

## ✦ Deploy

One small VPS + Cloudflare Tunnel serves everything from a single origin.

## ✦ Environment variables

See [.env.example](.env.example) for the full, commented list (browser-side `VITE_*` values are compiled in at build time; server values are read at runtime).

## ✦ Operating permanent rooms

```bash
node scripts/purge-room.js --list              # rooms (hashes, sizes) — never content
node scripts/purge-room.js --code "the code"   # delete one room (asks for confirmation)
```

## ✦ License

AGPL-3.0 — see [LICENSE](LICENSE). If you run a modified version as a public service you must offer its source to users: publish your fork and set `VITE_SOURCE_URL` so the in-app link points to it.

Original project by //tedDev.
