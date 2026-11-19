# NasirLink — REST API Reference

## Public, Player & SEO Endpoints
- `GET /api/health` — Returns database connectivity and runtime status.
- `GET /api/settings/public` — Returns site name, configured domain, default redirect status, and registration flag.
- `GET /api/preview/:slug` — Returns public video link metadata, OpenGraph/X Card tags, validation checks, and disclosed destination URL. Pass `?track=1` to record a preview view, or `?audit=1` to include live HTTP probe status on the video and thumbnail URLs.
- `GET /:slug` — Serves an uncloaked `200 OK` server-rendered landing page with initial `<head>` OpenGraph / X Player Card metadata when `linkType === 'video' && previewEnabled`; returns a direct `301`/`302` redirect for normal links or preview-disabled links.
- `GET /v/:slug` & `GET /video/:slug` — Canonical video preview landing page routes.
- `GET /player/:slug` (alias `GET /embed/:slug`) — Dedicated HTTPS-embeddable HTML5 `<video>` player page (`Content-Security-Policy: frame-ancestors *`) with Play/Pause/Stop controls, poster fallback, and transparent destination disclosure.
- `GET /api/oembed?url=...` — Returns oEmbed JSON referencing the `/player/:slug` iframe URL.
- `POST /api/reports` — Submit an abuse report (`slug`, `reason`, `details`).
- `GET /robots.txt` & `GET /sitemap.xml` — Dynamic SEO crawler directives and XML sitemap of active video previews.

## Links & Validation
- `GET /api/links/check-alias?slug=...` — Real-time alias format, reserved route, and uniqueness validation.
- `POST /api/links/validate-video` — Enforces HTTPS and SSRF rules, converts GitHub `blob/` URLs to `raw.githubusercontent.com`, checks MP4/WebM MIME types, and probes reachability using SSRF-safe manual redirect inspection.
- `POST /api/links` — Create a normal or video preview link (`previewEnabled`, `autoRedirectSeconds`, `videoWidth`, `videoHeight`, `twitterCardType`, etc.).
- `GET /api/links` — Paginated, searchable (`q`), filterable (`status`, `type`, `page`, `pageSize`) list of links.
- `GET /api/links/:id` — Fetch single link details.
- `PUT /api/links/:id` — Update destination, alias, video metadata, `previewEnabled`, `autoRedirectSeconds`, X Card properties, `301`/`302` redirect, expiration, password, UTM tags, or active status.
- `DELETE /api/links/:id` — Delete link and cascade analytics records.
- `POST /api/links/:id/verify-password` — Verify passcode on password-protected links and record unlock click.

## QR & Analytics
- `POST /api/qr` — Generate SVG string and PNG Data URL with custom colors and optional center logo badge.
- `GET /api/analytics/overview` — Global or user-scoped KPI totals, 14-day & hourly series, top links, devices, browsers, OS, referrers, and countries.
- `GET /api/analytics/:id` — Per-link analytics breakdown.

## Authentication
- `POST /api/auth/register` — Register user (`name`, `email`, `password`).
- `POST /api/auth/login` — Authenticate user and set `HttpOnly` session cookie.
- `POST /api/auth/logout` — Revoke session token and clear cookie.
- `GET /api/auth/me` — Return authenticated user profile or `null`.
- `POST /api/auth/request-reset` & `POST /api/auth/reset-password` — Token-based password reset flow.
- `POST /api/auth/verify-email` — Email verification endpoint.

## Admin Endpoints (Requires `role === 'admin'`)
- `GET /api/admin/stats` — Platform user, link, click, report, and daily registration stats.
- `GET /api/admin/users` / `PATCH /api/admin/users/:id` / `DELETE /api/admin/users/:id`
- `GET /api/admin/links` / `PATCH /api/admin/links/:id` (supports toggling `previewEnabled`, `isActive`, `autoRedirectSeconds`, and editing video preview metadata) / `DELETE /api/admin/links/:id`
- `GET /api/admin/reports` / `PATCH /api/admin/reports/:id`
- `GET /api/admin/settings` / `PUT /api/admin/settings`
