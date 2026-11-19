import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendUtmParams,
  convertGitHubVideoUrl,
  generateRandomSlug,
  validateCustomAlias,
  validateSafeExternalUrl,
  validateVideoUrl,
} from '../src/shared/validation.ts';
import {
  createAnonymousVisitorId,
  hashPassword,
  parseUserAgent,
  verifyPassword,
} from '../src/server/crypto.ts';
import {
  buildSocialMetadata,
  injectVideoMetaIntoHtml,
  renderPlayerPageHtml,
} from '../src/server/metadata.ts';
import {
  parseVideoContainerBytes,
  probeVideoStream,
  sanitizeSourceAttribution,
} from '../src/server/videoProbe.ts';
import type { LinkRecord, SystemSettings } from '../src/shared/types.ts';

describe('URL Validation & SSRF Prevention', () => {
  it('accepts valid HTTPS and HTTP public URLs', () => {
    expect(validateSafeExternalUrl('https://example.com/landing?ref=1').valid).toBe(true);
    expect(validateSafeExternalUrl('http://docs.cloudflare.com/workers').valid).toBe(true);
  });

  it('blocks dangerous schemes (javascript, data, file)', () => {
    expect(validateSafeExternalUrl('javascript:alert(1)').valid).toBe(false);
    expect(validateSafeExternalUrl('data:text/html,<script>alert(1)</script>').valid).toBe(false);
    expect(validateSafeExternalUrl('file:///etc/passwd').valid).toBe(false);
  });

  it('blocks localhost, private RFC1918 networks, and cloud metadata IPs', () => {
    expect(validateSafeExternalUrl('http://localhost:3000/admin').valid).toBe(false);
    expect(validateSafeExternalUrl('http://127.0.0.1/internal').valid).toBe(false);
    expect(validateSafeExternalUrl('http://10.0.0.5/secret').valid).toBe(false);
    expect(validateSafeExternalUrl('http://192.168.1.1/router').valid).toBe(false);
    expect(validateSafeExternalUrl('http://172.16.0.10/db').valid).toBe(false);
    expect(validateSafeExternalUrl('http://169.254.169.254/latest/meta-data/').valid).toBe(false);
    expect(validateSafeExternalUrl('http://0x7f000001/').valid).toBe(false);
  });

  it('requires HTTPS for external video URLs', () => {
    expect(validateVideoUrl('http://cdn.example.com/video.mp4').valid).toBe(false);
    expect(validateVideoUrl('https://cdn.example.com/video.mp4').valid).toBe(true);
  });
});

describe('Custom Alias & Slug Generation', () => {
  it('generates valid random Base62 slugs', () => {
    const s1 = generateRandomSlug(6);
    const s2 = generateRandomSlug(6);
    expect(s1).toMatch(/^[a-zA-Z0-9]{6}$/);
    expect(s1).not.toBe(s2);
  });

  it('validates custom alias rules and rejects reserved routes', () => {
    expect(validateCustomAlias('my-launch_2026').valid).toBe(true);
    expect(validateCustomAlias('ab').valid).toBe(false);
    expect(validateCustomAlias('bad alias!').valid).toBe(false);
    expect(validateCustomAlias('admin').valid).toBe(false);
    expect(validateCustomAlias('dashboard').valid).toBe(false);
    expect(validateCustomAlias('api').valid).toBe(false);
    expect(validateCustomAlias('video').valid).toBe(false);
    expect(validateCustomAlias('v').valid).toBe(false);
    expect(validateCustomAlias('s').valid).toBe(false);
    expect(validateCustomAlias('r').valid).toBe(false);
    expect(validateCustomAlias('player').valid).toBe(false);
    expect(validateCustomAlias('embed').valid).toBe(false);
    expect(validateCustomAlias('media').valid).toBe(false);
  });
});

describe('GitHub Video URL Conversion & Container Probing', () => {
  it('converts github.com blob URLs to raw.githubusercontent.com', () => {
    const out = convertGitHubVideoUrl(
      'https://github.com/octocat/media-assets/blob/main/demos/intro.mp4'
    );
    expect(out.convertedFromGithub).toBe(true);
    expect(out.normalizedUrl).toBe(
      'https://raw.githubusercontent.com/octocat/media-assets/main/demos/intro.mp4'
    );
  });

  it('validates MP4 and WebM formats and rejects unsupported extensions', () => {
    const mp4 = validateVideoUrl('https://github.com/user/repo/blob/main/clip.mp4');
    expect(mp4.valid).toBe(true);
    expect(mp4.mimeType).toBe('video/mp4');

    const webm = validateVideoUrl('https://cdn.example.com/streams/demo.webm?v=2');
    expect(webm.valid).toBe(true);
    expect(webm.mimeType).toBe('video/webm');

    const bad = validateVideoUrl('https://cdn.example.com/page.html');
    expect(bad.valid).toBe(false);
  });

  it('reads exact original MP4 container dimensions (720x1278 portrait & 1290x720 landscape) from disk samples', async () => {
    const portraitBytes = new Uint8Array(
      fs.readFileSync(path.join(process.cwd(), 'public', 'samples', 'showcase.mp4'))
    );
    const portraitInfo = parseVideoContainerBytes(portraitBytes, 'video/mp4');
    expect(portraitInfo.width).toBe(720);
    expect(portraitInfo.height).toBe(1278);

    const landscapeBytes = new Uint8Array(
      fs.readFileSync(path.join(process.cwd(), 'public', 'samples', 'showcase1.mp4'))
    );
    const landscapeInfo = parseVideoContainerBytes(landscapeBytes, 'video/mp4');
    expect(landscapeInfo.width).toBe(1290);
    expect(landscapeInfo.height).toBe(720);

    const probeResult = await probeVideoStream('/api/sample-video/showcase.mp4', {
      origin: 'https://nasirlink.com',
      localReader: async (p) => {
        const clean = p.includes('showcase1.mp4') ? 'showcase1.mp4' : 'showcase.mp4';
        const buf = new Uint8Array(
          fs.readFileSync(path.join(process.cwd(), 'public', 'samples', clean))
        );
        return {
          status: 200,
          contentType: 'video/mp4',
          totalSize: buf.byteLength,
          bytes: buf,
        };
      },
    });
    expect(probeResult.valid).toBe(true);
    expect(probeResult.audit.detectedWidth).toBe(720);
    expect(probeResult.audit.detectedHeight).toBe(1278);
    expect(probeResult.audit.rangeSupported).toBe(true);
  });

  it('strips embedded credentials and signed URL secrets from source attribution links', () => {
    const clean = sanitizeSourceAttribution(
      'https://user:secret@imgbb.space/clip.mp4?token=abc123&X-Amz-Signature=deadbeef&v=2',
      null,
      'https://nasirlink.com'
    );
    expect(clean.sourceDomain).toBe('imgbb.space');
    expect(clean.sourceUrl).toBe('https://imgbb.space/clip.mp4?v=2');
    expect(clean.sourceUrl).not.toContain('secret');
    expect(clean.sourceUrl).not.toContain('token=');
    expect(clean.sourceUrl).not.toContain('X-Amz-Signature');
  });
});

describe('Web Crypto Security & Analytics Helpers', () => {
  it('hashes and verifies passwords with PBKDF2-SHA256', async () => {
    const hash = await hashPassword('SuperSecure!2026');
    expect(hash.startsWith('pbkdf2_sha256$')).toBe(true);
    expect(await verifyPassword('SuperSecure!2026', hash)).toBe(true);
    expect(await verifyPassword('WrongPassword', hash)).toBe(false);
  });

  it('creates anonymized daily visitor IDs without storing raw IPs', async () => {
    const id1 = await createAnonymousVisitorId('203.0.113.10', 'Mozilla/5.0');
    const id2 = await createAnonymousVisitorId('203.0.113.10', 'Mozilla/5.0');
    const id3 = await createAnonymousVisitorId('203.0.113.99', 'Mozilla/5.0');
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).not.toContain('203.0.113.10');
  });

  it('parses User-Agent device, browser, and OS cleanly', () => {
    const ua = parseUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    );
    expect(ua.deviceType).toBe('Mobile');
    expect(ua.browser).toBe('Safari');
    expect(ua.operatingSystem).toBe('iOS');
  });

  it('appends UTM parameters safely without overwriting existing query params', () => {
    const out = appendUtmParams('https://example.com/page?foo=bar', {
      source: 'nasirlink',
      medium: 'video',
      campaign: 'launch',
    });
    const parsed = new URL(out);
    expect(parsed.searchParams.get('foo')).toBe('bar');
    expect(parsed.searchParams.get('utm_source')).toBe('nasirlink');
    expect(parsed.searchParams.get('utm_campaign')).toBe('launch');
  });
});

describe('Server-Rendered X Video Player Card Metadata & Clean Embed Player', () => {
  const sampleLink: LinkRecord = {
    id: 'lnk_test',
    userId: null,
    slug: 'demo-card',
    linkType: 'video',
    destinationUrl: 'https://example.com/product',
    videoUrl: 'https://imgbb.space/streams/launch.mp4',
    videoTitle: 'Launch Demo Video',
    videoDescription: 'Watch our 2026 release preview.',
    thumbnailUrl: null,
    videoMimeType: 'video/mp4',
    videoWidth: 1290,
    videoHeight: 720,
    twitterCardType: 'player',
    playerUrl: null,
    previewEnabled: true,
    autoRedirectSeconds: 0,
    redirectType: 302,
    hasPassword: false,
    expiresAt: null,
    isActive: true,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    campaignName: null,
    tags: [],
    clicksCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('generates X Player Card & OpenGraph video tags with required twitter:image and og:image poster tags', () => {
    const meta = buildSocialMetadata(sampleLink, 'https://nasirlink.com', '/s/demo-card');
    const baseHtml = '<!doctype html><html><head><title>Placeholder</title></head><body></body></html>';
    const rendered = injectVideoMetaIntoHtml(baseHtml, meta);

    expect(rendered.match(/<meta name="twitter:card"/g)?.length).toBe(1);
    expect(rendered).toContain('<meta name="twitter:card" content="player" />');
    expect(rendered).toContain('<meta name="twitter:title" content="Launch Demo Video" />');
    expect(rendered).toContain('<meta name="twitter:image" content="https://nasirlink.com/poster/demo-card.jpg" />');
    expect(rendered).toContain('<meta name="twitter:player" content="https://nasirlink.com/embed/demo-card" />');
    expect(rendered).toContain('<meta name="twitter:player:width" content="1290" />');
    expect(rendered).toContain('<meta name="twitter:player:height" content="720" />');
    expect(rendered).toContain('<meta name="twitter:player:stream" content="https://imgbb.space/streams/launch.mp4" />');
    expect(rendered).toContain('<meta name="twitter:player:stream:content_type" content="video/mp4" />');
    expect(rendered).toContain('<meta property="og:type" content="video.other" />');
    expect(rendered).toContain('<meta property="og:image" content="https://nasirlink.com/poster/demo-card.jpg" />');
    expect(rendered).toContain('<meta property="og:image:secure_url" content="https://nasirlink.com/poster/demo-card.jpg" />');
    expect(rendered).toContain('<meta property="og:video" content="https://imgbb.space/streams/launch.mp4" />');
    expect(rendered).toContain('<meta property="og:video:type" content="video/mp4" />');
    expect(rendered).toContain('<meta property="og:video:width" content="1290" />');
    expect(rendered).toContain('<meta property="og:video:height" content="720" />');
    expect(rendered).toContain('<meta property="og:url" content="https://nasirlink.com/s/demo-card" />');
    expect(rendered).not.toContain('summary_large_image');
    expect(rendered).not.toContain('ANH_CUA_BAN');
    expect(rendered).not.toContain('imgur-embed-pub');
  });

  it('preserves portrait (720x1278) and square (1080x1080) dimensions without forcing 1280x720', () => {
    const portraitMeta = buildSocialMetadata(
      {
        ...sampleLink,
        slug: 'portrait-clip',
        videoUrl: 'https://video.twimg.com/amplify_video/2122735467695353856/vid/avc1/720x1278/5kKXcgJKfyoEYzwe.mp4',
        videoWidth: 720,
        videoHeight: 1278,
      },
      'https://nasirlink.com',
      '/s/portrait-clip'
    );
    expect(portraitMeta.twitterPlayerWidth).toBe(720);
    expect(portraitMeta.twitterPlayerHeight).toBe(1278);
    expect(portraitMeta.renderedMetaHtml).toContain('<meta name="twitter:player:width" content="720" />');
    expect(portraitMeta.renderedMetaHtml).toContain('<meta name="twitter:player:height" content="1278" />');

    const squareMeta = buildSocialMetadata(
      { ...sampleLink, videoWidth: 1080, videoHeight: 1080 },
      'https://nasirlink.com',
      '/s/square-clip'
    );
    expect(squareMeta.twitterPlayerWidth).toBe(1080);
    expect(squareMeta.twitterPlayerHeight).toBe(1080);
    expect(squareMeta.renderedMetaHtml).toContain('<meta name="twitter:player:width" content="1080" />');
    expect(squareMeta.renderedMetaHtml).toContain('<meta name="twitter:player:height" content="1080" />');
  });

  it('reports an explicit error and falls back cleanly to summary_large_image card without sample video fallback when videoUrl is missing', () => {
    const brokenMeta = buildSocialMetadata(
      {
        ...sampleLink,
        videoUrl: null,
        videoWidth: 0,
        videoHeight: 0,
      },
      'https://nasirlink.com',
      '/s/broken'
    );
    expect(brokenMeta.hasValidVideo).toBe(false);
    expect(brokenMeta.videoError).toBeTruthy();
    expect(brokenMeta.ogVideo).toBe('');
    expect(brokenMeta.renderedMetaHtml).not.toContain('showcase.mp4');
    expect(brokenMeta.renderedMetaHtml).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(brokenMeta.renderedMetaHtml).toContain('<meta name="twitter:image" content="https://nasirlink.com/poster/demo-card.jpg" />');
    expect(brokenMeta.renderedMetaHtml).toContain('<meta property="og:image" content="https://nasirlink.com/poster/demo-card.jpg" />');

    const errorEmbedHtml = renderPlayerPageHtml(
      { ...sampleLink, videoUrl: null },
      'https://nasirlink.com'
    );
    expect(errorEmbedHtml).toContain('Video stream unavailable');
    expect(errorEmbedHtml).toContain('No video URL is configured');
    expect(errorEmbedHtml).not.toContain('<video');
  });

  it('supports Admin global video configuration & override in metadata resolution', () => {
    const globalSettings: SystemSettings = {
      siteName: 'NasirLink',
      domain: 'nasirlink.com',
      defaultRedirectType: 302,
      registrationEnabled: true,
      maxLinksPerUser: 100,
      rateLimitPerMin: 120,
      maintenanceMode: false,
      globalVideoUrl: 'https://imgbb.space/vertical-720x1278.mp4',
      globalVideoWidth: 720,
      globalVideoHeight: 1278,
      globalVideoMimeType: 'video/mp4',
      globalVideoTitle: 'Global Feature Video',
      globalVideoDescription: 'Vertical showcase.',
      globalVideoSourceUrl: 'https://imgbb.space/example?token=secret123',
      globalVideoOverride: true,
    };

    const meta = buildSocialMetadata(sampleLink, 'https://nasirlink.com', '/s/demo-card', globalSettings);
    expect(meta.ogVideo).toBe('https://imgbb.space/vertical-720x1278.mp4');
    expect(meta.twitterPlayerWidth).toBe(720);
    expect(meta.twitterPlayerHeight).toBe(1278);
    expect(meta.sourceDomain).toBe('imgbb.space');
    expect(meta.sourceUrl).toBe('https://imgbb.space/example');
  });

  it('renders /embed/:slug HTML5 player with controls, loop, autoplay/muted/playsinline/contain, aspect ratio, real From domain link, and real frame poster only when captured', () => {
    const portraitLink: LinkRecord = {
      ...sampleLink,
      videoUrl: 'https://imgbb.space/vertical/clip.mp4?token=secret',
      videoWidth: 720,
      videoHeight: 1278,
    };
    const htmlWithoutPoster = renderPlayerPageHtml(portraitLink, 'https://nasirlink.com');
    expect(htmlWithoutPoster).toContain('controls autoplay muted playsinline loop preload="auto"');
    expect(htmlWithoutPoster).toContain('<meta property="og:image" content="https://nasirlink.com/poster/demo-card.jpg" />');
    expect(htmlWithoutPoster).toContain('<meta name="twitter:image" content="https://nasirlink.com/poster/demo-card.jpg" />');
    expect(htmlWithoutPoster).not.toMatch(/<video[^>]*\sposter=/);
    expect(htmlWithoutPoster).toContain('object-fit: contain');
    expect(htmlWithoutPoster).toContain('aspect-ratio: 720 / 1278');
    expect(htmlWithoutPoster).toContain('border: none');
    expect(htmlWithoutPoster).toContain('border-radius: 0');
    expect(htmlWithoutPoster).toContain('href="https://imgbb.space/vertical/clip.mp4"');
    expect(htmlWithoutPoster).toContain('>From imgbb.space</a>');
    expect(htmlWithoutPoster).not.toContain('nl-btn-play');
    expect(htmlWithoutPoster).not.toContain('nl-btn-pause');
    expect(htmlWithoutPoster).not.toContain('nl-btn-stop');
    expect(htmlWithoutPoster).not.toMatch(/class="source-link"[^>]*token=secret/);
    expect(htmlWithoutPoster).not.toContain('window.location.replace');

    const htmlWithCapturedFrame = renderPlayerPageHtml(
      { ...portraitLink, thumbnailUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==' },
      'https://nasirlink.com'
    );
    expect(htmlWithCapturedFrame).toContain('poster="https://nasirlink.com/poster/demo-card.jpg"');
  });
});

describe('Cloudflare Worker Entrypoint (src/worker.ts)', () => {
  it('serves /s/:slug Player Card metadata, direct redirects on /:slug & /r/:slug, clean /embed/:slug, normal links, and admin global settings', async () => {
    const { default: worker } = await import('../src/worker.ts');
    const mockAssets = {
      async fetch(input: Request | string) {
        const reqUrl = typeof input === 'string' ? input : input.url;
        if (reqUrl.endsWith('/index.html')) {
          return new Response('<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('asset', { status: 200 });
      },
    };
    const env = { ASSETS: mockAssets, APP_DOMAIN: 'nasirlink.com' };

    const healthRes = await worker.fetch(new Request('https://nasirlink.com/api/health'), env);
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.runtime).toBe('cloudflare-workers');

    // Reject http:// external video URL
    const badValidateRes = await worker.fetch(
      new Request('https://nasirlink.com/api/links/validate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: 'http://cdn.example.com/clip.mp4' }),
      }),
      env
    );
    expect(badValidateRes.status).toBe(400);
    const badValidateJson = await badValidateRes.json();
    expect(badValidateJson.valid).toBe(false);

    // Reject SSRF target
    const ssrfRes = await worker.fetch(
      new Request('https://nasirlink.com/api/links/validate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: 'https://127.0.0.1/internal.mp4' }),
      }),
      env
    );
    expect(ssrfRes.status).toBe(400);
    const ssrfJson = await ssrfRes.json();
    expect(ssrfJson.valid).toBe(false);

    // Create normal short link WITHOUT forcing video/showcase fallback
    const normalCreateRes = await worker.fetch(
      new Request('https://nasirlink.com/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationUrl: 'https://example.com/plain-short',
          customAlias: 'plain26',
          linkType: 'normal',
        }),
      }),
      env
    );
    expect(normalCreateRes.status).toBe(201);
    const normalCreated = await normalCreateRes.json();
    expect(normalCreated.link.linkType).toBe('normal');
    expect(normalCreated.link.videoUrl).toBeNull();
    expect(normalCreated.link.thumbnailUrl).toBeNull();

    // Create portrait video preview link (720x1278)
    const createPortraitRes = await worker.fetch(
      new Request('https://nasirlink.com/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationUrl: 'https://example.com/my-destination',
          customAlias: 'portrait720',
          linkType: 'video',
          previewEnabled: true,
          autoRedirectSeconds: 10,
          videoUrl: 'https://video.twimg.com/amplify_video/2122735467695353856/vid/avc1/720x1278/5kKXcgJKfyoEYzwe.mp4',
          videoTitle: 'Portrait Clip',
          videoDescription: 'Vertical showcase clip.',
          videoWidth: 720,
          videoHeight: 1278,
        }),
      }),
      env
    );
    expect(createPortraitRes.status).toBe(201);
    const createdPortrait = await createPortraitRes.json();
    expect(createdPortrait.link.previewEnabled).toBe(true);
    expect(createdPortrait.link.videoWidth).toBe(720);
    expect(createdPortrait.link.videoHeight).toBe(1278);

    // Social crawler receives X Player Card metadata HTML (200 OK),
    // while browser visitor redirects directly to the destination URL (302).
    const botRes = await worker.fetch(
      new Request('https://nasirlink.com/portrait720', {
        headers: { 'User-Agent': 'Twitterbot/1.0' },
      }),
      env
    );
    const browserRes = await worker.fetch(
      new Request('https://nasirlink.com/portrait720', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }),
      env
    );
    expect(botRes.status).toBe(200);
    const botHtml = await botRes.text();
    expect(botHtml).toContain('<meta name="twitter:card" content="player" />');
    expect(botHtml).toContain('<meta name="twitter:image" content="https://nasirlink.com/poster/portrait720.jpg" />');
    expect(botHtml).toContain('<meta property="og:image" content="https://nasirlink.com/poster/portrait720.jpg" />');
    expect(browserRes.status).toBe(302);
    expect(browserRes.headers.get('location')).toContain('https://example.com/my-destination');

    // /poster/:slug.jpg always returns 200 OK even when thumbnailUrl is null
    const posterRes = await worker.fetch(new Request('https://nasirlink.com/poster/portrait720.jpg'), env);
    expect(posterRes.status).toBe(200);
    expect(posterRes.headers.get('content-type')).toBe('image/jpeg');
    expect(posterRes.headers.get('access-control-allow-origin')).toBe('*');

    // /s/:slug serves clean static X Player Card HTML for social crawlers and hydrated HTML for browsers
    const botShareRes = await worker.fetch(
      new Request('https://nasirlink.com/s/portrait720', {
        headers: { 'User-Agent': 'Twitterbot/1.0' },
      }),
      env
    );
    expect(botShareRes.status).toBe(200);
    const botShareHtml = await botShareRes.text();
    expect(botShareHtml).toContain('<meta name="twitter:card" content="player" />');
    expect(botShareHtml).toContain('<meta name="twitter:image" content="https://nasirlink.com/poster/portrait720.jpg" />');
    expect(botShareHtml).not.toContain('id="root"');

    const socialShareRes = await worker.fetch(new Request('https://nasirlink.com/s/portrait720'), env);
    expect(socialShareRes.status).toBe(200);
    const socialShareHtml = await socialShareRes.text();
    expect(socialShareHtml).toContain('<meta name="twitter:card" content="player" />');
    expect(socialShareHtml).toContain('<meta name="twitter:image" content="https://nasirlink.com/poster/portrait720.jpg" />');
    expect(socialShareHtml).toContain('<meta property="og:image" content="https://nasirlink.com/poster/portrait720.jpg" />');
    expect(socialShareHtml).toContain('<meta name="twitter:player" content="https://nasirlink.com/embed/portrait720" />');
    expect(socialShareHtml).toContain('<meta name="twitter:player:width" content="720" />');
    expect(socialShareHtml).toContain('<meta name="twitter:player:height" content="1278" />');
    expect(socialShareHtml).not.toContain('summary_large_image');
    expect(socialShareHtml).not.toContain('imgur-embed-pub');

    const directRedirectRes = await worker.fetch(new Request('https://nasirlink.com/r/portrait720'), env);
    expect(directRedirectRes.status).toBe(302);
    expect(directRedirectRes.headers.get('location')).toContain('https://example.com/my-destination');

    // /embed/:slug page check (frameable, player with controls+loop, aspect ratio preserved, no fake poster, From domain link)
    const embedRes = await worker.fetch(new Request('https://nasirlink.com/embed/portrait720'), env);
    expect(embedRes.status).toBe(200);
    expect(embedRes.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(embedRes.headers.get('x-frame-options')).toBeNull();
    const embedHtml = await embedRes.text();
    expect(embedHtml).toContain('https://video.twimg.com/amplify_video/2122735467695353856/vid/avc1/720x1278/5kKXcgJKfyoEYzwe.mp4');
    expect(embedHtml).toContain('controls autoplay muted playsinline loop preload="auto"');
    expect(embedHtml).not.toMatch(/<video[^>]*\sposter=/);
    expect(embedHtml).toContain('aspect-ratio: 720 / 1278');
    expect(embedHtml).toContain('>From video.twimg.com</a>');
    expect(embedHtml).not.toContain('nl-btn-play');

    // /player/:slug remains compatible and serves the same clean embed
    const playerRes = await worker.fetch(new Request('https://nasirlink.com/player/portrait720'), env);
    expect(playerRes.status).toBe(200);
    const playerHtml = await playerRes.text();
    expect(playerHtml).toContain('aspect-ratio: 720 / 1278');
    expect(playerHtml).not.toContain('nl-btn-play');

    // Normal short URL continues to return 302 redirect
    const normalRedirectRes = await worker.fetch(
      new Request('https://nasirlink.com/cf-docs', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }),
      env
    );
    expect(normalRedirectRes.status).toBe(302);
    expect(normalRedirectRes.headers.get('location')).toContain('https://developers.cloudflare.com/workers/');

    // Built-in media proxy check for seeded link
    const mediaGetRes = await worker.fetch(new Request('https://nasirlink.com/media/product-tour.mp4'), env);
    expect(mediaGetRes.status).toBe(200);
    expect(mediaGetRes.headers.get('content-type')).toBe('video/mp4');
    expect(mediaGetRes.headers.get('accept-ranges')).toBe('bytes');

    // Admin auth + PATCH + Global Video Settings override
    const loginRes = await worker.fetch(
      new Request('https://nasirlink.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@nasirlink.com',
          password: 'Admin123!',
        }),
      }),
      env
    );
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie') || '';
    const cookieHeader = setCookie.split(';')[0];

    const patchRes = await worker.fetch(
      new Request(`https://nasirlink.com/api/admin/links/${createdPortrait.link.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          previewEnabled: false,
          videoWidth: 640,
          videoHeight: 480,
        }),
      }),
      env
    );
    expect(patchRes.status).toBe(200);
    const patchedJson = await patchRes.json();
    expect(patchedJson.link.previewEnabled).toBe(false);
    expect(patchedJson.link.videoWidth).toBe(640);
    expect(patchedJson.link.videoHeight).toBe(480);

    // Disabled preview performs direct redirect
    const toggledRedirectRes = await worker.fetch(new Request('https://nasirlink.com/portrait720'), env);
    expect(toggledRedirectRes.status).toBe(302);

    // Admin Global Video Settings update & override check
    const saveGlobalRes = await worker.fetch(
      new Request('https://nasirlink.com/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          globalVideoUrl: 'https://imgbb.space/streams/clip_720x1278.mp4',
          globalVideoWidth: 720,
          globalVideoHeight: 1278,
          globalVideoSourceUrl: 'https://imgbb.space/example',
          globalVideoOverride: true,
        }),
      }),
      env
    );
    expect(saveGlobalRes.status).toBe(200);

    const overrideShareRes = await worker.fetch(new Request('https://nasirlink.com/s/product-tour'), env);
    expect(overrideShareRes.status).toBe(200);
    const overrideHtml = await overrideShareRes.text();
    expect(overrideHtml).toContain('https://imgbb.space/streams/clip_720x1278.mp4');
    expect(overrideHtml).toContain('<meta name="twitter:player:width" content="720" />');
    expect(overrideHtml).toContain('<meta name="twitter:player:height" content="1278" />');

    const overrideEmbedRes = await worker.fetch(new Request('https://nasirlink.com/embed/product-tour'), env);
    const overrideEmbedHtml = await overrideEmbedRes.text();
    expect(overrideEmbedHtml).toContain('>From imgbb.space</a>');
    expect(overrideEmbedHtml).toContain('href="https://imgbb.space/example"');

    // Clear global override for subsequent checks
    await worker.fetch(
      new Request('https://nasirlink.com/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          globalVideoUrl: null,
          globalVideoSourceUrl: null,
          globalVideoOverride: false,
        }),
      }),
      env
    );

    // oEmbed check
    const oembedRes = await worker.fetch(
      new Request('https://nasirlink.com/api/oembed?url=https%3A%2F%2Fnasirlink.com%2Fproduct-tour'),
      env
    );
    expect(oembedRes.status).toBe(200);
    const oembedJson = await oembedRes.json();
    expect(oembedJson.type).toBe('video');
    expect(oembedJson.html).toContain('<iframe');
    expect(oembedJson.html).toContain('/embed/product-tour');

    // QR SVG check
    const qrRes = await worker.fetch(
      new Request('https://nasirlink.com/api/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://nasirlink.com/product-tour',
          fgColor: '#4F46E5',
          bgColor: '#FFFFFF',
          size: 360,
          includeLogo: true,
          logoText: 'NL',
        }),
      }),
      env
    );
    expect(qrRes.status).toBe(200);
    const qrJson = await qrRes.json();
    expect(qrJson.svg).toContain('<svg');
    expect(qrJson.svg).toContain('>NL</text>');

    // Rotating timestamp titles without thumbnail/Imgur injection
    const randomTitleLinkRes = await worker.fetch(
      new Request('https://nasirlink.com/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationUrl: 'https://example.com/dest-random',
          customAlias: 'random-ts',
          linkType: 'video',
          previewEnabled: true,
          videoUrl: 'https://cdn.example.com/clip_720x1278.mp4',
          videoTitle: '46:44 | 59:52',
        }),
      }),
      env
    );
    expect(randomTitleLinkRes.status).toBe(201);

    const shareHtmlRes1 = await worker.fetch(new Request('https://nasirlink.com/s/random-ts'), env);
    expect(shareHtmlRes1.status).toBe(200);
    const html1 = await shareHtmlRes1.text();
    expect(html1).toMatch(/<title>(46:44|59:52)<\/title>/);
    expect(html1).not.toContain('ANH_CUA_BAN');
    expect(html1).not.toContain('imgur-embed-pub');
    expect(html1).not.toContain('s.imgur.com');
    expect(html1).toContain('<meta property="og:video:width" content="720" />');
    expect(html1).toContain('<meta property="og:video:height" content="1278" />');
    expect(html1).toContain('<meta name="twitter:player:width" content="720" />');
    expect(html1).toContain('<meta name="twitter:player:height" content="1278" />');
  });
});
