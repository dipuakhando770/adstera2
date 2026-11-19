# NasirLink — Cloudflare Workers & D1 Deployment Guide

## 1. Prerequisites
- Node.js 22+
- Cloudflare account with Workers & D1 enabled
- Wrangler CLI (`npm i -g wrangler` or `npx wrangler`)

## 2. Optional: Bind Cloudflare D1 Database for Persistent Storage
Without a D1 binding, `src/worker.ts` still deploys cleanly and serves requests using an isolate-local fallback store. For full persistent multi-region storage across Worker restarts:

```bash
npx wrangler d1 create nasirlink-db
```
Then either:
- Bind the D1 database with variable name **`DB`** in **Cloudflare Dashboard -> Workers & Pages -> `nasirlink` -> Settings -> Bindings**, **or**
- Uncomment the `d1_databases` section in `wrangler.jsonc` and paste the returned `database_id`.

Apply the SQLite migrations (`0001_initial.sql` and `0002_video_preview_upgrade.sql`; note that both Node SQLite and Worker D1 also safely auto-add missing columns on startup without dropping existing rows):
```bash
npx wrangler d1 migrations apply nasirlink-db --remote
```
(Optional) For R2 media storage, create the bucket referenced in `wrangler.jsonc`:
```bash
npx wrangler r2 bucket create nasirlink-media
```

## 3. Configure Custom Domain & Secrets
1. Update `vars.APP_DOMAIN` in `wrangler.jsonc` or configure `domain` in the Admin System Settings UI.
2. Add custom domain routes in the Cloudflare Dashboard -> Workers & Pages -> `nasirlink` -> Settings -> Domains & Routes.
3. Set production secrets via Wrangler (never commit secrets):
```bash
npx wrangler secret put SESSION_SECRET
```

## 4. Build & Deploy Commands
```bash
npm install        # install dependencies
npm run dev        # Local full-stack Express + Vite + SQLite server on port 3000
npm run build      # Production Vite client bundle -> ./dist (also copies sample assets)
npx wrangler deploy # Bundles src/worker.ts + uploads ./dist Workers static assets
```

## 5. X (Twitter) Player Card Allowlisting Note
- NasirLink emits standards-compliant `twitter:card="player"` (pointing to HTTPS `/player/:slug`), `twitter:image`, `og:video`, and `summary_large_image` fallback metadata.
- X (Twitter) requires domain-level Player Card allowlisting/approval by X before rendering an inline interactive iframe player inside X feeds. Until X approves your domain, X automatically falls back to displaying your `twitter:image` thumbnail card linking to your landing page (`/:slug`).

## 6. Runtime Notes
- `src/worker.ts` uses Web Standards APIs (`Request`, `Response`, `globalThis.crypto` PBKDF2-SHA256 / SHA-256) and Cloudflare Workers `ASSETS` + `D1` bindings with zero incompatible Node APIs.
- Local development uses `server.ts` + Node 22's built-in `node:sqlite` (`DatabaseSync`) applying `migrations/0001_initial.sql` and `migrations/0002_video_preview_upgrade.sql` non-destructively.
