import { appendUtmParams } from '../shared/validation.ts';
import { escapeHtml } from './crypto.ts';
import { sanitizeSourceAttribution } from './videoProbe.ts';
import type {
  LinkRecord,
  MetadataValidationCheck,
  SocialMetadataPreview,
  SystemSettings,
} from '../shared/types.ts';

function normalizeOrigin(origin: string): { isLocal: boolean; safeOrigin: string } {
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const safeOrigin = isLocal ? origin : origin.replace(/^http:\/\//i, 'https://');
  return { isLocal, safeOrigin };
}

function resolveAbsoluteUrl(urlOrPath: string | null | undefined, origin: string): string {
  if (!urlOrPath) return '';
  const trimmed = urlOrPath.trim();
  const { isLocal, safeOrigin } = normalizeOrigin(origin);
  if (/^https?:\/\//i.test(trimmed)) {
    return isLocal ? trimmed : trimmed.replace(/^http:\/\//i, 'https://');
  }
  if (trimmed.startsWith('/')) return `${safeOrigin}${trimmed}`;
  return `${safeOrigin}/${trimmed}`;
}

export interface EffectiveVideoResolution {
  videoUrl: string;
  mimeType: 'video/mp4' | 'video/webm' | '';
  width: number;
  height: number;
  title: string;
  description: string;
  sourceUrl: string;
  sourceDomain: string;
  hasValidVideo: boolean;
  videoError?: string;
}

export function resolveMediaAccessUrl(
  link: LinkRecord,
  origin: string,
  videoUrlOverride?: string | null,
  mimeOverride?: string | null
): string {
  const { safeOrigin } = normalizeOrigin(origin);
  const targetUrl = (videoUrlOverride ?? link.videoUrl ?? '').trim();
  const ext =
    mimeOverride === 'video/webm' ||
    link.videoMimeType === 'video/webm' ||
    targetUrl.toLowerCase().split('?')[0].endsWith('.webm')
      ? 'webm'
      : 'mp4';
  return `${safeOrigin}/media/${encodeURIComponent(link.slug)}.${ext}`;
}

export function selectSocialStreamUrl(
  link: LinkRecord,
  safeOrigin: string,
  rawVideoUrl?: string | null,
  mimeOverride?: string | null
): string {
  const raw = (rawVideoUrl ?? link.videoUrl ?? '').trim();
  if (!raw) return '';
  // Local bundled sample streams and raw.githubusercontent.com URLs (which often return
  // application/octet-stream) are proxied through first-party /media/:slug.mp4 with
  // guaranteed video/mp4 Content-Type and Byte-Range 206 support.
  if (raw.startsWith('/') || /raw\.githubusercontent\.com/i.test(raw)) {
    return resolveMediaAccessUrl(link, safeOrigin, raw, mimeOverride);
  }
  return resolveAbsoluteUrl(raw, safeOrigin);
}

function getSafeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export const SAMPLE_TIMESTAMP_TITLES = [
  '46:44', '59:52', '32:31', '39:45', '03:32',
  '28:15', '51:08', '19:42', '35:18', '42:07',
];

export function resolveVideoDimensions(
  videoUrl: string | null | undefined,
  storedWidth?: number | null,
  storedHeight?: number | null
): { width: number; height: number } {
  const url = (videoUrl || '').trim();
  const w = Number(storedWidth || 0);
  const h = Number(storedHeight || 0);

  // Known local sample files — verify actual container dimensions
  if (url.includes('showcase1.mp4')) {
    return {
      width: w >= 160 && w !== 1280 ? w : 1290,
      height: h >= 90 && h !== 720 ? h : 720,
    };
  }
  if (url.includes('showcase.mp4')) {
    // showcase.mp4 native dimensions are 720x1278 portrait
    return {
      width: w >= 160 && !(w === 1280 && h === 720) ? w : 720,
      height: h >= 90 && !(w === 1280 && h === 720) ? h : 1278,
    };
  }

  // Respect explicit stored dimensions read from video metadata
  if (w >= 160 && w <= 3840 && h >= 90 && h <= 3840) {
    return { width: w, height: h };
  }

  // Extract explicit resolution embedded in URL path/filename (e.g. /720x1278/ or _1080x1920.)
  const match = url.match(/[/_](\d{3,4})x(\d{3,4})[./_?]/i);
  if (match) {
    const parsedW = parseInt(match[1], 10);
    const parsedH = parseInt(match[2], 10);
    if (parsedW >= 160 && parsedW <= 3840 && parsedH >= 90 && parsedH <= 3840) {
      return { width: parsedW, height: parsedH };
    }
  }

  return { width: 0, height: 0 };
}

function pickTitleFromVariants(link: LinkRecord, candidateTitle: string): string {
  let activeTitle = candidateTitle;
  if (Array.isArray(link.metadataVariants) && link.metadataVariants.length > 0) {
    const activeVariants = link.metadataVariants.filter((v) => v.isActive !== false);
    if (activeVariants.length > 0) {
      const variant = activeVariants[Math.floor(Math.random() * activeVariants.length)];
      if (variant?.title) activeTitle = variant.title.trim();
    }
  } else if (activeTitle.includes('|') || activeTitle.includes(',')) {
    const parts = activeTitle
      .split(/[|,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      activeTitle = parts[Math.floor(Math.random() * parts.length)];
    }
  } else if (
    activeTitle.toLowerCase() === 'random' ||
    activeTitle.toLowerCase() === 'rendom' ||
    /^\d{1,2}:\d{2}$/.test(activeTitle)
  ) {
    activeTitle = SAMPLE_TIMESTAMP_TITLES[Math.floor(Math.random() * SAMPLE_TIMESTAMP_TITLES.length)];
  }
  return activeTitle;
}

export function resolveEffectiveVideo(
  link: LinkRecord,
  origin: string,
  globalConfig?: SystemSettings
): EffectiveVideoResolution {
  const { safeOrigin } = normalizeOrigin(origin);
  const destDomain = getSafeDomain(link.destinationUrl);

  const useGlobal =
    Boolean(globalConfig?.globalVideoUrl?.trim()) &&
    (Boolean(globalConfig?.globalVideoOverride) || !link.videoUrl?.trim());

  const rawVideoUrl = useGlobal
    ? (globalConfig?.globalVideoUrl || '').trim()
    : (link.videoUrl || '').trim();

  const rawWidth = useGlobal
    ? globalConfig?.globalVideoWidth ?? link.videoWidth
    : link.videoWidth;
  const rawHeight = useGlobal
    ? globalConfig?.globalVideoHeight ?? link.videoHeight
    : link.videoHeight;
  const rawMime = useGlobal
    ? globalConfig?.globalVideoMimeType || link.videoMimeType
    : link.videoMimeType;

  const baseTitle = useGlobal
    ? globalConfig?.globalVideoTitle?.trim() || link.videoTitle?.trim() || `Video Preview: ${link.slug}`
    : link.videoTitle?.trim() || `Video Preview: ${link.slug}`;
  const title = pickTitleFromVariants(link, baseTitle);

  const description = useGlobal
    ? globalConfig?.globalVideoDescription?.trim() ||
      link.videoDescription?.trim() ||
      `${destDomain}.`
    : link.videoDescription?.trim() || ` ${destDomain}.`;

  if (!rawVideoUrl) {
    return {
      videoUrl: '',
      mimeType: '',
      width: 0,
      height: 0,
      title,
      description,
      sourceUrl: '',
      sourceDomain: '',
      hasValidVideo: false,
      videoError: 'No video URL is configured for this link or in Global Video Settings.',
    };
  }

  const streamUrl = selectSocialStreamUrl(link, safeOrigin, rawVideoUrl, rawMime);
  const cleanExtUrl = rawVideoUrl.split('?')[0].split('#')[0].toLowerCase();
  const mimeType: 'video/mp4' | 'video/webm' | '' =
    rawMime === 'video/webm' || cleanExtUrl.endsWith('.webm')
      ? 'video/webm'
      : rawMime === 'video/mp4' || cleanExtUrl.endsWith('.mp4')
        ? 'video/mp4'
        : '';

  if (!streamUrl || !mimeType) {
    return {
      videoUrl: streamUrl,
      mimeType: '',
      width: 0,
      height: 0,
      title,
      description,
      sourceUrl: '',
      sourceDomain: '',
      hasValidVideo: false,
      videoError: 'Configured video URL is not a valid direct HTTPS MP4 or WebM stream.',
    };
  }

  const dims = resolveVideoDimensions(rawVideoUrl, rawWidth, rawHeight);
  const explicitSource = useGlobal ? globalConfig?.globalVideoSourceUrl : undefined;
  const attribution = sanitizeSourceAttribution(rawVideoUrl, explicitSource, safeOrigin);

  return {
    videoUrl: streamUrl,
    mimeType,
    width: dims.width,
    height: dims.height,
    title,
    description,
    sourceUrl: attribution.sourceUrl,
    sourceDomain: attribution.sourceDomain,
    hasValidVideo: true,
  };
}

export function resolvePosterAccessUrl(link: LinkRecord, origin: string): string {
  const { isLocal, safeOrigin } = normalizeOrigin(origin);
  const thumb = (link.thumbnailUrl || '').trim();
  if (/^https?:\/\//i.test(thumb)) {
    return isLocal ? thumb : thumb.replace(/^http:\/\//i, 'https://');
  }
  return `${safeOrigin}/poster/${encodeURIComponent(link.slug)}.jpg`;
}

export function buildSocialMetadata(
  link: LinkRecord,
  origin: string,
  canonicalPath?: string,
  globalConfig?: SystemSettings
): SocialMetadataPreview {
  const { isLocal, safeOrigin } = normalizeOrigin(origin);
  const resolved = resolveEffectiveVideo(link, safeOrigin, globalConfig);

  const pageUrl = canonicalPath
    ? `${safeOrigin}${canonicalPath.startsWith('/') ? canonicalPath : `/${canonicalPath}`}`
    : `${safeOrigin}/s/${encodeURIComponent(link.slug)}`;

  const host = (() => {
    try {
      return new URL(safeOrigin).host;
    } catch {
      return '';
    }
  })();

  const hasDetectedDims = resolved.width >= 160 && resolved.height >= 90;
  const detectedWidth = hasDetectedDims ? Math.max(160, Math.min(3840, resolved.width)) : 0;
  const detectedHeight = hasDetectedDims ? Math.max(90, Math.min(3840, resolved.height)) : 0;

  const playerUrl =
    resolveAbsoluteUrl(link.playerUrl, safeOrigin) ||
    `${safeOrigin}/embed/${encodeURIComponent(link.slug)}`;
  const oembedUrl = `${safeOrigin}/api/oembed?url=${encodeURIComponent(pageUrl)}`;
  const posterUrl = resolvePosterAccessUrl(link, safeOrigin);
  const hasExplicitPoster = Boolean((link.thumbnailUrl || '').trim());
  const isDefaultPoster = !/^https?:\/\//i.test((link.thumbnailUrl || '').trim());
  const defaultPosterW = (link.videoUrl || '').includes('showcase1.mp4') ? 1290 : 720;
  const defaultPosterH = (link.videoUrl || '').includes('showcase1.mp4') ? 720 : 1278;
  const effectiveImageWidth = isDefaultPoster ? (hasExplicitPoster && detectedWidth > 0 ? detectedWidth : defaultPosterW) : undefined;
  const effectiveImageHeight = isDefaultPoster ? (hasExplicitPoster && detectedHeight > 0 ? detectedHeight : defaultPosterH) : undefined;

  const secureVideoUrl = isLocal
    ? resolved.videoUrl
    : resolved.videoUrl.replace(/^http:\/\//i, 'https://');

  const hasValidVideo = resolved.hasValidVideo && Boolean(secureVideoUrl) && Boolean(resolved.mimeType);
  // Always provide valid positive dimensions for X Player Card & OpenGraph video tags
  const effectiveWidth = hasValidVideo ? (hasDetectedDims ? detectedWidth : 1280) : 0;
  const effectiveHeight = hasValidVideo ? (hasDetectedDims ? detectedHeight : 720) : 0;
  const effectiveCardType = hasValidVideo
    ? link.twitterCardType === 'summary_large_image'
      ? 'summary_large_image'
      : 'player'
    : 'summary_large_image';
  const siteName = (globalConfig?.siteName || 'NasirLink').trim() || 'NasirLink';

  const metaLines: string[] = [];

  if (hasValidVideo) {
    metaLines.push(
      `<meta name="twitter:card" content="${effectiveCardType}" />`,
      ...(host ? [`<meta name="twitter:domain" content="${escapeHtml(host)}" />`] : []),
      `<meta name="twitter:title" content="${escapeHtml(resolved.title)}" />`,
      ...(resolved.description
        ? [`<meta name="twitter:description" content="${escapeHtml(resolved.description)}" />`]
        : []),
      `<meta name="twitter:image" content="${escapeHtml(posterUrl)}" />`,
      `<meta name="twitter:image:alt" content="${escapeHtml(resolved.title)}" />`,
      ...(effectiveCardType === 'player'
        ? [
            `<meta name="twitter:player" content="${escapeHtml(playerUrl)}" />`,
            `<meta name="twitter:player:width" content="${effectiveWidth}" />`,
            `<meta name="twitter:player:height" content="${effectiveHeight}" />`,
            `<meta name="twitter:player:stream" content="${escapeHtml(secureVideoUrl)}" />`,
            `<meta name="twitter:player:stream:content_type" content="${escapeHtml(resolved.mimeType)}" />`,
          ]
        : []),
      `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
      `<meta property="og:type" content="video.other" />`,
      `<meta property="og:title" content="${escapeHtml(resolved.title)}" />`,
      ...(resolved.description
        ? [`<meta property="og:description" content="${escapeHtml(resolved.description)}" />`]
        : []),
      `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
      `<meta property="og:image" content="${escapeHtml(posterUrl)}" />`,
      `<meta property="og:image:url" content="${escapeHtml(posterUrl)}" />`,
      `<meta property="og:image:secure_url" content="${escapeHtml(posterUrl)}" />`,
      `<meta property="og:image:type" content="image/jpeg" />`,
      ...(effectiveImageWidth && effectiveImageHeight
        ? [
            `<meta property="og:image:width" content="${effectiveImageWidth}" />`,
            `<meta property="og:image:height" content="${effectiveImageHeight}" />`,
          ]
        : []),
      `<meta property="og:video" content="${escapeHtml(secureVideoUrl)}" />`,
      `<meta property="og:video:url" content="${escapeHtml(secureVideoUrl)}" />`,
      `<meta property="og:video:secure_url" content="${escapeHtml(secureVideoUrl)}" />`,
      `<meta property="og:video:type" content="${escapeHtml(resolved.mimeType)}" />`,
      `<meta property="og:video:width" content="${effectiveWidth}" />`,
      `<meta property="og:video:height" content="${effectiveHeight}" />`,
      `<link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${escapeHtml(resolved.title)}" />`
    );
  } else {
    metaLines.push(
      `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:title" content="${escapeHtml(resolved.title)}" />`,
      ...(resolved.description
        ? [`<meta property="og:description" content="${escapeHtml(resolved.description)}" />`]
        : []),
      `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
      `<meta property="og:image" content="${escapeHtml(posterUrl)}" />`,
      `<meta property="og:image:secure_url" content="${escapeHtml(posterUrl)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escapeHtml(resolved.title)}" />`,
      ...(resolved.description
        ? [`<meta name="twitter:description" content="${escapeHtml(resolved.description)}" />`]
        : []),
      `<meta name="twitter:image" content="${escapeHtml(posterUrl)}" />`
    );
  }

  const orientation =
    effectiveWidth > effectiveHeight
      ? 'Landscape'
      : effectiveHeight > effectiveWidth
        ? 'Portrait'
        : effectiveWidth > 0
          ? 'Square'
          : 'Unknown';

  const checks: MetadataValidationCheck[] = [
    {
      id: 'video_configured',
      label: 'Video Stream Configuration',
      passed: hasValidVideo,
      detail: hasValidVideo
        ? `${resolved.mimeType} · ${secureVideoUrl}`
        : resolved.videoError || 'No valid MP4/WebM video URL configured',
    },
    {
      id: 'card_type',
      label: 'X & OpenGraph Video Card Tags',
      passed: hasValidVideo,
      detail: hasValidVideo
        ? `twitter:card="${effectiveCardType}" + twitter:image + og:image + og:video emitted`
        : 'Video stream missing or invalid; summary_large_image fallback emitted.',
    },
    {
      id: 'poster_image',
      label: 'Social Poster / Thumbnail Image',
      passed: Boolean(posterUrl),
      detail: posterUrl,
    },
    {
      id: 'player_https',
      label: 'Embed Player HTTPS URL',
      passed: isLocal ? /^https?:\/\//i.test(playerUrl) : playerUrl.startsWith('https://'),
      detail: playerUrl,
    },
    {
      id: 'dimensions',
      label: 'Original Video Aspect Ratio & Dimensions',
      passed: hasDetectedDims,
      detail: hasDetectedDims
        ? `${detectedWidth} × ${detectedHeight} px (${orientation})`
        : hasValidVideo
          ? `Using ${effectiveWidth}×${effectiveHeight} fallback — click "Verify Stream" to read exact container dimensions.`
          : 'Dimensions unavailable without a valid video stream.',
    },
    {
      id: 'source_attribution',
      label: 'Source Domain Attribution Link',
      passed: Boolean(resolved.sourceDomain && resolved.sourceUrl),
      detail:
        resolved.sourceDomain && resolved.sourceUrl
          ? `From ${resolved.sourceDomain} (${resolved.sourceUrl})`
          : 'Source domain unavailable',
    },
  ];

  return {
    title: resolved.title,
    description: resolved.description,
    url: pageUrl,
    ogType: hasValidVideo ? 'video.other' : 'website',
    ogImage: posterUrl,
    ogImageUrl: posterUrl,
    ogImageSecureUrl: posterUrl,
    ogImageType: 'image/jpeg',
    ogImageWidth: effectiveImageWidth,
    ogImageHeight: effectiveImageHeight,
    ogVideo: hasValidVideo ? secureVideoUrl : '',
    ogVideoUrl: hasValidVideo ? secureVideoUrl : '',
    ogVideoSecureUrl: hasValidVideo ? secureVideoUrl : '',
    ogVideoType: hasValidVideo ? resolved.mimeType : '',
    ogVideoWidth: effectiveWidth,
    ogVideoHeight: effectiveHeight,
    twitterCard: effectiveCardType,
    twitterTitle: resolved.title,
    twitterDescription: resolved.description,
    twitterImage: posterUrl,
    twitterPlayer: hasValidVideo ? playerUrl : '',
    twitterPlayerWidth: effectiveWidth,
    twitterPlayerHeight: effectiveHeight,
    twitterPlayerStream: hasValidVideo ? secureVideoUrl : '',
    twitterPlayerStreamContentType: hasValidVideo ? resolved.mimeType : '',
    sourceUrl: resolved.sourceUrl,
    sourceDomain: resolved.sourceDomain,
    hasValidVideo,
    videoError: resolved.videoError,
    renderedMetaHtml: metaLines.join('\n'),
    checks,
  };
}

export function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function renderLandingBodySnapshot(
  link: LinkRecord,
  origin: string,
  globalConfig?: SystemSettings,
  canonicalPath?: string
): string {
  const meta = buildSocialMetadata(link, origin, canonicalPath, globalConfig);
  const finalDest = appendUtmParams(link.destinationUrl, {
    source: link.utmSource,
    medium: link.utmMedium,
    campaign: link.utmCampaign,
  });
  const destDomain = getSafeDomain(finalDest);
  const safeDest = escapeHtml(finalDest);
  const safeDomain = escapeHtml(destDomain);
  const safeTitle = escapeHtml(meta.title);
  const safeDesc = escapeHtml(meta.description);
  const safeVideo = escapeHtml(meta.ogVideo);
  const hasRealPoster = Boolean((link.thumbnailUrl || '').trim());
  const safePoster = hasRealPoster ? escapeHtml(meta.ogImage || resolvePosterAccessUrl(link, origin)) : '';
  const posterAttr = safePoster ? ` poster="${safePoster}"` : '';
  const safeMime = escapeHtml(meta.ogVideoType || 'video/mp4');
  const aspectCss =
    meta.ogVideoWidth > 0 && meta.ogVideoHeight > 0
      ? `${meta.ogVideoWidth} / ${meta.ogVideoHeight}`
      : '9 / 16';

  return `<main style="max-width:720px;margin:0 auto;padding:24px 16px;font-family:system-ui,-apple-system,sans-serif;color:#0f172a;">
      ${
        meta.hasValidVideo && safeVideo
          ? `<div style="background:#000;display:flex;justify-content:center;align-items:center;">
              <video controls autoplay muted playsinline loop preload="auto"${posterAttr} style="width:100%;max-height:75vh;aspect-ratio:${aspectCss};object-fit:contain;display:block;background:#000;">
                <source src="${safeVideo}" type="${safeMime}" />
              </video>
            </div>
            ${
              meta.sourceUrl && meta.sourceDomain
                ? `<div style="margin-top:8px;font-size:13px;">
                    <a href="${escapeHtml(meta.sourceUrl)}" target="_blank" rel="noopener noreferrer" style="color:#475569;text-decoration:none;">From ${escapeHtml(meta.sourceDomain)}</a>
                  </div>`
                : ''
            }`
          : `<div style="padding:20px;border:1px solid #fecdd3;background:#fff1f2;color:#9f1239;font-size:14px;">
              ${escapeHtml(meta.videoError || 'Configured video is unavailable.')}
            </div>`
      }
      <h1 style="font-size:20px;font-weight:700;margin:16px 0 6px;">${safeTitle}</h1>
      ${safeDesc ? `<p style="font-size:14px;color:#475569;margin:0 0 16px;line-height:1.5;">${safeDesc}</p>` : ''}
      <div style="padding:14px;background:#f8fafc;border:1px solid #e2e8f0;">
        <div style="font-size:12px;color:#64748b;margin-bottom:4px;">Short link destination: <strong>${safeDomain}</strong></div>
        <div style="font-size:12px;font-family:monospace;color:#334155;word-break:break-all;margin-bottom:12px;">${safeDest}</div>
        <a href="${safeDest}" rel="noopener noreferrer" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;">Open Destination Website</a>
      </div>
    </main>`;
}

export function injectVideoMetaIntoHtml(
  baseHtml: string,
  meta: SocialMetadataPreview,
  bootstrapPayload?: unknown,
  ssrBodyFallback?: string
): string {
  const cleaned = baseHtml
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/gi, '')
    .replace(/<meta\s+name="clckd"[^>]*>/gi, '')
    .replace(/<meta\s+property="og:[^"]*"[^>]*>/gi, '')
    .replace(/<meta\s+name="twitter:[^"]*"[^>]*>/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>/gi, '')
    .replace(/<link\s+rel="alternate"\s+type="application\/json\+oembed"[^>]*>/gi, '');

  const bootstrapScript =
    bootstrapPayload !== undefined
      ? `<script>window.__NASIRLINK_PREVIEW__=${safeJsonForScript(bootstrapPayload)};</script>`
      : '';

  const headBlock = `
    <meta name="clckd" content="a6c0dfb12e845a3e3e7915edcbcde473" />
    <title>${escapeHtml(meta.title || 'Video Preview')}</title>
    ${meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}" />` : ''}
    <link rel="canonical" href="${escapeHtml(meta.url)}" />
    ${meta.renderedMetaHtml || ''}
    ${bootstrapScript}
  `;

  let out = cleaned.replace('</head>', `${headBlock}\n  </head>`);
  if (ssrBodyFallback) {
    out = out.replace('<div id="root"></div>', `<div id="root">${ssrBodyFallback}</div>`);
  }
  return out;
}

export function renderSocialCrawlerHtml(
  link: LinkRecord,
  origin: string,
  canonicalPath?: string,
  globalConfig?: SystemSettings
): string {
  const meta = buildSocialMetadata(link, origin, canonicalPath, globalConfig);
  const body = renderLandingBodySnapshot(link, origin, globalConfig, canonicalPath);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="clckd" content="a6c0dfb12e845a3e3e7915edcbcde473" />
    <title>${escapeHtml(meta.title || 'Video Preview')}</title>
    ${meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}" />` : ''}
    <link rel="canonical" href="${escapeHtml(meta.url)}" />
    ${meta.renderedMetaHtml || ''}
  </head>
  <body style="margin:0;background:#ffffff;">
    ${body}
  </body>
</html>`;
}

export function renderPlayerPageHtml(
  link: LinkRecord,
  origin: string,
  globalConfig?: SystemSettings
): string {
  const { safeOrigin } = normalizeOrigin(origin);
  const resolved = resolveEffectiveVideo(link, safeOrigin, globalConfig);
  const posterUrl = resolvePosterAccessUrl(link, safeOrigin);
  const title = escapeHtml(resolved.title);
  const videoUrl = escapeHtml(resolved.videoUrl);
  const safePoster = escapeHtml(posterUrl);
  const mime = escapeHtml(resolved.mimeType || 'video/mp4');
  const hasVideo = resolved.hasValidVideo && Boolean(resolved.videoUrl);
  const errorMsg = escapeHtml(
    resolved.videoError || 'Configured video stream is currently unavailable.'
  );
  const hasRealPoster = Boolean((link.thumbnailUrl || '').trim());
  const videoPosterAttr = hasRealPoster ? ` poster="${safePoster}"` : '';
  const hasKnownDims = resolved.width >= 160 && resolved.height >= 90;
  const aspectCss = hasKnownDims ? `${resolved.width} / ${resolved.height}` : 'auto';
  const safeSourceUrl = resolved.sourceUrl ? escapeHtml(resolved.sourceUrl) : '';
  const safeSourceDomain = resolved.sourceDomain ? escapeHtml(resolved.sourceDomain) : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="clckd" content="a6c0dfb12e845a3e3e7915edcbcde473" />
    <title>${title}</title>
    <meta property="og:title" content="${title}" />
    <meta property="og:image" content="${safePoster}" />
    <meta name="twitter:image" content="${safePoster}" />
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: 100%;
        height: 100%;
        background: #000000;
        color: #f8fafc;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow: hidden;
      }
      .player-root {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #000000;
      }
      .video-frame {
        position: relative;
        flex: 1 1 auto;
        width: 100%;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #000000;
      }
      .video-aspect {
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: 100%;
        ${hasKnownDims ? `aspect-ratio: ${aspectCss};` : ''}
        display: flex;
        align-items: center;
        justify-content: center;
        background: #000000;
      }
      video {
        width: 100%;
        height: 100%;
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        background: #000000;
        display: block;
        border: none;
        border-radius: 0;
        outline: none;
      }
      .error-state {
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 20px;
        gap: 8px;
        color: #e2e8f0;
        font-size: 13px;
      }
      .error-state.visible {
        display: flex;
      }
      .source-bar {
        flex: 0 0 auto;
        width: 100%;
        padding: 8px 12px;
        text-align: center;
        background: #000000;
      }
      .source-link {
        color: #94a3b8;
        font-size: 13px;
        text-decoration: none;
        display: inline-block;
      }
      .source-link:hover {
        color: #e2e8f0;
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <div class="player-root">
      <div class="video-frame">
        ${
          hasVideo
            ? `<div class="video-aspect" id="nl-video-wrap">
                <video id="nl-player" controls autoplay muted playsinline loop preload="auto"${videoPosterAttr} aria-label="${title}">
                  <source id="nl-source" src="${videoUrl}" type="${mime}" />
                </video>
              </div>`
            : ''
        }
        <div id="nl-error" class="error-state${hasVideo ? '' : ' visible'}">
          <div style="font-weight:600;color:#fca5a5;">Video stream unavailable</div>
          <div style="font-size:12px;color:#94a3b8;max-width:420px;">${errorMsg}</div>
        </div>
      </div>
      ${
        safeSourceUrl && safeSourceDomain
          ? `<div class="source-bar">
              <a class="source-link" href="${safeSourceUrl}" target="_blank" rel="noopener noreferrer">From ${safeSourceDomain}</a>
            </div>`
          : ''
      }
    </div>
    <script>
      (function () {
        var video = document.getElementById('nl-player');
        var source = document.getElementById('nl-source');
        var wrap = document.getElementById('nl-video-wrap');
        var errBox = document.getElementById('nl-error');

        function showError() {
          if (wrap) wrap.style.display = 'none';
          if (errBox) errBox.classList.add('visible');
        }

        if (video) {
          video.muted = true;
          video.playsInline = true;
          video.addEventListener('loadedmetadata', function () {
            if (wrap && video.videoWidth > 0 && video.videoHeight > 0) {
              wrap.style.aspectRatio = video.videoWidth + ' / ' + video.videoHeight;
            }
          });
          video.addEventListener('error', showError);
          var playPromise = video.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(function () {});
          }
        }
        if (source) {
          source.addEventListener('error', showError);
        }
      })();
    </script>
  </body>
</html>`;
}

// Backward-compatible alias for /embed/:slug route
export function renderEmbedPlayerHtml(
  link: LinkRecord,
  origin: string,
  globalConfig?: SystemSettings
): string {
  return renderPlayerPageHtml(link, origin, globalConfig);
}
