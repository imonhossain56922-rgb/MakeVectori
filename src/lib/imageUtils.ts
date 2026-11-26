/**
 * Cross-browser & iOS Safari-compatible image, Base64, Blob, Clipboard, and URL utilities.
 * - Eliminates Safari DOMException/SyntaxError ("The string did not match the expected pattern.")
 * - Sanitizes Unicode/Arabic/Bengali/emoji filenames into unique safe ASCII filenames
 * - Validates binary magic bytes & handles HEIC/HEIF cleanly
 */

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/x-png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/gif': 'gif',
};

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
};

const VALID_RASTER_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']);

export function trimUrl(raw: string | undefined | null): string {
  return String(raw || '').trim();
}

export function trimToken(raw: string | undefined | null): string {
  return String(raw || '').trim();
}

/**
 * Strips any `data:image/...;base64,` prefix and removes all whitespace/line breaks
 * so Base64 payloads are valid across iOS Safari and server decoders.
 */
export function stripDataUrlPrefix(input: string): string {
  const trimmed = String(input || '').trim();
  const commaIdx = trimmed.indexOf(',');
  const payload =
    trimmed.startsWith('data:') && commaIdx !== -1
      ? trimmed.slice(commaIdx + 1)
      : trimmed;
  return payload.replace(/\s+/g, '');
}

/**
 * Safely converts a Data URL or raw Base64 string into a native Blob without using fetch(dataUrl),
 * which throws DOMException ("The string did not match the expected pattern") on iOS Safari.
 */
export function dataUrlToBlob(dataUrlOrBase64: string, fallbackMime = 'image/png'): Blob {
  const raw = String(dataUrlOrBase64 || '').trim();
  let mimeType = fallbackMime;

  const headerMatch = raw.match(/^data:([^;,]+)(?:;[^,]*)?,/i);
  if (headerMatch?.[1]) {
    mimeType = headerMatch[1].trim().toLowerCase();
  }

  let cleanB64 = stripDataUrlPrefix(raw)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const pad = cleanB64.length % 4;
  if (pad === 2) cleanB64 += '==';
  else if (pad === 3) cleanB64 += '=';

  const binaryStr = window.atob(cleanB64);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Reads a File/Blob via FileReader and returns clean Base64 (without data URL prefix or whitespace).
 */
export function blobToCleanBase64(blob: Blob): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read image data.'));
        return;
      }
      const clean = stripDataUrlPrefix(reader.result);
      resolve({
        base64: clean,
        mimeType: normalizeImageMimeType(blob.type) || 'image/png',
      });
    };
    reader.onerror = () => {
      reject(new Error('Failed to read the selected image file.'));
    };
    reader.readAsDataURL(blob);
  });
}

export function normalizeImageMimeType(rawMime: string | undefined | null): string {
  const base = String(rawMime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!base || base === 'application/octet-stream' || base === 'binary/octet-stream') return '';
  if (base === 'image/jpg' || base === 'image/pjpeg') return 'image/jpeg';
  if (base === 'image/x-png') return 'image/png';
  if (base === 'image/x-ms-bmp') return 'image/bmp';
  if (base === 'image/heic-sequence') return 'image/heic';
  if (base === 'image/heif-sequence') return 'image/heif';
  return base;
}

export function extractRawExtension(filename: string | undefined | null): string {
  const clean = String(filename || '').trim();
  const base = clean.split(/[/\\]/).pop() || '';
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === base.length - 1) return '';
  return base.slice(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Replaces non-ASCII (Arabic, Bengali, CJK, accented, emoji) and special characters with safe ASCII,
 * generates a unique filename, and preserves the original valid image extension.
 */
export function buildSafeImageFile(
  blob: Blob,
  rawName = 'uploaded_image',
  rawMime?: string,
  detectedExt?: string
): File {
  const normalizedMime = normalizeImageMimeType(rawMime || blob.type);
  const originalExt = extractRawExtension(rawName);
  const cleanDetectedExt = detectedExt ? detectedExt.toLowerCase() : '';

  let ext = '';
  if (originalExt && VALID_RASTER_EXTS.has(originalExt)) {
    // Preserve user's original extension (.jpeg vs .jpg) when it matches/is valid
    ext = originalExt;
  } else if (cleanDetectedExt && VALID_RASTER_EXTS.has(cleanDetectedExt)) {
    ext = cleanDetectedExt;
  } else if (normalizedMime && MIME_TO_EXT[normalizedMime]) {
    ext = MIME_TO_EXT[normalizedMime];
  } else {
    ext = 'png';
  }

  const resolvedMime =
    (normalizedMime && MIME_TO_EXT[normalizedMime] ? normalizedMime : undefined) ||
    EXT_TO_MIME[ext] ||
    'image/png';

  const rawLeaf = String(rawName || 'image').split(/[/\\]/).pop() || 'image';
  const stem = rawLeaf.replace(/\.[^/.]+$/, '');
  const asciiStem = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);

  const safeStem = asciiStem || 'image';
  const uniqueTag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const safeFilename = `${safeStem}_${uniqueTag}.${ext}`;

  return new File([blob], safeFilename, {
    type: resolvedMime,
    lastModified: Date.now(),
  });
}

export interface ClientSignatureInspection {
  valid: boolean;
  isHeic: boolean;
  isTextMarkup: boolean;
  mimeType: string | null;
  extension: string | null;
}

/**
 * Inspects the first 512 bytes of a File/Blob locally before uploading.
 * Works reliably on iOS Safari even when `file.type` is empty.
 */
export async function inspectClientImageBytes(file: Blob): Promise<ClientSignatureInspection> {
  if (!file || file.size < 12) {
    return { valid: false, isHeic: false, isTextMarkup: false, mimeType: null, extension: null };
  }

  const sliceLen = Math.min(file.size, 512);
  const buffer = await file.slice(0, sliceLen).arrayBuffer();
  const buf = new Uint8Array(buffer);

  // Check for HTML / SVG / XML scripts disguised as images
  let asciiHead = '';
  for (let i = 0; i < Math.min(buf.length, 256); i++) {
    const ch = buf[i];
    if (ch >= 9 && ch <= 126) asciiHead += String.fromCharCode(ch);
  }
  const headLower = asciiHead.trimStart().toLowerCase();
  if (
    headLower.startsWith('<svg') ||
    headLower.startsWith('<?xml') ||
    headLower.startsWith('<!doctype') ||
    headLower.startsWith('<html') ||
    headLower.includes('<script')
  ) {
    return { valid: false, isHeic: false, isTextMarkup: true, mimeType: null, extension: null };
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
    return { valid: true, isHeic: false, isTextMarkup: false, mimeType: 'image/png', extension: 'png' };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, isHeic: false, isTextMarkup: false, mimeType: 'image/jpeg', extension: 'jpg' };
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
    return { valid: true, isHeic: false, isTextMarkup: false, mimeType: 'image/webp', extension: 'webp' };
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
    return { valid: true, isHeic: false, isTextMarkup: false, mimeType: 'image/gif', extension: 'gif' };
  }

  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { valid: true, isHeic: false, isTextMarkup: false, mimeType: 'image/bmp', extension: 'bmp' };
  }

  // ISO BMFF HEIC/HEIF: ....ftyp(heic|heix|heim|heis|hevc|hevx|mif1|msf1)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]).toLowerCase();
    if (
      brand === 'heic' ||
      brand === 'heix' ||
      brand === 'heim' ||
      brand === 'heis' ||
      brand === 'hevc' ||
      brand === 'hevx' ||
      brand === 'mif1' ||
      brand === 'msf1'
    ) {
      return { valid: false, isHeic: true, isTextMarkup: false, mimeType: 'image/heic', extension: 'heic' };
    }
  }

  return { valid: false, isHeic: false, isTextMarkup: false, mimeType: null, extension: null };
}

/**
 * Attempts native browser decoding (works natively on iOS/macOS Safari for HEIC/HEIF)
 * and re-encodes cleanly to JPEG via Canvas. Returns null when the browser cannot decode HEIC.
 */
async function tryConvertHeicInBrowser(file: Blob): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null;

  let width = 0;
  let height = 0;
  let drawSource: CanvasImageSource | null = null;
  let bitmap: ImageBitmap | null = null;
  let objectUrl: string | null = null;

  try {
    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = await Promise.race([
          createImageBitmap(file),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
        width = bitmap.width;
        height = bitmap.height;
        drawSource = bitmap;
      } catch {
        bitmap = null;
      }
    }

    if (!drawSource && typeof URL.createObjectURL === 'function') {
      objectUrl = URL.createObjectURL(file);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        const timer = setTimeout(() => reject(new Error('timeout')), 6000);
        el.onload = () => {
          clearTimeout(timer);
          resolve(el);
        };
        el.onerror = () => {
          clearTimeout(timer);
          reject(new Error('decode_failed'));
        };
        el.src = objectUrl!;
      });
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
      drawSource = img;
    }

    if (!drawSource || width < 4 || height < 4) return null;

    // Respect server dimension bounds
    const maxDim = 4096;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const outW = Math.max(4, Math.round(width * scale));
    const outH = Math.max(4, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(drawSource, 0, 0, outW, outH);

    const outBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
    );
    return outBlob && outBlob.size > 0 ? outBlob : null;
  } catch {
    return null;
  } finally {
    try {
      bitmap?.close();
    } catch {
      // ignore
    }
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Validates, converts (if browser supports HEIC), and wraps an uploaded File/Blob
 * into a guaranteed iOS Safari-safe File with sanitized unique ASCII filename.
 */
export async function prepareUploadImageFile(
  fileOrBlob: Blob,
  rawName?: string,
  rawMime?: string,
  maxUploadMb = 25
): Promise<File> {
  if (!fileOrBlob || !(fileOrBlob instanceof Blob)) {
    throw new Error('Invalid image file selected.');
  }
  if (fileOrBlob.size === 0) {
    throw new Error('The selected image file is empty (0 bytes).');
  }

  const maxBytes = maxUploadMb * 1024 * 1024;
  if (fileOrBlob.size > maxBytes) {
    throw new Error(`Image file is too large. Maximum allowed size is ${maxUploadMb} MB.`);
  }

  const effectiveName = rawName || (fileOrBlob instanceof File ? fileOrBlob.name : 'uploaded_image');
  const effectiveMime = normalizeImageMimeType(rawMime || fileOrBlob.type);
  const extFromName = extractRawExtension(effectiveName);

  const sig = await inspectClientImageBytes(fileOrBlob);

  if (sig.isTextMarkup) {
    throw new Error(
      'SVG, HTML, and XML files cannot be uploaded as raster images. Please choose a PNG, JPG, WebP, BMP, or GIF file.'
    );
  }

  const looksLikeHeic =
    sig.isHeic ||
    effectiveMime === 'image/heic' ||
    effectiveMime === 'image/heif' ||
    extFromName === 'heic' ||
    extFromName === 'heif';

  if (looksLikeHeic) {
    const converted = await tryConvertHeicInBrowser(fileOrBlob);
    if (converted) {
      const convertedName = effectiveName.replace(/\.(heic|heif)$/i, '.jpg');
      return buildSafeImageFile(converted, convertedName, 'image/jpeg', 'jpg');
    }
    throw new Error(
      'HEIC/HEIF photos are not supported by this browser. Please select a JPG, PNG, or WebP image (or set iPhone Camera > Formats to Most Compatible).'
    );
  }

  if (!sig.valid || !sig.mimeType || !sig.extension) {
    throw new Error(
      'Unsupported or corrupted image file. Please select a valid PNG, JPG, JPEG, WebP, BMP, or GIF image.'
    );
  }

  return buildSafeImageFile(fileOrBlob, effectiveName, sig.mimeType, sig.extension);
}

export function createSafePreviewUrl(blob: Blob): string | undefined {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
  try {
    return URL.createObjectURL(blob);
  } catch {
    return undefined;
  }
}

export function revokeSafePreviewUrl(url?: string | null): void {
  if (!url || !url.startsWith('blob:')) return;
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

export interface ClipboardImageReadResult {
  file: File | null;
  errorMessage?: string;
}

/**
 * Safely reads an image from the browser clipboard with full iOS Safari / mobile compatibility.
 */
export async function readClipboardImageSafe(): Promise<ClipboardImageReadResult> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { file: null, errorMessage: 'Clipboard access is unavailable in this environment.' };
  }

  if (!window.isSecureContext) {
    return {
      file: null,
      errorMessage: 'Clipboard image pasting requires a secure HTTPS connection.',
    };
  }

  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== 'function') {
    return {
      file: null,
      errorMessage:
        'Direct clipboard reading is not supported on this browser. Tap Upload Image or paste directly (Ctrl+V / Cmd+V).',
    };
  }

  try {
    const items = await clipboard.read();
    if (!Array.isArray(items) || items.length === 0) {
      return {
        file: null,
        errorMessage: 'Your clipboard is empty. Copy an image first and try again.',
      };
    }

    for (const item of items) {
      const types = Array.isArray(item.types) ? item.types : [];
      const imgType = types.find((t) => t.toLowerCase().startsWith('image/'));
      if (!imgType) continue;

      try {
        const blob = await item.getType(imgType);
        if (!blob || blob.size === 0) continue;
        const file = await prepareUploadImageFile(blob, 'clipboard_image', imgType);
        return { file };
      } catch (innerErr) {
        if (innerErr instanceof Error && /HEIC|corrupted|Unsupported|empty|large/i.test(innerErr.message)) {
          return { file: null, errorMessage: innerErr.message };
        }
        // Continue checking remaining clipboard items if one type fails on mobile Safari
      }
    }

    return {
      file: null,
      errorMessage: 'No image was found on your clipboard. Copy an image or screenshot first.',
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message : String(err || '');

    if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|gesture/i.test(msg)) {
      return {
        file: null,
        errorMessage:
          'Clipboard permission was not granted by your browser. Tap Upload Image to choose a photo from your device.',
      };
    }

    if (/pattern|not supported|type/i.test(msg)) {
      return {
        file: null,
        errorMessage:
          'This mobile browser could not read the clipboard item format. Please tap Upload Image instead.',
      };
    }

    return {
      file: null,
      errorMessage: 'Unable to read an image from your clipboard. Please tap Upload Image instead.',
    };
  }
}
