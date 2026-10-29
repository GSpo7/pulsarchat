# PLAN — Permanent Code Rooms for PulsarChat

Status: **implemented on branch `feature/permanent-rooms` (M0–M5 done and tested; M6 = your deployment).** See "Implementation notes" at the end for where the build differs from the original plan.
Scope guard: see [CLAUDE.md](CLAUDE.md). Hosting: see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 1. Goal

1. Re-create the existing app (anonymous, ephemeral P2P chat) on **your own Cloudflare domain**, unchanged in behaviour.
2. Add **one** feature: **Permanent Rooms**.
   - A user types (or generates) any code — letters, digits, or both, any length.
   - Anyone who enters the same code lands in the same room.
   - Messages are **stored on the server forever** and are available any time, from any device, by re-entering the code.
   - No accounts, no sign-up.

Everything else (ghost rooms, contacts, saved chats, settings, Android folder) stays as it is.

## 2. What exists today (findings from the code)

| Area | Today | File(s) |
|---|---|---|
| Frontend | React 18 + Vite, CSS modules | `src/`, `vite.config.js` |
| Ghost chat | PeerJS/WebRTC P2P, ECDH + AES-GCM, nothing stored | `src/chat/*`, `useGhostChatSession.js`, `usePeer.js` |
| "Saved chat" | Still P2P; history kept **only in the browser's IndexedDB**; both people must be online to exchange | `savedChatStore.js`, `useSavedChatSession.js` |
| Identity | Random handle + token in IndexedDB | `utils/identity.js` |
| Server | One Node file: Express + PeerJS signalling at `/peerjs`, WebSocket pings at `/notify`, optional Firebase push, `/stats` | `server.js` |
| Hosting (original) | Vercel (frontend) + Render (server) | `README.md` |
| Server storage | **None.** Everything is in-memory Maps | `server.js` |

Key consequence: the server has **no database** and no way to relay a message to someone who is offline. Permanent rooms therefore need a new server-relayed, server-stored path. They cannot reuse the P2P path.

### Problems found that must be fixed in the clone (Milestone 0)

1. `server.js` imports `express` but `package.json` does not list it (it only works because `peer` pulls it in). Add it explicitly.
2. No `start` script and the server does not serve the built frontend. The original relied on Vercel for that.
3. `ALLOWED_ORIGINS` is hard-coded to `pulsarchat.space`, and the check uses `startsWith` (so `https://pulsarchat.space.evil.com` passes) plus `origin.includes(".vercel.app")`. Replace with an exact-match list read from an env var.
4. Per-IP rate limiting uses `req.socket.remoteAddress`. Behind Cloudflare every user shares the proxy's IP, so the "10 connections/minute" limit would apply to **all users combined**. Must read `CF-Connecting-IP`.
5. `src/components/Waiting.jsx:11` hard-codes `https://www.pulsarchat.space/?room=` in the share link.
6. Branding/domain strings in `index.html`, `robots.txt`, `sitemap.xml`, `Lobby.jsx`, `Settings.jsx`, `Legal.jsx`, `README.md`, `.env.example`.
7. Marketing copy says "no logs, no trace". That stays true for ghost rooms but is **false for permanent rooms**; copy must say so (see §8).

### Licence obligation

The repo is **AGPL-3.0**. If you run a modified version as a public website, you must offer your visitors the source of *your* version (publish your fork and link it in the footer), and keep the existing copyright/licence notices. The "open source" badge in `Lobby.jsx` and the GitHub link in `Settings.jsx` should point to **your** fork. Do not delete the original author's attribution.

---

## 3. Design decisions (and why)

| # | Decision | Reason |
|---|---|---|
| D1 | Permanent rooms use a **server-relayed WebSocket** (`/permanent`) with **SQLite** storage on the same Node server. | Needs to work when the other person is offline. Keeps the whole app on one small server. |
| D2 | **End-to-end encrypted, stored as ciphertext.** The code never leaves the browser. | Matches the app's identity (E2EE). A database leak or a curious operator cannot read messages. *Trade-off:* the server can't search, moderate by content, or show message text in push notifications. |
| D3 | Code → keys via **PBKDF2-SHA256 (600 000 iterations)** in the browser: 64 bytes out = 32-byte **roomId** (what the server sees) + 32-byte **AES-256-GCM key** (never sent). | One secret gives both "find the room" and "decrypt it", and the server can't derive the key from the roomId. |
| D4 | Server stores `SHA-256(roomId)` as the room key, not `roomId`. | A stolen DB can't be used to open rooms through the live API. |
| D5 | "No limit on digits": client accepts **1 to 2 048 characters** (constant, easy to change). | Truly unbounded input is an abuse/UX hazard (huge share links). 2 048 is effectively "no limit" for humans. Long codes cost nothing because PBKDF2 hashes the password once. |
| D6 | **Server cannot enforce a minimum code length** (it never sees the code). The UI warns on weak codes and offers a **Generate** button for a strong random one. | Honest consequence of D2. A code like `1234` can be guessed by anyone. |
| D7 | Rooms are created implicitly on first join. Multi-person (not just 2). | Simplest model; "same code = same room". |
| D8 | **No auto-expiry and no "delete for everyone"** in v1. Users can "forget this room on this device" (local only). Operator can purge a room with a CLI script. | You asked for chats that never delete. A public delete button would let any code-holder wipe history. |
| D9 | Share link puts the code in the **URL fragment**: `https://yourdomain.com/#/r/<code>`. | Fragments are never sent to the server, proxies or Cloudflare logs. |
| D10 | Hosting: **one VPS + Cloudflare Tunnel** serving frontend, signalling and permanent rooms from a single origin. | Cheapest persistent-disk option, no open inbound ports, free HTTPS/DDoS cover from Cloudflare, no CORS. See DEPLOYMENT.md. |
| D11 | Images in permanent rooms: reuse `compressImage()` (≤800 px JPEG), encrypt, store in the same table. Cap 1 MB per message. | No new storage service in v1. (R2 is a later option.) |

### Known limitations to accept up front

- **Lose the code → lose the room.** There is no recovery (D2).
- Weak codes are guessable (D6). Anyone with the code can read, write, and see all history.
- Server operator can see metadata: when messages were sent, sizes, IPs in logs (not content).
- No read receipts / "delivered" ticks in permanent rooms v1 (only queued → sent).
- No push notifications for permanent rooms v1 (in-app and tab-title only).
- Anyone can create unlimited rooms → mitigated by rate limits and quotas (§6.3), not eliminated.

---

## 4. Architecture

```
Browser (React)                        Cloudflare edge                 VPS (Ubuntu)
─────────────────                      ───────────────                 ─────────────────────────
https://yourdomain.com  ─── HTTPS ───► DNS + proxy + TLS ── Tunnel ──► cloudflared ► Node :9000
                                                                          ├─ static  dist/  (React build)
  Ghost / Saved (unchanged)                                               ├─ /peerjs  (PeerJS signalling)
    WebRTC P2P  ◄────────── TURN (ExpressTurn) ──────────►                ├─ /notify  (pings WebSocket)
                                                                          ├─ /permanent (NEW WebSocket)
  Permanent room (NEW)                                                    ├─ /api/health (NEW)
    PBKDF2(code) → roomId + AES key                                       └─ SQLite file (NEW) /var/lib/pulsarchat/pulsar.db
    encrypt → WS → server stores ciphertext → broadcast to room
```

### 4.1 Crypto flow (client)

```
code (utf-8, 1..2048 chars)
  └─ PBKDF2-SHA256, salt = "pulsarchat/permanent/v1", 600 000 iters ─► 64 bytes
        ├─ bytes 0..31  → roomId  (base64url)   → sent to server (bearer credential)
        └─ bytes 32..63 → AES-256-GCM key       → stays in the browser
message plaintext = JSON { text | image, replyTo, name, v:1 }
  → AES-GCM(random 12-byte IV) → { iv, ct }   (reuse encrypt()/decrypt() from utils/crypto.js)
```

The salt is app-wide (no per-room salt is possible without the server knowing something about the code). This means very weak codes can be brute-forced offline *if the database leaks*. PBKDF2 slows that down; it cannot fix it. This is why D6 exists.

### 4.2 Wire protocol (`wss://domain/permanent`)

All frames are JSON, ≤ 1.5 MB.

Client → server
| type | fields | notes |
|---|---|---|
| `join` | `roomId`, `senderId`, `afterSeq?` | `senderId` = random id per device per room, kept in IndexedDB. `afterSeq` = last seq the client has (for catch-up). |
| `send` | `kind` (`text`|`image`), `msgId`, `iv`, `ct` | `msgId` is client-generated (idempotent: resend after reconnect never duplicates). `kind` selects the size cap (the server cannot see inside the ciphertext). |
| `history` | `beforeSeq`, `limit` (≤100) | page older messages. |
| `typing` | `iv`, `ct` | relayed only, **not stored**. |
| `ping` | – | keepalive every 25 s (Cloudflare drops idle sockets at ~100 s). |

Server → client
| type | fields |
|---|---|
| `joined` | `roomId`, `lastSeq`, `online` (count) |
| `messages` | `items:[{seq, msgId, senderId, ts, iv, ct}]`, `hasMore` |
| `message` | one live item (same shape) |
| `ack` | `msgId`, `seq`, `ts` |
| `typing` | `senderId`, `iv`, `ct` |
| `presence` | `online` count |
| `error` | `code` (`rate_limited`, `too_large`, `quota`, `bad_request`) |

### 4.3 Database (SQLite, WAL mode, `better-sqlite3`)

```sql
CREATE TABLE rooms (
  room_hash   BLOB PRIMARY KEY,        -- SHA-256(roomId)
  created_at  INTEGER NOT NULL,        -- unix ms
  last_seq    INTEGER NOT NULL DEFAULT 0,
  bytes_used  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  room_hash BLOB    NOT NULL REFERENCES rooms(room_hash),
  seq       INTEGER NOT NULL,          -- 1,2,3… per room, assigned by server in a transaction
  msg_id    TEXT    NOT NULL,
  sender_id TEXT    NOT NULL,
  ts        INTEGER NOT NULL,          -- server time, unix ms
  iv        TEXT    NOT NULL,
  ct        BLOB    NOT NULL,
  PRIMARY KEY (room_hash, seq),
  UNIQUE (room_hash, msg_id)
) WITHOUT ROWID;
```
No `DELETE` is ever issued by application code. A migration table (`schema_version`) guards future changes.

### 4.4 New / changed files

New
- `server/db.js` — open DB, pragmas, prepared statements, migrations
- `server/permanentRooms.js` — WS handler, room registry, broadcast, limits
- `server/rateLimit.js` — small sliding-window limiter keyed by client IP
- `server/clientIp.js` — reads `CF-Connecting-IP` (only trusted when `TRUST_PROXY=true`)
- `scripts/purge-room.js` — operator CLI (takes a roomId hash, deletes with confirmation)
- `src/permanent/roomKeys.js` — PBKDF2 derivation, code generator, strength check
- `src/permanent/permanentClient.js` — WebSocket client, reconnect/backoff, resend queue
- `src/permanent/permanentStore.js` — IndexedDB: rooms joined on this device (code, label, senderId, lastSeq, local display name)
- `src/hooks/usePermanentRoom.js`
- `src/components/PermanentLobby.jsx` (enter/generate code, list of rooms on this device)
- `src/components/PermanentChat.jsx`

Changed (minimal)
- `server.js` — serve `dist/`, mount `/permanent`, `/api/health`, env-driven origins, `CF-Connecting-IP`
- `package.json` — add `express`, `better-sqlite3`, `start` script
- `src/hooks/useAppNavigation.js` — add `APP_MODE.PERMANENT` + two views
- `src/App.jsx` — render the two new views
- `src/components/Lobby.jsx` — one new "Permanent room" card/button
- `src/utils/url.js` — parse `#/r/<code>` share links
- copy/domain strings (list in §2 item 5–7)
- `.env.example`, `README.md`, `.gitignore` (add `*.db`, `*.db-wal`, `*.db-shm`, `data/`)

Nothing in `src/chat/*`, `useGhostChatSession.js`, `useSavedChat*.js`, `savedChatStore.js` or `android/` is touched.

---

## 5. UX

**Lobby** gains a third card next to "Start a room / Join a room": **Permanent room**.

**PermanentLobby**
1. Input: "your code" (any text/number, show/hide toggle) + strength hint ("short codes can be guessed by anyone — use a longer one or tap Generate").
2. **Generate** → random 20-character code in four groups (`XXXXX-XXXXX-XXXXX-XXXXX`, ≈ 100 bits); **Copy code** and **Copy invite link**.
3. Checkbox "remember on this device" (default on) → saves code locally so the room appears in the list.
4. Display name (optional, per room, stored locally and sent *inside* encrypted messages).
5. List of rooms remembered on this device (label, name) + "forget on this device".
6. Big, plain warning on first use: **"If you lose this code, nobody can recover this chat."**

**PermanentChat** — same look as the existing Chat/SavedChat: bubbles, emoji picker, image send with lightbox, reply-to, typing indicator, timestamps, connection status pill (connecting / live / reconnecting), "N online", infinite scroll up for history, offline queue (messages typed while disconnected are sent on reconnect using the `msgId` idempotency key).

---

## 6. Server behaviour details

### 6.1 Ordering & delivery
`seq` is assigned inside a SQLite transaction (`UPDATE rooms SET last_seq = last_seq + 1 … RETURNING`). The server then acks the sender and broadcasts to every other socket in that room. A reconnecting client sends `afterSeq` and receives everything it missed.

### 6.2 Multiple devices / tabs
Each socket is independent. The same user on two devices simply has two `senderId`s unless they copy the code to both — acceptable.

### 6.3 Abuse limits (all configurable via env)
- max frame 1.5 MB; max text ciphertext 64 KB; max image message 1 MB
- per-socket: 20 messages / 10 s
- per-IP (via `CF-Connecting-IP`): 30 joins / min, 20 new rooms / hour
- per-room quota `ROOM_MAX_BYTES` (default 500 MB) → `quota` error, **never deletes old data**
- global disk watermark: refuse new rooms if free disk < 2 GB; log loudly
- sockets idle > 90 s without ping are closed

### 6.4 Logging policy
Log counts and error codes only. **Never** log `roomId`, `ct`, `iv`, or codes. Cloudflare/`cloudflared` logs may still contain IPs; mention in the legal page.

### 6.5 Backups
Nightly `sqlite3 pulsar.db ".backup …"` → gzip → Cloudflare R2 (free tier) with 30-day rotation. Restore procedure is in DEPLOYMENT.md. A permanent chat with no backup is not permanent.

---

## 7. Milestones (do them in order; each ends with a testable result)

### M0 — Faithful clone on your domain (no new feature)
1. Fork/clone, set new git remote.
2. Add `express` to `package.json`; add `"start": "node server.js"`.
3. `server.js`: serve `dist/` with SPA fallback (long-cache `/assets/*`); listen on `HOST` (default `127.0.0.1` in production); origins from `ALLOWED_ORIGINS` env (exact match, drop `.vercel.app`); `/api/health`; `CF-Connecting-IP` handling behind `TRUST_PROXY`.
4. Replace domain/branding strings; fix `Waiting.jsx` share URL; point source links to your fork.
5. Get your own TURN credentials (ExpressTurn or Cloudflare Realtime TURN) and, optionally, a Web3Forms key.
6. Deploy following DEPLOYMENT.md **Parts 1–8**.
   **Done when:** two phones on different networks (one on mobile data) can create/join a ghost room at `https://yourdomain.com`, and contacts/saved chats work.

### M1 — Server persistence layer
`server/db.js`, schema, migrations, unit tests (Node `node:test`) for: create room, seq monotonicity under concurrent inserts, idempotent `msg_id`, paging, quota.
**Done when:** `npm test` passes against a temp DB file.

### M2 — `/permanent` WebSocket
Handler, rate limits, presence, typing relay, catch-up, history paging, health endpoint. Test with a Node script using `ws` (two clients, kill one, reconnect, verify catch-up and no duplicates).
**Done when:** scripted scenario passes, and server restart loses no acked message.

### M3 — Client crypto + transport
`roomKeys.js`, `permanentClient.js`, `permanentStore.js`. Test vectors: same code → same roomId/key; different code → different; unicode and 2 048-char codes; wrong key fails GCM auth.
**Done when:** a browser-console script can join, send, receive, and decrypt.

### M4 — UI
Lobby card, PermanentLobby, PermanentChat, navigation, `#/r/<code>` deep link (consumed then immediately cleared from the address bar with `history.replaceState`).
**Done when:** the acceptance checklist in §9 passes.

### M5 — Copy, legal, hardening
Update Legal/Lobby/`index.html` text for the permanent-room data policy; verify no logging of secrets; run an `npm audit`; load-test 200 sockets in one room; restore-from-backup drill.

### M6 — Release
Deploy via `deploy.sh`, smoke test on the live domain, enable backups + uptime monitor.

---

## 8. Copy changes required (honesty)

- Tagline stays for ghost mode. Add under Permanent: "Messages are end-to-end encrypted and stored on our server until you stop using the room. We can't read them. If you lose your code they cannot be recovered."
- `Legal.jsx`: add a section describing what the server stores (ciphertext, timestamps, sender id, size), what it can't see (text, images, code), IP handling, and that rooms are never auto-deleted.
- `index.html` description/OG text: remove "vanish when you close it" for the site-level description, or qualify it with "ghost rooms".

---

## 9. Acceptance checklist

Functional
- [ ] Code `1` works; code with spaces/emoji/non-Latin works; 2 048-char code works; 2 049 rejected with a clear message.
- [ ] Same code on two devices → same history. Different code → empty, separate room.
- [ ] A sends while B offline; B opens later and sees it, in order.
- [ ] Kill server mid-conversation, restart: nothing acked is lost; clients reconnect automatically and queued messages send once.
- [ ] Image send/receive; reply-to; emoji; typing indicator; "N online".
- [ ] Scroll-up loads older pages; 10 000-message room opens fast (first page < 1 s).
- [ ] Share link `#/r/<code>` opens the room and the code disappears from the address bar.
- [ ] "Forget on this device" removes local data only; re-entering the code restores history.

Security
- [ ] Inspect DB with `sqlite3`: no plaintext, no raw roomId, no code anywhere.
- [ ] Network tab: code never appears in any request/URL/header; only the derived roomId.
- [ ] Server logs contain no secrets.
- [ ] Origin check rejects a foreign `Origin`. Rate limits trigger per real client IP, not per Cloudflare IP.
- [ ] Oversized frames and malformed JSON do not crash the server.

Regression
- [ ] Ghost room create/join, contacts ping, saved chats behave exactly as before.

---

## 10. Cost estimate

| Item | Approx. |
|---|---|
| VPS (2 vCPU/2 GB is plenty) | ≈ €4–6 / month |
| Cloudflare DNS, proxy, Tunnel, R2 backups (free tier) | $0 |
| TURN (ExpressTurn free tier) | $0 |
| Domain | already owned |

## 11. Out of scope (do not build unless asked)

Accounts/logins, payments, admin dashboard, message editing/deleting for everyone, search, voice/video, file attachments other than compressed images, push notifications for permanent rooms, Android build changes, migrating ghost/saved modes to the server, moving to Cloudflare Workers/Durable Objects.

## 12. Later options (not now)

- Cloudflare Workers + Durable Objects (SQLite) for edge-hosted rooms — would need a PeerJS-compatible signalling rewrite for ghost mode.
- R2 for large attachments; Web Push for permanent rooms; Argon2id via WASM instead of PBKDF2; optional per-room "owner" key for admin actions.

---

## 13. Implementation notes (what was built, and deviations from the plan above)

Built and verified: M0 (clone fixes), M1 (SQLite layer), M2 (`/permanent` WebSocket), M3 (client crypto/transport), M4 (UI), M5 (copy/legal/hardening). Verification: `npm test` (30 tests: database, WebSocket protocol, crypto, and a full two-user end-to-end through the real server), a real-Chrome run of the whole user flow with two isolated browser profiles (14 checks incl. "code never appears in any request"), a ghost-mode regression run, and the Vite dev-proxy path.

Deviations
- **Code generator** produces a 20-character grouped code (~100 bits) instead of a 4-word passphrase (~44 bits): stronger, and needs no word list.
- **`kind` field** added to `send` frames (text/image) so the server can apply different size caps.
- **Rooms are created by the first message, not by joining**, so merely probing codes creates nothing and the per-IP "new rooms" limit applies to real rooms.
- **Code normalisation** (NFKC + trim) is part of the frozen v1 derivation so the same visible text opens the same room on every device and a stray pasted space cannot silently open a different room. Codes are case-sensitive.
- **No unread dot / last-activity** in the saved-room list (message history lives only on the server; the list shows label and name).
- **`utils/crypto.js encrypt()` is not reused**: it spreads the ciphertext into `String.fromCharCode(...)`, which overflows the call stack for image-sized payloads; `src/permanent/messageCrypto.js` encodes in slices instead.
- Extra fixes found during M0: `/stats` was open when `STATS_SECRET` was unset (now requires it); rate-limit map cleanup; origin checks are exact-match; the "Vercel Analytics" claim in the legal text (no analytics code exists) was replaced.
- Dev note: the repo's Vite dev server uses `@vitejs/plugin-basic-ssl`; on the Node 25 used during development Chrome rejected its certificate (`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`). That is pre-existing and unrelated; the proxy itself was verified over plain HTTP.

Known limitations still true
- The operator (or anyone who steals the server) could delete, reorder or replay ciphertext; AES-GCM protects each message's content and authenticity but not the completeness of the history.
- Weak codes are guessable and, if the database leaked, brute-forceable offline (PBKDF2 slows this but cannot prevent it).
- No push notifications for permanent rooms; no delivery/read receipts.
