# bilihistory-recorder

Node.js app (also deployable to Cloudflare Workers). All source files under `src/`. Vite builds frontend to `dist/`, esbuild bundles backend to `dist/server.js`.

## Commands

```bash
pnpm build:frontend   # vite build -> dist/ (SolidJS from src/index.html + src/frontend.tsx)
pnpm build:backend    # esbuild src/index.ts -> dist/server.js
pnpm start            # build + run with sqlite (default)
pnpm start:json       # build + run with JSON file backend (STORAGE_BACKEND=json)
pnpm start:webdav     # build + run with WebDAV backend (STORAGE_BACKEND=webdav)
pnpm deploy           # build frontend + wrangler deploy (D1 backend)
pnpm dev:all          # wrangler dev (with D1)
```

## Architecture

| File | Purpose |
|------|---------|
| `src/index.ts` | Hono API routes (bili fetch, auth, history sync/list/clear) + static file serve + server bootstrap |
| `src/db.ts` | Storage adapter layer: D1 / SQLite / JSON files / WebDAV |
| `src/frontend.tsx` | SolidJS SPA: login/register, Cookie input, fetch & decrypt real Bili history as video cards |
| `src/crypto.ts` | Client-side crypto: PBKDF2 key derivation, AES-GCM encrypt/decrypt, HMAC-SHA256 blind index |
| `src/index.html` | HTML host with Tailwind CSS CDN |

## Storage Backends

Select via `STORAGE_BACKEND` env var (Node.js mode):

| Backend | Env Var | Description |
|---------|---------|-------------|
| `sqlite` (default) | — | better-sqlite3, local file `bili_vault.db` |
| `json` | `JSON_STORAGE_PATH` (default `./data`) | Flat JSON files per user |
| `webdav` | `WEBDAV_URL`, `WEBDAV_USERNAME`, `WEBDAV_PASSWORD` | Remote WebDAV (Nextcloud etc.) |
| `d1` | (auto in CF Workers) | Uses `env.DB` D1 binding |

In Cloudflare Workers mode (`env.DB` present) D1 is always used, ignoring `STORAGE_BACKEND`.

### WebDAV setup

```
STORAGE_BACKEND=webdav
WEBDAV_URL=https://nextcloud.example.com/remote.php/dav/files/user/bili-history
WEBDAV_USERNAME=user
WEBDAV_PASSWORD=pass
```

Data layout on WebDAV:
```
_bili-history/
  _users.json
  {userId}/
    _config.json
    _history.json
```

## Auth system

- JWT-based auth (HS256, 30-day expiry)
- Register: `POST /api/auth/register { username, passwordHash }` → `{ token, userId }`
- Login: `POST /api/auth/login { username, passwordHash }` → `{ token, userId }`
- Verify: `POST /api/auth/verify` (Authorization: Bearer) → `{ userId, username }`
- All `/api/user/*`, `/api/history/*`, `/api/bili/fetch` require Bearer token
- Frontend stores token in `localStorage`, auto-restores on reload

## User config fields (saved via `POST /api/user/config`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `biliCookie` | string | null | B站 SESSDATA (plain or AES-GCM encrypted) |
| `encryptCookie` | number | 0 | 1 = encrypt cookie at rest |
| `isAutoSync` | number | 0 | auto-sync on login |
| `encryptEnabled` | number | 1 | AES-GCM payload encryption |
| `fullEncrypt` | number | 0 | encrypt title/author/bvid fields |
| `fetchLimit` | number | 30 | items per B站 API page (10-100) |
| `fetchMaxPages` | number | 5 | max cursor pages to fetch (1-20) |
| `autoFetchInterval` | number | 0 | auto-fetch interval in minutes (0=off) |

## Notes

- B站 blocks Cloudflare IPs — must run locally with residential IP
- `src/db.ts` auto-creates tables on first use for all backends
- Frontend encrypts data in-browser before sending to server; server never sees plaintext
- Cookie can be AES-GCM encrypted at rest (encryptCookie toggle in settings)
- Auto-fetch uses `setInterval` in the browser; configurable interval
