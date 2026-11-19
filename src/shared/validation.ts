import { z } from 'zod';

export const RESERVED_SLUGS = new Set([
  'admin',
  'dashboard',
  'api',
  'login',
  'register',
  'forgot-password',
  'reset-password',
  'verify-email',
  'settings',
  'analytics',
  'video',
  'v',
  's',
  'r',
  'embed',
  'video-links',
  'links',
  'qr',
  'qr-codes',
  'preview',
  'player',
  'media',
  'poster',
  'assets',
  'health',
  'sitemap.xml',
  'robots.txt',
  'unlock',
  'status',
  'docs',
  'src',
]);

export const ALIAS_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd/i,
  /\.local$/i,
  /\.internal$/i,
  /\.localhost$/i,
  /\.lan$/i,
];

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

export function validateSafeExternalUrl(
  rawInput: string,
  allowRelativeSample = false,
  requireHttps = false
): UrlValidationResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { valid: false, error: 'URL is required.' };
  }

  if (allowRelativeSample && trimmed.startsWith('/api/sample-video/')) {
    return { valid: true, normalizedUrl: trimmed };
  }

  if (allowRelativeSample && trimmed.startsWith('/src/assets/')) {
    return { valid: true, normalizedUrl: trimmed };
  }

  if (
    allowRelativeSample &&
    trimmed.length <= 220_000 &&
    /^data:image\/(jpeg|jpg|png|webp);base64,[a-zA-Z0-9+/=]+$/i.test(trimmed)
  ) {
    return { valid: true, normalizedUrl: trimmed };
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vbscript:')
  ) {
    return { valid: false, error: 'Unsafe URL protocol is not permitted.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Enter a valid HTTP or HTTPS URL.' };
  }

  if (requireHttps) {
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'External video and player URLs must use HTTPS.' };
    }
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only http:// and https:// URLs are permitted.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Embedded credentials in URLs are not allowed.' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || !hostname.includes('.') && !PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(hostname))) {
    // Allow valid single-label only if not blocked, actually require dot for public hostnames
    if (!hostname.includes('.')) {
      return { valid: false, error: 'Destination must use a valid public domain name.' };
    }
  }

  if (PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return { valid: false, error: 'Localhost, private network, and metadata IP addresses are blocked.' };
  }

  // Block integer/hex IP bypass forms like http://2130706433 or http://0x7f000001
  if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
    return { valid: false, error: 'Numeric or hex IP hostnames are blocked.' };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

export function validateCustomAlias(alias: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = alias.trim();
  if (!normalized) {
    return { valid: false, normalized, error: 'Alias cannot be empty.' };
  }
  if (normalized.length < 3 || normalized.length > 50) {
    return { valid: false, normalized, error: 'Alias must be between 3 and 50 characters.' };
  }
  if (!ALIAS_REGEX.test(normalized)) {
    return { valid: false, normalized, error: 'Alias may only contain letters, numbers, hyphens, and underscores.' };
  }
  if (RESERVED_SLUGS.has(normalized.toLowerCase())) {
    return { valid: false, normalized, error: `"${normalized}" is a reserved system route.` };
  }
  return { valid: true, normalized };
}

export function convertGitHubVideoUrl(inputUrl: string): {
  normalizedUrl: string;
  convertedFromGithub: boolean;
} {
  const trimmed = inputUrl.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() === 'github.com') {
      // Pattern: https://github.com/user/repo/blob/branch/path/to/video.mp4
      const blobMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
      if (blobMatch) {
        const [, owner, repo, rest] = blobMatch;
        return {
          normalizedUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`,
          convertedFromGithub: true,
        };
      }
      // Pattern: https://github.com/user/repo/raw/branch/path/to/video.mp4
      const rawMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/raw\/(.+)$/);
      if (rawMatch) {
        const [, owner, repo, rest] = rawMatch;
        return {
          normalizedUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`,
          convertedFromGithub: true,
        };
      }
    }
  } catch {
    // Handled by URL validator downstream
  }
  return { normalizedUrl: trimmed, convertedFromGithub: false };
}

export interface VideoValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  convertedFromGithub: boolean;
  mimeType?: 'video/mp4' | 'video/webm';
  error?: string;
}

export function validateVideoUrl(rawUrl: string): VideoValidationResult {
  const { normalizedUrl, convertedFromGithub } = convertGitHubVideoUrl(rawUrl);
  const urlCheck = validateSafeExternalUrl(normalizedUrl, true, true);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return {
      valid: false,
      convertedFromGithub,
      error: urlCheck.error || 'Invalid video URL.',
    };
  }

  const cleanPath = urlCheck.normalizedUrl.split('?')[0].split('#')[0].toLowerCase();
  if (cleanPath.endsWith('.mp4')) {
    return {
      valid: true,
      normalizedUrl: urlCheck.normalizedUrl,
      convertedFromGithub,
      mimeType: 'video/mp4',
    };
  }
  if (cleanPath.endsWith('.webm')) {
    return {
      valid: true,
      normalizedUrl: urlCheck.normalizedUrl,
      convertedFromGithub,
      mimeType: 'video/webm',
    };
  }

  return {
    valid: false,
    convertedFromGithub,
    error: 'Unsupported video format. Direct HTTPS URL must point to an .mp4 or .webm file.',
  };
}

export function detectVideoMimeFromContentType(contentType: string | null | undefined): 'video/mp4' | 'video/webm' | null {
  if (!contentType) return null;
  const lower = contentType.toLowerCase();
  if (lower.includes('video/mp4')) return 'video/mp4';
  if (lower.includes('video/webm')) return 'video/webm';
  return null;
}

export function generateRandomSlug(length = 6): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  if (RESERVED_SLUGS.has(out.toLowerCase())) {
    return generateRandomSlug(length);
  }
  return out;
}

export function appendUtmParams(
  destinationUrl: string,
  utm: { source?: string | null; medium?: string | null; campaign?: string | null }
): string {
  try {
    const url = new URL(destinationUrl);
    if (utm.source && !url.searchParams.has('utm_source')) {
      url.searchParams.set('utm_source', utm.source);
    }
    if (utm.medium && !url.searchParams.has('utm_medium')) {
      url.searchParams.set('utm_medium', utm.medium);
    }
    if (utm.campaign && !url.searchParams.has('utm_campaign')) {
      url.searchParams.set('utm_campaign', utm.campaign);
    }
    return url.toString();
  } catch {
    return destinationUrl;
  }
}

export const createLinkSchema = z.object({
  destinationUrl: z.string().min(1, 'Destination URL is required'),
  customAlias: z.string().optional().nullable(),
  linkType: z.enum(['normal', 'video']).default('normal'),
  previewEnabled: z.boolean().optional(),
  autoRedirectSeconds: z.number().int().min(0).max(120).optional().default(0),
  videoUrl: z.string().optional().nullable(),
  videoTitle: z.string().max(120, 'Title must be 120 characters or less').optional().nullable(),
  videoDescription: z.string().max(500, 'Description must be 500 characters or less').optional().nullable(),
  thumbnailUrl: z.string().optional().nullable(),
  videoWidth: z.number().int().min(160).max(3840).optional().nullable(),
  videoHeight: z.number().int().min(90).max(3840).optional().nullable(),
  twitterCardType: z.enum(['player', 'summary_large_image']).optional().default('player'),
  playerUrl: z.string().optional().nullable(),
  redirectType: z.union([z.literal(301), z.literal(302)]).optional().default(302),
  password: z.string().max(128).optional().nullable(),
  expiresAt: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  utmSource: z.string().max(100).optional().nullable(),
  utmMedium: z.string().max(100).optional().nullable(),
  utmCampaign: z.string().max(100).optional().nullable(),
  campaignName: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(32)).max(10).optional().default([]),
});

export const updateLinkSchema = createLinkSchema.partial().extend({
  clearPassword: z.boolean().optional(),
});

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().email('Valid email address required').max(160),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Valid email address required'),
  password: z.string().min(1, 'Password is required'),
});

export const reportLinkSchema = z.object({
  slug: z.string().min(1).max(64),
  reason: z.enum(['phishing', 'malware', 'spam', 'deceptive_video', 'copyright', 'other']),
  details: z.string().max(500).optional().nullable(),
});

export const qrRequestSchema = z.object({
  url: z.string().min(1),
  fgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0F172A'),
  bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  size: z.number().int().min(128).max(1024).default(320),
  includeLogo: z.boolean().default(false),
  logoText: z.string().max(4).default('NL'),
  logoDataUrl: z.string().max(350000).optional().nullable(),
});
