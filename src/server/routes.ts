import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import {
  computeAnalytics,
  createClickRecord,
  getAdminStats,
  getDb,
  getSystemSettings,
  listReports,
  mapLinkRow,
  mapUserRow,
  updateSystemSettings,
} from './db.ts';
import {
  createAnonymousVisitorId,
  generateSecureToken,
  hashPassword,
  parseUserAgent,
  randomId,
  sha256Hex,
  verifyPassword,
} from './crypto.ts';
import { buildSocialMetadata, resolveVideoDimensions } from './metadata.ts';
import { probeVideoStream, type LocalMediaReader } from './videoProbe.ts';
import {
  appendUtmParams,
  createLinkSchema,
  generateRandomSlug,
  loginSchema,
  qrRequestSchema,
  registerSchema,
  reportLinkSchema,
  updateLinkSchema,
  validateCustomAlias,
  validateSafeExternalUrl,
  validateVideoUrl,
} from '../shared/validation.ts';
import type { PublicUser, VideoStreamAudit } from '../shared/types.ts';

export const localSampleReader: LocalMediaReader = async (pathOrUrl, start = 0, end = 131071) => {
  if (!pathOrUrl.startsWith('/api/sample-video/')) return null;
  const safeName = path.basename(pathOrUrl.slice('/api/sample-video/'.length));
  if (!['showcase.mp4', 'showcase1.mp4', 'edge-network.mp4'].includes(safeName)) return null;
  const filePath = path.resolve(process.cwd(), 'public/samples', safeName);
  if (!fs.existsSync(filePath)) return null;
  const totalSize = fs.statSync(filePath).size;
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(totalSize - 1, end);
  if (safeStart > safeEnd) return null;
  const len = safeEnd - safeStart + 1;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, len, safeStart);
  } finally {
    fs.closeSync(fd);
  }
  return {
    status: 206,
    contentType: 'video/mp4',
    totalSize,
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  };
};

async function safeProbeExternalUrl(
  targetUrl: string,
  requireHttps = true
): Promise<{ ok: boolean; status: number | null; contentType: string | null; error: string | null }> {
  let currentUrl = targetUrl;
  for (let hop = 0; hop < 4; hop++) {
    const check = validateSafeExternalUrl(currentUrl, false, requireHttps);
    if (!check.valid || !check.normalizedUrl) {
      return {
        ok: false,
        status: null,
        contentType: null,
        error: check.error || 'Blocked unsafe URL or redirect target.',
      };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(check.normalizedUrl, {
        method: 'HEAD',
        signal: ctrl.signal,
        redirect: 'manual',
      });
      clearTimeout(timer);
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        await resp.body?.cancel();
        if (!loc) {
          return { ok: false, status: resp.status, contentType: null, error: `Redirect missing Location header (${resp.status})` };
        }
        currentUrl = new URL(loc, check.normalizedUrl).toString();
        continue;
      }
      const contentType = resp.headers.get('content-type');
      await resp.body?.cancel();
      return {
        ok: resp.ok,
        status: resp.status,
        contentType,
        error: resp.ok ? null : `Remote server returned HTTP ${resp.status}`,
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        status: null,
        contentType: null,
        error: (err as Error).name === 'AbortError' ? 'Connection timed out' : 'Could not reach remote host (CORS, hotlink protection, or offline)',
      };
    }
  }
  return { ok: false, status: null, contentType: null, error: 'Too many redirects' };
}

const SESSION_COOKIE_NAME = 'nasirlink_session';
const RATE_BUCKETS = new Map<string, { count: number; resetAt: number }>();

export function getRequestOrigin(req: Request): string {
  const protoHeader = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const proto = protoHeader.split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || '127.0.0.1';
}

export function getCountryFromRequest(req: Request): string {
  const cfCountry = req.headers['cf-ipcountry'];
  if (typeof cfCountry === 'string' && cfCountry.trim() && cfCountry !== 'XX') {
    return cfCountry.trim().toUpperCase();
  }
  const acceptLang = req.headers['accept-language'];
  if (typeof acceptLang === 'string') {
    const match = acceptLang.match(/[a-z]{2}-([A-Z]{2})/);
    if (match) {
      const regionNames: Record<string, string> = {
        US: 'United States',
        GB: 'United Kingdom',
        DE: 'Germany',
        CA: 'Canada',
        SG: 'Singapore',
        JP: 'Japan',
        FR: 'France',
        IN: 'India',
        AU: 'Australia',
        BD: 'Bangladesh',
      };
      return regionNames[match[1]] || match[1];
    }
  }
  return 'Global';
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function setSessionCookie(res: Response, token: string, maxAgeSec = 7 * 86400): void {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAgeSec}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

export async function resolveAuthUser(req: Request): Promise<PublicUser | null> {
  const cookies = parseCookies(req);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) return null;

  const tokenHash = await sha256Hex(rawToken);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at as session_expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as Record<string, unknown> | undefined;

  if (!row) return null;
  if (new Date(String(row.session_expires_at)).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  if (row.status === 'suspended') {
    return null;
  }
  return mapUserRow(row);
}

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const settings = getSystemSettings();
  const limit = Math.max(20, settings.rateLimitPerMin);
  const key = `${getClientIp(req)}:${req.path.startsWith('/api/auth') ? 'auth' : 'api'}`;
  const now = Date.now();
  const bucket = RATE_BUCKETS.get(key);
  if (!bucket || bucket.resetAt < now) {
    RATE_BUCKETS.set(key, { count: 1, resetAt: now + 60_000 });
    next();
    return;
  }
  bucket.count++;
  if (bucket.count > limit) {
    res.status(429).json({ error: 'Rate limit exceeded. Please wait a minute before retrying.' });
    return;
  }
  next();
}

export function createApiRouter(): express.Router {
  const router = express.Router();
  router.use(rateLimitMiddleware);

  // Health Check
  router.get('/health', (_req, res) => {
    try {
      const db = getDb();
      const row = db.prepare('SELECT 1 as ok').get() as { ok: number };
      res.json({
        status: 'ok',
        database: row.ok === 1 ? 'connected' : 'error',
        timestamp: new Date().toISOString(),
        runtime: 'nodejs-sqlite-d1-compatible',
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: (err as Error).message });
    }
  });

  // Sample Video Streaming with Byte-Range support
  router.get('/sample-video/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    if (!['showcase.mp4', 'edge-network.mp4', 'showcase1.mp4'].includes(safeName)) {
      res.status(404).json({ error: 'Sample video not found.' });
      return;
    }
    const filePath = path.resolve(process.cwd(), 'public/samples', safeName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Video file missing.' });
      return;
    }
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=86400',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // Public Settings
  router.get('/settings/public', (_req, res) => {
    const s = getSystemSettings();
    res.json({
      siteName: s.siteName,
      domain: s.domain,
      defaultRedirectType: s.defaultRedirectType,
      registrationEnabled: s.registrationEnabled,
      maintenanceMode: s.maintenanceMode,
      globalVideoUrl: s.globalVideoUrl,
      globalVideoWidth: s.globalVideoWidth,
      globalVideoHeight: s.globalVideoHeight,
      globalVideoSourceUrl: s.globalVideoSourceUrl,
      globalVideoOverride: s.globalVideoOverride,
    });
  });

  // ================= AUTH =================
  router.get('/auth/me', async (req, res) => {
    const user = await resolveAuthUser(req);
    res.json({ user });
  });

  router.post('/auth/register', async (req, res) => {
    const settings = getSystemSettings();
    if (!settings.registrationEnabled) {
      res.status(403).json({ error: 'New user registration is currently disabled by an administrator.' });
      return;
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration data.' });
      return;
    }

    const { name, email, password } = parsed.data;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const userId = randomId('usr');
    const passwordHash = await hashPassword(password);
    const verificationToken = generateSecureToken(16);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, role, status, email_verified, verification_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'user', 'active', 0, ?, ?, ?)
    `).run(userId, email.toLowerCase(), name, passwordHash, verificationToken, now, now);

    const rawSessionToken = generateSecureToken(32);
    const tokenHash = await sha256Hex(rawSessionToken);
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomId('ses'), userId, tokenHash, req.headers['user-agent'] || '', expiresAt, now);

    setSessionCookie(res, rawSessionToken);
    const user = mapUserRow(
      db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>
    );

    res.status(201).json({
      user,
      verificationTokenPreview: verificationToken,
    });
  });

  router.post('/auth/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid credentials.' });
      return;
    }

    const { email, password } = parsed.data;
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    if (row.status === 'suspended') {
      res.status(403).json({ error: 'Your account has been suspended. Contact an administrator.' });
      return;
    }

    const valid = await verifyPassword(password, String(row.password_hash));
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const rawSessionToken = generateSecureToken(32);
    const tokenHash = await sha256Hex(rawSessionToken);
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomId('ses'), String(row.id), tokenHash, req.headers['user-agent'] || '', expiresAt, now);

    setSessionCookie(res, rawSessionToken);
    res.json({ user: mapUserRow(row) });
  });

  router.post('/auth/logout', async (req, res) => {
    const cookies = parseCookies(req);
    const rawToken = cookies[SESSION_COOKIE_NAME];
    if (rawToken) {
      const tokenHash = await sha256Hex(rawToken);
      getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.post('/auth/request-reset', (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }
    const db = getDb();
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    if (!row) {
      // Do not leak user existence in production semantics, return generic message
      res.json({ ok: true, message: 'If an account matches that email, a reset token has been generated.' });
      return;
    }
    const token = generateSecureToken(16);
    const expires = new Date(Date.now() + 3600_000).toISOString();
    db.prepare('UPDATE users SET reset_token = ?, reset_expires_at = ?, updated_at = ? WHERE id = ?').run(
      token,
      expires,
      new Date().toISOString(),
      row.id
    );
    res.json({
      ok: true,
      message: 'Password reset token generated (valid for 1 hour).',
      resetTokenPreview: token,
    });
  });

  router.post('/auth/reset-password', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const newPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!token || newPassword.length < 8) {
      res.status(400).json({ error: 'Valid reset token and password (8+ chars) required.' });
      return;
    }
    const db = getDb();
    const row = db
      .prepare('SELECT id, reset_expires_at FROM users WHERE reset_token = ?')
      .get(token) as { id: string; reset_expires_at: string } | undefined;
    if (!row || new Date(row.reset_expires_at).getTime() < Date.now()) {
      res.status(400).json({ error: 'Reset token is invalid or expired.' });
      return;
    }
    const passwordHash = await hashPassword(newPassword);
    db.prepare(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL, updated_at = ? WHERE id = ?'
    ).run(passwordHash, new Date().toISOString(), row.id);
    res.json({ ok: true });
  });

  router.post('/auth/verify-email', (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'Verification token required.' });
      return;
    }
    const db = getDb();
    const row = db
      .prepare('SELECT id FROM users WHERE verification_token = ?')
      .get(token) as { id: string } | undefined;
    if (!row) {
      res.status(400).json({ error: 'Invalid verification token.' });
      return;
    }
    db.prepare(
      'UPDATE users SET email_verified = 1, verification_token = NULL, updated_at = ? WHERE id = ?'
    ).run(new Date().toISOString(), row.id);
    res.json({ ok: true });
  });

  // ================= LINKS =================
  router.get('/links/check-alias', (req, res) => {
    const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
    const excludeId = typeof req.query.excludeId === 'string' ? req.query.excludeId : '';
    const check = validateCustomAlias(slug);
    if (!check.valid) {
      res.json({ available: false, normalized: check.normalized, reason: check.error });
      return;
    }
    const db = getDb();
    const existing = db
      .prepare('SELECT id FROM links WHERE slug = ?')
      .get(check.normalized) as { id: string } | undefined;
    if (existing && existing.id !== excludeId) {
      res.json({ available: false, normalized: check.normalized, reason: 'This alias is already taken.' });
      return;
    }
    res.json({ available: true, normalized: check.normalized });
  });

  router.post('/links/validate-video', async (req, res) => {
    const rawUrl = typeof req.body?.videoUrl === 'string' ? req.body.videoUrl : '';
    const origin = getRequestOrigin(req);
    const probe = await probeVideoStream(rawUrl, {
      origin,
      localReader: localSampleReader,
    });

    if (!probe.valid && probe.audit.errors.length > 0 && !probe.audit.videoReachable && !validateVideoUrl(rawUrl).valid) {
      res.status(400).json({
        valid: false,
        convertedFromGithub: probe.convertedFromGithub,
        error: probe.audit.errors[0] || 'Invalid video URL.',
        audit: probe.audit,
      });
      return;
    }

    res.json({
      valid: true,
      normalizedUrl: probe.normalizedUrl,
      convertedFromGithub: probe.convertedFromGithub,
      mimeType: probe.audit.videoMimeType,
      httpsVideo: probe.audit.videoHttps,
      reachable: probe.audit.videoReachable,
      httpStatus: probe.audit.videoStatus,
      contentType: probe.audit.videoMimeType,
      fetchError: probe.audit.errors[0] || null,
      audit: probe.audit,
    });
  });

  router.post('/links', async (req, res) => {
    const settings = getSystemSettings();
    if (settings.maintenanceMode) {
      res.status(503).json({ error: 'Platform is temporarily in maintenance mode.' });
      return;
    }

    const user = await resolveAuthUser(req);
    const parsed = createLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid link payload.' });
      return;
    }

    const data = parsed.data;
    const destCheck = validateSafeExternalUrl(data.destinationUrl);
    if (!destCheck.valid || !destCheck.normalizedUrl) {
      res.status(400).json({ error: destCheck.error || 'Invalid destination URL.' });
      return;
    }

    const db = getDb();
    if (user) {
      const countRow = db
        .prepare('SELECT COUNT(*) as cnt FROM links WHERE user_id = ?')
        .get(user.id) as { cnt: number };
      if (countRow.cnt >= settings.maxLinksPerUser && user.role !== 'admin') {
        res.status(403).json({
          error: `Maximum link limit (${settings.maxLinksPerUser}) reached for your account.`,
        });
        return;
      }
    }

    let slug = '';
    if (data.customAlias && data.customAlias.trim()) {
      const aliasCheck = validateCustomAlias(data.customAlias);
      if (!aliasCheck.valid) {
        res.status(400).json({ error: aliasCheck.error });
        return;
      }
      const conflict = db.prepare('SELECT id FROM links WHERE slug = ?').get(aliasCheck.normalized);
      if (conflict) {
        res.status(409).json({ error: 'Custom alias is already in use.' });
        return;
      }
      slug = aliasCheck.normalized;
    } else {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = generateRandomSlug(6);
        const exists = db.prepare('SELECT id FROM links WHERE slug = ?').get(candidate);
        if (!exists) {
          slug = candidate;
          break;
        }
      }
      if (!slug) slug = generateRandomSlug(8);
    }

    let normalizedVideoUrl: string | null = null;
    let videoMimeType: string | null = null;
    let normalizedThumbUrl: string | null = null;
    let normalizedPlayerUrl: string | null = null;

    const rawVideoUrl = data.videoUrl && data.videoUrl.trim() ? data.videoUrl.trim() : '';
    const effectiveLinkType =
      data.linkType === 'video' || Boolean(rawVideoUrl) ? 'video' : 'normal';
    const previewEnabled =
      data.previewEnabled !== undefined ? Boolean(data.previewEnabled) : effectiveLinkType === 'video';

    let resolvedWidth = Number(data.videoWidth || 0);
    let resolvedHeight = Number(data.videoHeight || 0);

    if (effectiveLinkType === 'video' || rawVideoUrl) {
      if (rawVideoUrl) {
        const videoCheck = validateVideoUrl(rawVideoUrl);
        if (!videoCheck.valid || !videoCheck.normalizedUrl) {
          res.status(400).json({ error: videoCheck.error || 'Invalid video URL.' });
          return;
        }
        normalizedVideoUrl = videoCheck.normalizedUrl;
        videoMimeType = videoCheck.mimeType || 'video/mp4';

        if (resolvedWidth <= 0 || resolvedHeight <= 0) {
          const urlDims = resolveVideoDimensions(normalizedVideoUrl, null, null);
          resolvedWidth = urlDims.width;
          resolvedHeight = urlDims.height;
          if (resolvedWidth <= 0 || resolvedHeight <= 0) {
            const probe = await probeVideoStream(normalizedVideoUrl, {
              origin: getRequestOrigin(req),
              localReader: localSampleReader,
            });
            if (probe.audit.detectedWidth && probe.audit.detectedHeight) {
              resolvedWidth = probe.audit.detectedWidth;
              resolvedHeight = probe.audit.detectedHeight;
            }
          }
        }
      } else if (!settings.globalVideoUrl) {
        res.status(400).json({
          error: 'Video URL is required for video preview links unless a Global Video is configured in Admin.',
        });
        return;
      }

      if (data.thumbnailUrl && data.thumbnailUrl.trim()) {
        const thumbCheck = validateSafeExternalUrl(data.thumbnailUrl, true, true);
        if (!thumbCheck.valid || !thumbCheck.normalizedUrl) {
          res.status(400).json({ error: thumbCheck.error || 'Invalid thumbnail URL.' });
          return;
        }
        normalizedThumbUrl = thumbCheck.normalizedUrl;
      }

      if (data.playerUrl && data.playerUrl.trim()) {
        const pCheck = validateSafeExternalUrl(data.playerUrl, true, true);
        if (!pCheck.valid || !pCheck.normalizedUrl) {
          res.status(400).json({ error: pCheck.error || 'Invalid custom Player URL.' });
          return;
        }
        normalizedPlayerUrl = pCheck.normalizedUrl;
      }
    }

    const titleToSave = data.videoTitle?.trim() || null;
    const redirectType = data.redirectType || settings.defaultRedirectType;
    const passwordHash =
      data.password && data.password.trim() ? await hashPassword(data.password.trim()) : null;
    const linkId = randomId('lnk');
    const now = new Date().toISOString();
    const autoRedirectSeconds = Math.max(0, Math.min(120, Number(data.autoRedirectSeconds || 0)));

    db.prepare(`
      INSERT INTO links (
        id, user_id, slug, link_type, preview_enabled, auto_redirect_seconds,
        destination_url, video_url, video_title, video_description, thumbnail_url,
        video_mime_type, video_width, video_height, twitter_card_type, player_url,
        redirect_type, password_hash, expires_at, is_active, utm_source, utm_medium,
        utm_campaign, campaign_name, tags, clicks_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      linkId,
      user ? user.id : null,
      slug,
      effectiveLinkType,
      effectiveLinkType === 'video' && previewEnabled ? 1 : 0,
      autoRedirectSeconds,
      destCheck.normalizedUrl,
      normalizedVideoUrl,
      titleToSave,
      data.videoDescription?.trim() || null,
      normalizedThumbUrl,
      videoMimeType,
      resolvedWidth,
      resolvedHeight,
      data.twitterCardType || 'player',
      normalizedPlayerUrl,
      redirectType,
      passwordHash,
      data.expiresAt || null,
      data.isActive ? 1 : 0,
      data.utmSource?.trim() || null,
      data.utmMedium?.trim() || null,
      data.utmCampaign?.trim() || null,
      data.campaignName?.trim() || null,
      JSON.stringify(data.tags || []),
      now,
      now
    );

    const created = mapLinkRow(
      db.prepare('SELECT * FROM links WHERE id = ?').get(linkId) as Record<string, unknown>
    );
    res.status(201).json({ link: created });
  });

  router.get('/links', async (req, res) => {
    const user = await resolveAuthUser(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    const type = typeof req.query.type === 'string' ? req.query.type : 'all';
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || '10'), 10) || 10));

    const db = getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user) {
      if (user.role !== 'admin') {
        conditions.push('(user_id = ? OR user_id IS NULL)');
        params.push(user.id);
      }
    } else {
      // Guest workspace shows public/demo links + links created anonymously
      conditions.push('(user_id IS NULL OR id LIKE "lnk_demo_%")');
    }

    if (status === 'active') conditions.push('is_active = 1');
    else if (status === 'disabled') conditions.push('is_active = 0');

    if (type === 'normal') conditions.push("link_type = 'normal'");
    else if (type === 'video') conditions.push("link_type = 'video'");

    if (q) {
      conditions.push('(LOWER(slug) LIKE ? OR LOWER(destination_url) LIKE ? OR LOWER(COALESCE(video_title, "")) LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (
      db.prepare(`SELECT COUNT(*) as cnt FROM links ${whereClause}`).get(...params) as { cnt: number }
    ).cnt;

    const rows = db
      .prepare(`SELECT * FROM links ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;

    res.json({
      links: rows.map(mapLinkRow),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  });

  router.get('/links/:id', async (req, res) => {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE id = ?')
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Link not found.' });
      return;
    }
    res.json({ link: mapLinkRow(row) });
  });

  router.put('/links/:id', async (req, res) => {
    const user = await resolveAuthUser(req);
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM links WHERE id = ?')
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Link not found.' });
      return;
    }

    if (existing.user_id && user && user.role !== 'admin' && existing.user_id !== user.id) {
      res.status(403).json({ error: 'You do not have permission to edit this link.' });
      return;
    }
    if (existing.user_id && !user && !String(existing.id).startsWith('lnk_demo_')) {
      res.status(401).json({ error: 'Authentication required to edit owned links.' });
      return;
    }

    const parsed = updateLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid update payload.' });
      return;
    }

    const data = parsed.data;
    let slug = String(existing.slug);
    if (data.customAlias !== undefined && data.customAlias !== null && data.customAlias.trim() !== slug) {
      const check = validateCustomAlias(data.customAlias);
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
      const conflict = db
        .prepare('SELECT id FROM links WHERE slug = ? AND id != ?')
        .get(check.normalized, String(existing.id));
      if (conflict) {
        res.status(409).json({ error: 'Alias is already taken.' });
        return;
      }
      slug = check.normalized;
    }

    let destinationUrl = String(existing.destination_url);
    if (data.destinationUrl !== undefined) {
      const destCheck = validateSafeExternalUrl(data.destinationUrl);
      if (!destCheck.valid || !destCheck.normalizedUrl) {
        res.status(400).json({ error: destCheck.error || 'Invalid destination URL.' });
        return;
      }
      destinationUrl = destCheck.normalizedUrl;
    }

    const linkType = data.linkType ?? (existing.link_type as 'normal' | 'video');
    const previewEnabled =
      data.previewEnabled !== undefined
        ? data.previewEnabled
        : data.linkType !== undefined
          ? data.linkType === 'video'
          : existing.preview_enabled !== undefined
            ? Number(existing.preview_enabled) === 1
            : linkType === 'video';
    const autoRedirectSeconds =
      data.autoRedirectSeconds !== undefined
        ? Math.max(0, Math.min(120, Number(data.autoRedirectSeconds)))
        : Math.max(0, Math.min(120, Number(existing.auto_redirect_seconds || 0)));

    let videoUrl = existing.video_url ? String(existing.video_url) : null;
    let videoMimeType = existing.video_mime_type ? String(existing.video_mime_type) : null;

    if (data.videoUrl !== undefined) {
      if (data.videoUrl && data.videoUrl.trim()) {
        const vCheck = validateVideoUrl(data.videoUrl);
        if (!vCheck.valid || !vCheck.normalizedUrl) {
          res.status(400).json({ error: vCheck.error || 'Invalid video URL.' });
          return;
        }
        videoUrl = vCheck.normalizedUrl;
        videoMimeType = vCheck.mimeType || 'video/mp4';
      } else {
        videoUrl = null;
        videoMimeType = null;
      }
    }

    let thumbnailUrl = existing.thumbnail_url ? String(existing.thumbnail_url) : null;
    if (data.thumbnailUrl !== undefined) {
      if (data.thumbnailUrl && data.thumbnailUrl.trim()) {
        const tCheck = validateSafeExternalUrl(data.thumbnailUrl, true, true);
        if (!tCheck.valid || !tCheck.normalizedUrl) {
          res.status(400).json({ error: tCheck.error || 'Invalid thumbnail URL.' });
          return;
        }
        thumbnailUrl = tCheck.normalizedUrl;
      } else {
        thumbnailUrl = null;
      }
    }

    let playerUrl = existing.player_url ? String(existing.player_url) : null;
    if (data.playerUrl !== undefined) {
      if (data.playerUrl && data.playerUrl.trim()) {
        const pCheck = validateSafeExternalUrl(data.playerUrl, true, true);
        if (!pCheck.valid || !pCheck.normalizedUrl) {
          res.status(400).json({ error: pCheck.error || 'Invalid player URL.' });
          return;
        }
        playerUrl = pCheck.normalizedUrl;
      } else {
        playerUrl = null;
      }
    }

    let passwordHash = existing.password_hash ? String(existing.password_hash) : null;
    if (data.clearPassword) {
      passwordHash = null;
    } else if (data.password && data.password.trim()) {
      passwordHash = await hashPassword(data.password.trim());
    }

    const now = new Date().toISOString();
    const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

    db.prepare(`
      UPDATE links SET
        slug = ?,
        link_type = ?,
        preview_enabled = ?,
        auto_redirect_seconds = ?,
        destination_url = ?,
        video_url = ?,
        video_title = ?,
        video_description = ?,
        thumbnail_url = ?,
        video_mime_type = ?,
        video_width = ?,
        video_height = ?,
        twitter_card_type = ?,
        player_url = ?,
        redirect_type = ?,
        password_hash = ?,
        expires_at = ?,
        is_active = ?,
        utm_source = ?,
        utm_medium = ?,
        utm_campaign = ?,
        campaign_name = ?,
        tags = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      slug,
      linkType,
      previewEnabled ? 1 : 0,
      autoRedirectSeconds,
      destinationUrl,
      videoUrl,
      data.videoTitle !== undefined ? data.videoTitle?.trim() || null : strOrNull(existing.video_title),
      data.videoDescription !== undefined ? data.videoDescription?.trim() || null : strOrNull(existing.video_description),
      thumbnailUrl,
      videoMimeType,
      Number(data.videoWidth ?? existing.video_width ?? 0),
      Number(data.videoHeight ?? existing.video_height ?? 0),
      String(data.twitterCardType ?? existing.twitter_card_type ?? 'player'),
      playerUrl,
      Number(data.redirectType ?? existing.redirect_type ?? 302),
      passwordHash,
      data.expiresAt !== undefined ? data.expiresAt || null : strOrNull(existing.expires_at),
      data.isActive !== undefined ? (data.isActive ? 1 : 0) : Number(existing.is_active),
      data.utmSource !== undefined ? data.utmSource?.trim() || null : strOrNull(existing.utm_source),
      data.utmMedium !== undefined ? data.utmMedium?.trim() || null : strOrNull(existing.utm_medium),
      data.utmCampaign !== undefined ? data.utmCampaign?.trim() || null : strOrNull(existing.utm_campaign),
      data.campaignName !== undefined ? data.campaignName?.trim() || null : strOrNull(existing.campaign_name),
      data.tags !== undefined ? JSON.stringify(data.tags) : strOrNull(existing.tags),
      now,
      String(existing.id)
    );

    const updated = mapLinkRow(
      db.prepare('SELECT * FROM links WHERE id = ?').get(String(existing.id)) as Record<string, unknown>
    );
    res.json({ link: updated });
  });

  router.delete('/links/:id', async (req, res) => {
    const user = await resolveAuthUser(req);
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM links WHERE id = ?')
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Link not found.' });
      return;
    }
    if (existing.user_id && user && user.role !== 'admin' && existing.user_id !== user.id) {
      res.status(403).json({ error: 'Permission denied.' });
      return;
    }
    db.prepare('DELETE FROM links WHERE id = ?').run(String(existing.id));
    res.json({ ok: true });
  });

  router.post('/links/:id/verify-password', async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE id = ? OR slug = ?')
      .get(req.params.id, req.params.id) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: 'Link not found.' });
      return;
    }
    if (!row.password_hash) {
      res.json({ unlocked: true, destinationUrl: row.destination_url });
      return;
    }
    const ok = await verifyPassword(password, String(row.password_hash));
    if (!ok) {
      res.status(401).json({ error: 'Incorrect link password.' });
      return;
    }
    const link = mapLinkRow(row);
    const finalDest = appendUtmParams(link.destinationUrl, {
      source: link.utmSource,
      medium: link.utmMedium,
      campaign: link.utmCampaign,
    });

    // Record click upon unlock
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

    res.json({ unlocked: true, destinationUrl: finalDest });
  });

  // ================= PUBLIC PREVIEW & METADATA =================
  router.get('/preview/:slug', async (req, res) => {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ?')
      .get(req.params.slug) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: 'Preview link not found.' });
      return;
    }

    const link = mapLinkRow(row);
    const settings = getSystemSettings();
    const isExpired = link.expiresAt ? new Date(link.expiresAt).getTime() < Date.now() : false;
    const origin = getRequestOrigin(req);
    const metadata = buildSocialMetadata(
      link,
      origin,
      `/s/${encodeURIComponent(link.slug)}`,
      settings
    );

    // Optionally record view if ?track=1 is passed by public video preview page
    if (req.query.track === '1' && link.isActive && !isExpired) {
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

    const destinationWithUtm = appendUtmParams(link.destinationUrl, {
      source: link.utmSource,
      medium: link.utmMedium,
      campaign: link.utmCampaign,
    });

    let audit: VideoStreamAudit | undefined;

    if (req.query.audit === '1') {
      const rawEffectiveVideo =
        settings.globalVideoOverride && settings.globalVideoUrl
          ? settings.globalVideoUrl
          : link.videoUrl || settings.globalVideoUrl || '';

      if (rawEffectiveVideo) {
        const probed = await probeVideoStream(rawEffectiveVideo, {
          origin,
          localReader: localSampleReader,
          playerUrl: metadata.twitterPlayer,
        });
        audit = probed.audit;
      } else {
        audit = {
          videoReachable: false,
          videoStatus: null,
          videoHttps: false,
          videoMimeType: null,
          videoContentLength: null,
          acceptRanges: false,
          rangeSupported: false,
          rangeStatus: null,
          detectedWidth: null,
          detectedHeight: null,
          codec: null,
          faststart: null,
          isGithubRaw: false,
          xCrawlerReady: false,
          playerReachable: true,
          playerStatus: 200,
          playerHttps: metadata.twitterPlayer.startsWith('https://'),
          errors: ['No video URL configured for this link or in Global Video Settings.'],
          warnings: [],
        };
      }
    }

    res.json({
      link: { ...link, destinationUrl: destinationWithUtm },
      isExpired,
      metadata,
      audit,
    });
  });

  // ================= OEMBED FOR SOCIAL VIDEO EMBEDS =================
  router.get('/oembed', (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Missing url parameter.' });
      return;
    }

    let slug = '';
    try {
      const parsed = new URL(rawUrl);
      const parts = parsed.pathname.split('/').filter(Boolean);
      slug =
        parts.length >= 2 && (parts[0] === 'v' || parts[0] === 'video' || parts[0] === 's')
          ? parts[1]
          : parts[0] || '';
    } catch {
      slug = rawUrl.replace(/^\/+/, '').split('/')[0] || '';
    }

    const db = getDb();
    const row = db
      .prepare('SELECT * FROM links WHERE slug = ? AND is_active = 1')
      .get(slug) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: 'Video link not found.' });
      return;
    }

    const link = mapLinkRow(row);
    const settings = getSystemSettings();
    const origin = getRequestOrigin(req);
    const meta = buildSocialMetadata(
      link,
      origin,
      `/s/${encodeURIComponent(link.slug)}`,
      settings
    );
    if (!meta.hasValidVideo) {
      res.status(404).json({ error: meta.videoError || 'No video configured for this link.' });
      return;
    }

    const w = meta.twitterPlayerWidth || 720;
    const h = meta.twitterPlayerHeight || 1278;
    const safePlayer = meta.twitterPlayer.replace(/"/g, '&quot;');

    res.json({
      version: '1.0',
      type: 'video',
      provider_name: 'NasirLink',
      provider_url: origin,
      title: meta.title,
      description: meta.description,
      width: w,
      height: h,
      html: `<iframe src="${safePlayer}" width="${w}" height="${h}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`,
    });
  });

  // ================= QR CODE GENERATOR =================
  router.post('/qr', async (req, res) => {
    const parsed = qrRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid QR options.' });
      return;
    }
    const { url, fgColor, bgColor, size, includeLogo, logoText, logoDataUrl } = parsed.data;
    const ecLevel = includeLogo ? 'H' : 'M';

    try {
      let svg = await QRCode.toString(url, {
        type: 'svg',
        width: size,
        margin: 2,
        errorCorrectionLevel: ecLevel,
        color: {
          dark: fgColor,
          light: bgColor,
        },
      });

      if (includeLogo) {
        // QRCode.toString generates SVG with viewBox="0 0 N N" where N is module count + margins
        const vbMatch = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
        const vbSize = vbMatch ? parseFloat(vbMatch[1]) : 33;
        const badgeSize = Number((vbSize * 0.24).toFixed(3));
        const center = vbSize / 2;
        const x = Number((center - badgeSize / 2).toFixed(3));
        const y = Number((center - badgeSize / 2).toFixed(3));
        const rx = Number((badgeSize * 0.2).toFixed(3));
        const strokeW = Number((vbSize * 0.015).toFixed(3));

        let innerLogo = '';
        const cleanLogoUrl = logoDataUrl?.trim() || '';
        const isSafeDataImg = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[a-zA-Z0-9+/=]+$/i.test(
          cleanLogoUrl
        );

        if (isSafeDataImg) {
          const pad = Number((badgeSize * 0.1).toFixed(3));
          const imgX = Number((x + pad).toFixed(3));
          const imgY = Number((y + pad).toFixed(3));
          const imgS = Number((badgeSize - pad * 2).toFixed(3));
          const clipId = `qr_logo_clip_${Date.now()}`;
          innerLogo = `
            <defs><clipPath id="${clipId}"><rect x="${imgX}" y="${imgY}" width="${imgS}" height="${imgS}" rx="${Number((rx * 0.7).toFixed(3))}" /></clipPath></defs>
            <image href="${cleanLogoUrl}" x="${imgX}" y="${imgY}" width="${imgS}" height="${imgS}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />
          `;
        } else {
          const safeText = (logoText || 'NL').replace(/[<>&"]/g, '');
          const fontSize = Number((badgeSize * 0.42).toFixed(3));
          const textY = Number((center + badgeSize * 0.15).toFixed(3));
          innerLogo = `<text x="${center}" y="${textY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="${fontSize}" fill="${fgColor}">${safeText}</text>`;
        }

        const overlay = `
          <rect x="${x}" y="${y}" width="${badgeSize}" height="${badgeSize}" rx="${rx}" fill="${bgColor}" stroke="${fgColor}" stroke-width="${strokeW}" />
          ${innerLogo}
        `;
        svg = svg.replace('</svg>', `${overlay}</svg>`);
      }

      const pngDataUrl = await QRCode.toDataURL(url, {
        width: size,
        margin: 2,
        errorCorrectionLevel: ecLevel,
        color: {
          dark: fgColor,
          light: bgColor,
        },
      });

      res.json({ svg, pngDataUrl });
    } catch (err) {
      res.status(500).json({ error: `QR generation failed: ${(err as Error).message}` });
    }
  });

  // ================= ANALYTICS =================
  router.get('/analytics/overview', async (req, res) => {
    const user = await resolveAuthUser(req);
    const scopeUserId = user && user.role === 'admin' ? null : user?.id || null;
    const overview = computeAnalytics(scopeUserId, null);
    res.json(overview);
  });

  router.get('/analytics/:id', async (req, res) => {
    const db = getDb();
    const row = db
      .prepare('SELECT id, slug FROM links WHERE id = ? OR slug = ?')
      .get(req.params.id, req.params.id) as { id: string; slug: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Link not found for analytics.' });
      return;
    }
    const analytics = computeAnalytics(null, row.id);
    res.json(analytics);
  });

  // ================= ABUSE REPORTS =================
  router.post('/reports', async (req, res) => {
    const parsed = reportLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid report payload.' });
      return;
    }
    const { slug, reason, details } = parsed.data;
    const db = getDb();
    const link = db.prepare('SELECT id FROM links WHERE slug = ?').get(slug) as { id: string } | undefined;
    const reporterHash = await sha256Hex(`${getClientIp(req)}|${slug}`);

    const reportId = randomId('rpt');
    db.prepare(`
      INSERT INTO reports (id, link_id, slug, reason, details, reporter_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(reportId, link?.id || null, slug, reason, details?.trim() || null, reporterHash.slice(0, 24), new Date().toISOString());

    res.status(201).json({ ok: true, id: reportId });
  });

  // ================= ADMIN =================
  async function requireAdmin(req: Request, res: Response): Promise<PublicUser | null> {
    const user = await resolveAuthUser(req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return null;
    }
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Administrator privileges required.' });
      return null;
    }
    return user;
  }

  router.get('/admin/stats', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    res.json(getAdminStats());
  });

  router.get('/admin/users', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const db = getDb();
    const rows = q
      ? (db
          .prepare('SELECT * FROM users WHERE LOWER(email) LIKE ? OR LOWER(name) LIKE ? ORDER BY created_at DESC')
          .all(`%${q}%`, `%${q}%`) as Array<Record<string, unknown>>)
      : (db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as Array<Record<string, unknown>>);

    res.json({ users: rows.map(mapUserRow) });
  });

  router.patch('/admin/users/:id', async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const targetId = req.params.id;
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const nextRole = req.body?.role === 'admin' || req.body?.role === 'user' ? req.body.role : row.role;
    const nextStatus =
      req.body?.status === 'active' || req.body?.status === 'suspended' ? req.body.status : row.status;

    if (targetId === admin.id && (nextRole !== 'admin' || nextStatus !== 'active')) {
      res.status(400).json({ error: 'You cannot suspend or demote your own active admin account.' });
      return;
    }

    db.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?').run(
      String(nextRole),
      String(nextStatus),
      new Date().toISOString(),
      targetId
    );
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as Record<string, unknown>;
    res.json({ user: mapUserRow(updated) });
  });

  router.delete('/admin/users/:id', async (req, res) => {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    if (req.params.id === admin.id) {
      res.status(400).json({ error: 'Cannot delete your own admin account.' });
      return;
    }
    const db = getDb();
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  router.get('/admin/links', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const db = getDb();
    const rows = q
      ? (db
          .prepare(
            'SELECT * FROM links WHERE LOWER(slug) LIKE ? OR LOWER(destination_url) LIKE ? ORDER BY created_at DESC LIMIT 200'
          )
          .all(`%${q}%`, `%${q}%`) as Array<Record<string, unknown>>)
      : (db.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT 200').all() as Array<
          Record<string, unknown>
        >);
    res.json({ links: rows.map(mapLinkRow) });
  });

  router.patch('/admin/links/:id', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Link not found.' });
      return;
    }

    const parsed = updateLinkSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid admin link update payload.' });
      return;
    }
    const data = parsed.data;

    let videoUrl = existing.video_url ? String(existing.video_url) : null;
    let videoMimeType = existing.video_mime_type ? String(existing.video_mime_type) : null;
    if (data.videoUrl !== undefined) {
      if (data.videoUrl && data.videoUrl.trim()) {
        const vCheck = validateVideoUrl(data.videoUrl);
        if (!vCheck.valid || !vCheck.normalizedUrl) {
          res.status(400).json({ error: vCheck.error || 'Invalid video URL.' });
          return;
        }
        videoUrl = vCheck.normalizedUrl;
        videoMimeType = vCheck.mimeType || 'video/mp4';
      } else {
        videoUrl = null;
        videoMimeType = null;
      }
    }

    let thumbnailUrl = existing.thumbnail_url ? String(existing.thumbnail_url) : null;
    if (data.thumbnailUrl !== undefined) {
      if (data.thumbnailUrl && data.thumbnailUrl.trim()) {
        const tCheck = validateSafeExternalUrl(data.thumbnailUrl, true, true);
        if (!tCheck.valid || !tCheck.normalizedUrl) {
          res.status(400).json({ error: tCheck.error || 'Invalid thumbnail URL.' });
          return;
        }
        thumbnailUrl = tCheck.normalizedUrl;
      } else {
        thumbnailUrl = null;
      }
    }

    const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
    const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : Number(existing.is_active);
    const previewEnabled =
      data.previewEnabled !== undefined
        ? data.previewEnabled
          ? 1
          : 0
        : existing.preview_enabled !== undefined
          ? Number(existing.preview_enabled)
          : existing.link_type === 'video'
            ? 1
            : 0;
    const autoRedirectSeconds =
      data.autoRedirectSeconds !== undefined
        ? Math.max(0, Math.min(120, Number(data.autoRedirectSeconds)))
        : Math.max(0, Math.min(120, Number(existing.auto_redirect_seconds || 0)));

    db.prepare(`
      UPDATE links SET
        is_active = ?,
        preview_enabled = ?,
        auto_redirect_seconds = ?,
        video_url = ?,
        video_mime_type = ?,
        thumbnail_url = ?,
        video_title = ?,
        video_description = ?,
        video_width = ?,
        video_height = ?,
        twitter_card_type = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      isActive,
      previewEnabled,
      autoRedirectSeconds,
      videoUrl,
      videoMimeType,
      thumbnailUrl,
      data.videoTitle !== undefined ? data.videoTitle?.trim() || null : strOrNull(existing.video_title),
      data.videoDescription !== undefined ? data.videoDescription?.trim() || null : strOrNull(existing.video_description),
      Number(data.videoWidth ?? existing.video_width ?? 0),
      Number(data.videoHeight ?? existing.video_height ?? 0),
      String(data.twitterCardType ?? existing.twitter_card_type ?? 'player'),
      new Date().toISOString(),
      req.params.id
    );
    const updated = db.prepare('SELECT * FROM links WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ link: mapLinkRow(updated) });
  });

  router.delete('/admin/links/:id', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    getDb().prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  router.get('/admin/reports', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    res.json({ reports: listReports() });
  });

  router.patch('/admin/reports/:id', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const status = req.body?.status;
    if (!['pending', 'reviewed', 'dismissed', 'actioned'].includes(status)) {
      res.status(400).json({ error: 'Invalid report status.' });
      return;
    }
    const db = getDb();
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!report) {
      res.status(404).json({ error: 'Report not found.' });
      return;
    }
    db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, req.params.id);
    if (status === 'actioned' && report.link_id) {
      db.prepare('UPDATE links SET is_active = 0, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        String(report.link_id)
      );
    }
    res.json({ ok: true });
  });

  router.get('/admin/settings', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    res.json({ settings: getSystemSettings() });
  });

  router.put('/admin/settings', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const b = req.body || {};

    let normalizedGlobalVideoUrl: string | null | undefined = undefined;
    let detectedGlobalMime: string | null | undefined =
      b.globalVideoMimeType === null
        ? null
        : typeof b.globalVideoMimeType === 'string'
          ? b.globalVideoMimeType
          : undefined;
    let detectedGlobalWidth: number | null | undefined =
      b.globalVideoWidth === null
        ? null
        : typeof b.globalVideoWidth === 'number' && b.globalVideoWidth > 0
          ? b.globalVideoWidth
          : undefined;
    let detectedGlobalHeight: number | null | undefined =
      b.globalVideoHeight === null
        ? null
        : typeof b.globalVideoHeight === 'number' && b.globalVideoHeight > 0
          ? b.globalVideoHeight
          : undefined;

    if (b.globalVideoUrl !== undefined) {
      if (typeof b.globalVideoUrl === 'string' && b.globalVideoUrl.trim()) {
        const vCheck = validateVideoUrl(b.globalVideoUrl);
        if (!vCheck.valid || !vCheck.normalizedUrl) {
          res.status(400).json({ error: vCheck.error || 'Invalid Global Video URL.' });
          return;
        }
        normalizedGlobalVideoUrl = vCheck.normalizedUrl;
        if (!detectedGlobalMime) detectedGlobalMime = vCheck.mimeType || 'video/mp4';

        if (!detectedGlobalWidth || !detectedGlobalHeight) {
          const urlDims = resolveVideoDimensions(normalizedGlobalVideoUrl, null, null);
          if (urlDims.width > 0 && urlDims.height > 0) {
            detectedGlobalWidth = urlDims.width;
            detectedGlobalHeight = urlDims.height;
          } else {
            const probed = await probeVideoStream(normalizedGlobalVideoUrl, {
              origin: getRequestOrigin(req),
              localReader: localSampleReader,
            });
            if (probed.audit.detectedWidth && probed.audit.detectedHeight) {
              detectedGlobalWidth = probed.audit.detectedWidth;
              detectedGlobalHeight = probed.audit.detectedHeight;
            }
          }
        }
      } else {
        normalizedGlobalVideoUrl = null;
        detectedGlobalWidth = null;
        detectedGlobalHeight = null;
        detectedGlobalMime = null;
      }
    }

    let normalizedGlobalSourceUrl: string | null | undefined = undefined;
    if (b.globalVideoSourceUrl !== undefined) {
      if (typeof b.globalVideoSourceUrl === 'string' && b.globalVideoSourceUrl.trim()) {
        const sCheck = validateSafeExternalUrl(b.globalVideoSourceUrl, true, true);
        if (!sCheck.valid || !sCheck.normalizedUrl) {
          res.status(400).json({ error: sCheck.error || 'Global Source Attribution URL must be a valid public HTTPS URL.' });
          return;
        }
        normalizedGlobalSourceUrl = sCheck.normalizedUrl;
      } else {
        normalizedGlobalSourceUrl = null;
      }
    }

    const updated = updateSystemSettings({
      siteName: typeof b.siteName === 'string' ? b.siteName.trim().slice(0, 60) : undefined,
      domain: typeof b.domain === 'string' ? b.domain.trim().slice(0, 120) : undefined,
      defaultRedirectType: b.defaultRedirectType === 301 ? 301 : b.defaultRedirectType === 302 ? 302 : undefined,
      registrationEnabled: typeof b.registrationEnabled === 'boolean' ? b.registrationEnabled : undefined,
      maxLinksPerUser: typeof b.maxLinksPerUser === 'number' ? Math.max(1, Math.min(100000, b.maxLinksPerUser)) : undefined,
      rateLimitPerMin: typeof b.rateLimitPerMin === 'number' ? Math.max(10, Math.min(5000, b.rateLimitPerMin)) : undefined,
      maintenanceMode: typeof b.maintenanceMode === 'boolean' ? b.maintenanceMode : undefined,
      globalVideoUrl: normalizedGlobalVideoUrl,
      globalVideoWidth: detectedGlobalWidth,
      globalVideoHeight: detectedGlobalHeight,
      globalVideoMimeType: detectedGlobalMime,
      globalVideoTitle:
        b.globalVideoTitle === null
          ? null
          : typeof b.globalVideoTitle === 'string'
            ? b.globalVideoTitle.trim().slice(0, 120) || null
            : undefined,
      globalVideoDescription:
        b.globalVideoDescription === null
          ? null
          : typeof b.globalVideoDescription === 'string'
            ? b.globalVideoDescription.trim().slice(0, 500) || null
            : undefined,
      globalVideoSourceUrl: normalizedGlobalSourceUrl,
      globalVideoOverride:
        typeof b.globalVideoOverride === 'boolean' ? b.globalVideoOverride : undefined,
    });
    res.json({ settings: updated });
  });

  return router;
}
