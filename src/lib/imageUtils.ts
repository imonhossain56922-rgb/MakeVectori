/**
 * iOS Safari-compatible image, Base64, Blob, Clipboard, and URL utilities.
 * Avoids fetch(dataUrl) and raw atob() failures ("The string did not match the expected pattern").
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

export function trimUrl(raw: string): string {
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
 * which throws DOMException ("The string did not match the expected pattern") on iOS Safari
 * when Data URLs contain whitespace, unusual MIME parameters, or large payloads.
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

  // Pad base64 length to a multiple of 4 if needed
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
        mimeType: normalizeImageMimeType(blob.type),
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
  if (base === 'image/jpg' || base === 'image/pjpeg') return 'image/jpeg';
  if (base === 'image/x-png') return 'image/png';
  if (base === 'image/x-ms-bmp') return 'image/bmp';
  return base || 'image/png';
}

export function buildSafeImageFile(blob: Blob, rawName = 'pasted_image', rawMime?: string): File {
  const mimeType = normalizeImageMimeType(rawMime || blob.type);
  const ext = MIME_TO_EXT[mimeType] || 'png';
  const baseName =
    rawName
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'pasted_image';

  return new File([blob], `${baseName}.${ext}`, { type: mimeType });
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
        const file = buildSafeImageFile(blob, 'clipboard_image', imgType);
        return { file };
      } catch {
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
