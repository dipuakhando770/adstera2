# NasirLink — Security Architecture

## 1. SSRF & Safe URL Validation
- Enforces `https:` on external video streams and `http:`/`https:` on destination links; rejects `javascript:`, `data:`, `file:`, and `vbscript:`.
- Blocks `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `::1`, `.local`, `.internal`, and hex/integer IP bypass encodings.
- Blocks embedded credentials (`user:pass@host`) in redirect targets.
- Outbound URL probing and `/media/:slug` proxying use manual redirect handling (`redirect: 'manual'`, max 4 hops) and validate every intermediate `Location` target against SSRF rules.

## 2. Authentication & Session Security
- Passwords hashed with Web Crypto `PBKDF2-HMAC-SHA256` (100,000 iterations, random 16-byte salt, constant-time comparison).
- Session tokens are 256-bit cryptographically random secrets; only their SHA-256 digest is persisted in the `sessions` table.
- Cookies set with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production.

## 3. Anti-Cloaking & Video Preview Transparency
- Video-preview-enabled short links (`/:slug`, `/v/:slug`, `/video/:slug`) serve identical `200 OK` HTML and initial `<head>` metadata to both social crawlers and regular browsers (zero User-Agent cloaking).
- Dedicated `/player/:slug` pages never hijack video playback or perform automatic/hidden redirects.
- Destination domain and full URL are clearly disclosed alongside an explicit **Open Destination Website** button, cancellable countdown timer (when configured), and abuse reporting modal.

## 4. Privacy-First Analytics
- Raw visitor IP addresses are never permanently stored in `clicks`.
- Unique visitors are computed using a daily-rotating `SHA-256(date + ip + userAgent)` digest.

## 5. HTTP Hardening & Rate Limiting
- Sets `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
- Sets `X-Frame-Options: SAMEORIGIN` globally while allowing `Content-Security-Policy: frame-ancestors *` exclusively on `/player/:slug` (and `/embed/:slug`) for X/Twitter Player Card iframes.
- Configurable per-IP sliding-window API rate limiting (`rate_limit_per_min` in Admin System Settings).
