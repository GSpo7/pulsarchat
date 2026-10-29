# CLAUDE.md — project rules for this repo

This repo is a clone of PulsarChat (AGPL-3.0) being re-hosted on the owner's own Cloudflare domain, plus **exactly one new feature: Permanent Rooms**.

Authoritative documents — read before changing anything:
- [PLAN.md](PLAN.md) — what to build, design decisions, milestones, acceptance checklist
- [DEPLOYMENT.md](DEPLOYMENT.md) — how it is hosted

If a request conflicts with PLAN.md, stop and ask; do not silently deviate.

## Scope (hard limits)

IN scope
1. Milestone 0 clone fixes listed in PLAN.md §2 and §7 (domain strings, `express` dependency, `start` script, static serving, origin allowlist, `CF-Connecting-IP`).
2. Permanent Rooms: a user-chosen code (any text/digits, 1–2 048 chars) opens a room whose messages are stored on the server permanently and can be read any time with the same code.
3. Copy/legal text that must change because permanent rooms store data.

OUT of scope — do not do these unless the owner explicitly asks in the conversation
- Accounts, logins, emails, payments, admin UI
- Auto-expiry/TTL, or any "delete for everyone" in permanent rooms
- Changing ghost mode, contacts, or saved-chat behaviour; refactoring those files "while you're there"
- Touching `android/` or Capacitor/Firebase config
- Moving to another framework, language (no TypeScript migration), bundler, or CSS approach
- New third-party services, or new dependencies beyond `express` and `better-sqlite3` (ask first for anything else)
- Cloudflare Workers/Durable Objects rewrite

## Non-negotiable design rules for Permanent Rooms

1. **The raw code never leaves the browser.** Not in a URL, query string, header, WebSocket frame, log line, or error message. The server only ever receives the derived `roomId`.
2. **The server stores ciphertext only.** No plaintext message text, names or images in the DB or logs. Display names live inside the encrypted payload.
3. Derivation is fixed: code → NFKC-normalise + trim → PBKDF2-SHA256, 600 000 iterations, salt `pulsarchat/permanent/v1`, 64 bytes → 32-byte roomId + 32-byte AES-256-GCM key. A test pins a known vector. Changing it requires a new versioned salt (`v2`), never an edit of `v1`.
4. The DB stores `SHA-256(roomId)`, never `roomId`.
5. **No application code path deletes room data.** No `DELETE FROM messages/rooms` outside `scripts/purge-room.js`. Quotas return an error; they never evict.
6. Share links use the URL **fragment** (`#/r/<code>`); after reading it, clear it with `history.replaceState`.
7. Never log `roomId`, `code`, `iv`, `ct`. Log counts and error codes only.
8. Every limit in PLAN.md §6.3 must be enforced server-side and read from env with the documented default.
9. Client-generated `msgId` must make `send` idempotent (UNIQUE `(room_hash, msg_id)`).
10. Be honest in the UI: never describe permanent rooms as "no logs / no trace / vanishes". Ghost mode keeps its existing wording.

## Code conventions (match the surrounding code)

- JavaScript ES modules, React 18 function components + hooks, CSS Modules (`App.module.css`; add classes there rather than inventing a new styling system).
- Two-space indent, double quotes, semicolons — as in the existing files.
- Server code goes in `server/` (new) and is imported by `server.js`; keep `server.js` thin.
- Client code for the feature goes in `src/permanent/`, `src/hooks/usePermanentRoom.js`, `src/components/Permanent*.jsx`.
- Reuse existing helpers: `utils/image.js` (`compressImage`), `chat/messageModels.js` (`generateMessageId`, `DELIVERY_STATUS`), `utils/emoji.js`. Do not duplicate them. (Exception: use `src/permanent/messageCrypto.js`, not `utils/crypto.js encrypt()`, for permanent rooms — the latter overflows the stack on image-sized payloads.)
- Comments: sparse, explain *why*; same density as existing files.
- No secrets in the repo. New env vars go in `.env.example` with a comment.

## Environment variables (server)

`HOST` (127.0.0.1) · `PORT` (9000) · `NODE_ENV` · `ALLOWED_ORIGINS` (comma list, exact match) · `TRUST_PROXY` (`true` behind Cloudflare Tunnel) · `DATABASE_PATH` (`/var/lib/pulsarchat/pulsar.db`) · `ROOM_MAX_BYTES` (524288000) · `MAX_TEXT_BYTES` (65536) · `MAX_IMAGE_BYTES` (1048576) · `MIN_FREE_DISK_BYTES` (2147483648) · `STATS_SECRET` · `FIREBASE_SERVICE_ACCOUNT` (optional)

Client (build-time): `VITE_SERVER_URL`, `VITE_APP_URL`, `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`, `VITE_WEB3FORMS_KEY`

## Workflow rules

- Work milestone by milestone (PLAN.md §7). Finish and verify one before starting the next. State which milestone a change belongs to.
- Before editing a file outside the "New / Changed files" list in PLAN.md §4.4, say why and wait for approval.
- Verify, don't assume: run `npm run build`; run the server tests (`npm test`) once they exist; for UI changes run the app and exercise the flow. Report failures honestly with the output.
- Small commits on a feature branch (`feature/permanent-rooms`), never directly on `main`. Do not push, deploy, or change Cloudflare/server settings without being asked.
- Do not commit `.env`, `*.db`, `*.db-wal`, `*.db-shm`, `data/`, tunnel credential JSONs.
- Preserve AGPL notices and the original author's attribution; the visible "source code" link must point to the owner's fork.
- Database migrations are additive and versioned (`schema_version`). Never rewrite history of an existing migration.

## Commands

```bash
npm install
npm run dev          # Vite dev server (proxies /notify /peerjs /stats; /permanent added in M2)
npm run build        # outputs dist/
npm start            # node server.js (serves dist/ + signalling + permanent rooms)
npm run dev:server    # server only (dev)
npm test             # node --test: database, WebSocket, crypto, end-to-end
```

## Definition of done (any task)

- Matches PLAN.md and the rules above
- Build passes; relevant tests pass; ghost and saved modes still work
- No secret/plaintext logging introduced
- `.env.example` and docs updated if config changed
