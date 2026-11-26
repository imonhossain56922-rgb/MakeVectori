import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import * as jose from 'jose';

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_REGEX.test(id);
}

export function sanitizeFilename(name: string, fallbackExt = ''): string {
  const leaf = path.basename(String(name || 'image').replace(/\\/g, '/'));
  const parsed = path.parse(leaf);
  const rawStem = parsed.name || 'image';
  const rawExt = (parsed.ext || '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const cleanStem =
    rawStem
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 64) || 'image';

  const chosenExt = rawExt || fallbackExt.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return chosenExt ? `${cleanStem}.${chosenExt}` : cleanStem;
}

export function resolveSafeSubpath(baseDir: string, targetName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, targetName);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Invalid file path traversal attempt');
  }
  return resolvedTarget;
}

export interface MagicSignatureResult {
  valid: boolean;
  isHeic?: boolean;
  mimeType: string | null;
  extension: string | null;
}

/**
 * Inspects actual binary magic bytes rather than trusting uploaded filename or Content-Type header.
 */
export function detectImageSignature(buf: Buffer): MagicSignatureResult {
  if (!buf || buf.length < 12) {
    return { valid: false, mimeType: null, extension: null };
  }

  // Reject HTML / SVG / XML scripts masquerading as raster images
  const headText = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').trimStart().toLowerCase();
  if (
    headText.startsWith('<svg') ||
    headText.startsWith('<?xml') ||
    headText.startsWith('<!doctype html') ||
    headText.startsWith('<html') ||
    headText.includes('<script')
  ) {
    return { valid: false, mimeType: null, extension: null };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { valid: true, mimeType: 'image/png', extension: 'png' };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, mimeType: 'image/jpeg', extension: 'jpg' };
  }

  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { valid: true, mimeType: 'image/webp', extension: 'webp' };
  }

  // GIF: GIF87a or GIF89a
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { valid: true, mimeType: 'image/gif', extension: 'gif' };
  }

  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { valid: true, mimeType: 'image/bmp', extension: 'bmp' };
  }

  // ISO BMFF HEIC/HEIF: ....ftyp(heic|heix|heim|heis|hevc|hevx|mif1|msf1)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return { valid: false, isHeic: true, mimeType: 'image/heic', extension: 'heic' };
    }
  }

  return { valid: false, mimeType: null, extension: null };
}

/**
 * Strips any unsafe scripts, foreignObject, event handlers, or javascript: URIs from SVG output.
 */
export function sanitizeSvgXml(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, 'blocked:')
    .replace(/data\s*:\s*text\/html/gi, 'blocked:');
}

export function generateSecureId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

// Lightweight Firebase ID token verifier using Google public x509 certs (zero IAM needed)
let cachedCerts: Record<string, string> | null = null;
let certsExpiresAt = 0;

function readFirebaseConfig(): { projectId?: string; storageBucket?: string } | null {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch {
    // ignore
  }
  return null;
}

function getFirebaseProjectId(): string | null {
  return readFirebaseConfig()?.projectId || null;
}

export function getFirebaseStorageBucket(): string | null {
  return readFirebaseConfig()?.storageBucket || null;
}

async function fetchGoogleCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now < certsExpiresAt) {
    return cachedCerts;
  }
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error('Failed to fetch Firebase token certificates');
  }
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeSec = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;
  cachedCerts = (await res.json()) as Record<string, string>;
  certsExpiresAt = now + maxAgeSec * 1000;
  return cachedCerts;
}

export interface VerifiedCaller {
  uid: string;
  email?: string;
  emailVerified: boolean;
}

export async function verifyOptionalFirebaseAuth(
  authHeader: string | undefined
): Promise<VerifiedCaller | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const projectId = getFirebaseProjectId();
  if (!projectId) return null;

  try {
    const header = jose.decodeProtectedHeader(token);
    if (!header.kid) return null;
    const certs = await fetchGoogleCerts();
    const pem = certs[header.kid];
    if (!pem) return null;

    const key = await jose.importX509(pem, 'RS256');
    const { payload } = await jose.jwtVerify(token, key, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    const uid = typeof payload.sub === 'string' ? payload.sub : null;
    if (!uid) return null;
    return {
      uid,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified: payload.email_verified === true,
    };
  } catch {
    return null;
  }
}
