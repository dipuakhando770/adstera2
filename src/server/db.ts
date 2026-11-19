import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, randomId } from './crypto.ts';
import type {
  AbuseReport,
  AdminStats,
  AnalyticsOverview,
  BreakdownItem,
  CustomDomain,
  LinkRecord,
  PublicUser,
  RedirectStatusCode,
  SystemSettings,
  UserRole,
  UserStatus,
} from '../shared/types.ts';

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  const dbPath = process.env.SQLITE_DB_PATH || path.resolve(process.cwd(), 'nasirlink.db');
  dbInstance = new DatabaseSync(dbPath);
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');

  const migrationPath = path.resolve(process.cwd(), 'migrations/0001_initial.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
  dbInstance.exec(migrationSql);

  const migration04Path = path.resolve(process.cwd(), 'migrations/0004_cloudflare_domains_rotation.sql');
  if (fs.existsSync(migration04Path)) {
    const migration04Sql = fs.readFileSync(migration04Path, 'utf-8');
    try {
      dbInstance.exec(migration04Sql);
    } catch {
      // Ignore already existing tables/columns
    }
  }

  // Auto-migrate columns for pre-existing local SQLite databases
  const cols = dbInstance.prepare('PRAGMA table_info(links)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string]> = [
    ['video_width', 'INTEGER DEFAULT 1280'],
    ['video_height', 'INTEGER DEFAULT 720'],
    ['twitter_card_type', "TEXT NOT NULL DEFAULT 'player'"],
    ['player_url', 'TEXT'],
    ['preview_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['auto_redirect_seconds', 'INTEGER NOT NULL DEFAULT 0'],
    ['custom_domain_id', 'TEXT'],
  ];
  let addedPreviewCol = false;
  for (const [col, def] of missingColumns) {
    if (!colNames.has(col)) {
      try {
        dbInstance.exec(`ALTER TABLE links ADD COLUMN ${col} ${def};`);
      } catch {}
      if (col === 'preview_enabled') addedPreviewCol = true;
    }
  }
  if (addedPreviewCol) {
    dbInstance.exec("UPDATE links SET preview_enabled = 1 WHERE link_type = 'video' AND preview_enabled = 0;");
  }

  return dbInstance;
}

export async function seedDatabaseIfEmpty(): Promise<void> {
  const db = getDb();
  const settingsCount = (db.prepare('SELECT COUNT(*) as cnt FROM settings').get() as { cnt: number }).cnt;
  if (settingsCount === 0) {
    const defaultSettings: Array<[string, string]> = [
      ['site_name', 'NasirLink'],
      ['domain', 'nasirlink.com'],
      ['default_redirect_type', '302'],
      ['registration_enabled', 'true'],
      ['max_links_per_user', '500'],
      ['rate_limit_per_min', '120'],
      ['maintenance_mode', 'false'],
    ];
    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    for (const [key, val] of defaultSettings) {
      insertSetting.run(key, val);
    }
  }

  const usersCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  if (usersCount === 0) {
    const adminId = 'usr_admin_nasir';
    const creatorId = 'usr_creator_demo';
    const adminPass = await hashPassword('Admin123!');
    const creatorPass = await hashPassword('Creator123!');

    const insertUser = db.prepare(`
      INSERT INTO users (id, email, name, password_hash, role, status, email_verified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    insertUser.run(
      adminId,
      'admin@nasirlink.com',
      'Nasir Hassan',
      adminPass,
      'admin',
      'active',
      1,
      new Date(now - 14 * 86400_000).toISOString()
    );
    insertUser.run(
      creatorId,
      'creator@nasirlink.com',
      'Maya Lin',
      creatorPass,
      'user',
      'active',
      1,
      new Date(now - 7 * 86400_000).toISOString()
    );

    const insertLink = db.prepare(`
      INSERT INTO links (
        id, user_id, slug, link_type, preview_enabled, auto_redirect_seconds,
        destination_url, video_url, video_title, video_description, thumbnail_url,
        video_mime_type, video_width, video_height, redirect_type, is_active,
        utm_source, utm_medium, utm_campaign, campaign_name, tags, clicks_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const sampleLinks = [
      {
        id: 'lnk_demo_launch',
        userId: creatorId,
        slug: 'product-tour',
        linkType: 'video',
        destinationUrl: 'https://cloudflare.com/developer-platform/workers/',
        videoUrl: '/api/sample-video/showcase.mp4',
        videoTitle: 'NasirLink Edge Analytics — 2026 Product Walkthrough',
        videoDescription:
          'Interactive walkthrough of real-time link telemetry, custom slug routing, and X Video Player Cards built for modern product teams.',
        thumbnailUrl: null,
        videoMimeType: 'video/mp4',
        videoWidth: 720,
        videoHeight: 1278,
        redirectType: 302,
        utmSource: 'nasirlink',
        utmMedium: 'video_preview',
        utmCampaign: 'q4_launch',
        campaignName: 'Q4 Product Launch',
        tags: JSON.stringify(['product', 'walkthrough', 'analytics']),
        clicksCount: 184,
      },
      {
        id: 'lnk_demo_edge',
        userId: adminId,
        slug: 'edge-routing',
        linkType: 'video',
        destinationUrl: 'https://developers.cloudflare.com/d1/',
        videoUrl: '/api/sample-video/showcase1.mp4',
        videoTitle: 'Global Edge Routing & D1 Persistence Architecture',
        videoDescription:
          'How distributed redirect workers resolve custom slugs with sub-15ms overhead and privacy-preserving visitor hashing.',
        thumbnailUrl: null,
        videoMimeType: 'video/mp4',
        videoWidth: 1290,
        videoHeight: 720,
        redirectType: 302,
        utmSource: 'nasirlink',
        utmMedium: 'video_card',
        utmCampaign: 'architecture',
        campaignName: 'Developer Docs',
        tags: JSON.stringify(['architecture', 'edge', 'd1']),
        clicksCount: 129,
      },
      {
        id: 'lnk_demo_docs',
        userId: creatorId,
        slug: 'cf-docs',
        linkType: 'normal',
        destinationUrl: 'https://developers.cloudflare.com/workers/',
        videoUrl: null,
        videoTitle: null,
        videoDescription: null,
        thumbnailUrl: null,
        videoMimeType: null,
        videoWidth: 1280,
        videoHeight: 720,
        redirectType: 302,
        utmSource: 'newsletter',
        utmMedium: 'email',
        utmCampaign: 'dev_digest',
        campaignName: 'Weekly Dev Digest',
        tags: JSON.stringify(['docs', 'workers']),
        clicksCount: 96,
      },
      {
        id: 'lnk_demo_design',
        userId: adminId,
        slug: 'web-standards',
        linkType: 'normal',
        destinationUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API',
        videoUrl: null,
        videoTitle: null,
        videoDescription: null,
        thumbnailUrl: null,
        videoMimeType: null,
        videoWidth: 1280,
        videoHeight: 720,
        redirectType: 301,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        campaignName: 'Security Reference',
        tags: JSON.stringify(['security', 'webcrypto']),
        clicksCount: 64,
      },
    ];

    for (const item of sampleLinks) {
      const created = new Date(now - 10 * 86400_000).toISOString();
      insertLink.run(
        item.id,
        item.userId,
        item.slug,
        item.linkType,
        item.linkType === 'video' ? 1 : 0,
        0,
        item.destinationUrl,
        item.videoUrl,
        item.videoTitle,
        item.videoDescription,
        item.thumbnailUrl,
        item.videoMimeType,
        item.videoWidth,
        item.videoHeight,
        item.redirectType,
        1,
        item.utmSource,
        item.utmMedium,
        item.utmCampaign,
        item.campaignName,
        item.tags,
        item.clicksCount,
        created,
        created
      );
    }

    // Seed realistic privacy-friendly click history across the last 14 days
    const insertClick = db.prepare(`
      INSERT INTO clicks (
        id, link_id, clicked_at, country, device_type, browser, operating_system, referrer, anonymous_visitor_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const countries = ['United States', 'United Kingdom', 'Germany', 'Canada', 'Singapore', 'Japan', 'France'];
    const devices = ['Desktop', 'Desktop', 'Desktop', 'Mobile', 'Mobile', 'Tablet'];
    const browsers = ['Chrome', 'Chrome', 'Safari', 'Firefox', 'Edge'];
    const oss = ['macOS', 'Windows', 'iOS', 'Android', 'Linux'];
    const referrers = ['Direct', 'x.com', 'github.com', 'linkedin.com', 'news.ycombinator.com', 'google.com'];

    let clickSeq = 0;
    for (const item of sampleLinks) {
      for (let i = 0; i < item.clicksCount; i++) {
        clickSeq++;
        const daysAgo = i % 14;
        const hoursAgo = (i * 7) % 24;
        const ts = new Date(now - daysAgo * 86400_000 - hoursAgo * 3600_000).toISOString();
        insertClick.run(
          `clk_seed_${clickSeq}`,
          item.id,
          ts,
          countries[(i + clickSeq) % countries.length],
          devices[(i + clickSeq) % devices.length],
          browsers[(i + clickSeq) % browsers.length],
          oss[(i + clickSeq) % oss.length],
          referrers[(i + clickSeq) % referrers.length],
          `anon_seed_${(i % Math.max(18, Math.floor(item.clicksCount * 0.68))).toString().padStart(3, '0')}`
        );
      }
    }
  }
}

export function mapUserRow(row: Record<string, unknown>): PublicUser {
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

export function mapLinkRow(row: Record<string, unknown>): LinkRecord {
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
  const previewEnabled =
    row.preview_enabled !== undefined && row.preview_enabled !== null
      ? Number(row.preview_enabled) === 1
      : linkType === 'video';

  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    slug: String(row.slug),
    shortCode: String(row.slug),
    linkType,
    previewEnabled,
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

export function getSystemSettings(): SystemSettings {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const gWidth = Number(map.get('global_video_width') || 0);
  const gHeight = Number(map.get('global_video_height') || 0);
  return {
    siteName: map.get('site_name') || 'NasirLink',
    domain: map.get('domain') || 'nasirlink.com',
    defaultRedirectType: map.get('default_redirect_type') === '301' ? 301 : 302,
    registrationEnabled: map.get('registration_enabled') !== 'false',
    maxLinksPerUser: Number(map.get('max_links_per_user') || 500),
    rateLimitPerMin: Number(map.get('rate_limit_per_min') || 120),
    maintenanceMode: map.get('maintenance_mode') === 'true',
    globalVideoUrl: map.get('global_video_url') || null,
    globalVideoWidth: gWidth > 0 ? gWidth : null,
    globalVideoHeight: gHeight > 0 ? gHeight : null,
    globalVideoMimeType: map.get('global_video_mime_type') || null,
    globalVideoTitle: map.get('global_video_title') || null,
    globalVideoDescription: map.get('global_video_description') || null,
    globalVideoSourceUrl: map.get('global_video_source_url') || null,
    globalVideoOverride: map.get('global_video_override') === 'true',
    cloudflareApiToken: map.get('cloudflare_api_token') || null,
    cloudflareZoneId: map.get('cloudflare_zone_id') || null,
    cloudflareAccountId: map.get('cloudflare_account_id') || null,
    cloudflareTargetCname: map.get('cloudflare_target_cname') || null,
  };
}

export function updateSystemSettings(partial: Partial<SystemSettings>): SystemSettings {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const setOrDel = (key: string, value: string | null | undefined, now: string) => {
    if (value === undefined) return;
    if (value === null || value === '') del.run(key);
    else upsert.run(key, value, now);
  };

  const now = new Date().toISOString();
  if (partial.siteName !== undefined) upsert.run('site_name', partial.siteName, now);
  if (partial.domain !== undefined) upsert.run('domain', partial.domain, now);
  if (partial.defaultRedirectType !== undefined)
    upsert.run('default_redirect_type', String(partial.defaultRedirectType), now);
  if (partial.registrationEnabled !== undefined)
    upsert.run('registration_enabled', String(partial.registrationEnabled), now);
  if (partial.maxLinksPerUser !== undefined)
    upsert.run('max_links_per_user', String(partial.maxLinksPerUser), now);
  if (partial.rateLimitPerMin !== undefined)
    upsert.run('rate_limit_per_min', String(partial.rateLimitPerMin), now);
  if (partial.maintenanceMode !== undefined)
    upsert.run('maintenance_mode', String(partial.maintenanceMode), now);

  setOrDel('global_video_url', partial.globalVideoUrl, now);
  setOrDel(
    'global_video_width',
    partial.globalVideoWidth === undefined
      ? undefined
      : partial.globalVideoWidth && partial.globalVideoWidth > 0
        ? String(partial.globalVideoWidth)
        : null,
    now
  );
  setOrDel(
    'global_video_height',
    partial.globalVideoHeight === undefined
      ? undefined
      : partial.globalVideoHeight && partial.globalVideoHeight > 0
        ? String(partial.globalVideoHeight)
        : null,
    now
  );
  setOrDel('global_video_mime_type', partial.globalVideoMimeType, now);
  setOrDel('global_video_title', partial.globalVideoTitle, now);
  setOrDel('global_video_description', partial.globalVideoDescription, now);
  setOrDel('global_video_source_url', partial.globalVideoSourceUrl, now);
  if (partial.globalVideoOverride !== undefined)
    upsert.run('global_video_override', String(partial.globalVideoOverride), now);
  setOrDel('cloudflare_api_token', partial.cloudflareApiToken, now);
  setOrDel('cloudflare_zone_id', partial.cloudflareZoneId, now);
  setOrDel('cloudflare_account_id', partial.cloudflareAccountId, now);
  setOrDel('cloudflare_target_cname', partial.cloudflareTargetCname, now);

  return getSystemSettings();
}

function buildBreakdown(rows: Array<{ name: string; cnt: number }>): BreakdownItem[] {
  const total = rows.reduce((sum, r) => sum + Number(r.cnt), 0) || 1;
  return rows.map((r) => ({
    name: r.name || 'Unknown',
    count: Number(r.cnt),
    percentage: Math.round((Number(r.cnt) / total) * 1000) / 10,
  }));
}

export function computeAnalytics(userId?: string | null, linkId?: string | null): AnalyticsOverview {
  const db = getDb();
  const linkWhereParts: string[] = [];
  const linkParams: string[] = [];

  if (linkId) {
    linkWhereParts.push('id = ?');
    linkParams.push(linkId);
  } else if (userId) {
    linkWhereParts.push('(user_id = ? OR user_id IS NULL)');
    linkParams.push(userId);
  }

  const linkWhere = linkWhereParts.length ? `WHERE ${linkWhereParts.join(' AND ')}` : '';
  const links = db.prepare(`SELECT * FROM links ${linkWhere}`).all(...linkParams) as Array<Record<string, unknown>>;
  const linkIds = links.map((l) => String(l.id));

  const todayPrefix = new Date().toISOString().slice(0, 10);

  if (linkIds.length === 0) {
    return {
      totals: {
        totalLinks: 0,
        totalClicks: 0,
        activeLinks: 0,
        videoLinks: 0,
        todaysClicks: 0,
        uniqueVisitors: 0,
      },
      clicksOverTime: [],
      hourlyClicks: [],
      topLinks: [],
      devices: [],
      browsers: [],
      operatingSystems: [],
      referrers: [],
      countries: [],
    };
  }

  const placeholders = linkIds.map(() => '?').join(',');
  const totalClicks = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM clicks WHERE link_id IN (${placeholders})`)
      .get(...linkIds) as { cnt: number }
  ).cnt;

  const uniqueVisitors = (
    db
      .prepare(`SELECT COUNT(DISTINCT anonymous_visitor_id) as cnt FROM clicks WHERE link_id IN (${placeholders})`)
      .get(...linkIds) as { cnt: number }
  ).cnt;

  const todaysClicks = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM clicks WHERE link_id IN (${placeholders}) AND substr(clicked_at, 1, 10) = ?`
      )
      .get(...linkIds, todayPrefix) as { cnt: number }
  ).cnt;

  // Last 14 days series
  const dailyRows = db
    .prepare(
      `SELECT substr(clicked_at, 1, 10) as day, COUNT(*) as cnt, COUNT(DISTINCT anonymous_visitor_id) as uniq
       FROM clicks
       WHERE link_id IN (${placeholders})
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(...linkIds) as Array<{ day: string; cnt: number; uniq: number }>;

  const dailyMap = new Map(dailyRows.map((r) => [r.day, r]));
  const clicksOverTime: AnalyticsOverview['clicksOverTime'] = [];
  for (let d = 13; d >= 0; d--) {
    const dt = new Date(Date.now() - d * 86400_000);
    const key = dt.toISOString().slice(0, 10);
    const hit = dailyMap.get(key);
    clicksOverTime.push({
      label: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      clicks: hit ? Number(hit.cnt) : 0,
      uniqueVisitors: hit ? Number(hit.uniq) : 0,
    });
  }

  // Hourly distribution (00 - 23)
  const hourlyRows = db
    .prepare(
      `SELECT substr(clicked_at, 12, 2) as hr, COUNT(*) as cnt, COUNT(DISTINCT anonymous_visitor_id) as uniq
       FROM clicks
       WHERE link_id IN (${placeholders})
       GROUP BY hr
       ORDER BY hr ASC`
    )
    .all(...linkIds) as Array<{ hr: string; cnt: number; uniq: number }>;
  const hourlyMap = new Map(hourlyRows.map((r) => [r.hr, r]));
  const hourlyClicks: AnalyticsOverview['hourlyClicks'] = [];
  for (let h = 0; h < 24; h++) {
    const key = String(h).padStart(2, '0');
    const hit = hourlyMap.get(key);
    hourlyClicks.push({
      label: `${key}:00`,
      clicks: hit ? Number(hit.cnt) : 0,
      uniqueVisitors: hit ? Number(hit.uniq) : 0,
    });
  }

  const topLinks = links
    .map(mapLinkRow)
    .sort((a, b) => b.clicksCount - a.clicksCount)
    .slice(0, 6)
    .map((l) => ({
      id: l.id,
      slug: l.slug,
      linkType: l.linkType,
      destinationUrl: l.destinationUrl,
      clicks: l.clicksCount,
    }));

  const devices = buildBreakdown(
    db
      .prepare(
        `SELECT device_type as name, COUNT(*) as cnt FROM clicks WHERE link_id IN (${placeholders}) GROUP BY device_type ORDER BY cnt DESC`
      )
      .all(...linkIds) as Array<{ name: string; cnt: number }>
  );

  const browsers = buildBreakdown(
    db
      .prepare(
        `SELECT browser as name, COUNT(*) as cnt FROM clicks WHERE link_id IN (${placeholders}) GROUP BY browser ORDER BY cnt DESC`
      )
      .all(...linkIds) as Array<{ name: string; cnt: number }>
  );

  const operatingSystems = buildBreakdown(
    db
      .prepare(
        `SELECT operating_system as name, COUNT(*) as cnt FROM clicks WHERE link_id IN (${placeholders}) GROUP BY operating_system ORDER BY cnt DESC`
      )
      .all(...linkIds) as Array<{ name: string; cnt: number }>
  );

  const referrers = buildBreakdown(
    db
      .prepare(
        `SELECT referrer as name, COUNT(*) as cnt FROM clicks WHERE link_id IN (${placeholders}) GROUP BY referrer ORDER BY cnt DESC LIMIT 8`
      )
      .all(...linkIds) as Array<{ name: string; cnt: number }>
  );

  const countries = buildBreakdown(
    db
      .prepare(
        `SELECT country as name, COUNT(*) as cnt FROM clicks WHERE link_id IN (${placeholders}) GROUP BY country ORDER BY cnt DESC LIMIT 8`
      )
      .all(...linkIds) as Array<{ name: string; cnt: number }>
  );

  return {
    totals: {
      totalLinks: links.length,
      totalClicks,
      activeLinks: links.filter((l) => Number(l.is_active) === 1).length,
      videoLinks: links.filter((l) => l.link_type === 'video').length,
      todaysClicks,
      uniqueVisitors,
    },
    clicksOverTime,
    hourlyClicks,
    topLinks,
    devices,
    browsers,
    operatingSystems,
    referrers,
    countries,
  };
}

export function getAdminStats(): AdminStats {
  const db = getDb();
  const totalUsers = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  const activeUsers = (
    db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'").get() as { cnt: number }
  ).cnt;
  const totalLinks = (db.prepare('SELECT COUNT(*) as cnt FROM links').get() as { cnt: number }).cnt;
  const totalVideoLinks = (
    db.prepare("SELECT COUNT(*) as cnt FROM links WHERE link_type = 'video'").get() as { cnt: number }
  ).cnt;
  const totalClicks = (db.prepare('SELECT COUNT(*) as cnt FROM clicks').get() as { cnt: number }).cnt;
  const pendingReports = (
    db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE status = 'pending'").get() as { cnt: number }
  ).cnt;

  const regRows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) as date, COUNT(*) as count
       FROM users
       GROUP BY date
       ORDER BY date DESC
       LIMIT 14`
    )
    .all() as Array<{ date: string; count: number }>;

  return {
    totalUsers,
    totalLinks,
    totalVideoLinks,
    totalClicks,
    activeUsers,
    dailyRegistrations: regRows.reverse(),
    pendingReports,
  };
}

export function listReports(): AbuseReport[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 100').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: String(r.id),
    linkId: r.link_id ? String(r.link_id) : null,
    slug: String(r.slug),
    reason: String(r.reason),
    details: r.details ? String(r.details) : null,
    status: r.status as AbuseReport['status'],
    createdAt: String(r.created_at),
  }));
}

export function createClickRecord(params: {
  linkId: string;
  country: string;
  deviceType: string;
  browser: string;
  operatingSystem: string;
  referrer: string;
  anonymousVisitorId: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO clicks (
      id, link_id, clicked_at, country, device_type, browser, operating_system, referrer, anonymous_visitor_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomId('clk'),
    params.linkId,
    new Date().toISOString(),
    params.country,
    params.deviceType,
    params.browser,
    params.operatingSystem,
    params.referrer,
    params.anonymousVisitorId
  );

  db.prepare('UPDATE links SET clicks_count = clicks_count + 1, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    params.linkId
  );
}

export function mapDomainRow(row: Record<string, unknown>): CustomDomain {
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    hostname: String(row.hostname),
    cloudflareMode: (row.cloudflare_mode as 'zone' | 'saas') || 'zone',
    cloudflareZoneId: row.cloudflare_zone_id ? String(row.cloudflare_zone_id) : null,
    cloudflareHostnameId: row.cloudflare_hostname_id ? String(row.cloudflare_hostname_id) : null,
    dnsStatus: (row.dns_status as 'pending' | 'verified' | 'active' | 'failed') || 'pending',
    sslStatus: (row.ssl_status as 'pending' | 'active' | 'failed') || 'pending',
    domainStatus: (row.domain_status as 'active' | 'suspended' | 'maintenance') || 'active',
    isDefault: Number(row.is_default) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listCustomDomains(): CustomDomain[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM custom_domains ORDER BY is_default DESC, created_at DESC').all() as Record<string, unknown>[];
  return rows.map(mapDomainRow);
}

export function getCustomDomainById(id: string): CustomDomain | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM custom_domains WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapDomainRow(row) : null;
}

export function getCustomDomainByHostname(hostname: string): CustomDomain | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM custom_domains WHERE hostname = ? COLLATE NOCASE').get(hostname.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row ? mapDomainRow(row) : null;
}

export function getDefaultCustomDomain(): CustomDomain | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM custom_domains WHERE is_default = 1 LIMIT 1').get() as Record<string, unknown> | undefined;
  return row ? mapDomainRow(row) : null;
}

export function createCustomDomain(data: {
  userId?: string | null;
  hostname: string;
  cloudflareMode?: 'zone' | 'saas';
  cloudflareZoneId?: string | null;
  cloudflareHostnameId?: string | null;
  dnsStatus?: 'pending' | 'verified' | 'active' | 'failed';
  sslStatus?: 'pending' | 'active' | 'failed';
  domainStatus?: 'active' | 'suspended' | 'maintenance';
  isDefault?: boolean;
}): CustomDomain {
  const db = getDb();
  const id = `dom_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const now = new Date().toISOString();
  const cleanHost = data.hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (data.isDefault) {
    db.prepare('UPDATE custom_domains SET is_default = 0').run();
  }

  db.prepare(`
    INSERT INTO custom_domains (
      id, user_id, hostname, cloudflare_mode, cloudflare_zone_id, cloudflare_hostname_id,
      dns_status, ssl_status, domain_status, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.userId || null,
    cleanHost,
    data.cloudflareMode || 'zone',
    data.cloudflareZoneId || null,
    data.cloudflareHostnameId || null,
    data.dnsStatus || 'active',
    data.sslStatus || 'active',
    data.domainStatus || 'active',
    data.isDefault ? 1 : 0,
    now,
    now
  );

  return {
    id,
    userId: data.userId || null,
    hostname: cleanHost,
    cloudflareMode: data.cloudflareMode || 'zone',
    cloudflareZoneId: data.cloudflareZoneId || null,
    cloudflareHostnameId: data.cloudflareHostnameId || null,
    dnsStatus: data.dnsStatus || 'active',
    sslStatus: data.sslStatus || 'active',
    domainStatus: data.domainStatus || 'active',
    isDefault: Boolean(data.isDefault),
    createdAt: now,
    updatedAt: now,
  };
}

export function updateCustomDomain(id: string, partial: Partial<CustomDomain>): CustomDomain | null {
  const db = getDb();
  const existing = getCustomDomainById(id);
  if (!existing) return null;

  if (partial.isDefault) {
    db.prepare('UPDATE custom_domains SET is_default = 0 WHERE id != ?').run(id);
  }

  const now = new Date().toISOString();
  const updated: CustomDomain = {
    ...existing,
    ...partial,
    updatedAt: now,
  };

  db.prepare(`
    UPDATE custom_domains SET
      hostname = ?,
      cloudflare_mode = ?,
      cloudflare_zone_id = ?,
      cloudflare_hostname_id = ?,
      dns_status = ?,
      ssl_status = ?,
      domain_status = ?,
      is_default = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    updated.hostname,
    updated.cloudflareMode,
    updated.cloudflareZoneId,
    updated.cloudflareHostnameId,
    updated.dnsStatus,
    updated.sslStatus,
    updated.domainStatus,
    updated.isDefault ? 1 : 0,
    now,
    id
  );

  return updated;
}

export function deleteCustomDomain(id: string): boolean {
  const db = getDb();
  const res = db.prepare('DELETE FROM custom_domains WHERE id = ?').run(id);
  return res.changes > 0;
}
