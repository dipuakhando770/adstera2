import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import express from 'express';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { createClickRecord, getDb, getSystemSettings, mapLinkRow, seedDatabaseIfEmpty } from './src/server/db.ts';
import { createAnonymousVisitorId, escapeHtml, parseUserAgent } from './src/server/crypto.ts';
import {
  buildSocialMetadata,
  injectVideoMetaIntoHtml,
  renderLandingBodySnapshot,
  renderPlayerPageHtml,
  renderSocialCrawlerHtml,
} from './src/server/metadata.ts';
import {
  createApiRouter,
  getClientIp,
  getCountryFromRequest,
  getRequestOrigin,
} from './src/server/routes.ts';
import { appendUtmParams, validateSafeExternalUrl } from './src/shared/validation.ts';

const FRONTEND_ROUTES = new Set([
  '',
  'dashboard',
  'links',
  'video-links',
  'analytics',
  'qr-codes',
  'settings',
  'admin',
  'metadata-debug',
  'login',
  'register',
  'forgot-password',
  'docs',
  'media',
  'poster',
  'player',
  'embed',
  's',
  'r',
]);

async function fetchWithSafeRedirects(
  targetUrl: string,
  init: { method: string; headers?: Record<string, string> }
): Promise<globalThis.Response> {
  let current = targetUrl;
  for (let hop = 0; hop < 4; hop++) {
    const check = validateSafeExternalUrl(current, false, false);
    if (!check.valid || !check.normalizedUrl) {
      throw new Error(check.error || 'Unsafe external URL');
    }
    const resp = await fetch(check.normalizedUrl, {
      method: init.method,
      headers: init.headers,
      redirect: 'manual',
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      await resp.body?.cancel();
      if (!loc) throw new Error('Redirect missing Location header');
      current = new URL(loc, check.normalizedUrl).toString();
      continue;
    }
    return resp;
  }
  throw new Error('Too many redirects');
}

function parseServerArgs(): { port?: number; host?: string } {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      const p = Number(args[++i]);
      if (Number.isFinite(p) && p > 0) port = p;
    } else if (arg.startsWith('--port=')) {
      const p = Number(arg.slice('--port='.length));
      if (Number.isFinite(p) && p > 0) port = p;
    } else if (arg === '--host' && args[i + 1]) {
      host = args[++i];
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    }
  }
  return { port, host };
}

async function startServer() {
  await seedDatabaseIfEmpty();

  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  const cli = parseServerArgs();
  const envPort = Number(process.env.PORT || 0);
  const nginxPort = Number(process.env.NGINX_PORT || 0);
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT || 3000);
  const resolvedEnvPort =
    !isProd && envPort > 0 && nginxPort > 0 && envPort === nginxPort
      ? defaultAppPort
      : envPort > 0
        ? envPort
        : defaultAppPort;
  const port = cli.port || resolvedEnvPort;
  const host = cli.host || '0.0.0.0';

  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Baseline security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path.startsWith('/embed/') || req.path.startsWith('/player/')) {
      // X/Twitter Player Card iframes MUST NOT have X-Frame-Options — only CSP frame-ancestors
      res.setHeader('Content-Security-Policy', 'frame-ancestors *');
      res.removeHeader('X-Frame-Options');
    } else {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    next();
  });

  // Static sample media & assets
  app.use('/samples', express.static(path.resolve(process.cwd(), 'public/samples')));

  // SEO: robots.txt & dynamic sitemap.xml
  app.get('/robots.txt', (req, res) => {
    const origin = getRequestOrigin(req);
    res.type('text/plain').send(
      [
        'User-agent: *',
        'Allow: /',
        'Allow: /v/',
        'Allow: /video/',
        'Allow: /s/',
        'Allow: /embed/',
        'Allow: /player/',
        'Disallow: /api/',
        'Disallow: /admin',
        `Sitemap: ${origin}/sitemap.xml`,
      ].join('\n')
    );
  });

  app.get('/sitemap.xml', (req, res) => {
    const origin = getRequestOrigin(req);
    const db = getDb();
    const videoLinks = db
      .prepare("SELECT slug, updated_at FROM links WHERE link_type = 'video' AND is_active = 1 ORDER BY updated_at DESC LIMIT 200")
      .all() as Array<{ slug: string; updated_at: string }>;

    const urls = [
      `<url><loc>${escapeHtml(origin)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
      ...videoLinks.map(
        (v) =>
          `<url><loc>${escapeHtml(origin)}/v/${escapeHtml(encodeURIComponent(v.slug))}</loc><lastmod>${escapeHtml(v.updated_at.slice(0, 10))}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`
      ),
    ];

    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`
    );
  });

  // Mount API routes
  app.use('/api', createApiRouter());

  // Set up Vite dev server or production static handler
  let vite: ViteDevServer | null = null;
  if (!isProd) {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
  } else {
    app.use(express.static(path.resolve(process.cwd(), 'dist'), { index: false }));
  }

  async function renderSpaHtml(req: express.Request, res: express.Response, customTransform?: (html: string) => string) {
    try {
      const templatePath = isProd
        ? path.resolve(process.cwd(), 'dist/index.html')
        : path.resolve(process.cwd(), 'index.html');
      let html = fs.readFileSync(templatePath, 'utf-8');
      if (vite && !isProd) {
        html = await vite.transformIndexHtml(req.originalUrl, html);
      }
      if (customTransform) {
        html = customTransform(html);
      }
      res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' });
      if (req.method === 'HEAD') res.end();
      else res.end(html);
    } catch (err) {
      if (vite) vite.ssrFixStacktrace(err as Error);
      res.status(500).send(`Render error: ${(err as Error).message}`);
    }
  }

  // Dedicated HTML5 player page for X/Twitter Player Card (/player/:slug and legacy /embed/:slug)
  const handlePlayerPage = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(req.params.slug) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).type('text/html').send(req.method === 'HEAD' ? '' : '<h1>Video player not found</h1>');
      return;
    }
    const link = mapLinkRow(row);
    const isExpired = link.expiresAt ? new Date(link.expiresAt).getTime() < Date.now() : false;
    if (!link.isActive || isExpired) {
      res.status(410).type('text/html').send(req.method === 'HEAD' ? '' : '<h1>This video link is unavailable</h1>');
      return;
    }
    const origin = getRequestOrigin(req);
    const settings = getSystemSettings();
    const html = renderPlayerPageHtml(link, origin, settings);
    res.status(200).set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    });
    if (req.method === 'HEAD') res.end();
    else res.send(html);
  };

  app.all('/player/:slug', handlePlayerPage);
  app.all('/embed/:slug', handlePlayerPage);

const SOCIAL_CRAWLER_UA_REGEX =
  /(twitterbot|xbot|x-card|twitter-card|cardvalidator|facebookexternalhit|facebot|meta-externalagent|meta-externalfetcher|discordbot|telegrambot|whatsapp|slackbot|linkedinbot|pinterest|applebot|embedly|redditbot|skypeuripreview|skype|threads|bluesky|vkshare|iframely|quora link preview|mastodon|misskey|line-poker|kakaotalk-scrap|viber|snapchat|googlebot|bingbot|crawler|spider|preview|unfurl|curl|wget)/i;

  // Server-rendered metadata + uncloaked landing HTML for Public Video Preview Pages (/v/:slug and /video/:slug)
  const handleVideoPreviewPage = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(req.params.slug) as Record<string, unknown> | undefined;

    if (!row) {
      await renderSpaHtml(req, res);
      return;
    }

    const link = mapLinkRow(row);
    const isExpired = link.expiresAt ? new Date(link.expiresAt).getTime() < Date.now() : false;
    const origin = getRequestOrigin(req);
    const settings = getSystemSettings();
    const rawUa = String(req.headers['user-agent'] || '');
    const isCrawler = SOCIAL_CRAWLER_UA_REGEX.test(rawUa) && req.query.preview !== '1';
    if (isCrawler && link.isActive && !isExpired) {
      const crawlerHtml = renderSocialCrawlerHtml(link, origin, req.path, settings);
      res.status(200).set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      });
      if (req.method === 'HEAD') res.end();
      else res.send(crawlerHtml);
      return;
    }

    const meta = buildSocialMetadata(link, origin, req.path, settings);
    const finalDest = appendUtmParams(link.destinationUrl, {
      source: link.utmSource,
      medium: link.utmMedium,
      campaign: link.utmCampaign,
    });
    const bootstrapPayload = {
      link: { ...link, destinationUrl: finalDest },
      isExpired,
      metadata: meta,
    };
    const ssrBody = renderLandingBodySnapshot(link, origin, settings, req.path);
    await renderSpaHtml(req, res, (html) => injectVideoMetaIntoHtml(html, meta, bootstrapPayload, ssrBody));
  };

  app.all('/v/:slug', handleVideoPreviewPage);
  app.all('/video/:slug', handleVideoPreviewPage);

  // A. SOCIAL SHARE URL (/s/:slug) — returns server-rendered X Player Card metadata referencing /embed/:slug
  app.all('/s/:slug', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(req.params.slug) as Record<string, unknown> | undefined;

    if (!row) {
      await renderSpaHtml(req, res);
      return;
    }

    const link = mapLinkRow(row);
    const isExpired = link.expiresAt ? new Date(link.expiresAt).getTime() < Date.now() : false;
    const origin = getRequestOrigin(req);
    const settings = getSystemSettings();
    const canonicalPath = `/s/${encodeURIComponent(link.slug)}`;
    const rawUa = String(req.headers['user-agent'] || '');
    const isCrawler = SOCIAL_CRAWLER_UA_REGEX.test(rawUa) && req.query.preview !== '1';
    if (isCrawler && link.isActive && !isExpired) {
      const crawlerHtml = renderSocialCrawlerHtml(link, origin, canonicalPath, settings);
      res.status(200).set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      });
      if (req.method === 'HEAD') res.end();
      else res.send(crawlerHtml);
      return;
    }

    const meta = buildSocialMetadata(link, origin, canonicalPath, settings);
    const finalDest = appendUtmParams(link.destinationUrl, {
      source: link.utmSource,
      medium: link.utmMedium,
      campaign: link.utmCampaign,
    });
    const bootstrapPayload = {
      link: { ...link, destinationUrl: finalDest },
      isExpired,
      metadata: meta,
    };
    const ssrBody = renderLandingBodySnapshot(link, origin, settings, canonicalPath);
    await renderSpaHtml(req, res, (html) => injectVideoMetaIntoHtml(html, meta, bootstrapPayload, ssrBody));
  });

  // B. DIRECT REDIRECT URL (/r/:slug) — immediately redirects visitors to destination with analytics
  app.all('/r/:slug', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(req.params.slug) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).type('text/plain').send('Direct link not found');
      return;
    }

    const link = mapLinkRow(row);
    if (!link.isActive) {
      res.redirect(302, `/status/disabled?slug=${encodeURIComponent(link.slug)}`);
      return;
    }
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      res.redirect(302, `/status/expired?slug=${encodeURIComponent(link.slug)}`);
      return;
    }
    if (link.hasPassword) {
      res.redirect(302, `/unlock/${encodeURIComponent(link.slug)}`);
      return;
    }

    const destination = appendUtmParams(link.destinationUrl, {
      source: link.utmSource,
      medium: link.utmMedium,
      campaign: link.utmCampaign,
    });

    if (req.method === 'GET') {
      const rawUa = String(req.headers['user-agent'] || '');
      const ua = parseUserAgent(rawUa);
      const anonId = await createAnonymousVisitorId(getClientIp(req), rawUa);
      createClickRecord({
        linkId: link.id,
        country: getCountryFromRequest(req),
        deviceType: ua.deviceType,
        browser: ua.browser,
        operatingSystem: ua.operatingSystem,
        referrer: String(req.headers.referer || 'Direct'),
        anonymousVisitorId: anonId,
      });
    }

    res.redirect(link.redirectType, destination);
  });

  // First-party Video Poster Image URL (/poster/:slug, /poster/:slug.jpg)
  app.all('/poster/:slug', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const rawSlug = decodeURIComponent(req.params.slug || '');
    const slug = rawSlug.replace(/\.(jpg|jpeg|png|webp)$/i, '');
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(slug) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).type('text/plain').send('Poster not found');
      return;
    }
    const link = mapLinkRow(row);
    if (!link.isActive) {
      res.status(410).type('text/plain').send('Poster unavailable');
      return;
    }
    const thumb = (link.thumbnailUrl || '').trim();

    if (thumb) {
      const dataMatch = thumb.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
      if (dataMatch) {
        const mime = dataMatch[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : dataMatch[1].toLowerCase();
        const buf = Buffer.from(dataMatch[2], 'base64');
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': String(buf.length),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(buf);
        return;
      }

      if (thumb.startsWith('/src/assets/') || thumb.startsWith('/samples/')) {
        const localPath = thumb.startsWith('/samples/')
          ? path.resolve(process.cwd(), 'public', thumb.slice(1))
          : path.resolve(process.cwd(), thumb.slice(1));
        if (fs.existsSync(localPath)) {
          const stat = fs.statSync(localPath);
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': String(stat.size),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          });
          if (req.method === 'HEAD') res.end();
          else fs.createReadStream(localPath).pipe(res);
          return;
        }
      }

      if (/^https?:\/\//i.test(thumb)) {
        const safeThumb = validateSafeExternalUrl(thumb, false, false);
        if (!safeThumb.valid || !safeThumb.normalizedUrl) {
          res.status(400).type('text/plain').send('Invalid poster URL');
          return;
        }
        res.redirect(302, safeThumb.normalizedUrl);
        return;
      }
    }

    // Default first-party fallback poster (never 404 for active links)
    const fallbackFile = (link.videoUrl || '').includes('showcase1.mp4')
      ? 'edge-poster.jpg'
      : 'default-poster.jpg';
    const fallbackPath = path.resolve(process.cwd(), 'public/samples', fallbackFile);
    if (!fs.existsSync(fallbackPath)) {
      res.status(404).type('text/plain').send('Default poster missing');
      return;
    }
    const stat = fs.statSync(fallbackPath);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(stat.size),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(fallbackPath).pipe(res);
  });

  // First-party Video Access URL (/media/:slug, /media/:slug.mp4, /media/:slug.webm)
  // Serves guaranteed video/mp4 or video/webm Content-Type, Byte-Range 206, HEAD, and CORS headers
  app.all('/media/:slug', async (req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      });
      res.status(204).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    const rawSlug = decodeURIComponent(req.params.slug || '');
    const slug = rawSlug.replace(/\.(mp4|webm)$/i, '');
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(slug) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).type('text/plain').send('Media not found');
      return;
    }
    const link = mapLinkRow(row);
    const settings = getSystemSettings();
    const useGlobal =
      Boolean(settings.globalVideoUrl?.trim()) &&
      (Boolean(settings.globalVideoOverride) || !link.videoUrl?.trim());
    const rawVideoUrl = useGlobal
      ? (settings.globalVideoUrl || '').trim()
      : (link.videoUrl || '').trim();
    const effectiveMime = useGlobal
      ? settings.globalVideoMimeType || link.videoMimeType
      : link.videoMimeType;

    if (!link.isActive || !rawVideoUrl) {
      res.status(410).type('text/plain').send('Media unavailable');
      return;
    }

    const contentType =
      effectiveMime || (rawVideoUrl.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4');

    const baseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Cache-Control': 'public, max-age=3600',
    };

    if (rawVideoUrl.startsWith('/api/sample-video/')) {
      const safeName = path.basename(rawVideoUrl.slice('/api/sample-video/'.length));
      if (!['showcase.mp4', 'showcase1.mp4', 'edge-network.mp4'].includes(safeName)) {
        res.status(404).type('text/plain').send('Sample media not found');
        return;
      }
      const filePath = path.resolve(process.cwd(), 'public/samples', safeName);
      if (!fs.existsSync(filePath)) {
        res.status(404).type('text/plain').send('Media file missing');
        return;
      }
      const fileSize = fs.statSync(filePath).size;
      const range = req.headers.range;
      if (range && req.method === 'GET') {
        const parts = range.replace(/bytes=/i, '').split('-');
        const start = Math.max(0, parseInt(parts[0], 10) || 0);
        const parsedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const end = Math.min(fileSize - 1, Number.isFinite(parsedEnd) ? parsedEnd : fileSize - 1);
        if (start > end || start >= fileSize) {
          res.status(416).set({ ...baseHeaders, 'Content-Range': `bytes */${fileSize}` }).end();
          return;
        }
        const chunksize = end - start + 1;
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': String(chunksize),
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': String(fileSize),
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    }

    // Proxy remote video URL (e.g. raw.githubusercontent.com or external MP4/WebM) with SSRF redirect guard
    try {
      const forwardHeaders: Record<string, string> = {};
      if (req.headers.range) forwardHeaders['Range'] = String(req.headers.range);

      let upstream = await fetchWithSafeRedirects(rawVideoUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: forwardHeaders,
      });

      if (req.method === 'HEAD' && (upstream.status === 405 || upstream.status === 501)) {
        await upstream.body?.cancel();
        upstream = await fetchWithSafeRedirects(rawVideoUrl, {
          method: 'GET',
          headers: forwardHeaders,
        });
      }

      const outHeaders: Record<string, string> = { ...baseHeaders };
      const contentLength = upstream.headers.get('content-length');
      const contentRange = upstream.headers.get('content-range');
      const etag = upstream.headers.get('etag');
      const lastModified = upstream.headers.get('last-modified');
      if (contentLength) outHeaders['Content-Length'] = contentLength;
      if (contentRange) outHeaders['Content-Range'] = contentRange;
      if (etag) outHeaders['ETag'] = etag;
      if (lastModified) outHeaders['Last-Modified'] = lastModified;

      res.writeHead(upstream.status, outHeaders);
      if (req.method === 'HEAD' || !upstream.body) {
        await upstream.body?.cancel();
        res.end();
        return;
      }

      Readable.fromWeb(upstream.body as unknown as NodeReadableStream).pipe(res);
    } catch {
      res.status(502).type('text/plain').send('Failed to fetch upstream video stream');
    }
  });

  // Crawler user-agent matcher defined above near /v/:slug & /s/:slug

  // Short Slug Router: GET/HEAD /:slug (must run BEFORE Vite SPA fallback)
  app.all('/:slug', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    const slug = req.params.slug;

    // Skip files with extensions, Vite internal prefixes, SPA known routes, or empty
    if (
      !slug ||
      slug.startsWith('@') ||
      slug.includes('.') ||
      FRONTEND_ROUTES.has(slug.toLowerCase())
    ) {
      next();
      return;
    }

    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(slug) as Record<string, unknown> | undefined;

    if (!row) {
      next();
      return;
    }

    const link = mapLinkRow(row);

    if (!link.isActive) {
      res.redirect(302, `/status/disabled?slug=${encodeURIComponent(link.slug)}`);
      return;
    }

    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      res.redirect(302, `/status/expired?slug=${encodeURIComponent(link.slug)}`);
      return;
    }

    if (link.hasPassword) {
      res.redirect(302, `/unlock/${encodeURIComponent(link.slug)}`);
      return;
    }

    const destination = appendUtmParams(link.destinationUrl, {
      source: link.utmSource,
      medium: link.utmMedium,
      campaign: link.utmCampaign,
    });

    // Video Preview Link: serve server-rendered social metadata to social crawlers,
    // and redirect normal browser visitors directly to the destination URL (no landing page, no intermediate player).
    if (link.linkType === 'video' && link.previewEnabled) {
      const rawUa = String(req.headers['user-agent'] || '');
      const isCrawler = SOCIAL_CRAWLER_UA_REGEX.test(rawUa) || req.query.preview === '1';
      if (!isCrawler) {
        if (req.method === 'GET') {
          const ua = parseUserAgent(rawUa);
          const anonId = await createAnonymousVisitorId(getClientIp(req), rawUa);
          createClickRecord({
            linkId: link.id,
            country: getCountryFromRequest(req),
            deviceType: ua.deviceType,
            browser: ua.browser,
            operatingSystem: ua.operatingSystem,
            referrer: String(req.headers.referer || 'Direct'),
            anonymousVisitorId: anonId,
          });
        }
        res.redirect(link.redirectType, destination);
        return;
      }

      const origin = getRequestOrigin(req);
      const settings = getSystemSettings();
      const canonicalPath = `/${encodeURIComponent(link.slug)}`;

      if (isCrawler && req.query.preview !== '1') {
        const crawlerHtml = renderSocialCrawlerHtml(link, origin, canonicalPath, settings);
        res.status(200).set({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=600',
        });
        if (req.method === 'HEAD') res.end();
        else res.send(crawlerHtml);
        return;
      }

      const meta = buildSocialMetadata(link, origin, canonicalPath, settings);
      const bootstrapPayload = {
        link: { ...link, destinationUrl: destination },
        isExpired: false,
        metadata: meta,
      };
      const ssrBody = renderLandingBodySnapshot(link, origin, settings, canonicalPath);
      await renderSpaHtml(req, res, (html) => injectVideoMetaIntoHtml(html, meta, bootstrapPayload, ssrBody));
      return;
    }

    // Standard Short Link Redirect (normal links or video links with Social Video Preview disabled)
    if (req.method === 'GET') {
      const ua = parseUserAgent(req.headers['user-agent'] || '');
      const anonId = await createAnonymousVisitorId(getClientIp(req), req.headers['user-agent'] || '');
      createClickRecord({
        linkId: link.id,
        country: getCountryFromRequest(req),
        deviceType: ua.deviceType,
        browser: ua.browser,
        operatingSystem: ua.operatingSystem,
        referrer: String(req.headers.referer || 'Direct'),
        anonymousVisitorId: anonId,
      });
    }

    res.redirect(link.redirectType, destination);
  });

  // Let Vite serve internal assets / modules in dev
  if (vite) {
    app.use(vite.middlewares);
  }

  // Catch-all SPA fallback
  app.use(async (req, res) => {
    await renderSpaHtml(req, res);
  });

  app.listen(port, host, () => {
    console.log(`NasirLink server listening on http://${host}:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start NasirLink server:', err);
  process.exit(1);
});
