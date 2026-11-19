# NasirLink — Testing & Verification Guide

## Automated Verification Commands
```bash
npm run lint    # TypeScript strict static check (tsc --noEmit)
npm test        # Vitest unit & Worker integration tests (tests/nasirlink.test.ts)
npm run build   # Production Vite bundle verification
```

## Covered Automated Suites
1. **SSRF & HTTPS Video Security**: HTTPS enforcement on external video URLs, blocking `http://`, `javascript:`, `data:`, `file:`, `localhost`, RFC1918 private subnets, cloud metadata IPs (`169.254.169.254`), and hex/numeric IP encodings.
2. **Slug & Custom Alias Rules**: Base62 generation, length/charset enforcement, and reserved system route protection (`admin`, `dashboard`, `api`, `video`, `v`, `player`, `embed`, `media`, etc.).
3. **GitHub Video URL Conversion**: Automatic conversion of `github.com/<user>/<repo>/blob/<branch>/...` to `raw.githubusercontent.com/...` and MP4/WebM MIME validation.
4. **Web Crypto Security & Analytics**: PBKDF2-SHA256 password hashing/verification, daily anonymized visitor digest, User-Agent device/browser/OS parsing, and safe UTM appending.
5. **Uncloaked Metadata, Portrait Dimensions & Fallback Cards**: Verification that `/:slug` serves identical `200 OK` HTML and `<meta>` tags to both crawlers and browsers when `previewEnabled` is true, supports portrait (`720x1278`) and `4:3` (`640x480`) dimensions, emits exactly one `twitter:card` tag, and cleanly omits `twitter:player*`/`og:video*` in `summary_large_image` fallback mode.
6. **Dedicated Player Page (`/player/:slug`) & Admin Controls**: Verification of `Content-Security-Policy: frame-ancestors *`, Play/Pause/Stop HTML5 controls, transparent destination disclosure CTA, and `PATCH /api/admin/links/:id`.

## Live HTTP Integration Checks
- Start the server (`npm run dev`) and verify:
  - `GET /api/health` returns `200 OK`
  - `GET /:slug` for a preview-enabled video link returns `200 OK` HTML with `<meta name="twitter:card" content="player" />`, `<meta name="twitter:player" content=".../player/:slug" />`, and `<meta property="og:video" ... />` identically for `Twitterbot/1.0` and `Mozilla/5.0`
  - `GET /player/:slug` returns playable HTML5 video page with `Content-Security-Policy: frame-ancestors *` and no `X-Frame-Options`
  - `GET /cf-docs` (or a video link with `previewEnabled: false`) responds with `302` redirect to destination with UTM params
