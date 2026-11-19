import QRCore from 'qrcode/lib/core/qrcode.js';
import SvgRenderer from 'qrcode/lib/renderer/svg-tag.js';
import {
  createAnonymousVisitorId,
  escapeHtml,
  generateSecureToken,
  hashPassword,
  parseUserAgent,
  randomId,
  sha256Hex,
  verifyPassword,
} from './server/crypto.ts';
import {
  buildSocialMetadata,
  injectVideoMetaIntoHtml,
  renderLandingBodySnapshot,
  renderPlayerPageHtml,
  renderSocialCrawlerHtml,
  resolveVideoDimensions,
} from './server/metadata.ts';
import { probeVideoStream, type LocalMediaReader } from './server/videoProbe.ts';
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
} from './shared/validation.ts';
import type {
  AbuseReport,
  AdminStats,
  AnalyticsOverview,
  BreakdownItem,
  LinkRecord,
  PublicUser,
  RedirectStatusCode,
  SystemSettings,
  UserRole,
  UserStatus,
  VideoStreamAudit,
} from './shared/types.ts';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
}

interface AssetsFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface WorkerEnv {
  DB?: D1Database;
  ASSETS?: AssetsFetcher;
  APP_DOMAIN?: string;
  DEFAULT_REDIRECT_STATUS?: string;
}

const SESSION_COOKIE_NAME = 'nasirlink_session';

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

const WORKER_RATE_BUCKETS = new Map<string, { count: number; resetAt: number }>();

function createWorkerLocalReader(env: WorkerEnv, requestUrl: string): LocalMediaReader | undefined {
  if (!env.ASSETS) return undefined;
  return async (pathOrUrl: string, start = 0, end = 131071) => {
    if (!pathOrUrl.startsWith('/api/sample-video/')) return null;
    const filename = pathOrUrl.slice('/api/sample-video/'.length).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!['showcase.mp4', 'showcase1.mp4', 'edge-network.mp4'].includes(filename)) return null;
    const sampleUrl = new URL(`/samples/${filename}`, requestUrl);
    const resp = await env.ASSETS!.fetch(new Request(sampleUrl, { headers: { Range: `bytes=${start}-${end}` } }));
    if (!resp.ok && resp.status !== 206) {
      await resp.body?.cancel();
      return null;
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const cr = resp.headers.get('content-range');
    const totalMatch = cr?.match(/\/(\d+)$/);
    const totalSize = totalMatch ? Number(totalMatch[1]) : Number(resp.headers.get('content-length') || buf.length);
    return {
      status: resp.status,
      contentType: resp.headers.get('content-type') || 'video/mp4',
      totalSize,
      bytes: buf,
    };
  };
}

async function fetchWithSafeRedirects(
  targetUrl: string,
  init: { method: string; headers?: Headers }
): Promise<Response> {
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

const SOCIAL_CRAWLER_UA_REGEX =
  /(twitterbot|xbot|facebookexternalhit|facebot|meta-externalagent|meta-externalfetcher|discordbot|telegrambot|whatsapp|slackbot|linkedinbot|pinterest|applebot|embedly|redditbot|skypeuripreview|vkshare|iframely|quora link preview|mastodon|misskey|line-poker|kakaotalk-scrap|viber|snapchat|googlebot|bingbot|crawler|spider|preview|unfurl|curl|wget)/i;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    email_verified INTEGER NOT NULL DEFAULT 0,
    verification_token TEXT,
    reset_token TEXT,
    reset_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    link_type TEXT NOT NULL DEFAULT 'normal',
    preview_enabled INTEGER NOT NULL DEFAULT 0,
    auto_redirect_seconds INTEGER NOT NULL DEFAULT 0,
    destination_url TEXT NOT NULL,
    video_url TEXT,
    video_title TEXT,
    video_description TEXT,
    thumbnail_url TEXT,
    video_mime_type TEXT,
    video_width INTEGER DEFAULT 0,
    video_height INTEGER DEFAULT 0,
    twitter_card_type TEXT NOT NULL DEFAULT 'player',
    player_url TEXT,
    redirect_type INTEGER NOT NULL DEFAULT 302,
    password_hash TEXT,
    expires_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    campaign_name TEXT,
    tags TEXT,
    clicks_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS clicks (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    clicked_at TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'Unknown',
    device_type TEXT NOT NULL DEFAULT 'Desktop',
    browser TEXT NOT NULL DEFAULT 'Other',
    operating_system TEXT NOT NULL DEFAULT 'Other',
    referrer TEXT NOT NULL DEFAULT 'Direct',
    anonymous_visitor_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    link_id TEXT,
    slug TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT,
    reporter_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

// ================= IN-MEMORY FALLBACK STORE (when D1 binding isn't attached yet) =================
interface MemoryClick {
  id: string;
  linkId: string;
  clickedAt: string;
  country: string;
  deviceType: string;
  browser: string;
  operatingSystem: string;
  referrer: string;
  anonymousVisitorId: string;
}

interface MemoryUser extends PublicUser {
  passwordHash: string;
  verificationToken: string | null;
  resetToken: string | null;
  resetExpiresAt: string | null;
  updatedAt: string;
}

interface MemoryLink extends LinkRecord {
  passwordHash: string | null;
}

interface MemorySession {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string;
  expiresAt: string;
  createdAt: string;
}

interface MemoryReport extends AbuseReport {
  reporterHash: string;
}

interface MemoryStore {
  initialized: boolean;
  users: MemoryUser[];
  sessions: MemorySession[];
  links: MemoryLink[];
  clicks: MemoryClick[];
  reports: MemoryReport[];
  settings: SystemSettings;
}

const memStore: MemoryStore = {
  initialized: false,
  users: [],
  sessions: [],
  links: [],
  clicks: [],
  reports: [],
  settings: {
    siteName: 'NasirLink',
    domain: 'nasirlink.com',
    defaultRedirectType: 302,
    registrationEnabled: true,
    maxLinksPerUser: 500,
    rateLimitPerMin: 120,
    maintenanceMode: false,
    globalVideoUrl: null,
    globalVideoWidth: null,
    globalVideoHeight: null,
    globalVideoMimeType: null,
    globalVideoTitle: null,
    globalVideoDescription: null,
    globalVideoSourceUrl: null,
    globalVideoOverride: false,
  },
};

function buildSeedFixtures(adminHash: string, creatorHash: string) {
  const now = Date.now();
  const created = new Date(now - 10 * 86400_000).toISOString();
  const users: MemoryUser[] = [
    {
      id: 'usr_admin_nasir',
      email: 'admin@nasirlink.com',
      name: 'Nasir Hassan',
      role: 'admin',
      status: 'active',
      emailVerified: true,
      passwordHash: adminHash,
      verificationToken: null,
      resetToken: null,
      resetExpiresAt: null,
      createdAt: new Date(now - 14 * 86400_000).toISOString(),
      updatedAt: created,
    },
    {
      id: 'usr_creator_demo',
      email: 'creator@nasirlink.com',
      name: 'Maya Lin',
      role: 'user',
      status: 'active',
      emailVerified: true,
      passwordHash: creatorHash,
      verificationToken: null,
      resetToken: null,
      resetExpiresAt: null,
      createdAt: new Date(now - 7 * 86400_000).toISOString(),
      updatedAt: created,
    },
  ];

  const links: MemoryLink[] = [
    {
      id: 'lnk_demo_launch',
      userId: 'usr_creator_demo',
      slug: 'product-tour',
      linkType: 'video',
      previewEnabled: true,
      autoRedirectSeconds: 0,
      destinationUrl: 'https://cloudflare.com/developer-platform/workers/',
      videoUrl: '/api/sample-video/showcase.mp4',
      videoTitle: 'NasirLink Edge Analytics — 2026 Product Walkthrough',
      videoDescription:
        'Interactive walkthrough of real-time link telemetry, custom slug routing, and social preview cards built for modern product teams.',
      thumbnailUrl: null,
      videoMimeType: 'video/mp4',
      videoWidth: 720,
      videoHeight: 1278,
      twitterCardType: 'player',
      playerUrl: null,
      redirectType: 302,
      hasPassword: false,
      passwordHash: null,
      expiresAt: null,
      isActive: true,
      utmSource: 'nasirlink',
      utmMedium: 'video_preview',
      utmCampaign: 'q4_launch',
      campaignName: 'Q4 Product Launch',
      tags: ['product', 'walkthrough', 'analytics'],
      clicksCount: 184,
      createdAt: created,
      updatedAt: created,
    },
    {
      id: 'lnk_demo_edge',
      userId: 'usr_admin_nasir',
      slug: 'edge-routing',
      linkType: 'video',
      previewEnabled: true,
      autoRedirectSeconds: 0,
      destinationUrl: 'https://developers.cloudflare.com/d1/',
      videoUrl: '/api/sample-video/showcase1.mp4',
      videoTitle: 'Global Edge Routing & D1 Persistence Architecture',
      videoDescription:
        'How distributed redirect workers resolve custom slugs with sub-15ms overhead and privacy-preserving visitor hashing.',
      thumbnailUrl: null,
      videoMimeType: 'video/mp4',
      videoWidth: 1290,
      videoHeight: 720,
      twitterCardType: 'player',
      playerUrl: null,
      redirectType: 302,
      hasPassword: false,
      passwordHash: null,
      expiresAt: null,
      isActive: true,
      utmSource: 'nasirlink',
      utmMedium: 'video_card',
      utmCampaign: 'architecture',
      campaignName: 'Developer Docs',
      tags: ['architecture', 'edge', 'd1'],
      clicksCount: 129,
      createdAt: created,
      updatedAt: created,
    },
    {
      id: 'lnk_demo_docs',
      userId: 'usr_creator_demo',
      slug: 'cf-docs',
      linkType: 'normal',
      previewEnabled: false,
      autoRedirectSeconds: 0,
      destinationUrl: 'https://developers.cloudflare.com/workers/',
      videoUrl: null,
      videoTitle: null,
      videoDescription: null,
      thumbnailUrl: null,
      videoMimeType: null,
      videoWidth: 0,
      videoHeight: 0,
      twitterCardType: 'player',
      playerUrl: null,
      redirectType: 302,
      hasPassword: false,
      passwordHash: null,
      expiresAt: null,
      isActive: true,
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'dev_digest',
      campaignName: 'Weekly Dev Digest',
      tags: ['docs', 'workers'],
      clicksCount: 96,
      createdAt: created,
      updatedAt: created,
    },
    {
      id: 'lnk_demo_design',
      userId: 'usr_admin_nasir',
      slug: 'web-standards',
      linkType: 'normal',
      previewEnabled: false,
      autoRedirectSeconds: 0,
      destinationUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API',
      videoUrl: null,
      videoTitle: null,
      videoDescription: null,
      thumbnailUrl: null,
      videoMimeType: null,
      videoWidth: 0,
      videoHeight: 0,
      twitterCardType: 'player',
      playerUrl: null,
      redirectType: 301,
      hasPassword: false,
      passwordHash: null,
      expiresAt: null,
      isActive: true,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      campaignName: 'Security Reference',
      tags: ['security', 'webcrypto'],
      clicksCount: 64,
      createdAt: created,
      updatedAt: created,
    },
  ];

  const countries = ['United States', 'United Kingdom', 'Germany', 'Canada', 'Singapore', 'Japan', 'France'];
  const devices = ['Desktop', 'Desktop', 'Desktop', 'Mobile', 'Mobile', 'Tablet'];
  const browsers = ['Chrome', 'Chrome', 'Safari', 'Firefox', 'Edge'];
  const oss = ['macOS', 'Windows', 'iOS', 'Android', 'Linux'];
  const referrers = ['Direct', 'x.com', 'github.com', 'linkedin.com', 'news.ycombinator.com', 'google.com'];

  const clicks: MemoryClick[] = [];
  let seq = 0;
  for (const item of links) {
    for (let i = 0; i < item.clicksCount; i++) {
      seq++;
      const daysAgo = i % 14;
      const hoursAgo = (i * 7) % 24;
      const ts = new Date(now - daysAgo * 86400_000 - hoursAgo * 3600_000).toISOString();
      clicks.push({
        id: `clk_seed_${seq}`,
        linkId: item.id,
        clickedAt: ts,
        country: countries[(i + seq) % countries.length],
        deviceType: devices[(i + seq) % devices.length],
        browser: browsers[(i + seq) % browsers.length],
        operatingSystem: oss[(i + seq) % oss.length],
        referrer: referrers[(i + seq) % referrers.length],
        anonymousVisitorId: `anon_seed_${(i % Math.max(18, Math.floor(item.clicksCount * 0.68))).toString().padStart(3, '0')}`,
      });
    }
  }

  return { users, links, clicks };
}

let d1Bootstrapped = false;

async function ensureBootstrapped(env: WorkerEnv): Promise<void> {
  if (!env.DB) {
    if (memStore.initialized) return;
    if (env.APP_DOMAIN) memStore.settings.domain = env.APP_DOMAIN;
    if (env.DEFAULT_REDIRECT_STATUS === '301') memStore.settings.defaultRedirectType = 301;
    const [adminHash, creatorHash] = await Promise.all([
      hashPassword('Admin123!'),
      hashPassword('Creator123!'),
    ]);
    const seeded = buildSeedFixtures(adminHash, creatorHash);
    memStore.users = seeded.users;
    memStore.links = seeded.links;
    memStore.clicks = seeded.clicks;
    memStore.initialized = true;
    return;
  }

  if (d1Bootstrapped) return;
  await env.DB.batch(SCHEMA_STATEMENTS.map((sql) => env.DB!.prepare(sql)));

  // Auto-migrate columns on pre-existing D1 databases so schema updates never break production
  try {
    const tableInfo = await env.DB.prepare('PRAGMA table_info(links)').all<{ name: string }>();
    const colNames = new Set(tableInfo.results.map((c) => c.name));
    const missingColumns: Array<[string, string]> = [
      ['video_width', 'INTEGER DEFAULT 1280'],
      ['video_height', 'INTEGER DEFAULT 720'],
      ['twitter_card_type', "TEXT NOT NULL DEFAULT 'player'"],
      ['player_url', 'TEXT'],
      ['preview_enabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['auto_redirect_seconds', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    let addedPreviewCol = false;
    for (const [col, def] of missingColumns) {
      if (!colNames.has(col)) {
        await env.DB.prepare(`ALTER TABLE links ADD COLUMN ${col} ${def}`).run();
        if (col === 'preview_enabled') addedPreviewCol = true;
      }
    }
    if (addedPreviewCol) {
      await env.DB.prepare("UPDATE links SET preview_enabled = 1 WHERE link_type = 'video' AND preview_enabled = 0").run();
    }
  } catch {
    // Ignore if columns already exist
  }

  const settingsCnt = await env.DB.prepare('SELECT COUNT(*) as cnt FROM settings').first<{ cnt: number }>();
  if (!settingsCnt || Number(settingsCnt.cnt) === 0) {
    const now = new Date().toISOString();
    const defaults: Array<[string, string]> = [
      ['site_name', 'NasirLink'],
      ['domain', env.APP_DOMAIN || 'nasirlink.com'],
      ['default_redirect_type', env.DEFAULT_REDIRECT_STATUS === '301' ? '301' : '302'],
      ['registration_enabled', 'true'],
      ['max_links_per_user', '500'],
      ['rate_limit_per_min', '120'],
      ['maintenance_mode', 'false'],
    ];
    await env.DB.batch(
      defaults.map(([k, v]) =>
        env.DB!.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(k, v, now)
      )
    );
  }

  const usersCnt = await env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
  if (!usersCnt || Number(usersCnt.cnt) === 0) {
    const [adminHash, creatorHash] = await Promise.all([
      hashPassword('Admin123!'),
      hashPassword('Creator123!'),
    ]);
    const seeded = buildSeedFixtures(adminHash, creatorHash);
    const stmts: D1PreparedStatement[] = [];
    for (const u of seeded.users) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO users (id, email, name, password_hash, role, status, email_verified, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(u.id, u.email, u.name, u.passwordHash, u.role, u.status, u.emailVerified ? 1 : 0, u.createdAt, u.updatedAt)
      );
    }
    for (const l of seeded.links) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO links (
            id, user_id, slug, link_type, preview_enabled, auto_redirect_seconds, destination_url,
            video_url, video_title, video_description, thumbnail_url, video_mime_type, video_width, video_height,
            twitter_card_type, player_url, redirect_type, is_active, utm_source, utm_medium,
            utm_campaign, campaign_name, tags, clicks_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          l.id,
          l.userId,
          l.slug,
          l.linkType,
          l.previewEnabled ? 1 : 0,
          l.autoRedirectSeconds || 0,
          l.destinationUrl,
          l.videoUrl,
          l.videoTitle,
          l.videoDescription,
          l.thumbnailUrl,
          l.videoMimeType,
          l.videoWidth,
          l.videoHeight,
          l.twitterCardType,
          l.playerUrl,
          l.redirectType,
          l.isActive ? 1 : 0,
          l.utmSource,
          l.utmMedium,
          l.utmCampaign,
          l.campaignName,
          JSON.stringify(l.tags),
          l.clicksCount,
          l.createdAt,
          l.updatedAt
        )
      );
    }
    for (const c of seeded.clicks) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO clicks (
            id, link_id, clicked_at, country, device_type, browser, operating_system, referrer, anonymous_visitor_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          c.id,
          c.linkId,
          c.clickedAt,
          c.country,
          c.deviceType,
          c.browser,
          c.operatingSystem,
          c.referrer,
          c.anonymousVisitorId
        )
      );
    }
    // Batch in chunks of 80 statements for D1 limits
    for (let i = 0; i < stmts.length; i += 80) {
      await env.DB.batch(stmts.slice(i, i + 80));
    }
  }
  d1Bootstrapped = true;
}

// ================= ROW MAPPERS & HELPERS =================
function mapUserRow(row: Record<string, unknown>): PublicUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: row.role as UserRole,
    status: row.status as UserStatus,
    emailVerified: Number(row.email_verified) === 1,
    createdAt: String(row.created_at),
  };
}

function mapLinkRow(row: Record<string, unknown>): LinkRecord {
  let parsedTags: string[] = [];
  if (typeof row.tags === 'string' && row.tags.trim()) {
    try {
      const json = JSON.parse(row.tags);
      if (Array.isArray(json)) parsedTags = json.map(String);
    } catch {
      parsedTags = [];
    }
  }
  const linkType = (row.link_type as 'normal' | 'video') || 'normal';
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    slug: String(row.slug),
    shortCode: String(row.slug),
    linkType,
    previewEnabled: row.preview_enabled !== undefined ? Number(row.preview_enabled) === 1 : linkType === 'video',
    autoRedirectSeconds: Math.max(0, Math.min(120, Number(row.auto_redirect_seconds || 0))),
    destinationUrl: String(row.destination_url),
    videoUrl: row.video_url ? String(row.video_url) : null,
    videoTitle: row.video_title ? String(row.video_title) : null,
    videoDescription: row.video_description ? String(row.video_description) : null,
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    videoMimeType: row.video_mime_type ? String(row.video_mime_type) : null,
    videoWidth: Number(row.video_width || 0),
    videoHeight: Number(row.video_height || 0),
    twitterCardType: row.twitter_card_type === 'summary_large_image' ? 'summary_large_image' : 'player',
    playerUrl: row.player_url ? String(row.player_url) : null,
    redirectType: (Number(row.redirect_type) === 301 ? 301 : 302) as RedirectStatusCode,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    isActive: Number(row.is_active) === 1,
    utmSource: row.utm_source ? String(row.utm_source) : null,
    utmMedium: row.utm_medium ? String(row.utm_medium) : null,
    utmCampaign: row.utm_campaign ? String(row.utm_campaign) : null,
    campaignName: row.campaign_name ? String(row.campaign_name) : null,
    tags: parsedTags,
    clicksCount: Number(row.clicks_count || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPublicLink(link: MemoryLink): LinkRecord {
  const { passwordHash: _pw, ...rest } = link;
  return rest;
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...extraHeaders,
    },
  });
}

function htmlResponse(html: string, status = 200, isEmbed = false): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (isEmbed) {
    headers['Content-Security-Policy'] = 'frame-ancestors *';
  } else {
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }
  return new Response(html, { status, headers });
}

function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = (request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host).trim();
  return `${proto}://${host}`;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1'
  );
}

function getCountryFromRequest(request: Request): string {
  const cfCountry = request.headers.get('cf-ipcountry');
  if (cfCountry && cfCountry.trim() && cfCountry !== 'XX') {
    return cfCountry.trim().toUpperCase();
  }
  const acceptLang = request.headers.get('accept-language');
  if (acceptLang) {
    const match = acceptLang.match(/[a-z]{2}-([A-Z]{2})/);
    if (match) return match[1];
  }
  return 'Global';
}

function parseCookies(request: Request): Record<string, string> {
  const raw = request.headers.get('cookie');
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function sessionCookieHeader(token: string, maxAgeSec = 7 * 86400): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSec}`;
}

function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ================= UNIFIED DATA OPERATIONS (D1 OR MEMORY) =================
async function getSystemSettings(env: WorkerEnv): Promise<SystemSettings> {
  if (!env.DB) return { ...memStore.settings };
  const rows = (await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()).results;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const gW = Number(map.get('global_video_width') || 0);
  const gH = Number(map.get('global_video_height') || 0);
  return {
    siteName: map.get('site_name') || 'NasirLink',
    domain: map.get('domain') || env.APP_DOMAIN || 'nasirlink.com',
    defaultRedirectType: map.get('default_redirect_type') === '301' ? 301 : 302,
    registrationEnabled: map.get('registration_enabled') !== 'false',
    maxLinksPerUser: Number(map.get('max_links_per_user') || 500),
    rateLimitPerMin: Number(map.get('rate_limit_per_min') || 120),
    maintenanceMode: map.get('maintenance_mode') === 'true',
    globalVideoUrl: map.get('global_video_url') || null,
    globalVideoWidth: gW > 0 ? gW : null,
    globalVideoHeight: gH > 0 ? gH : null,
    globalVideoMimeType: map.get('global_video_mime_type') || null,
    globalVideoTitle: map.get('global_video_title') || null,
    globalVideoDescription: map.get('global_video_description') || null,
    globalVideoSourceUrl: map.get('global_video_source_url') || null,
    globalVideoOverride: map.get('global_video_override') === 'true',
  };
}

async function updateSystemSettings(env: WorkerEnv, partial: Partial<SystemSettings>): Promise<SystemSettings> {
  if (!env.DB) {
    memStore.settings = {
      ...memStore.settings,
      ...(partial.siteName !== undefined ? { siteName: partial.siteName } : {}),
      ...(partial.domain !== undefined ? { domain: partial.domain } : {}),
      ...(partial.defaultRedirectType !== undefined ? { defaultRedirectType: partial.defaultRedirectType } : {}),
      ...(partial.registrationEnabled !== undefined ? { registrationEnabled: partial.registrationEnabled } : {}),
      ...(partial.maxLinksPerUser !== undefined ? { maxLinksPerUser: partial.maxLinksPerUser } : {}),
      ...(partial.rateLimitPerMin !== undefined ? { rateLimitPerMin: partial.rateLimitPerMin } : {}),
      ...(partial.maintenanceMode !== undefined ? { maintenanceMode: partial.maintenanceMode } : {}),
      ...(partial.globalVideoUrl !== undefined ? { globalVideoUrl: partial.globalVideoUrl } : {}),
      ...(partial.globalVideoWidth !== undefined ? { globalVideoWidth: partial.globalVideoWidth } : {}),
      ...(partial.globalVideoHeight !== undefined ? { globalVideoHeight: partial.globalVideoHeight } : {}),
      ...(partial.globalVideoMimeType !== undefined ? { globalVideoMimeType: partial.globalVideoMimeType } : {}),
      ...(partial.globalVideoTitle !== undefined ? { globalVideoTitle: partial.globalVideoTitle } : {}),
      ...(partial.globalVideoDescription !== undefined
        ? { globalVideoDescription: partial.globalVideoDescription }
        : {}),
      ...(partial.globalVideoSourceUrl !== undefined ? { globalVideoSourceUrl: partial.globalVideoSourceUrl } : {}),
      ...(partial.globalVideoOverride !== undefined ? { globalVideoOverride: partial.globalVideoOverride } : {}),
    };
    return { ...memStore.settings };
  }

  const now = new Date().toISOString();
  const pairs: Array<[string, string]> = [];
  const deletes: string[] = [];

  const setOrDelete = (key: string, val: string | null | undefined) => {
    if (val === undefined) return;
    if (val === null || val === '') deletes.push(key);
    else pairs.push([key, val]);
  };

  if (partial.siteName !== undefined) pairs.push(['site_name', partial.siteName]);
  if (partial.domain !== undefined) pairs.push(['domain', partial.domain]);
  if (partial.defaultRedirectType !== undefined)
    pairs.push(['default_redirect_type', String(partial.defaultRedirectType)]);
  if (partial.registrationEnabled !== undefined)
    pairs.push(['registration_enabled', String(partial.registrationEnabled)]);
  if (partial.maxLinksPerUser !== undefined) pairs.push(['max_links_per_user', String(partial.maxLinksPerUser)]);
  if (partial.rateLimitPerMin !== undefined) pairs.push(['rate_limit_per_min', String(partial.rateLimitPerMin)]);
  if (partial.maintenanceMode !== undefined) pairs.push(['maintenance_mode', String(partial.maintenanceMode)]);
  setOrDelete('global_video_url', partial.globalVideoUrl);
  if (partial.globalVideoWidth !== undefined) {
    setOrDelete('global_video_width', partial.globalVideoWidth ? String(partial.globalVideoWidth) : null);
  }
  if (partial.globalVideoHeight !== undefined) {
    setOrDelete('global_video_height', partial.globalVideoHeight ? String(partial.globalVideoHeight) : null);
  }
  setOrDelete('global_video_mime_type', partial.globalVideoMimeType);
  setOrDelete('global_video_title', partial.globalVideoTitle);
  setOrDelete('global_video_description', partial.globalVideoDescription);
  setOrDelete('global_video_source_url', partial.globalVideoSourceUrl);
  if (partial.globalVideoOverride !== undefined) {
    pairs.push(['global_video_override', String(partial.globalVideoOverride)]);
  }

  const stmts: D1PreparedStatement[] = [
    ...pairs.map(([k, v]) =>
      env.DB!.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(k, v, now)
    ),
    ...deletes.map((k) => env.DB!.prepare('DELETE FROM settings WHERE key = ?').bind(k)),
  ];

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }
  return getSystemSettings(env);
}

async function resolveAuthUser(env: WorkerEnv, request: Request): Promise<PublicUser | null> {
  const rawToken = parseCookies(request)[SESSION_COOKIE_NAME];
  if (!rawToken) return null;
  const tokenHash = await sha256Hex(rawToken);

  if (!env.DB) {
    const sess = memStore.sessions.find((s) => s.tokenHash === tokenHash);
    if (!sess) return null;
    if (new Date(sess.expiresAt).getTime() < Date.now()) {
      memStore.sessions = memStore.sessions.filter((s) => s.tokenHash !== tokenHash);
      return null;
    }
    const u = memStore.users.find((usr) => usr.id === sess.userId);
    if (!u || u.status === 'suspended') return null;
    const { passwordHash: _pw, verificationToken: _vt, resetToken: _rt, resetExpiresAt: _re, updatedAt: _ua, ...pub } = u;
    return pub;
  }

  const row = await env.DB.prepare(
    `SELECT u.*, s.expires_at as session_expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first<Record<string, unknown>>();

  if (!row) return null;
  if (new Date(String(row.session_expires_at)).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (row.status === 'suspended') return null;
  return mapUserRow(row);
}

async function getLinkBySlug(env: WorkerEnv, slug: string): Promise<{ link: LinkRecord; passwordHash: string | null } | null> {
  if (!env.DB) {
    const found = memStore.links.find((l) => l.slug.toLowerCase() === slug.toLowerCase());
    if (!found) return null;
    return { link: toPublicLink(found), passwordHash: found.passwordHash };
  }
  const row = await env.DB.prepare('SELECT * FROM links WHERE slug = ?').bind(slug).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    link: mapLinkRow(row),
    passwordHash: row.password_hash ? String(row.password_hash) : null,
  };
}

async function getLinkById(env: WorkerEnv, idOrSlug: string): Promise<{ link: LinkRecord; passwordHash: string | null } | null> {
  if (!env.DB) {
    const found = memStore.links.find((l) => l.id === idOrSlug || l.slug.toLowerCase() === idOrSlug.toLowerCase());
    if (!found) return null;
    return { link: toPublicLink(found), passwordHash: found.passwordHash };
  }
  const row = await env.DB.prepare('SELECT * FROM links WHERE id = ? OR slug = ?')
    .bind(idOrSlug, idOrSlug)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    link: mapLinkRow(row),
    passwordHash: row.password_hash ? String(row.password_hash) : null,
  };
}

async function recordClick(
  env: WorkerEnv,
  linkId: string,
  request: Request
): Promise<void> {
  const ua = parseUserAgent(request.headers.get('user-agent') || '');
  const anonId = await createAnonymousVisitorId(getClientIp(request), request.headers.get('user-agent') || '');
  const click: MemoryClick = {
    id: randomId('clk'),
    linkId,
    clickedAt: new Date().toISOString(),
    country: getCountryFromRequest(request),
    deviceType: ua.deviceType,
    browser: ua.browser,
    operatingSystem: ua.operatingSystem,
    referrer: request.headers.get('referer') || 'Direct',
    anonymousVisitorId: anonId,
  };

  if (!env.DB) {
    memStore.clicks.push(click);
    const l = memStore.links.find((item) => item.id === linkId);
    if (l) {
      l.clicksCount++;
      l.updatedAt = click.clickedAt;
    }
    return;
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO clicks (
        id, link_id, clicked_at, country, device_type, browser, operating_system, referrer, anonymous_visitor_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      click.id,
      click.linkId,
      click.clickedAt,
      click.country,
      click.deviceType,
      click.browser,
      click.operatingSystem,
      click.referrer,
      click.anonymousVisitorId
    ),
    env.DB.prepare('UPDATE links SET clicks_count = clicks_count + 1, updated_at = ? WHERE id = ?').bind(
      click.clickedAt,
      linkId
    ),
  ]);
}

function buildBreakdownFromCounts(map: Map<string, number>, limit?: number): BreakdownItem[] {
  const entries = Array.from(map.entries())
    .map(([name, count]) => ({ name: name || 'Unknown', count }))
    .sort((a, b) => b.count - a.count);
  const sliced = limit ? entries.slice(0, limit) : entries;
  const total = entries.reduce((sum, item) => sum + item.count, 0) || 1;
  return sliced.map((item) => ({
    name: item.name,
    count: item.count,
    percentage: Math.round((item.count / total) * 1000) / 10,
  }));
}

async function computeAnalytics(env: WorkerEnv, userId: string | null, linkId: string | null): Promise<AnalyticsOverview> {
  let links: LinkRecord[] = [];
  let clicks: MemoryClick[] = [];

  if (!env.DB) {
    links = memStore.links
      .filter((l) => (linkId ? l.id === linkId : userId ? l.userId === userId || l.userId === null : true))
      .map(toPublicLink);
    const idSet = new Set(links.map((l) => l.id));
    clicks = memStore.clicks.filter((c) => idSet.has(c.linkId));
  } else {
    let linkRows: Record<string, unknown>[] = [];
    if (linkId) {
      linkRows = (await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(linkId).all()).results;
    } else if (userId) {
      linkRows = (await env.DB.prepare('SELECT * FROM links WHERE user_id = ? OR user_id IS NULL').bind(userId).all()).results;
    } else {
      linkRows = (await env.DB.prepare('SELECT * FROM links').all()).results;
    }
    links = linkRows.map(mapLinkRow);
    const ids = links.map((l) => l.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const clickRows = (
        await env.DB.prepare(`SELECT * FROM clicks WHERE link_id IN (${placeholders})`).bind(...ids).all()
      ).results;
      clicks = clickRows.map((r) => ({
        id: String(r.id),
        linkId: String(r.link_id),
        clickedAt: String(r.clicked_at),
        country: String(r.country),
        deviceType: String(r.device_type),
        browser: String(r.browser),
        operatingSystem: String(r.operating_system),
        referrer: String(r.referrer),
        anonymousVisitorId: String(r.anonymous_visitor_id),
      }));
    }
  }

  const todayPrefix = new Date().toISOString().slice(0, 10);
  const uniqueSet = new Set(clicks.map((c) => c.anonymousVisitorId));
  const todaysClicks = clicks.filter((c) => c.clickedAt.slice(0, 10) === todayPrefix).length;

  const dailyBuckets = new Map<string, { cnt: number; visitors: Set<string> }>();
  const hourlyBuckets = new Map<string, { cnt: number; visitors: Set<string> }>();
  const devMap = new Map<string, number>();
  const brMap = new Map<string, number>();
  const osMap = new Map<string, number>();
  const refMap = new Map<string, number>();
  const countryMap = new Map<string, number>();

  for (const c of clicks) {
    const day = c.clickedAt.slice(0, 10);
    const dbkt = dailyBuckets.get(day) || { cnt: 0, visitors: new Set<string>() };
    dbkt.cnt++;
    dbkt.visitors.add(c.anonymousVisitorId);
    dailyBuckets.set(day, dbkt);

    const hr = c.clickedAt.slice(11, 13);
    const hbkt = hourlyBuckets.get(hr) || { cnt: 0, visitors: new Set<string>() };
    hbkt.cnt++;
    hbkt.visitors.add(c.anonymousVisitorId);
    hourlyBuckets.set(hr, hbkt);

    devMap.set(c.deviceType, (devMap.get(c.deviceType) || 0) + 1);
    brMap.set(c.browser, (brMap.get(c.browser) || 0) + 1);
    osMap.set(c.operatingSystem, (osMap.get(c.operatingSystem) || 0) + 1);
    refMap.set(c.referrer, (refMap.get(c.referrer) || 0) + 1);
    countryMap.set(c.country, (countryMap.get(c.country) || 0) + 1);
  }

  const clicksOverTime: AnalyticsOverview['clicksOverTime'] = [];
  for (let d = 13; d >= 0; d--) {
    const dt = new Date(Date.now() - d * 86400_000);
    const key = dt.toISOString().slice(0, 10);
    const hit = dailyBuckets.get(key);
    clicksOverTime.push({
      label: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      clicks: hit ? hit.cnt : 0,
      uniqueVisitors: hit ? hit.visitors.size : 0,
    });
  }

  const hourlyClicks: AnalyticsOverview['hourlyClicks'] = [];
  for (let h = 0; h < 24; h++) {
    const key = String(h).padStart(2, '0');
    const hit = hourlyBuckets.get(key);
    hourlyClicks.push({
      label: `${key}:00`,
      clicks: hit ? hit.cnt : 0,
      uniqueVisitors: hit ? hit.visitors.size : 0,
    });
  }

  const topLinks = [...links]
    .sort((a, b) => b.clicksCount - a.clicksCount)
    .slice(0, 6)
    .map((l) => ({
      id: l.id,
      slug: l.slug,
      linkType: l.linkType,
      destinationUrl: l.destinationUrl,
      clicks: l.clicksCount,
    }));

  return {
    totals: {
      totalLinks: links.length,
      totalClicks: clicks.length,
      activeLinks: links.filter((l) => l.isActive).length,
      videoLinks: links.filter((l) => l.linkType === 'video').length,
      todaysClicks,
      uniqueVisitors: uniqueSet.size,
    },
    clicksOverTime,
    hourlyClicks,
    topLinks,
    devices: buildBreakdownFromCounts(devMap),
    browsers: buildBreakdownFromCounts(brMap),
    operatingSystems: buildBreakdownFromCounts(osMap),
    referrers: buildBreakdownFromCounts(refMap, 8),
    countries: buildBreakdownFromCounts(countryMap, 8),
  };
}

// ================= SPA HTML RENDERER WITH SSR METADATA =================
async function renderSpaWithMeta(
  request: Request,
  env: WorkerEnv,
  link: LinkRecord,
  canonicalPath?: string
): Promise<Response> {
  const origin = getRequestOrigin(request);
  const settings = await getSystemSettings(env);
  const meta = buildSocialMetadata(link, origin, canonicalPath, settings);
  const isExpired = link.expiresAt ? new Date(link.expiresAt).getTime() < Date.now() : false;
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

  if (env.ASSETS) {
    let assetRes = await env.ASSETS.fetch(
      new Request(new URL('/index.html', request.url), { method: 'GET' })
    );
    if (!assetRes.ok) {
      assetRes = await env.ASSETS.fetch(
        new Request(new URL('/', request.url), { method: 'GET' })
      );
    }
    if (assetRes.ok) {
      const baseHtml = await assetRes.text();
      if (/<head[\s>]/i.test(baseHtml)) {
        return htmlResponse(injectVideoMetaIntoHtml(baseHtml, meta, bootstrapPayload, ssrBody), 200, false);
      }
    }
  }

  return htmlResponse(
    injectVideoMetaIntoHtml(renderSocialCrawlerHtml(link, origin, canonicalPath, settings), meta, bootstrapPayload, ssrBody),
    200,
    false
  );
}

// ================= MAIN WORKER FETCH HANDLER =================
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    await ensureBootstrapped(env);
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const origin = getRequestOrigin(request);

    // 1. SEO: robots.txt & sitemap.xml
    if (method === 'GET' && pathname === '/robots.txt') {
      return new Response(
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
        ].join('\n'),
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    if (method === 'GET' && pathname === '/sitemap.xml') {
      let videoRows: Array<{ slug: string; updated_at: string }> = [];
      if (!env.DB) {
        videoRows = memStore.links
          .filter((l) => l.linkType === 'video' && l.isActive)
          .slice(0, 200)
          .map((l) => ({ slug: l.slug, updated_at: l.updatedAt }));
      } else {
        videoRows = (
          await env.DB.prepare(
            "SELECT slug, updated_at FROM links WHERE link_type = 'video' AND is_active = 1 ORDER BY updated_at DESC LIMIT 200"
          ).all<{ slug: string; updated_at: string }>()
        ).results;
      }
      const urls = [
        `<url><loc>${escapeHtml(origin)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
        ...videoRows.map(
          (v) =>
            `<url><loc>${escapeHtml(origin)}/v/${escapeHtml(encodeURIComponent(v.slug))}</loc><lastmod>${escapeHtml(v.updated_at.slice(0, 10))}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`
        ),
      ];
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`,
        { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }
      );
    }

    // 2. API Routes
    if (pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, url, pathname, method, origin);
    }

    // 3. First-party Video Poster Image URL (/poster/:slug, /poster/:slug.jpg)
    if ((method === 'GET' || method === 'HEAD') && pathname.startsWith('/poster/')) {
      const rawSlug = decodeURIComponent(pathname.slice('/poster/'.length)).split('/')[0] || '';
      const slug = rawSlug.replace(/\.(jpg|jpeg|png|webp)$/i, '');
      const found = await getLinkBySlug(env, slug);
      if (!found) return new Response('Poster not found', { status: 404 });
      const thumb = (found.link.thumbnailUrl || '').trim();
      if (!found.link.isActive || !thumb) return new Response('Poster unavailable', { status: 404 });

      const dataMatch = thumb.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
      if (dataMatch) {
        const mime = dataMatch[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : dataMatch[1].toLowerCase();
        const binary = atob(dataMatch[2]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Response(method === 'HEAD' ? null : bytes, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(bytes.length),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      if (thumb.startsWith('/') && env.ASSETS) {
        return env.ASSETS.fetch(new Request(new URL(thumb, request.url), { method }));
      }
      const safeThumb = validateSafeExternalUrl(thumb, false, false);
      if (!safeThumb.valid || !safeThumb.normalizedUrl) {
        return new Response('Invalid poster URL', { status: 400 });
      }
      return Response.redirect(safeThumb.normalizedUrl, 302);
    }

    // 4. First-party Video Access URL (/media/:slug, /media/:slug.mp4, /media/:slug.webm)
    if ((method === 'GET' || method === 'HEAD' || method === 'OPTIONS') && pathname.startsWith('/media/')) {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      };
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const rawSlug = decodeURIComponent(pathname.slice('/media/'.length)).split('/')[0] || '';
      const slug = rawSlug.replace(/\.(mp4|webm)$/i, '');
      const found = await getLinkBySlug(env, slug);
      if (!found) {
        return new Response('Media not found', { status: 404, headers: corsHeaders });
      }
      const { link } = found;
      const settings = await getSystemSettings(env);
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
        return new Response('Media unavailable', { status: 410, headers: corsHeaders });
      }
      const contentType =
        effectiveMime || (rawVideoUrl.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4');

      if (rawVideoUrl.startsWith('/api/sample-video/') && env.ASSETS) {
        const filename = rawVideoUrl.slice('/api/sample-video/'.length);
        const sampleUrl = new URL(`/samples/${filename}`, request.url);
        const assetRes = await env.ASSETS.fetch(
          new Request(sampleUrl, {
            method,
            headers: request.headers,
          })
        );
        const headers = new Headers(assetRes.headers);
        headers.set('Content-Type', contentType);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Range');
        headers.set('Cache-Control', 'public, max-age=3600');
        return new Response(method === 'HEAD' ? null : assetRes.body, {
          status: assetRes.status,
          headers,
        });
      }

      try {
        const forwardHeaders = new Headers();
        const rangeHeader = request.headers.get('range');
        if (rangeHeader) forwardHeaders.set('Range', rangeHeader);

        let upstream = await fetchWithSafeRedirects(rawVideoUrl, {
          method,
          headers: forwardHeaders,
        });

        if (method === 'HEAD' && (upstream.status === 405 || upstream.status === 501)) {
          await upstream.body?.cancel();
          upstream = await fetchWithSafeRedirects(rawVideoUrl, {
            method: 'GET',
            headers: forwardHeaders,
          });
        }

        const headers = new Headers(upstream.headers);
        headers.set('Content-Type', contentType);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Range');
        headers.set('Cache-Control', 'public, max-age=3600');
        if (method === 'HEAD') {
          await upstream.body?.cancel();
        }
        return new Response(method === 'HEAD' ? null : upstream.body, {
          status: upstream.status,
          headers,
        });
      } catch {
        return new Response('Failed to fetch upstream video stream', { status: 502, headers: corsHeaders });
      }
    }

    // 5. Dedicated HTML5 player page (/player/:slug and /embed/:slug)
    if ((method === 'GET' || method === 'HEAD') && (pathname.startsWith('/player/') || pathname.startsWith('/embed/'))) {
      const prefix = pathname.startsWith('/player/') ? '/player/' : '/embed/';
      const slug = decodeURIComponent(pathname.slice(prefix.length)).split('/')[0] || '';
      const found = await getLinkBySlug(env, slug);
      if (!found) {
        return htmlResponse(method === 'HEAD' ? '' : '<h1>Video player not found</h1>', 404, true);
      }
      const isExpired = found.link.expiresAt ? new Date(found.link.expiresAt).getTime() < Date.now() : false;
      if (!found.link.isActive || isExpired) {
        return htmlResponse(method === 'HEAD' ? '' : '<h1>This video link is unavailable</h1>', 410, true);
      }
      const settings = await getSystemSettings(env);
      const res = htmlResponse(renderPlayerPageHtml(found.link, origin, settings), 200, true);
      return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
    }

    // 6. Public Video Preview Pages (/v/:slug & /video/:slug)
    if ((method === 'GET' || method === 'HEAD') && (pathname.startsWith('/v/') || pathname.startsWith('/video/'))) {
      const prefix = pathname.startsWith('/v/') ? '/v/' : '/video/';
      const slug = decodeURIComponent(pathname.slice(prefix.length)).split('/')[0] || '';
      const found = await getLinkBySlug(env, slug);
      if (found) {
        const res = await renderSpaWithMeta(request, env, found.link, pathname);
        return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
      }
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    // 6.5 Social Share URL (/s/:slug) & Direct Redirect URL (/r/:slug)
    if ((method === 'GET' || method === 'HEAD') && (pathname.startsWith('/s/') || pathname.startsWith('/r/'))) {
      const isSocial = pathname.startsWith('/s/');
      const prefix = isSocial ? '/s/' : '/r/';
      const slug = decodeURIComponent(pathname.slice(prefix.length)).split('/')[0] || '';
      const found = await getLinkBySlug(env, slug);
      if (!found) {
        return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
      }
      const { link } = found;
      if (isSocial) {
        const res = await renderSpaWithMeta(request, env, link, pathname);
        return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
      } else {
        if (!link.isActive) {
          return Response.redirect(`${origin}/status/disabled?slug=${encodeURIComponent(link.slug)}`, 302);
        }
        if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
          return Response.redirect(`${origin}/status/expired?slug=${encodeURIComponent(link.slug)}`, 302);
        }
        if (link.hasPassword) {
          return Response.redirect(`${origin}/unlock/${encodeURIComponent(link.slug)}`, 302);
        }
        const destination = appendUtmParams(link.destinationUrl, {
          source: link.utmSource,
          medium: link.utmMedium,
          campaign: link.utmCampaign,
        });
        if (method === 'GET') {
          await recordClick(env, link.id, request);
        }
        return Response.redirect(destination, link.redirectType);
      }
    }

    // 7. Short Slug Router (GET/HEAD /:slug)
    const cleanPath = pathname.replace(/^\/+|\/+$/g, '');
    if (
      (method === 'GET' || method === 'HEAD') &&
      cleanPath &&
      !cleanPath.includes('/') &&
      !cleanPath.startsWith('@') &&
      !cleanPath.includes('.') &&
      !FRONTEND_ROUTES.has(cleanPath.toLowerCase())
    ) {
      const slug = decodeURIComponent(cleanPath);
      const found = await getLinkBySlug(env, slug);
      if (found) {
        const { link } = found;
        if (!link.isActive) {
          return Response.redirect(`${origin}/status/disabled?slug=${encodeURIComponent(link.slug)}`, 302);
        }
        if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
          return Response.redirect(`${origin}/status/expired?slug=${encodeURIComponent(link.slug)}`, 302);
        }
        if (link.hasPassword) {
          return Response.redirect(`${origin}/unlock/${encodeURIComponent(link.slug)}`, 302);
        }

        const destination = appendUtmParams(link.destinationUrl, {
          source: link.utmSource,
          medium: link.utmMedium,
          campaign: link.utmCampaign,
        });

        // Video Preview Link: serve social metadata to crawlers, direct redirect to normal visitors
        if (link.linkType === 'video' && link.previewEnabled) {
          const ua = request.headers.get('user-agent') || '';
          const isCrawler = SOCIAL_CRAWLER_UA_REGEX.test(ua) || url.searchParams.get('preview') === '1';
          if (!isCrawler) {
            if (method === 'GET') {
              await recordClick(env, link.id, request);
            }
            return Response.redirect(destination, link.redirectType);
          }
          if (isCrawler && url.searchParams.get('preview') !== '1') {
            const settings = await getSystemSettings(env);
            const crawlerHtml = renderSocialCrawlerHtml(link, origin, `/${encodeURIComponent(link.slug)}`, settings);
            const res = htmlResponse(crawlerHtml, 200, false);
            return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
          }
          const res = await renderSpaWithMeta(request, env, link, `/${encodeURIComponent(link.slug)}`);
          return method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
        }

        if (method === 'GET') {
          await recordClick(env, link.id, request);
        }
        return Response.redirect(destination, link.redirectType);
      }
    }

    // 8. Static Assets & SPA fallback via Cloudflare Workers ASSETS binding
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Assets binding not configured', { status: 404 });
  },
};

// ================= API ROUTER =================
async function handleApiRequest(
  request: Request,
  env: WorkerEnv,
  url: URL,
  pathname: string,
  method: string,
  origin: string
): Promise<Response> {
  // Isolate sliding-window rate limit for write/auth endpoints
  if (method !== 'GET' && (pathname.startsWith('/api/auth/') || pathname === '/api/links' || pathname === '/api/reports')) {
    const settings = await getSystemSettings(env);
    const limit = Math.max(20, settings.rateLimitPerMin);
    const bucketKey = `${getClientIp(request)}:${pathname.startsWith('/api/auth/') ? 'auth' : 'write'}`;
    const nowMs = Date.now();
    const bucket = WORKER_RATE_BUCKETS.get(bucketKey);
    if (!bucket || bucket.resetAt < nowMs) {
      WORKER_RATE_BUCKETS.set(bucketKey, { count: 1, resetAt: nowMs + 60_000 });
    } else {
      bucket.count++;
      if (bucket.count > limit) {
        return jsonResponse({ error: 'Rate limit exceeded. Please wait a minute before retrying.' }, 429);
      }
    }
  }
  // Health Check
  if (method === 'GET' && pathname === '/api/health') {
    return jsonResponse({
      status: 'ok',
      database: env.DB ? 'connected-d1' : 'isolate-memory',
      timestamp: new Date().toISOString(),
      runtime: 'cloudflare-workers',
    });
  }

  // Sample video stream proxied from bundled /samples/*.mp4 static asset
  if (method === 'GET' && pathname.startsWith('/api/sample-video/')) {
    const filename = pathname.slice('/api/sample-video/'.length);
    if (!['showcase.mp4', 'edge-network.mp4', 'showcase1.mp4'].includes(filename)) {
      return jsonResponse({ error: 'Sample video not found.' }, 404);
    }
    if (env.ASSETS) {
      const sampleUrl = new URL(`/samples/${filename}`, request.url);
      const assetReq = new Request(sampleUrl, { headers: request.headers });
      return env.ASSETS.fetch(assetReq);
    }
    return jsonResponse({ error: 'Assets binding unavailable.' }, 404);
  }

  // Public Settings
  if (method === 'GET' && pathname === '/api/settings/public') {
    const s = await getSystemSettings(env);
    return jsonResponse({
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
  }

  // ================= AUTH =================
  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = await resolveAuthUser(env, request);
    return jsonResponse({ user });
  }

  if (method === 'POST' && pathname === '/api/auth/register') {
    const settings = await getSystemSettings(env);
    if (!settings.registrationEnabled) {
      return jsonResponse({ error: 'New user registration is currently disabled by an administrator.' }, 403);
    }
    const body = await readJsonBody(request);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || 'Invalid registration data.' }, 400);
    }
    const { name, email, password } = parsed.data;
    const emailLower = email.toLowerCase();

    if (!env.DB) {
      if (memStore.users.some((u) => u.email.toLowerCase() === emailLower)) {
        return jsonResponse({ error: 'An account with this email already exists.' }, 409);
      }
    } else {
      const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailLower).first();
      if (existing) return jsonResponse({ error: 'An account with this email already exists.' }, 409);
    }

    const userId = randomId('usr');
    const passwordHash = await hashPassword(password);
    const verificationToken = generateSecureToken(16);
    const rawSessionToken = generateSecureToken(32);
    const tokenHash = await sha256Hex(rawSessionToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

    const newUser: PublicUser = {
      id: userId,
      email: emailLower,
      name,
      role: 'user',
      status: 'active',
      emailVerified: false,
      createdAt: now,
    };

    if (!env.DB) {
      memStore.users.push({
        ...newUser,
        passwordHash,
        verificationToken,
        resetToken: null,
        resetExpiresAt: null,
        updatedAt: now,
      });
      memStore.sessions.push({
        id: randomId('ses'),
        userId,
        tokenHash,
        userAgent: request.headers.get('user-agent') || '',
        expiresAt,
        createdAt: now,
      });
    } else {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (id, email, name, password_hash, role, status, email_verified, verification_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'user', 'active', 0, ?, ?, ?)`
        ).bind(userId, emailLower, name, passwordHash, verificationToken, now, now),
        env.DB.prepare(
          `INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(randomId('ses'), userId, tokenHash, request.headers.get('user-agent') || '', expiresAt, now),
      ]);
    }

    return jsonResponse(
      { user: newUser, verificationTokenPreview: verificationToken },
      201,
      { 'Set-Cookie': sessionCookieHeader(rawSessionToken) }
    );
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJsonBody(request);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || 'Invalid credentials.' }, 400);
    }
    const { email, password } = parsed.data;
    const emailLower = email.toLowerCase();

    let pubUser: PublicUser | null = null;
    let storedHash = '';
    let status: UserStatus = 'active';

    if (!env.DB) {
      const found = memStore.users.find((u) => u.email.toLowerCase() === emailLower);
      if (found) {
        storedHash = found.passwordHash;
        status = found.status;
        const { passwordHash: _p, verificationToken: _v, resetToken: _r, resetExpiresAt: _e, updatedAt: _u, ...pub } = found;
        pubUser = pub;
      }
    } else {
      const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
        .bind(emailLower)
        .first<Record<string, unknown>>();
      if (row) {
        storedHash = String(row.password_hash);
        status = row.status as UserStatus;
        pubUser = mapUserRow(row);
      }
    }

    if (!pubUser) return jsonResponse({ error: 'Invalid email or password.' }, 401);
    if (status === 'suspended') {
      return jsonResponse({ error: 'Your account has been suspended. Contact an administrator.' }, 403);
    }
    const valid = await verifyPassword(password, storedHash);
    if (!valid) return jsonResponse({ error: 'Invalid email or password.' }, 401);

    const rawSessionToken = generateSecureToken(32);
    const tokenHash = await sha256Hex(rawSessionToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

    if (!env.DB) {
      memStore.sessions.push({
        id: randomId('ses'),
        userId: pubUser.id,
        tokenHash,
        userAgent: request.headers.get('user-agent') || '',
        expiresAt,
        createdAt: now,
      });
    } else {
      await env.DB.prepare(
        `INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(randomId('ses'), pubUser.id, tokenHash, request.headers.get('user-agent') || '', expiresAt, now)
        .run();
    }

    return jsonResponse({ user: pubUser }, 200, { 'Set-Cookie': sessionCookieHeader(rawSessionToken) });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const rawToken = parseCookies(request)[SESSION_COOKIE_NAME];
    if (rawToken) {
      const tokenHash = await sha256Hex(rawToken);
      if (!env.DB) {
        memStore.sessions = memStore.sessions.filter((s) => s.tokenHash !== tokenHash);
      } else {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
      }
    }
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
  }

  if (method === 'POST' && pathname === '/api/auth/request-reset') {
    const body = await readJsonBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) return jsonResponse({ error: 'Email is required.' }, 400);
    const token = generateSecureToken(16);
    const expires = new Date(Date.now() + 3600_000).toISOString();
    const now = new Date().toISOString();

    if (!env.DB) {
      const u = memStore.users.find((x) => x.email.toLowerCase() === email);
      if (!u) return jsonResponse({ ok: true, message: 'If an account matches that email, a reset token has been generated.' });
      u.resetToken = token;
      u.resetExpiresAt = expires;
      u.updatedAt = now;
    } else {
      const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
      if (!row) return jsonResponse({ ok: true, message: 'If an account matches that email, a reset token has been generated.' });
      await env.DB.prepare('UPDATE users SET reset_token = ?, reset_expires_at = ?, updated_at = ? WHERE id = ?')
        .bind(token, expires, now, row.id)
        .run();
    }
    return jsonResponse({
      ok: true,
      message: 'Password reset token generated (valid for 1 hour).',
      resetTokenPreview: token,
    });
  }

  if (method === 'POST' && pathname === '/api/auth/reset-password') {
    const body = await readJsonBody(request);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const newPassword = typeof body.password === 'string' ? body.password : '';
    if (!token || newPassword.length < 8) {
      return jsonResponse({ error: 'Valid reset token and password (8+ chars) required.' }, 400);
    }
    const passwordHash = await hashPassword(newPassword);
    const now = new Date().toISOString();

    if (!env.DB) {
      const u = memStore.users.find((x) => x.resetToken === token);
      if (!u || !u.resetExpiresAt || new Date(u.resetExpiresAt).getTime() < Date.now()) {
        return jsonResponse({ error: 'Reset token is invalid or expired.' }, 400);
      }
      u.passwordHash = passwordHash;
      u.resetToken = null;
      u.resetExpiresAt = null;
      u.updatedAt = now;
    } else {
      const row = await env.DB.prepare('SELECT id, reset_expires_at FROM users WHERE reset_token = ?')
        .bind(token)
        .first<{ id: string; reset_expires_at: string }>();
      if (!row || new Date(row.reset_expires_at).getTime() < Date.now()) {
        return jsonResponse({ error: 'Reset token is invalid or expired.' }, 400);
      }
      await env.DB.prepare(
        'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL, updated_at = ? WHERE id = ?'
      )
        .bind(passwordHash, now, row.id)
        .run();
    }
    return jsonResponse({ ok: true });
  }

  if (method === 'POST' && pathname === '/api/auth/verify-email') {
    const body = await readJsonBody(request);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return jsonResponse({ error: 'Verification token required.' }, 400);
    const now = new Date().toISOString();

    if (!env.DB) {
      const u = memStore.users.find((x) => x.verificationToken === token);
      if (!u) return jsonResponse({ error: 'Invalid verification token.' }, 400);
      u.emailVerified = true;
      u.verificationToken = null;
      u.updatedAt = now;
    } else {
      const row = await env.DB.prepare('SELECT id FROM users WHERE verification_token = ?')
        .bind(token)
        .first<{ id: string }>();
      if (!row) return jsonResponse({ error: 'Invalid verification token.' }, 400);
      await env.DB.prepare('UPDATE users SET email_verified = 1, verification_token = NULL, updated_at = ? WHERE id = ?')
        .bind(now, row.id)
        .run();
    }
    return jsonResponse({ ok: true });
  }

  // ================= LINKS =================
  if (method === 'GET' && pathname === '/api/links/check-alias') {
    const slug = url.searchParams.get('slug') || '';
    const excludeId = url.searchParams.get('excludeId') || '';
    const check = validateCustomAlias(slug);
    if (!check.valid) {
      return jsonResponse({ available: false, normalized: check.normalized, reason: check.error });
    }
    const existing = await getLinkBySlug(env, check.normalized);
    if (existing && existing.link.id !== excludeId) {
      return jsonResponse({ available: false, normalized: check.normalized, reason: 'This alias is already taken.' });
    }
    return jsonResponse({ available: true, normalized: check.normalized });
  }

  if (method === 'POST' && pathname === '/api/links/validate-video') {
    const body = await readJsonBody(request);
    const rawUrl = typeof body.videoUrl === 'string' ? body.videoUrl : '';
    const probe = await probeVideoStream(rawUrl, {
      origin,
      localReader: createWorkerLocalReader(env, request.url),
    });

    if (!probe.valid && probe.audit.errors.length > 0 && !probe.audit.videoReachable && !validateVideoUrl(rawUrl).valid) {
      return jsonResponse(
        {
          valid: false,
          convertedFromGithub: probe.convertedFromGithub,
          error: probe.audit.errors[0] || 'Invalid video URL.',
          audit: probe.audit,
        },
        400
      );
    }

    return jsonResponse({
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
  }

  if (method === 'GET' && pathname === '/api/links') {
    const user = await resolveAuthUser(env, request);
    const search = (url.searchParams.get('q') || '').trim().toLowerCase();
    const typeFilter = url.searchParams.get('type') || 'all';
    const statusFilter = url.searchParams.get('status') || 'all';
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize') || 10)));

    let allLinks: LinkRecord[] = [];
    if (!env.DB) {
      allLinks = memStore.links
        .filter((l) => (user && user.role !== 'admin' ? l.userId === user.id || l.userId === null : true))
        .map(toPublicLink)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else {
      const rows =
        user && user.role !== 'admin'
          ? (
              await env.DB.prepare('SELECT * FROM links WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC')
                .bind(user.id)
                .all()
            ).results
          : (await env.DB.prepare('SELECT * FROM links ORDER BY created_at DESC').all()).results;
      allLinks = rows.map(mapLinkRow);
    }

    const nowMs = Date.now();
    const filtered = allLinks.filter((l) => {
      if (typeFilter === 'normal' || typeFilter === 'video') {
        if (l.linkType !== typeFilter) return false;
      }
      if (statusFilter === 'active' && !l.isActive) return false;
      if (statusFilter === 'disabled' && l.isActive) return false;
      if (statusFilter === 'expired' && (!l.expiresAt || new Date(l.expiresAt).getTime() >= nowMs)) return false;
      if (search) {
        const hay = `${l.slug} ${l.destinationUrl} ${l.videoTitle || ''} ${l.campaignName || ''} ${l.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    return jsonResponse({ links: filtered.slice(offset, offset + pageSize), total, page, pageSize, totalPages });
  }

  if (method === 'POST' && pathname === '/api/links') {
    const settings = await getSystemSettings(env);
    if (settings.maintenanceMode) {
      return jsonResponse({ error: 'Platform is temporarily in maintenance mode.' }, 503);
    }
    const user = await resolveAuthUser(env, request);
    const body = await readJsonBody(request);
    const parsed = createLinkSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || 'Invalid link payload.' }, 400);
    }
    const data = parsed.data;
    const destCheck = validateSafeExternalUrl(data.destinationUrl);
    if (!destCheck.valid || !destCheck.normalizedUrl) {
      return jsonResponse({ error: destCheck.error || 'Invalid destination URL.' }, 400);
    }

    let slug = '';
    if (data.customAlias && data.customAlias.trim()) {
      const aliasCheck = validateCustomAlias(data.customAlias);
      if (!aliasCheck.valid) return jsonResponse({ error: aliasCheck.error }, 400);
      const conflict = await getLinkBySlug(env, aliasCheck.normalized);
      if (conflict) return jsonResponse({ error: 'Custom alias is already in use.' }, 409);
      slug = aliasCheck.normalized;
    } else {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = generateRandomSlug(6);
        if (!(await getLinkBySlug(env, candidate))) {
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
    const effectiveLinkType: 'normal' | 'video' =
      data.linkType === 'video' || Boolean(rawVideoUrl) ? 'video' : 'normal';
    const previewEnabled =
      data.previewEnabled !== undefined ? Boolean(data.previewEnabled) : effectiveLinkType === 'video';

    let resolvedWidth = Number(data.videoWidth || 0);
    let resolvedHeight = Number(data.videoHeight || 0);

    if (effectiveLinkType === 'video' || rawVideoUrl) {
      if (rawVideoUrl) {
        const videoCheck = validateVideoUrl(rawVideoUrl);
        if (!videoCheck.valid || !videoCheck.normalizedUrl) {
          return jsonResponse({ error: videoCheck.error || 'Invalid video URL.' }, 400);
        }
        normalizedVideoUrl = videoCheck.normalizedUrl;
        videoMimeType = videoCheck.mimeType || 'video/mp4';

        if (resolvedWidth <= 0 || resolvedHeight <= 0) {
          const urlDims = resolveVideoDimensions(normalizedVideoUrl, null, null);
          resolvedWidth = urlDims.width;
          resolvedHeight = urlDims.height;
          if (resolvedWidth <= 0 || resolvedHeight <= 0) {
            const probe = await probeVideoStream(normalizedVideoUrl, {
              origin,
              localReader: createWorkerLocalReader(env, request.url),
            });
            if (probe.audit.detectedWidth && probe.audit.detectedHeight) {
              resolvedWidth = probe.audit.detectedWidth;
              resolvedHeight = probe.audit.detectedHeight;
            }
          }
        }
      } else if (!settings.globalVideoUrl) {
        return jsonResponse(
          { error: 'Video URL is required for video preview links unless a Global Video is configured in Admin.' },
          400
        );
      }

      if (data.thumbnailUrl && data.thumbnailUrl.trim()) {
        const thumbCheck = validateSafeExternalUrl(data.thumbnailUrl, true, true);
        if (!thumbCheck.valid || !thumbCheck.normalizedUrl) {
          return jsonResponse({ error: thumbCheck.error || 'Invalid thumbnail URL.' }, 400);
        }
        normalizedThumbUrl = thumbCheck.normalizedUrl;
      }

      if (data.playerUrl && data.playerUrl.trim()) {
        const pCheck = validateSafeExternalUrl(data.playerUrl, true, true);
        if (!pCheck.valid || !pCheck.normalizedUrl) {
          return jsonResponse({ error: pCheck.error || 'Invalid custom Player URL.' }, 400);
        }
        normalizedPlayerUrl = pCheck.normalizedUrl;
      }
    }

    const titleToSave = data.videoTitle?.trim() || null;
    const redirectType = (data.redirectType || settings.defaultRedirectType) as RedirectStatusCode;
    const passwordHash = data.password && data.password.trim() ? await hashPassword(data.password.trim()) : null;
    const id = randomId('lnk');
    const now = new Date().toISOString();
    const autoRedirectSeconds = Math.max(0, Math.min(120, Number(data.autoRedirectSeconds || 0)));

    const newRecord: MemoryLink = {
      id,
      userId: user?.id || null,
      slug,
      shortCode: slug,
      linkType: effectiveLinkType,
      previewEnabled: effectiveLinkType === 'video' && previewEnabled,
      autoRedirectSeconds,
      destinationUrl: destCheck.normalizedUrl,
      videoUrl: normalizedVideoUrl,
      videoTitle: titleToSave,
      videoDescription: data.videoDescription?.trim() || null,
      thumbnailUrl: normalizedThumbUrl,
      videoMimeType,
      videoWidth: resolvedWidth,
      videoHeight: resolvedHeight,
      twitterCardType: data.twitterCardType || 'player',
      playerUrl: normalizedPlayerUrl,
      redirectType,
      hasPassword: Boolean(passwordHash),
      passwordHash,
      expiresAt: data.expiresAt || null,
      isActive: data.isActive ?? true,
      utmSource: data.utmSource?.trim() || null,
      utmMedium: data.utmMedium?.trim() || null,
      utmCampaign: data.utmCampaign?.trim() || null,
      campaignName: data.campaignName?.trim() || null,
      tags: data.tags || [],
      clicksCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (!env.DB) {
      memStore.links.unshift(newRecord);
    } else {
      await env.DB.prepare(
        `INSERT INTO links (
          id, user_id, slug, link_type, preview_enabled, auto_redirect_seconds, destination_url,
          video_url, video_title, video_description, thumbnail_url, video_mime_type, video_width, video_height,
          twitter_card_type, player_url, redirect_type, password_hash, expires_at, is_active,
          utm_source, utm_medium, utm_campaign, campaign_name, tags, clicks_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
        .bind(
          newRecord.id,
          newRecord.userId,
          newRecord.slug,
          newRecord.linkType,
          newRecord.previewEnabled ? 1 : 0,
          newRecord.autoRedirectSeconds,
          newRecord.destinationUrl,
          newRecord.videoUrl,
          newRecord.videoTitle,
          newRecord.videoDescription,
          newRecord.thumbnailUrl,
          newRecord.videoMimeType,
          newRecord.videoWidth,
          newRecord.videoHeight,
          newRecord.twitterCardType,
          newRecord.playerUrl,
          newRecord.redirectType,
          newRecord.passwordHash,
          newRecord.expiresAt,
          newRecord.isActive ? 1 : 0,
          newRecord.utmSource,
          newRecord.utmMedium,
          newRecord.utmCampaign,
          newRecord.campaignName,
          JSON.stringify(newRecord.tags),
          now,
          now
        )
        .run();
    }

    return jsonResponse({ link: toPublicLink(newRecord) }, 201);
  }

  // Link update / delete / verify-password
  const verifyPassMatch = pathname.match(/^\/api\/links\/([^/]+)\/verify-password$/);
  if (method === 'POST' && verifyPassMatch) {
    const body = await readJsonBody(request);
    const password = typeof body.password === 'string' ? body.password : '';
    const found = await getLinkById(env, decodeURIComponent(verifyPassMatch[1]));
    if (!found) return jsonResponse({ error: 'Link not found.' }, 404);
    if (!found.passwordHash) {
      return jsonResponse({ unlocked: true, destinationUrl: found.link.destinationUrl });
    }
    const ok = await verifyPassword(password, found.passwordHash);
    if (!ok) return jsonResponse({ error: 'Incorrect link password.' }, 401);
    const finalDest = appendUtmParams(found.link.destinationUrl, {
      source: found.link.utmSource,
      medium: found.link.utmMedium,
      campaign: found.link.utmCampaign,
    });
    await recordClick(env, found.link.id, request);
    return jsonResponse({ unlocked: true, destinationUrl: finalDest });
  }

  const linkIdMatch = pathname.match(/^\/api\/links\/([^/]+)$/);
  if (linkIdMatch && method === 'PUT') {
    const id = decodeURIComponent(linkIdMatch[1]);
    const user = await resolveAuthUser(env, request);
    const found = await getLinkById(env, id);
    if (!found) return jsonResponse({ error: 'Link not found.' }, 404);
    if (found.link.userId && user && user.role !== 'admin' && found.link.userId !== user.id) {
      return jsonResponse({ error: 'You do not have permission to edit this link.' }, 403);
    }

    const body = await readJsonBody(request);
    const parsed = updateLinkSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || 'Invalid update payload.' }, 400);
    }
    const data = parsed.data;
    const cur = found.link;

    let slug = cur.slug;
    if (data.customAlias && data.customAlias.trim() && data.customAlias.trim() !== cur.slug) {
      const aliasCheck = validateCustomAlias(data.customAlias);
      if (!aliasCheck.valid) return jsonResponse({ error: aliasCheck.error }, 400);
      const conflict = await getLinkBySlug(env, aliasCheck.normalized);
      if (conflict && conflict.link.id !== cur.id) {
        return jsonResponse({ error: 'Alias already in use.' }, 409);
      }
      slug = aliasCheck.normalized;
    }

    let destinationUrl = cur.destinationUrl;
    if (data.destinationUrl) {
      const dCheck = validateSafeExternalUrl(data.destinationUrl);
      if (!dCheck.valid || !dCheck.normalizedUrl) {
        return jsonResponse({ error: dCheck.error || 'Invalid destination URL.' }, 400);
      }
      destinationUrl = dCheck.normalizedUrl;
    }

    const nextType = data.linkType ?? cur.linkType;
    const previewEnabled =
      data.previewEnabled !== undefined
        ? data.previewEnabled
        : data.linkType !== undefined
          ? data.linkType === 'video'
          : cur.previewEnabled;
    const autoRedirectSeconds =
      data.autoRedirectSeconds !== undefined
        ? Math.max(0, Math.min(120, Number(data.autoRedirectSeconds)))
        : cur.autoRedirectSeconds;

    let videoUrl = cur.videoUrl;
    let videoMimeType = cur.videoMimeType;
    if (data.videoUrl !== undefined) {
      if (data.videoUrl && data.videoUrl.trim()) {
        const vCheck = validateVideoUrl(data.videoUrl);
        if (!vCheck.valid || !vCheck.normalizedUrl) {
          return jsonResponse({ error: vCheck.error || 'Invalid video URL.' }, 400);
        }
        videoUrl = vCheck.normalizedUrl;
        videoMimeType = vCheck.mimeType || 'video/mp4';
      } else {
        videoUrl = null;
        videoMimeType = null;
      }
    }

    let thumbnailUrl = cur.thumbnailUrl;
    if (data.thumbnailUrl !== undefined) {
      if (data.thumbnailUrl && data.thumbnailUrl.trim()) {
        const tCheck = validateSafeExternalUrl(data.thumbnailUrl, true, true);
        if (!tCheck.valid || !tCheck.normalizedUrl) {
          return jsonResponse({ error: tCheck.error || 'Invalid thumbnail URL.' }, 400);
        }
        thumbnailUrl = tCheck.normalizedUrl;
      } else {
        thumbnailUrl = null;
      }
    }

    let playerUrl = cur.playerUrl;
    if (data.playerUrl !== undefined) {
      if (data.playerUrl && data.playerUrl.trim()) {
        const pCheck = validateSafeExternalUrl(data.playerUrl, true, true);
        if (!pCheck.valid || !pCheck.normalizedUrl) {
          return jsonResponse({ error: pCheck.error || 'Invalid player URL.' }, 400);
        }
        playerUrl = pCheck.normalizedUrl;
      } else {
        playerUrl = null;
      }
    }

    let nextPasswordHash = found.passwordHash;
    if (data.clearPassword) nextPasswordHash = null;
    else if (data.password && data.password.trim()) nextPasswordHash = await hashPassword(data.password.trim());

    const now = new Date().toISOString();
    const updated: MemoryLink = {
      ...cur,
      slug,
      shortCode: slug,
      linkType: nextType,
      previewEnabled,
      autoRedirectSeconds,
      destinationUrl,
      videoUrl,
      videoTitle: data.videoTitle !== undefined ? data.videoTitle?.trim() || null : cur.videoTitle,
      videoDescription: data.videoDescription !== undefined ? data.videoDescription?.trim() || null : cur.videoDescription,
      thumbnailUrl,
      videoMimeType,
      videoWidth: data.videoWidth ?? cur.videoWidth,
      videoHeight: data.videoHeight ?? cur.videoHeight,
      twitterCardType: data.twitterCardType ?? cur.twitterCardType,
      playerUrl,
      redirectType: (data.redirectType ?? cur.redirectType) as RedirectStatusCode,
      hasPassword: Boolean(nextPasswordHash),
      passwordHash: nextPasswordHash,
      expiresAt: data.expiresAt !== undefined ? data.expiresAt || null : cur.expiresAt,
      isActive: data.isActive !== undefined ? data.isActive : cur.isActive,
      utmSource: data.utmSource !== undefined ? data.utmSource?.trim() || null : cur.utmSource,
      utmMedium: data.utmMedium !== undefined ? data.utmMedium?.trim() || null : cur.utmMedium,
      utmCampaign: data.utmCampaign !== undefined ? data.utmCampaign?.trim() || null : cur.utmCampaign,
      campaignName: data.campaignName !== undefined ? data.campaignName?.trim() || null : cur.campaignName,
      tags: data.tags !== undefined ? data.tags : cur.tags,
      updatedAt: now,
    };

    if (!env.DB) {
      const idx = memStore.links.findIndex((l) => l.id === cur.id);
      if (idx >= 0) memStore.links[idx] = updated;
    } else {
      await env.DB.prepare(
        `UPDATE links SET
          slug = ?, link_type = ?, preview_enabled = ?, auto_redirect_seconds = ?,
          destination_url = ?, video_url = ?, video_title = ?,
          video_description = ?, thumbnail_url = ?, video_mime_type = ?, video_width = ?,
          video_height = ?, twitter_card_type = ?, player_url = ?, redirect_type = ?,
          password_hash = ?, expires_at = ?, is_active = ?, utm_source = ?, utm_medium = ?,
          utm_campaign = ?, campaign_name = ?, tags = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(
          updated.slug,
          updated.linkType,
          updated.previewEnabled ? 1 : 0,
          updated.autoRedirectSeconds,
          updated.destinationUrl,
          updated.videoUrl,
          updated.videoTitle,
          updated.videoDescription,
          updated.thumbnailUrl,
          updated.videoMimeType,
          updated.videoWidth,
          updated.videoHeight,
          updated.twitterCardType,
          updated.playerUrl,
          updated.redirectType,
          updated.passwordHash,
          updated.expiresAt,
          updated.isActive ? 1 : 0,
          updated.utmSource,
          updated.utmMedium,
          updated.utmCampaign,
          updated.campaignName,
          JSON.stringify(updated.tags),
          now,
          updated.id
        )
        .run();
    }

    return jsonResponse({ link: toPublicLink(updated) });
  }

  if (linkIdMatch && method === 'DELETE') {
    const id = decodeURIComponent(linkIdMatch[1]);
    const user = await resolveAuthUser(env, request);
    const found = await getLinkById(env, id);
    if (!found) return jsonResponse({ error: 'Link not found.' }, 404);
    if (found.link.userId && user && user.role !== 'admin' && found.link.userId !== user.id) {
      return jsonResponse({ error: 'Permission denied.' }, 403);
    }
    if (!env.DB) {
      memStore.links = memStore.links.filter((l) => l.id !== found.link.id);
    } else {
      await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(found.link.id).run();
    }
    return jsonResponse({ ok: true });
  }

  // ================= PREVIEW & OEMBED =================
  if (method === 'GET' && pathname.startsWith('/api/preview/')) {
    const slug = decodeURIComponent(pathname.slice('/api/preview/'.length));
    const found = await getLinkBySlug(env, slug);
    if (!found) return jsonResponse({ error: 'Preview link not found.' }, 404);
    const { link } = found;
    const settings = await getSystemSettings(env);
    const isExpired = link.expiresAt ? new Date(link.expiresAt).getTime() < Date.now() : false;
    const metadata = buildSocialMetadata(
      link,
      origin,
      `/s/${encodeURIComponent(link.slug)}`,
      settings
    );

    if (url.searchParams.get('track') === '1' && link.isActive && !isExpired) {
      await recordClick(env, link.id, request);
    }

    const destinationWithUtm = appendUtmParams(link.destinationUrl, {
      source: link.utmSource,
      medium: link.utmMedium,
      campaign: link.utmCampaign,
    });

    let audit: VideoStreamAudit | undefined;
    if (url.searchParams.get('audit') === '1') {
      const rawEffectiveVideo =
        settings.globalVideoOverride && settings.globalVideoUrl
          ? settings.globalVideoUrl
          : link.videoUrl || settings.globalVideoUrl || '';

      if (rawEffectiveVideo) {
        const probed = await probeVideoStream(rawEffectiveVideo, {
          origin,
          localReader: createWorkerLocalReader(env, request.url),
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

    return jsonResponse({
      link: { ...link, destinationUrl: destinationWithUtm },
      isExpired,
      metadata,
      audit,
    });
  }

  if (method === 'GET' && pathname === '/api/oembed') {
    const rawUrl = (url.searchParams.get('url') || '').trim();
    if (!rawUrl) return jsonResponse({ error: 'Missing url parameter.' }, 400);
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
    const found = await getLinkBySlug(env, slug);
    if (!found || found.link.linkType !== 'video' || !found.link.isActive) {
      return jsonResponse({ error: 'Video link not found.' }, 404);
    }
    const settings = await getSystemSettings(env);
    const meta = buildSocialMetadata(
      found.link,
      origin,
      `/s/${encodeURIComponent(found.link.slug)}`,
      settings
    );
    if (!meta.hasValidVideo) {
      return jsonResponse({ error: meta.videoError || 'No video configured for this link.' }, 404);
    }
    const w = meta.twitterPlayerWidth || 720;
    const h = meta.twitterPlayerHeight || 1278;
    const safePlayer = meta.twitterPlayer.replace(/"/g, '&quot;');

    return jsonResponse({
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
  }

  // ================= QR CODE GENERATOR =================
  if (method === 'POST' && pathname === '/api/qr') {
    const body = await readJsonBody(request);
    const parsed = qrRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || 'Invalid QR options.' }, 400);
    }
    const { url: qrTarget, fgColor, bgColor, size, includeLogo, logoText, logoDataUrl } = parsed.data;
    const ecLevel = includeLogo ? 'H' : 'M';

    try {
      const qrData = QRCore.create(qrTarget, { errorCorrectionLevel: ecLevel });
      let svg: string = SvgRenderer.render(qrData, {
        width: size,
        margin: 2,
        color: { dark: fgColor, light: bgColor },
      });

      if (includeLogo) {
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

      // Encode SVG data URL cleanly on Workers (client QRCodeGenerator rasterizes SVG -> 720px PNG via canvas)
      const svgBase64 = btoa(unescape(encodeURIComponent(svg)));
      return jsonResponse({ svg, pngDataUrl: `data:image/svg+xml;base64,${svgBase64}` });
    } catch (err) {
      return jsonResponse({ error: `QR generation failed: ${(err as Error).message}` }, 500);
    }
  }

  // ================= ANALYTICS =================
  if (method === 'GET' && pathname === '/api/analytics/overview') {
    const user = await resolveAuthUser(env, request);
    const scopeUserId = user && user.role === 'admin' ? null : user?.id || null;
    return jsonResponse(await computeAnalytics(env, scopeUserId, null));
  }

  if (method === 'GET' && pathname.startsWith('/api/analytics/')) {
    const idOrSlug = decodeURIComponent(pathname.slice('/api/analytics/'.length));
    const found = await getLinkById(env, idOrSlug);
    if (!found) return jsonResponse({ error: 'Link not found for analytics.' }, 404);
    return jsonResponse(await computeAnalytics(env, null, found.link.id));
  }

  // ================= ABUSE REPORTS =================
  if (method === 'POST' && pathname === '/api/reports') {
    const body = await readJsonBody(request);
    const parsed = reportLinkSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || 'Invalid report payload.' }, 400);
    }
    const { slug, reason, details } = parsed.data;
    const found = await getLinkBySlug(env, slug);
    const reporterHash = (await sha256Hex(`${getClientIp(request)}|${slug}`)).slice(0, 24);
    const reportId = randomId('rpt');
    const now = new Date().toISOString();

    if (!env.DB) {
      memStore.reports.unshift({
        id: reportId,
        linkId: found?.link.id || null,
        slug,
        reason,
        details: details?.trim() || null,
        reporterHash,
        status: 'pending',
        createdAt: now,
      });
    } else {
      await env.DB.prepare(
        `INSERT INTO reports (id, link_id, slug, reason, details, reporter_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
        .bind(reportId, found?.link.id || null, slug, reason, details?.trim() || null, reporterHash, now)
        .run();
    }
    return jsonResponse({ ok: true, id: reportId }, 201);
  }

  // ================= ADMIN =================
  if (pathname.startsWith('/api/admin/')) {
    const user = await resolveAuthUser(env, request);
    if (!user) return jsonResponse({ error: 'Authentication required.' }, 401);
    if (user.role !== 'admin') return jsonResponse({ error: 'Administrator privileges required.' }, 403);

    if (method === 'GET' && pathname === '/api/admin/stats') {
      if (!env.DB) {
        const regMap = new Map<string, number>();
        for (const u of memStore.users) {
          const d = u.createdAt.slice(0, 10);
          regMap.set(d, (regMap.get(d) || 0) + 1);
        }
        const stats: AdminStats = {
          totalUsers: memStore.users.length,
          totalLinks: memStore.links.length,
          totalVideoLinks: memStore.links.filter((l) => l.linkType === 'video').length,
          totalClicks: memStore.clicks.length,
          activeUsers: memStore.users.filter((u) => u.status === 'active').length,
          dailyRegistrations: Array.from(regMap.entries())
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-14),
          pendingReports: memStore.reports.filter((r) => r.status === 'pending').length,
        };
        return jsonResponse(stats);
      }

      const [uCnt, aCnt, lCnt, vCnt, cCnt, rCnt, regs] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>(),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'").first<{ cnt: number }>(),
        env.DB.prepare('SELECT COUNT(*) as cnt FROM links').first<{ cnt: number }>(),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM links WHERE link_type = 'video'").first<{ cnt: number }>(),
        env.DB.prepare('SELECT COUNT(*) as cnt FROM clicks').first<{ cnt: number }>(),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM reports WHERE status = 'pending'").first<{ cnt: number }>(),
        env.DB.prepare(
          'SELECT substr(created_at, 1, 10) as date, COUNT(*) as count FROM users GROUP BY date ORDER BY date DESC LIMIT 14'
        ).all<{ date: string; count: number }>(),
      ]);

      return jsonResponse({
        totalUsers: Number(uCnt?.cnt || 0),
        activeUsers: Number(aCnt?.cnt || 0),
        totalLinks: Number(lCnt?.cnt || 0),
        totalVideoLinks: Number(vCnt?.cnt || 0),
        totalClicks: Number(cCnt?.cnt || 0),
        pendingReports: Number(rCnt?.cnt || 0),
        dailyRegistrations: [...regs.results].reverse(),
      });
    }

    if (method === 'GET' && pathname === '/api/admin/users') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!env.DB) {
        const users = memStore.users
          .filter((u) => (!q ? true : u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)))
          .map(({ passwordHash: _p, verificationToken: _v, resetToken: _r, resetExpiresAt: _e, updatedAt: _u, ...pub }) => pub);
        return jsonResponse({ users });
      }
      const rows = q
        ? (
            await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) LIKE ? OR LOWER(name) LIKE ? ORDER BY created_at DESC')
              .bind(`%${q}%`, `%${q}%`)
              .all()
          ).results
        : (await env.DB.prepare('SELECT * FROM users ORDER BY created_at DESC').all()).results;
      return jsonResponse({ users: rows.map(mapUserRow) });
    }

    const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && method === 'PATCH') {
      const targetId = decodeURIComponent(adminUserMatch[1]);
      const body = await readJsonBody(request);
      if (!env.DB) {
        const target = memStore.users.find((u) => u.id === targetId);
        if (!target) return jsonResponse({ error: 'User not found.' }, 404);
        const nextRole: UserRole = body.role === 'admin' || body.role === 'user' ? body.role : target.role;
        const nextStatus: UserStatus =
          body.status === 'active' || body.status === 'suspended' ? body.status : target.status;
        if (targetId === user.id && (nextRole !== 'admin' || nextStatus !== 'active')) {
          return jsonResponse({ error: 'You cannot suspend or demote your own active admin account.' }, 400);
        }
        target.role = nextRole;
        target.status = nextStatus;
        target.updatedAt = new Date().toISOString();
        const { passwordHash: _p, verificationToken: _v, resetToken: _r, resetExpiresAt: _e, updatedAt: _u, ...pub } = target;
        return jsonResponse({ user: pub });
      }
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first<Record<string, unknown>>();
      if (!row) return jsonResponse({ error: 'User not found.' }, 404);
      const nextRole = body.role === 'admin' || body.role === 'user' ? body.role : String(row.role);
      const nextStatus =
        body.status === 'active' || body.status === 'suspended' ? body.status : String(row.status);
      if (targetId === user.id && (nextRole !== 'admin' || nextStatus !== 'active')) {
        return jsonResponse({ error: 'You cannot suspend or demote your own active admin account.' }, 400);
      }
      await env.DB.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?')
        .bind(nextRole, nextStatus, new Date().toISOString(), targetId)
        .run();
      const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first<Record<string, unknown>>();
      return jsonResponse({ user: mapUserRow(updated!) });
    }

    if (adminUserMatch && method === 'DELETE') {
      const targetId = decodeURIComponent(adminUserMatch[1]);
      if (targetId === user.id) return jsonResponse({ error: 'Cannot delete your own admin account.' }, 400);
      if (!env.DB) {
        memStore.users = memStore.users.filter((u) => u.id !== targetId);
      } else {
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();
      }
      return jsonResponse({ ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/links') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!env.DB) {
        const links = memStore.links
          .filter((l) => (!q ? true : l.slug.toLowerCase().includes(q) || l.destinationUrl.toLowerCase().includes(q)))
          .slice(0, 200)
          .map(toPublicLink);
        return jsonResponse({ links });
      }
      const rows = q
        ? (
            await env.DB.prepare(
              'SELECT * FROM links WHERE LOWER(slug) LIKE ? OR LOWER(destination_url) LIKE ? ORDER BY created_at DESC LIMIT 200'
            )
              .bind(`%${q}%`, `%${q}%`)
              .all()
          ).results
        : (await env.DB.prepare('SELECT * FROM links ORDER BY created_at DESC LIMIT 200').all()).results;
      return jsonResponse({ links: rows.map(mapLinkRow) });
    }

    const adminLinkMatch = pathname.match(/^\/api\/admin\/links\/([^/]+)$/);
    if (adminLinkMatch && method === 'PATCH') {
      const id = decodeURIComponent(adminLinkMatch[1]);
      const body = await readJsonBody(request);
      const parsed = updateLinkSchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse({ error: parsed.error.issues[0]?.message || 'Invalid admin link update payload.' }, 400);
      }
      const data = parsed.data;

      if (!env.DB) {
        const target = memStore.links.find((l) => l.id === id);
        if (!target) return jsonResponse({ error: 'Link not found.' }, 404);
        if (data.videoUrl !== undefined) {
          if (data.videoUrl && data.videoUrl.trim()) {
            const vCheck = validateVideoUrl(data.videoUrl);
            if (!vCheck.valid || !vCheck.normalizedUrl) {
              return jsonResponse({ error: vCheck.error || 'Invalid video URL.' }, 400);
            }
            target.videoUrl = vCheck.normalizedUrl;
            target.videoMimeType = vCheck.mimeType || 'video/mp4';
          } else {
            target.videoUrl = null;
            target.videoMimeType = null;
          }
        }
        if (data.thumbnailUrl !== undefined) {
          if (data.thumbnailUrl && data.thumbnailUrl.trim()) {
            const tCheck = validateSafeExternalUrl(data.thumbnailUrl, true, true);
            if (!tCheck.valid || !tCheck.normalizedUrl) {
              return jsonResponse({ error: tCheck.error || 'Invalid thumbnail URL.' }, 400);
            }
            target.thumbnailUrl = tCheck.normalizedUrl;
          } else {
            target.thumbnailUrl = null;
          }
        }
        if (typeof data.isActive === 'boolean') target.isActive = data.isActive;
        if (typeof data.previewEnabled === 'boolean') target.previewEnabled = data.previewEnabled;
        if (typeof data.autoRedirectSeconds === 'number') {
          target.autoRedirectSeconds = Math.max(0, Math.min(120, data.autoRedirectSeconds));
        }
        if (data.videoTitle !== undefined) target.videoTitle = data.videoTitle?.trim() || null;
        if (data.videoDescription !== undefined) target.videoDescription = data.videoDescription?.trim() || null;
        if (data.videoWidth !== undefined) target.videoWidth = data.videoWidth ?? 0;
        if (data.videoHeight !== undefined) target.videoHeight = data.videoHeight ?? 0;
        if (data.twitterCardType !== undefined) target.twitterCardType = data.twitterCardType;
        target.updatedAt = new Date().toISOString();
        return jsonResponse({ link: toPublicLink(target) });
      }

      const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first<Record<string, unknown>>();
      if (!row) return jsonResponse({ error: 'Link not found.' }, 404);

      let videoUrl = row.video_url ? String(row.video_url) : null;
      let videoMimeType = row.video_mime_type ? String(row.video_mime_type) : null;
      if (data.videoUrl !== undefined) {
        if (data.videoUrl && data.videoUrl.trim()) {
          const vCheck = validateVideoUrl(data.videoUrl);
          if (!vCheck.valid || !vCheck.normalizedUrl) {
            return jsonResponse({ error: vCheck.error || 'Invalid video URL.' }, 400);
          }
          videoUrl = vCheck.normalizedUrl;
          videoMimeType = vCheck.mimeType || 'video/mp4';
        } else {
          videoUrl = null;
          videoMimeType = null;
        }
      }

      let thumbnailUrl = row.thumbnail_url ? String(row.thumbnail_url) : null;
      if (data.thumbnailUrl !== undefined) {
        if (data.thumbnailUrl && data.thumbnailUrl.trim()) {
          const tCheck = validateSafeExternalUrl(data.thumbnailUrl, true, true);
          if (!tCheck.valid || !tCheck.normalizedUrl) {
            return jsonResponse({ error: tCheck.error || 'Invalid thumbnail URL.' }, 400);
          }
          thumbnailUrl = tCheck.normalizedUrl;
        } else {
          thumbnailUrl = null;
        }
      }

      const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
      const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : Number(row.is_active);
      const previewEnabled =
        data.previewEnabled !== undefined
          ? data.previewEnabled
            ? 1
            : 0
          : row.preview_enabled !== undefined
            ? Number(row.preview_enabled)
            : row.link_type === 'video'
              ? 1
              : 0;
      const autoRedirectSeconds =
        data.autoRedirectSeconds !== undefined
          ? Math.max(0, Math.min(120, Number(data.autoRedirectSeconds)))
          : Math.max(0, Math.min(120, Number(row.auto_redirect_seconds || 0)));

      await env.DB.prepare(
        `UPDATE links SET
          is_active = ?, preview_enabled = ?, auto_redirect_seconds = ?,
          video_url = ?, video_mime_type = ?, thumbnail_url = ?,
          video_title = ?, video_description = ?, video_width = ?, video_height = ?,
          twitter_card_type = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(
          isActive,
          previewEnabled,
          autoRedirectSeconds,
          videoUrl,
          videoMimeType,
          thumbnailUrl,
          data.videoTitle !== undefined ? data.videoTitle?.trim() || null : strOrNull(row.video_title),
          data.videoDescription !== undefined ? data.videoDescription?.trim() || null : strOrNull(row.video_description),
          Number(data.videoWidth ?? row.video_width ?? 0),
          Number(data.videoHeight ?? row.video_height ?? 0),
          String(data.twitterCardType ?? row.twitter_card_type ?? 'player'),
          new Date().toISOString(),
          id
        )
        .run();
      const updated = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first<Record<string, unknown>>();
      return jsonResponse({ link: mapLinkRow(updated!) });
    }

    if (adminLinkMatch && method === 'DELETE') {
      const id = decodeURIComponent(adminLinkMatch[1]);
      if (!env.DB) memStore.links = memStore.links.filter((l) => l.id !== id);
      else await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
      return jsonResponse({ ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/reports') {
      if (!env.DB) {
        return jsonResponse({
          reports: memStore.reports.map(({ reporterHash: _rh, ...r }) => r),
        });
      }
      const rows = (await env.DB.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 100').all()).results;
      return jsonResponse({
        reports: rows.map((r) => ({
          id: String(r.id),
          linkId: r.link_id ? String(r.link_id) : null,
          slug: String(r.slug),
          reason: String(r.reason),
          details: r.details ? String(r.details) : null,
          status: r.status as AbuseReport['status'],
          createdAt: String(r.created_at),
        })),
      });
    }

    const adminReportMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)$/);
    if (adminReportMatch && method === 'PATCH') {
      const id = decodeURIComponent(adminReportMatch[1]);
      const body = await readJsonBody(request);
      const status = body.status;
      if (typeof status !== 'string' || !['pending', 'reviewed', 'dismissed', 'actioned'].includes(status)) {
        return jsonResponse({ error: 'Invalid report status.' }, 400);
      }
      if (!env.DB) {
        const rep = memStore.reports.find((r) => r.id === id);
        if (!rep) return jsonResponse({ error: 'Report not found.' }, 404);
        rep.status = status as AbuseReport['status'];
        if (status === 'actioned' && rep.linkId) {
          const lnk = memStore.links.find((l) => l.id === rep.linkId);
          if (lnk) lnk.isActive = false;
        }
        return jsonResponse({ ok: true });
      }
      const rep = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<Record<string, unknown>>();
      if (!rep) return jsonResponse({ error: 'Report not found.' }, 404);
      await env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind(status, id).run();
      if (status === 'actioned' && rep.link_id) {
        await env.DB.prepare('UPDATE links SET is_active = 0, updated_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), String(rep.link_id))
          .run();
      }
      return jsonResponse({ ok: true });
    }

    if (method === 'GET' && pathname === '/api/admin/settings') {
      return jsonResponse({ settings: await getSystemSettings(env) });
    }

    if (method === 'PUT' && pathname === '/api/admin/settings') {
      const b = await readJsonBody(request);

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
            return jsonResponse({ error: vCheck.error || 'Invalid Global Video URL.' }, 400);
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
                origin,
                localReader: createWorkerLocalReader(env, request.url),
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
            return jsonResponse(
              { error: sCheck.error || 'Global Source Attribution URL must be a valid public HTTPS URL.' },
              400
            );
          }
          normalizedGlobalSourceUrl = sCheck.normalizedUrl;
        } else {
          normalizedGlobalSourceUrl = null;
        }
      }

      const updated = await updateSystemSettings(env, {
        siteName: typeof b.siteName === 'string' ? b.siteName.trim().slice(0, 60) : undefined,
        domain: typeof b.domain === 'string' ? b.domain.trim().slice(0, 120) : undefined,
        defaultRedirectType:
          b.defaultRedirectType === 301 ? 301 : b.defaultRedirectType === 302 ? 302 : undefined,
        registrationEnabled: typeof b.registrationEnabled === 'boolean' ? b.registrationEnabled : undefined,
        maxLinksPerUser:
          typeof b.maxLinksPerUser === 'number' ? Math.max(1, Math.min(100000, b.maxLinksPerUser)) : undefined,
        rateLimitPerMin:
          typeof b.rateLimitPerMin === 'number' ? Math.max(10, Math.min(5000, b.rateLimitPerMin)) : undefined,
        maintenanceMode: typeof b.maintenanceMode === 'boolean' ? b.maintenanceMode : undefined,
        globalVideoUrl: normalizedGlobalVideoUrl,
        globalVideoWidth: detectedGlobalWidth,
        globalVideoHeight: detectedGlobalHeight,
        globalVideoMimeType: detectedGlobalMime,
        globalVideoTitle:
          b.globalVideoTitle === null
            ? null
            : typeof b.globalVideoTitle === 'string'
              ? b.globalVideoTitle.trim().slice(0, 200) || null
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
      return jsonResponse({ settings: updated });
    }
  }

  return jsonResponse({ error: 'API endpoint not found.' }, 404);
}
