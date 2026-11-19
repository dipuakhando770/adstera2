// Pure Web Crypto API utilities (100% Cloudflare Workers + Node 22 compatible)

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

export function randomId(prefix = ''): string {
  const uuid = globalThis.crypto.randomUUID();
  return prefix ? `${prefix}_${uuid.replace(/-/g, '').slice(0, 16)}` : uuid;
}

export function generateSecureToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(digest);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return `pbkdf2_sha256$100000$${toHex(salt)}$${toHex(derived)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }
  const iterations = parseInt(parts[1], 10);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt.buffer as ArrayBuffer,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    )
  );

  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) {
    diff |= derived[i] ^ expected[i];
  }
  return diff === 0;
}

export async function createAnonymousVisitorId(ip: string, userAgent: string): Promise<string> {
  const dayKey = new Date().toISOString().slice(0, 10);
  const raw = `${dayKey}|${ip}|${userAgent}`;
  const full = await sha256Hex(raw);
  return full.slice(0, 24);
}

export function parseUserAgent(uaRaw: string): {
  deviceType: 'Desktop' | 'Mobile' | 'Tablet';
  browser: string;
  operatingSystem: string;
} {
  const ua = uaRaw || '';
  let deviceType: 'Desktop' | 'Mobile' | 'Tablet' = 'Desktop';
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) {
    deviceType = 'Tablet';
  } else if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) {
    deviceType = 'Mobile';
  }

  let browser = 'Other';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome|crios/i.test(ua) && !/edg/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua) && !/chrome|crios/i.test(ua)) browser = 'Safari';
  else if (/curl|wget|bot|crawler|spider/i.test(ua)) browser = 'Bot / CLI';

  let operatingSystem = 'Other';
  if (/iphone|ipad|ipod/i.test(ua)) operatingSystem = 'iOS';
  else if (/android/i.test(ua)) operatingSystem = 'Android';
  else if (/windows/i.test(ua)) operatingSystem = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) operatingSystem = 'macOS';
  else if (/linux/i.test(ua)) operatingSystem = 'Linux';

  return { deviceType, browser, operatingSystem };
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
