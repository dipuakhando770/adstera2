import {
  detectVideoMimeFromContentType,
  validateSafeExternalUrl,
  validateVideoUrl,
} from '../shared/validation.ts';
import type { VideoStreamAudit } from '../shared/types.ts';

export interface SourceAttribution {
  sourceUrl: string;
  sourceDomain: string;
}

export interface ParsedContainerInfo {
  width: number | null;
  height: number | null;
  codec: string | null;
  faststart: boolean | null;
}

export interface LocalMediaReadResult {
  status: number;
  contentType: string;
  totalSize: number;
  bytes: Uint8Array;
}

export type LocalMediaReader = (
  pathOrUrl: string,
  start?: number,
  end?: number
) => Promise<LocalMediaReadResult | null>;

export interface VideoProbeResult {
  valid: boolean;
  normalizedUrl: string;
  convertedFromGithub: boolean;
  audit: VideoStreamAudit;
}

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'auth',
  'sig',
  'signature',
  'key',
  'api_key',
  'apikey',
  'secret',
  'policy',
  'expires',
  'expiry',
  'key-pair-id',
  'googleaccessid',
  'sv',
  'ss',
  'srt',
  'sp',
  'se',
  'st',
  'spr',
]);

export function sanitizeSourceAttribution(
  videoUrl: string | null | undefined,
  explicitSourceUrl?: string | null,
  origin = ''
): SourceAttribution {
  const candidates = [explicitSourceUrl, videoUrl].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  );

  for (const rawCandidate of candidates) {
    const trimmed = rawCandidate.trim();
    let candidate = trimmed;

    if (candidate.startsWith('/')) {
      if (!origin) continue;
      const base = origin.replace(/\/+$/, '');
      candidate = `${base}${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      const isLocal = /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
        if (parsed.protocol === 'http:') {
          parsed.protocol = 'https:';
        } else {
          continue;
        }
      }

      // Never expose embedded credentials or signed storage secrets
      parsed.username = '';
      parsed.password = '';

      const keysToDelete: string[] = [];
      for (const [k] of parsed.searchParams.entries()) {
        const lk = k.toLowerCase();
        if (
          SENSITIVE_QUERY_KEYS.has(lk) ||
          lk.startsWith('x-amz-') ||
          lk.startsWith('x-goog-') ||
          lk.startsWith('x-oss-')
        ) {
          keysToDelete.push(k);
        }
      }
      for (const k of keysToDelete) {
        parsed.searchParams.delete(k);
      }

      return {
        sourceUrl: parsed.toString(),
        sourceDomain: parsed.hostname.replace(/^www\./i, ''),
      };
    } catch {
      // Try next candidate
    }
  }

  return { sourceUrl: '', sourceDomain: '' };
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function readInt32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  );
}

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function parseMp4Container(
  bytes: Uint8Array,
  type: 'moov' | 'all' = 'all'
): ParsedContainerInfo {
  let moovOffset = -1;
  let mdatOffset = -1;
  let width: number | null = null;
  let height: number | null = null;
  let codec: string | null = null;

  const CONTAINER_BOXES = new Set([
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'edts',
    'udta',
  ]);

  const walkBoxes = (start: number, end: number, depth: number) => {
    if (depth > 8) return;
    let pos = start;
    while (pos + 8 <= end) {
      let size = readUint32BE(bytes, pos);
      const boxType = readAscii(bytes, pos + 4, 4);
      let headerSize = 8;

      if (size === 1) {
        if (pos + 16 > end) break;
        const hi = readUint32BE(bytes, pos + 8);
        const lo = readUint32BE(bytes, pos + 12);
        size = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }

      if (size < headerSize || pos + size > end + (depth === 0 ? 1024 * 1024 * 1024 : 0)) {
        // For top-level boxes, a box like mdat or moov may extend past the initial slice
        if (depth === 0 && size >= headerSize) {
          if (boxType === 'moov' && moovOffset === -1) moovOffset = pos;
          if (boxType === 'mdat' && mdatOffset === -1) mdatOffset = pos;
          if (boxType === 'moov') {
            walkBoxes(pos + headerSize, Math.min(end, pos + size), depth + 1);
          }
        }
        break;
      }

      const boxEnd = Math.min(end, pos + size);
      if (depth === 0) {
        if (boxType === 'moov' && moovOffset === -1) moovOffset = pos;
        if (boxType === 'mdat' && mdatOffset === -1) mdatOffset = pos;
      }

      if (boxType === 'tkhd' && boxEnd - (pos + headerSize) >= 84) {
        const version = bytes[pos + headerSize];
        // tkhd layout: version(1) + flags(3) + times/ids/duration...
        // width/height are the last 8 bytes of tkhd (16.16 fixed point), preceded by 36-byte matrix
        const matrixOffset =
          version === 1
            ? pos + headerSize + 4 + 8 + 8 + 4 + 4 + 8 + 8 + 2 + 2 + 2 + 2
            : pos + headerSize + 4 + 4 + 4 + 4 + 4 + 4 + 8 + 2 + 2 + 2 + 2;
        const dimsOffset = matrixOffset + 36;
        if (dimsOffset + 8 <= boxEnd) {
          const rawW = readUint32BE(bytes, dimsOffset) / 65536;
          const rawH = readUint32BE(bytes, dimsOffset + 4) / 65536;
          if (rawW > 0 && rawH > 0) {
            // Check 3x3 fixed-point matrix for 90° / 270° rotation:
            // matrix = [a, b, u, c, d, v, tx, ty, w] where a,b,c,d are 16.16 fixed-point
            const a = readInt32BE(bytes, matrixOffset) / 65536;
            const b = readInt32BE(bytes, matrixOffset + 4) / 65536;
            const c = readInt32BE(bytes, matrixOffset + 12) / 65536;
            const d = readInt32BE(bytes, matrixOffset + 16) / 65536;
            const isRotated90or270 =
              Math.abs(a) < 0.01 &&
              Math.abs(d) < 0.01 &&
              Math.abs(b) > 0.5 &&
              Math.abs(c) > 0.5;
            const finalW = Math.round(isRotated90or270 ? rawH : rawW);
            const finalH = Math.round(isRotated90or270 ? rawW : rawH);
            if (finalW >= 64 && finalH >= 64) {
              width = finalW;
              height = finalH;
            }
          }
        }
      } else if (boxType === 'stsd' && boxEnd - (pos + headerSize) >= 16) {
        const entryType = readAscii(bytes, pos + headerSize + 12, 4);
        if (['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01', 'mp4v'].includes(entryType)) {
          codec = entryType;
        }
      } else if (CONTAINER_BOXES.has(boxType)) {
        walkBoxes(pos + headerSize, boxEnd, depth + 1);
      }

      pos += size;
    }
  };

  if (type === 'moov') {
    const moovIdx = findBoxSignature(bytes, 'moov');
    if (moovIdx >= 4) {
      walkBoxes(moovIdx - 4, bytes.length, 0);
    }
  } else {
    walkBoxes(0, bytes.length, 0);
  }

  let faststart: boolean | null = null;
  if (moovOffset !== -1 && (mdatOffset === -1 || moovOffset < mdatOffset)) {
    faststart = true;
  } else if (mdatOffset !== -1 && moovOffset === -1) {
    faststart = false;
  } else if (moovOffset !== -1 && mdatOffset !== -1) {
    faststart = moovOffset < mdatOffset;
  }

  return { width, height, codec, faststart };
}

function findBoxSignature(bytes: Uint8Array, boxName: string): number {
  const c0 = boxName.charCodeAt(0);
  const c1 = boxName.charCodeAt(1);
  const c2 = boxName.charCodeAt(2);
  const c3 = boxName.charCodeAt(3);
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (bytes[i] === c0 && bytes[i + 1] === c1 && bytes[i + 2] === c2 && bytes[i + 3] === c3) {
      return i;
    }
  }
  return -1;
}

function parseWebmContainer(bytes: Uint8Array): ParsedContainerInfo {
  // Scan EBML header/Tracks for PixelWidth (0xB0), PixelHeight (0xBA), and CodecID (0x86)
  let width: number | null = null;
  let height: number | null = null;
  let codec: string | null = null;

  const readUint = (start: number, len: number): number => {
    let val = 0;
    for (let i = 0; i < len && start + i < bytes.length; i++) {
      val = (val << 8) | bytes[start + i];
    }
    return val;
  };

  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] === 0x86) {
      const sizeByte = bytes[i + 1];
      if ((sizeByte & 0x80) !== 0) {
        const len = sizeByte & 0x7f;
        if (len >= 4 && len <= 16 && i + 2 + len <= bytes.length) {
          const id = readAscii(bytes, i + 2, len);
          if (id.startsWith('V_')) {
            codec = id;
          }
        }
      }
    }
    if (bytes[i] === 0xb0 && (bytes[i + 1] & 0x80) !== 0) {
      const len = bytes[i + 1] & 0x7f;
      if (len >= 1 && len <= 4 && i + 2 + len <= bytes.length) {
        const val = readUint(i + 2, len);
        if (val >= 64 && val <= 7680) width = val;
      }
    }
    if (bytes[i] === 0xba && (bytes[i + 1] & 0x80) !== 0) {
      const len = bytes[i + 1] & 0x7f;
      if (len >= 1 && len <= 4 && i + 2 + len <= bytes.length) {
        const val = readUint(i + 2, len);
        if (val >= 64 && val <= 7680) height = val;
      }
    }
  }

  return { width, height, codec, faststart: true };
}

export function parseVideoContainerBytes(
  bytes: Uint8Array,
  mimeHint?: string | null
): ParsedContainerInfo {
  if (bytes.length < 16) {
    return { width: null, height: null, codec: null, faststart: null };
  }
  const ftyp = readAscii(bytes, 4, 4);
  if (ftyp === 'ftyp' || mimeHint === 'video/mp4') {
    return parseMp4Container(bytes, 'all');
  }
  if (
    (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) ||
    mimeHint === 'video/webm'
  ) {
    return parseWebmContainer(bytes);
  }
  return parseMp4Container(bytes, 'all');
}

async function readUpToBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const needed = Math.min(value.byteLength, maxBytes - total);
      chunks.push(needed === value.byteLength ? value : value.subarray(0, needed));
      total += needed;
      if (total >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel failures
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchWithValidatedRedirects(
  targetUrl: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string> = {},
  requireHttps = true
): Promise<{
  ok: boolean;
  status: number | null;
  response: Response | null;
  finalUrl: string;
  error: string | null;
}> {
  let current = targetUrl;
  for (let hop = 0; hop < 4; hop++) {
    const check = validateSafeExternalUrl(current, false, requireHttps);
    if (!check.valid || !check.normalizedUrl) {
      return {
        ok: false,
        status: null,
        response: null,
        finalUrl: current,
        error: check.error || 'Blocked unsafe URL or redirect target.',
      };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const resp = await fetch(check.normalizedUrl, {
        method,
        headers,
        signal: ctrl.signal,
        redirect: 'manual',
      });
      clearTimeout(timer);

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        await resp.body?.cancel();
        if (!loc) {
          return {
            ok: false,
            status: resp.status,
            response: null,
            finalUrl: check.normalizedUrl,
            error: `Redirect missing Location header (${resp.status})`,
          };
        }
        current = new URL(loc, check.normalizedUrl).toString();
        continue;
      }

      return {
        ok: resp.ok,
        status: resp.status,
        response: resp,
        finalUrl: check.normalizedUrl,
        error: resp.ok ? null : `Remote server returned HTTP ${resp.status}`,
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        status: null,
        response: null,
        finalUrl: check.normalizedUrl,
        error:
          (err as Error).name === 'AbortError'
            ? 'Connection timed out while probing video stream'
            : 'Could not reach remote host (DNS, TLS, CORS, or firewall blocked)',
      };
    }
  }
  return {
    ok: false,
    status: null,
    response: null,
    finalUrl: current,
    error: 'Too many redirects',
  };
}

export async function probeVideoStream(
  rawUrl: string,
  options: {
    origin?: string;
    localReader?: LocalMediaReader;
    playerUrl?: string;
  } = {}
): Promise<VideoProbeResult> {
  const urlCheck = validateVideoUrl(rawUrl);
  const normalizedUrl = urlCheck.normalizedUrl || rawUrl.trim();
  const isGithubRaw = /raw\.githubusercontent\.com/i.test(normalizedUrl);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    errors.push(urlCheck.error || 'Invalid video URL.');
    return {
      valid: false,
      normalizedUrl,
      convertedFromGithub: urlCheck.convertedFromGithub,
      audit: {
        videoReachable: false,
        videoStatus: null,
        videoHttps: normalizedUrl.startsWith('https://'),
        videoMimeType: null,
        videoContentLength: null,
        acceptRanges: false,
        rangeSupported: false,
        rangeStatus: null,
        detectedWidth: null,
        detectedHeight: null,
        codec: null,
        faststart: null,
        isGithubRaw,
        xCrawlerReady: false,
        playerReachable: true,
        playerStatus: 200,
        playerHttps: !options.playerUrl || options.playerUrl.startsWith('https://'),
        errors,
        warnings,
      },
    };
  }

  if (isGithubRaw) {
    warnings.push(
      'GitHub Raw URLs (raw.githubusercontent.com) are not a production video CDN; GitHub often serves application/octet-stream or rate-limits social crawlers. Dedicated HTTPS CDN / R2 / S3 storage is strongly recommended.'
    );
  }

  // First-party local sample video
  if (normalizedUrl.startsWith('/api/sample-video/')) {
    let info: ParsedContainerInfo = { width: null, height: null, codec: null, faststart: null };
    let totalSize: number | null = null;
    if (options.localReader) {
      const headChunk = await options.localReader(normalizedUrl, 0, 131071);
      if (headChunk) {
        totalSize = headChunk.totalSize;
        info = parseVideoContainerBytes(headChunk.bytes, 'video/mp4');
        if ((!info.width || !info.height) && totalSize > 131072) {
          const tailStart = Math.max(0, totalSize - 131072);
          const tailChunk = await options.localReader(normalizedUrl, tailStart, totalSize - 1);
          if (tailChunk) {
            const tailInfo = parseMp4Container(tailChunk.bytes, 'moov');
            info.width = info.width || tailInfo.width;
            info.height = info.height || tailInfo.height;
            info.codec = info.codec || tailInfo.codec;
          }
        }
      }
    }

    return {
      valid: true,
      normalizedUrl,
      convertedFromGithub: false,
      audit: {
        videoReachable: true,
        videoStatus: 200,
        videoHttps: !options.origin || options.origin.startsWith('https://'),
        videoMimeType: 'video/mp4',
        videoContentLength: totalSize,
        acceptRanges: true,
        rangeSupported: true,
        rangeStatus: 206,
        detectedWidth: info.width,
        detectedHeight: info.height,
        codec: info.codec,
        faststart: info.faststart,
        isGithubRaw: false,
        xCrawlerReady: true,
        playerReachable: true,
        playerStatus: 200,
        playerHttps: !options.origin || options.origin.startsWith('https://'),
        errors,
        warnings,
      },
    };
  }

  // External HTTPS stream probe
  let headRes = await fetchWithValidatedRedirects(normalizedUrl, 'HEAD', {}, true);
  if (headRes.response) {
    await headRes.response.body?.cancel();
  }

  let headStatus = headRes.status;
  let rawContentType = headRes.response?.headers.get('content-type') || null;
  let contentLengthHeader = headRes.response?.headers.get('content-length') || null;
  let acceptRangesHeader = headRes.response?.headers.get('accept-ranges') || null;

  // Attempt byte-range GET for HTTP 206 verification & real header/dimension inspection
  const rangeRes = await fetchWithValidatedRedirects(
    normalizedUrl,
    'GET',
    { Range: 'bytes=0-131071' },
    true
  );

  let rangeStatus = rangeRes.status;
  let headBytes: Uint8Array = new Uint8Array(0);
  if (rangeRes.response) {
    rawContentType = rangeRes.response.headers.get('content-type') || rawContentType;
    acceptRangesHeader = rangeRes.response.headers.get('accept-ranges') || acceptRangesHeader;
    const contentRange = rangeRes.response.headers.get('content-range');
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)$/);
      if (m) contentLengthHeader = m[1];
    } else if (!contentLengthHeader) {
      contentLengthHeader = rangeRes.response.headers.get('content-length');
    }
    headBytes = await readUpToBytes(rangeRes.response.body, 131072);
  }

  const totalLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
  const videoStatus = headStatus || rangeStatus;
  const videoReachable = Boolean(
    (headRes.ok || rangeRes.ok) && videoStatus && videoStatus >= 200 && videoStatus < 400
  );
  const rangeSupported = rangeStatus === 206;
  const acceptRanges = acceptRangesHeader?.toLowerCase().includes('bytes') || rangeSupported;

  if (!videoReachable) {
    errors.push(headRes.error || rangeRes.error || 'Video URL is unreachable over HTTPS.');
  }

  const headerMime = detectVideoMimeFromContentType(rawContentType);
  const inferredMime = headerMime || urlCheck.mimeType || null;
  if (rawContentType && !headerMime && !isGithubRaw) {
    warnings.push(
      `Upstream returned Content-Type "${rawContentType}" instead of video/mp4 or video/webm. Ensure your CDN serves video/mp4.`
    );
  }
  if (!rangeSupported && videoReachable) {
    warnings.push(
      `Server returned HTTP ${rangeStatus ?? 'N/A'} instead of 206 Partial Content for Byte-Range requests. X/Twitter streaming requires HTTP Range support.`
    );
  }

  let parsed = parseVideoContainerBytes(headBytes, inferredMime);
  if ((!parsed.width || !parsed.height) && rangeSupported && totalLength && totalLength > 131072) {
    const tailStart = Math.max(0, totalLength - 131072);
    const tailRes = await fetchWithValidatedRedirects(
      normalizedUrl,
      'GET',
      { Range: `bytes=${tailStart}-${totalLength - 1}` },
      true
    );
    if (tailRes.response) {
      const tailBytes = await readUpToBytes(tailRes.response.body, 131072);
      const tailInfo = parseMp4Container(tailBytes, 'moov');
      parsed = {
        width: parsed.width || tailInfo.width,
        height: parsed.height || tailInfo.height,
        codec: parsed.codec || tailInfo.codec,
        faststart: parsed.faststart ?? false,
      };
    }
  }

  if (parsed.faststart === false) {
    warnings.push(
      'MP4 moov atom is placed after mdat (not faststart). Re-mux with -movflags +faststart for faster inline startup.'
    );
  }

  if (parsed.codec && ['hvc1', 'hev1'].includes(parsed.codec)) {
    warnings.push(
      `Video uses HEVC/H.265 (${parsed.codec}), which has limited browser and X crawler compatibility. H.264 (avc1) + AAC MP4 is recommended.`
    );
  }

  let playerReachable = true;
  let playerStatus: number | null = 200;
  let playerHttps = true;
  if (options.playerUrl) {
    playerHttps = options.playerUrl.startsWith('https://');
    if (options.playerUrl.startsWith('https://') && !options.playerUrl.startsWith(options.origin || '')) {
      const pRes = await fetchWithValidatedRedirects(options.playerUrl, 'HEAD', {}, true);
      await pRes.response?.body?.cancel();
      playerReachable = pRes.ok;
      playerStatus = pRes.status;
    }
  }

  const xCrawlerReady = Boolean(
    normalizedUrl.startsWith('https://') &&
      videoReachable &&
      inferredMime &&
      rangeSupported &&
      !isGithubRaw
  );

  return {
    valid: errors.length === 0,
    normalizedUrl,
    convertedFromGithub: urlCheck.convertedFromGithub,
    audit: {
      videoReachable,
      videoStatus,
      videoHttps: normalizedUrl.startsWith('https://'),
      videoMimeType: inferredMime,
      videoContentLength: Number.isFinite(totalLength) ? totalLength : null,
      acceptRanges,
      rangeSupported,
      rangeStatus,
      detectedWidth: parsed.width,
      detectedHeight: parsed.height,
      codec: parsed.codec,
      faststart: parsed.faststart,
      isGithubRaw,
      xCrawlerReady,
      playerReachable,
      playerStatus,
      playerHttps,
      errors,
      warnings,
    },
  };
}
