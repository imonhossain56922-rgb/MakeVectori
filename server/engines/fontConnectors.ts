import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  FontLicenseClass,
  FontSourceHealth,
  GlyphAnatomyAnalysis,
} from '../../src/types/vector.ts';

// ============================================================================
// Normalized Connector Types & Allowlists
// ============================================================================

export interface NormalizedFontCandidate {
  id: string;
  family: string;
  styleName: string;
  weight: number;
  isItalic: boolean;
  foundryOrDesigner: string;
  sourceName: string;
  sourceReliability: 'official-catalog' | 'official-foundry-web' | 'marketplace-web' | 'open-repo';
  officialPageUrl: string | null;
  licenseName: string;
  licenseClass: FontLicenseClass | 'Commercial Proprietary License';
  commercialUseAllowed: boolean | null;
  weights: number[];
  styles: string[];
  subsets: string[];
  binaryUrls: {
    ttf?: string;
    otf?: string;
    woff2?: string;
    woff?: string;
  };
  cssUrl: string;
  inOpenCatalog: boolean;
  initialEvidence: string[];
}

export interface FontSearchConnectorMeta {
  sourceName: string;
  supportedMethods: string[];
  reliability: 'high' | 'medium';
}

export const ALLOWED_FONT_BINARY_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'api.fontsource.org',
  'fonts.gstatic.com',
  'fonts.googleapis.com',
]);

export function isAllowedFontDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return parsed.protocol === 'https:' && ALLOWED_FONT_BINARY_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function isSafePublicWebUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host === '169.254.169.254'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function normalizeExactFamily(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeFamilyKey(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(
      /\b(thin|extralight|light|regular|book|roman|medium|semibold|demibold|bold|extrabold|heavy|black|ultra|italic|oblique|condensed|narrow|compressed|extended|wide|display|text|pro|std|mt|lt|pt)\b/gi,
      ''
    )
    .replace(/[^a-z0-9]/g, '');
}

export function slugifyFamily(name: string): string {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function classifyFontLicense(
  raw: string | undefined,
  isOpenSourceFlag?: boolean
): {
  licenseName: string;
  licenseClass: FontLicenseClass | 'Commercial Proprietary License';
  commercialUseAllowed: boolean | null;
} {
  const val = (raw || '').trim();
  const lower = val.toLowerCase();

  if (lower.includes('ofl') || lower.includes('open font') || lower.includes('sil')) {
    return {
      licenseName: val.includes('1.1') ? 'SIL Open Font License 1.1' : 'SIL Open Font License',
      licenseClass: 'Free for Personal and Commercial Use',
      commercialUseAllowed: true,
    };
  }
  if (lower.includes('apache')) {
    return {
      licenseName: val.includes('2') ? 'Apache License 2.0' : 'Apache License',
      licenseClass: 'Free for Personal and Commercial Use',
      commercialUseAllowed: true,
    };
  }
  if (lower.includes('ufl') || lower.includes('ubuntu')) {
    return {
      licenseName: 'Ubuntu Font License 1.0',
      licenseClass: 'Free for Personal and Commercial Use',
      commercialUseAllowed: true,
    };
  }
  if (lower === 'mit' || lower.includes('mit ')) {
    return {
      licenseName: 'MIT License',
      licenseClass: 'Free for Personal and Commercial Use',
      commercialUseAllowed: true,
    };
  }
  if (lower.includes('cc0') || lower.includes('public domain') || lower.includes('gpl')) {
    return {
      licenseName: val || 'Open Source License',
      licenseClass: 'Free for Personal and Commercial Use',
      commercialUseAllowed: true,
    };
  }
  if (lower.includes('personal') && !lower.includes('commercial')) {
    return {
      licenseName: val,
      licenseClass: 'Free for Personal Use Only',
      commercialUseAllowed: false,
    };
  }
  if (
    lower.includes('commercial') ||
    lower.includes('proprietary') ||
    lower.includes('paid') ||
    lower.includes('retail') ||
    lower.includes('foundry')
  ) {
    return {
      licenseName: val || 'Commercial Proprietary License',
      licenseClass: 'Paid Font',
      commercialUseAllowed: false,
    };
  }
  if (isOpenSourceFlag === true) {
    return {
      licenseName: val || 'Open Source (SIL OFL / Apache)',
      licenseClass: 'Free for Personal and Commercial Use',
      commercialUseAllowed: true,
    };
  }
  return {
    licenseName: val || 'Unverified License',
    licenseClass: 'Unknown or Unverified License',
    commercialUseAllowed: null,
  };
}

// ============================================================================
// Catalog Data Structures & Caches
// ============================================================================

export interface CatalogFontEntry {
  id: string;
  family: string;
  normalizedFamily: string;
  looseKey: string;
  designer: string;
  googleCategory: string;
  stroke: string | null;
  classifications: string[];
  subsets: string[];
  weights: number[];
  styles: string[];
  variable: boolean;
  licenseRaw: string;
  licenseClass: FontLicenseClass | 'Commercial Proprietary License';
  commercialUseAllowed: boolean | null;
  popularity: number;
  inFontsource: boolean;
  inGoogleFonts: boolean;
  inFontSquirrel: boolean;
  fontSquirrelSlug?: string;
  metrics400: {
    thickness: number | null;
    slant: number | null;
    width: number | null;
    lineHeight: number | null;
  };
}

export interface FontsourceDetailResponse {
  id: string;
  family: string;
  license?: string;
  source?: string;
  version?: string;
  weights?: number[];
  styles?: string[];
  defSubset?: string;
  subsets?: string[];
  variants?: {
    [weight: string]: {
      [style: string]: {
        [subset: string]: {
          url?: {
            woff2?: string;
            woff?: string;
            ttf?: string;
            otf?: string;
          };
        };
      };
    };
  };
}

export interface CatalogCacheState {
  loadedAt: number;
  entries: CatalogFontEntry[];
  byNormFamily: Map<string, CatalogFontEntry>;
  byLooseKey: Map<string, CatalogFontEntry[]>;
  byId: Map<string, CatalogFontEntry>;
  health: FontSourceHealth[];
}

const CATALOG_TTL_MS = 1000 * 60 * 60 * 6;
let catalogCache: CatalogCacheState | null = null;
const fontDetailCache = new Map<string, { loadedAt: number; data: FontsourceDetailResponse }>();

// ============================================================================
// Connector 1, 2, 3: Google Fonts + Fontsource + Font Squirrel
// ============================================================================

export const CATALOG_CONNECTOR_METADATA: FontSearchConnectorMeta[] = [
  {
    sourceName: 'Google Fonts Metadata & CSS2 API',
    supportedMethods: ['family-lookup', 'classification-search', 'ttf-woff2-specimen'],
    reliability: 'high',
  },
  {
    sourceName: 'Fontsource v1 Open Registry',
    supportedMethods: ['family-lookup', 'license-verification', 'ttf-woff2-woff-download'],
    reliability: 'high',
  },
  {
    sourceName: 'Font Squirrel Open Catalog API',
    supportedMethods: ['family-lookup', 'license-metadata'],
    reliability: 'medium',
  },
  {
    sourceName: 'Official Type Foundry & Catalogue Web Research',
    supportedMethods: ['glyph-forensics', 'foundry-specimen-search', 'marketplace-verification'],
    reliability: 'high',
  },
];

export async function getLiveFontCatalog(): Promise<CatalogCacheState> {
  if (
    catalogCache &&
    Date.now() - catalogCache.loadedAt < CATALOG_TTL_MS &&
    catalogCache.entries.length > 0
  ) {
    return catalogCache;
  }

  const health: FontSourceHealth[] = [];
  const merged = new Map<string, CatalogFontEntry>();

  // 1. Google Fonts Metadata API
  try {
    const url = 'https://fonts.google.com/metadata/fonts'.trim();
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MakeVectorizer-FontResearch/2.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      familyMetadataList?: Array<{
        family: string;
        category?: string;
        stroke?: string | null;
        classifications?: string[];
        subsets?: string[];
        fonts?: Record<string, { thickness?: number | null; slant?: number | null; width?: number | null; lineHeight?: number | null }>;
        designers?: string[];
        popularity?: number;
        isOpenSource?: boolean;
        axes?: Array<{ tag: string }>;
      }>;
    };
    const list = Array.isArray(data.familyMetadataList) ? data.familyMetadataList : [];
    for (const item of list) {
      if (!item.family) continue;
      const norm = normalizeExactFamily(item.family);
      const fontKeys = Object.keys(item.fonts || {});
      const weights = Array.from(
        new Set(
          fontKeys
            .map((k) => parseInt(k.replace(/i$/, ''), 10))
            .filter((n) => !Number.isNaN(n) && n >= 100 && n <= 900)
        )
      ).sort((a, b) => a - b);
      const hasItalic = fontKeys.some((k) => k.endsWith('i'));
      const m400 = item.fonts?.['400'] || item.fonts?.[fontKeys[0] || '400'] || {};
      const lic = classifyFontLicense(item.isOpenSource ? 'OFL-1.1' : '', item.isOpenSource);

      merged.set(norm, {
        id: slugifyFamily(item.family),
        family: item.family,
        normalizedFamily: norm,
        looseKey: normalizeFamilyKey(item.family),
        designer: (item.designers || []).slice(0, 2).join(', ') || 'Open Source Foundry',
        googleCategory: item.category || 'Sans Serif',
        stroke: item.stroke || null,
        classifications: item.classifications || [],
        subsets: (item.subsets || []).filter((s) => s !== 'menu'),
        weights: weights.length > 0 ? weights : [400],
        styles: hasItalic ? ['normal', 'italic'] : ['normal'],
        variable: (item.axes || []).length > 0,
        licenseRaw: item.isOpenSource ? 'OFL-1.1' : '',
        licenseClass: lic.licenseClass,
        commercialUseAllowed: lic.commercialUseAllowed,
        popularity: typeof item.popularity === 'number' ? item.popularity : 9999,
        inFontsource: false,
        inGoogleFonts: true,
        inFontSquirrel: false,
        metrics400: {
          thickness: m400.thickness ?? null,
          slant: m400.slant ?? null,
          width: m400.width ?? null,
          lineHeight: m400.lineHeight ?? null,
        },
      });
    }
    health.push({
      source: 'Google Fonts Catalog',
      ok: true,
      count: list.length,
      method: 'Official Metadata JSON API',
    });
  } catch (err) {
    health.push({
      source: 'Google Fonts Catalog',
      ok: false,
      count: 0,
      method: 'Official Metadata JSON API',
      error: err instanceof Error ? err.message : 'Unavailable',
    });
  }

  // 2. Fontsource v1 Registry
  try {
    const url = 'https://api.fontsource.org/v1/fonts'.trim();
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MakeVectorizer-FontResearch/2.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as Array<{
      id: string;
      family: string;
      subsets?: string[];
      weights?: number[];
      styles?: string[];
      variable?: boolean;
      category?: string;
      license?: string;
    }>;

    for (const fsFont of list) {
      if (!fsFont.id || !fsFont.family) continue;
      const norm = normalizeExactFamily(fsFont.family);
      const lic = classifyFontLicense(fsFont.license, true);
      const existing = merged.get(norm);
      if (existing) {
        existing.id = fsFont.id;
        existing.inFontsource = true;
        existing.licenseRaw = fsFont.license || existing.licenseRaw;
        existing.licenseClass = lic.licenseClass;
        existing.commercialUseAllowed = lic.commercialUseAllowed;
        if (fsFont.weights?.length) existing.weights = fsFont.weights;
        if (fsFont.styles?.length) existing.styles = fsFont.styles;
        if (fsFont.subsets?.length) {
          existing.subsets = Array.from(new Set([...existing.subsets, ...fsFont.subsets]));
        }
        existing.variable = existing.variable || Boolean(fsFont.variable);
      } else {
        const catMap: Record<string, string> = {
          'sans-serif': 'Sans Serif',
          serif: 'Serif',
          display: 'Display',
          handwriting: 'Handwriting',
          monospace: 'Monospace',
        };
        merged.set(norm, {
          id: fsFont.id,
          family: fsFont.family,
          normalizedFamily: norm,
          looseKey: normalizeFamilyKey(fsFont.family),
          designer: 'Open Source Community',
          googleCategory: catMap[(fsFont.category || '').toLowerCase()] || 'Sans Serif',
          stroke: null,
          classifications: [],
          subsets: fsFont.subsets || ['latin'],
          weights: fsFont.weights?.length ? fsFont.weights : [400],
          styles: fsFont.styles?.length ? fsFont.styles : ['normal'],
          variable: Boolean(fsFont.variable),
          licenseRaw: fsFont.license || 'OFL-1.1',
          licenseClass: lic.licenseClass,
          commercialUseAllowed: lic.commercialUseAllowed,
          popularity: 5000,
          inFontsource: true,
          inGoogleFonts: false,
          inFontSquirrel: false,
          metrics400: { thickness: null, slant: null, width: null, lineHeight: null },
        });
      }
    }
    health.push({
      source: 'Fontsource Registry',
      ok: true,
      count: list.length,
      method: 'REST Registry v1',
    });
  } catch (err) {
    health.push({
      source: 'Fontsource Registry',
      ok: false,
      count: 0,
      method: 'REST Registry v1',
      error: err instanceof Error ? err.message : 'Unavailable',
    });
  }

  // 3. Font Squirrel Permitted Public API (never bypasses anti-bot challenges; degrades gracefully)
  try {
    const url = 'https://www.fontsquirrel.com/api/fontlist/all'.trim();
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MakeVectorizer-FontResearch/2.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5500),
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || res.status === 202 || !ct.includes('application/json')) {
      throw new Error(`HTTP ${res.status} (unavailable without browser challenge)`);
    }
    const list = (await res.json()) as Array<{
      family_name?: string;
      family_urlname?: string;
      foundry_name?: string;
      classification?: string;
      is_monospace?: string;
    }>;
    let added = 0;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item.family_name) continue;
        const norm = normalizeExactFamily(item.family_name);
        const existing = merged.get(norm);
        if (existing) {
          existing.inFontSquirrel = true;
          existing.fontSquirrelSlug = item.family_urlname;
          if (item.foundry_name && existing.designer === 'Open Source Community') {
            existing.designer = item.foundry_name;
          }
        } else {
          merged.set(norm, {
            id: item.family_urlname || slugifyFamily(item.family_name),
            family: item.family_name,
            normalizedFamily: norm,
            looseKey: normalizeFamilyKey(item.family_name),
            designer: item.foundry_name || 'Font Squirrel Foundry',
            googleCategory: item.classification || 'Sans Serif',
            stroke: null,
            classifications: item.classification ? [item.classification] : [],
            subsets: ['latin'],
            weights: [400],
            styles: ['normal'],
            variable: false,
            licenseRaw: 'Font Squirrel Listed License',
            licenseClass: 'Unknown or Unverified License',
            commercialUseAllowed: null,
            popularity: 6000,
            inFontsource: false,
            inGoogleFonts: false,
            inFontSquirrel: true,
            fontSquirrelSlug: item.family_urlname,
            metrics400: { thickness: null, slant: null, width: null, lineHeight: null },
          });
        }
        added++;
      }
    }
    health.push({
      source: 'Font Squirrel Catalog',
      ok: true,
      count: added,
      method: 'Public Fontlist API',
    });
  } catch (err) {
    health.push({
      source: 'Font Squirrel Catalog',
      ok: false,
      count: 0,
      method: 'Public Fontlist API',
      error: err instanceof Error ? err.message : 'Unavailable',
    });
  }

  const entries = Array.from(merged.values());
  const byNormFamily = new Map<string, CatalogFontEntry>();
  const byLooseKey = new Map<string, CatalogFontEntry[]>();
  const byId = new Map<string, CatalogFontEntry>();

  for (const e of entries) {
    byNormFamily.set(e.normalizedFamily, e);
    byId.set(e.id, e);
    if (e.looseKey) {
      const bucket = byLooseKey.get(e.looseKey) || [];
      bucket.push(e);
      byLooseKey.set(e.looseKey, bucket);
    }
  }

  catalogCache = {
    loadedAt: Date.now(),
    entries,
    byNormFamily,
    byLooseKey,
    byId,
    health,
  };
  return catalogCache;
}

export async function getFontsourceDetail(fontId: string): Promise<FontsourceDetailResponse | null> {
  const cleanId = encodeURIComponent(String(fontId || '').trim());
  const cached = fontDetailCache.get(cleanId);
  if (cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) {
    return cached.data;
  }
  try {
    const url = `https://api.fontsource.org/v1/fonts/${cleanId}`.trim();
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MakeVectorizer-FontResearch/2.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FontsourceDetailResponse;
    fontDetailCache.set(cleanId, { loadedAt: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

export function pickBestVariantUrls(
  detail: FontsourceDetailResponse | null,
  desiredWeight: number,
  desiredItalic: boolean,
  preferredSubset = 'latin'
): { woff2?: string; woff?: string; ttf?: string; otf?: string; resolvedWeight: number; resolvedStyle: string } {
  if (!detail?.variants) {
    return { resolvedWeight: desiredWeight, resolvedStyle: desiredItalic ? 'italic' : 'normal' };
  }
  const availableWeights = Object.keys(detail.variants)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (availableWeights.length === 0) {
    return { resolvedWeight: desiredWeight, resolvedStyle: 'normal' };
  }
  const closestW = availableWeights.reduce((best, curr) =>
    Math.abs(curr - desiredWeight) < Math.abs(best - desiredWeight) ? curr : best
  );
  const weightMap = detail.variants[String(closestW)];
  const styleKey =
    desiredItalic && weightMap?.italic
      ? 'italic'
      : weightMap?.normal
      ? 'normal'
      : Object.keys(weightMap || {})[0] || 'normal';
  const styleMap = weightMap?.[styleKey] || {};
  const subsetKey = styleMap[preferredSubset]
    ? preferredSubset
    : detail.defSubset && styleMap[detail.defSubset]
    ? detail.defSubset
    : styleMap.latin
    ? 'latin'
    : Object.keys(styleMap)[0];
  const urlObj = subsetKey ? styleMap[subsetKey]?.url : undefined;
  return {
    woff2: urlObj?.woff2,
    woff: urlObj?.woff,
    ttf: urlObj?.ttf,
    otf: urlObj?.otf,
    resolvedWeight: closestW,
    resolvedStyle: styleKey,
  };
}

/**
 * Fetches Google Fonts CSS2 directly to retrieve verified fonts.gstatic.com TTF and WOFF2 binary URLs,
 * even for Google Fonts not yet mirrored in Fontsource.
 */
export async function resolveGoogleFontsCss2Binaries(
  family: string,
  weight: number,
  isItalic: boolean
): Promise<{ ttf?: string; woff2?: string; cssUrl: string }> {
  const cleanFamily = String(family || '').trim();
  const safeWeight = Math.max(100, Math.min(900, Math.round(weight / 100) * 100 || 400));
  const famQuery = encodeURIComponent(cleanFamily).replace(/%20/g, '+');
  const axisQuery = isItalic ? `ital,wght@1,${safeWeight}` : `wght@${safeWeight}`;
  const cssUrl = `https://fonts.googleapis.com/css2?family=${famQuery}:${axisQuery}&display=swap`.trim();

  const out: { ttf?: string; woff2?: string; cssUrl: string } = { cssUrl };

  try {
    // Default User-Agent returns TrueType (.ttf) URLs from fonts.gstatic.com
    const ttfRes = await fetch(cssUrl, { signal: AbortSignal.timeout(7000) });
    if (ttfRes.ok) {
      const css = await ttfRes.text();
      const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.(?:ttf|otf))\)/i);
      if (match?.[1] && isAllowedFontDownloadUrl(match[1])) {
        out.ttf = match[1];
      }
    }
  } catch {
    // ignore
  }

  try {
    // Modern browser User-Agent returns WOFF2 URLs from fonts.gstatic.com
    const woffRes = await fetch(cssUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (woffRes.ok) {
      const css = await woffRes.text();
      const matches = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/gi)];
      const lastMatch = matches[matches.length - 1];
      if (lastMatch?.[1] && isAllowedFontDownloadUrl(lastMatch[1])) {
        out.woff2 = lastMatch[1];
      }
    }
  } catch {
    // ignore
  }

  return out;
}

export function resolveCatalogEntryToCandidate(
  entry: CatalogFontEntry,
  desiredWeight: number,
  desiredItalic: boolean,
  detail: FontsourceDetailResponse | null,
  css2Binaries?: { ttf?: string; woff2?: string; cssUrl: string },
  evidence: string[] = []
): NormalizedFontCandidate {
  const variant = pickBestVariantUrls(detail, desiredWeight, desiredItalic, 'latin');
  const resolvedW = entry.weights.includes(variant.resolvedWeight)
    ? variant.resolvedWeight
    : entry.weights.reduce((b, c) => (Math.abs(c - desiredWeight) < Math.abs(b - desiredWeight) ? c : b), 400);
  const resolvedItalic = desiredItalic && entry.styles.includes('italic');

  const ttf = variant.ttf || css2Binaries?.ttf;
  const woff2 = variant.woff2 || css2Binaries?.woff2;
  const woff = variant.woff;
  const otf = variant.otf;

  const officialPageUrl = entry.inGoogleFonts
    ? `https://fonts.google.com/specimen/${encodeURIComponent(entry.family.replace(/\s+/g, '+'))}`
    : entry.inFontsource
    ? `https://fontsource.org/fonts/${encodeURIComponent(entry.id)}`
    : entry.inFontSquirrel && entry.fontSquirrelSlug
    ? `https://www.fontsquirrel.com/fonts/${encodeURIComponent(entry.fontSquirrelSlug)}`
    : null;

  const cssUrl =
    css2Binaries?.cssUrl ||
    (entry.inGoogleFonts
      ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(entry.family).replace(/%20/g, '+')}:wght@${Array.from(new Set([...entry.weights, 400, 700]))
          .filter((w) => entry.weights.includes(w))
          .sort((a, b) => a - b)
          .join(';')}&display=swap`
      : '');

  const lic = classifyFontLicense(detail?.license || entry.licenseRaw, entry.inGoogleFonts || entry.inFontsource);

  return {
    id: entry.id,
    family: entry.family,
    styleName: `${resolvedW === 400 ? 'Regular' : resolvedW === 700 ? 'Bold' : `Weight ${resolvedW}`}${resolvedItalic ? ' Italic' : ''}`,
    weight: resolvedW,
    isItalic: resolvedItalic,
    foundryOrDesigner: entry.designer,
    sourceName: entry.inGoogleFonts
      ? 'Google Fonts'
      : entry.inFontsource
      ? 'Fontsource'
      : 'Font Squirrel',
    sourceReliability: 'official-catalog',
    officialPageUrl,
    licenseName: lic.licenseName,
    licenseClass: lic.licenseClass,
    commercialUseAllowed: lic.commercialUseAllowed,
    weights: entry.weights,
    styles: entry.styles,
    subsets: entry.subsets,
    binaryUrls: {
      ...(ttf ? { ttf } : {}),
      ...(otf ? { otf } : {}),
      ...(woff2 ? { woff2 } : {}),
      ...(woff ? { woff } : {}),
    },
    cssUrl,
    inOpenCatalog: true,
    initialEvidence: evidence,
  };
}

// ============================================================================
// Connector 4: Deep Foundry, Marketplace & Web Specimen Grounded Research
// ============================================================================

export interface GroundedWebFontLead {
  family: string;
  styleName: string;
  weight: number;
  isItalic: boolean;
  foundryOrDesigner: string;
  officialSourceName: string;
  officialPageUrl: string | null;
  licenseType: 'free-commercial' | 'free-personal' | 'paid-commercial' | 'unknown';
  licenseDetails: string;
  matchRationale: string;
  diagnosticGlyphMatches: string[];
  groundingVerified: boolean;
}

export interface GroundedResearchOutput {
  leads: GroundedWebFontLead[];
  groundingUrls: Array<{ title: string; uri: string }>;
  health: FontSourceHealth;
}

export async function runGroundedFoundryResearch(params: {
  cropBase64: string;
  extractedText: string;
  glyphAnalysis: GlyphAnatomyAnalysis;
  styleClassifications: string[];
  weightEstimate: string;
  numericWeight: number;
  isItalic: boolean;
  widthClass: string;
  initialHypotheses: string[];
}): Promise<GroundedResearchOutput> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return {
      leads: [],
      groundingUrls: [],
      health: {
        source: 'Foundry & Web Font Research',
        ok: false,
        count: 0,
        method: 'Web Search Grounding',
        error: 'API key missing',
      },
    };
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const {
    cropBase64,
    extractedText,
    glyphAnalysis,
    styleClassifications,
    weightEstimate,
    numericWeight,
    isItalic,
    widthClass,
    initialHypotheses,
  } = params;

  const researchPrompt = `You are a master forensic typographer investigating the EXACT original typeface shown in this cropped image.

Target Text: "${extractedText}"
Observed Style Classifications: ${styleClassifications.join(', ')}
Observed Weight: ${weightEstimate} (~${numericWeight}), Italic: ${isItalic ? 'Yes' : 'No'}, Width: ${widthClass}
Diagnostic Glyph Anatomy:
- Serif construction: ${glyphAnalysis.serifConstruction}
- Stroke contrast: ${glyphAnalysis.strokeContrast} (${glyphAnalysis.strokeThickness})
- Terminal shapes: ${glyphAnalysis.terminalShapes}
- Aperture & counters: ${glyphAnalysis.apertureSize}; ${glyphAnalysis.counterAndBowlShape}
- Crossbars & angles: ${glyphAnalysis.crossbarAndArmAngles}
- Distinctive characters: ${glyphAnalysis.distinctiveGlyphObservations.join('; ')}
- Effects/distortions separated from underlying font: ${glyphAnalysis.distortionsAndEffectsSeparated.join('; ') || 'None'}
Initial Hypotheses to verify or rule out: ${initialHypotheses.join(', ') || 'None yet'}

Use Google Search to research across:
1. Official foundries (Monotype, Adobe Fonts, Hoefler&Co., Commercial Type, Font Bureau, Dalton Maag, Klim Type Foundry, Pangram Pangram, Grilli Type, Swiss Typefaces, Lineto, Dinamo, Colophon Foundry, etc.)
2. Font marketplaces (MyFonts, Fonts.com, Fontspring, Creative Market, YouWorkForThem, Envato Elements, Creative Fabrica)
3. Open-source font directories (Google Fonts, Font Squirrel, Font Library, Fontsource, GitHub open font repositories)

Identify ONLY the exact original typeface(s) that match EVERY diagnostic glyph feature (do NOT suggest "visually similar" alternatives or substitutes!).
If this is a well-known commercial brand logotype or custom bespoke lettering that is NOT a downloadable/licensable font, note that honestly.
For each genuine exact candidate, verify its real foundry/designer, exact style/weight, license type, and official specimen or product URL from your search results.

Output a JSON block inside \`\`\`json ... \`\`\` with the shape:
{
  "candidates": [
    {
      "family": "Exact Font Family Name",
      "styleName": "e.g. Bold Italic or Regular",
      "weight": 700,
      "isItalic": false,
      "foundryOrDesigner": "Verified Foundry or Designer",
      "officialSourceName": "e.g. Adobe Fonts / Klim Type Foundry / Google Fonts / MyFonts",
      "officialPageUrl": "https://... (ONLY a real URL observed in search results, or null)",
      "licenseType": "free-commercial | free-personal | paid-commercial | unknown",
      "licenseDetails": "e.g. SIL Open Font License 1.1 or Commercial Proprietary License",
      "matchRationale": "Why the exact glyphs match",
      "diagnosticGlyphMatches": ["Single-story 'a' ...", "Flat-apex 'A' ..."]
    }
  ]
}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/png', data: cropBase64 } },
          { text: researchPrompt },
        ],
      },
      config: {
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });

    const rawText = (response.text || '').trim();
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const groundingUrls: Array<{ title: string; uri: string }> = [];
    for (const chunk of chunks) {
      const web = (chunk as { web?: { uri?: string; title?: string } }).web;
      if (web?.uri && isSafePublicWebUrl(web.uri)) {
        groundingUrls.push({
          title: (web.title || 'Verified Source').trim(),
          uri: web.uri.trim(),
        });
      }
    }

    // Parse JSON payload from response
    let parsedCandidates: Array<Record<string, unknown>> = [];
    const jsonBlockMatch = rawText.match(/```json\s*([\s\S]*?)```/i) || rawText.match(/(\{[\s\S]*\})/);
    if (jsonBlockMatch?.[1]) {
      try {
        const obj = JSON.parse(jsonBlockMatch[1]) as { candidates?: Array<Record<string, unknown>> };
        if (Array.isArray(obj.candidates)) {
          parsedCandidates = obj.candidates;
        }
      } catch {
        // Fallback: ask structured extraction without search tools if JSON was malformed
        const fixRes = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Extract the font candidates from this research note as strict JSON:\n\n${rawText}`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                candidates: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      family: { type: Type.STRING },
                      styleName: { type: Type.STRING },
                      weight: { type: Type.INTEGER },
                      isItalic: { type: Type.BOOLEAN },
                      foundryOrDesigner: { type: Type.STRING },
                      officialSourceName: { type: Type.STRING },
                      officialPageUrl: { type: Type.STRING },
                      licenseType: { type: Type.STRING },
                      licenseDetails: { type: Type.STRING },
                      matchRationale: { type: Type.STRING },
                      diagnosticGlyphMatches: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['family', 'foundryOrDesigner', 'officialSourceName', 'licenseType', 'matchRationale'],
                  },
                },
              },
              required: ['candidates'],
            },
          },
        });
        try {
          const obj = JSON.parse((fixRes.text || '{}').trim()) as {
            candidates?: Array<Record<string, unknown>>;
          };
          if (Array.isArray(obj.candidates)) parsedCandidates = obj.candidates;
        } catch {
          // ignore
        }
      }
    }

    const leads: GroundedWebFontLead[] = parsedCandidates
      .filter((c) => typeof c.family === 'string' && c.family.trim().length > 0)
      .slice(0, 6)
      .map((c) => {
        const rawUrl = typeof c.officialPageUrl === 'string' ? c.officialPageUrl.trim() : '';
        const famLower = String(c.family).toLowerCase();
        // Prefer URLs actually backed by groundingChunks or safe public URLs matching the font/foundry
        const matchedGround = groundingUrls.find(
          (g) =>
            g.title.toLowerCase().includes(famLower) ||
            g.uri.toLowerCase().includes(famLower.replace(/\s+/g, '')) ||
            g.uri.toLowerCase().includes(famLower.replace(/\s+/g, '-'))
        );

        let verifiedUrl: string | null = null;
        if (matchedGround) {
          verifiedUrl = matchedGround.uri;
        } else if (rawUrl && isSafePublicWebUrl(rawUrl) && groundingUrls.some((g) => g.uri === rawUrl)) {
          verifiedUrl = rawUrl;
        } else if (groundingUrls.length > 0 && rawUrl && isSafePublicWebUrl(rawUrl)) {
          // Only accept rawUrl if its hostname matches a trusted font domain or appears in grounding chunks
          const trustedHost =
            /(fonts\.google\.com|fontsource\.org|fontsquirrel\.com|myfonts\.com|fonts\.adobe\.com|fontspring\.com|typography\.com|klim\.co\.nz|pangrampangram\.com|grillitype\.com|swisstypefaces\.com|lineto\.com|abcdinamo\.com|colophon-foundry\.org|daltonmaag\.com|commercialtype\.com|monotype\.com|github\.com|fontlibrary\.org|creativemarket\.com|youworkforthem\.com)/i.test(
              rawUrl
            );
          if (trustedHost) verifiedUrl = rawUrl;
        }

        const lt = String(c.licenseType || 'unknown').toLowerCase();
        const normalizedLicenseType: GroundedWebFontLead['licenseType'] =
          lt.includes('free-commercial')
            ? 'free-commercial'
            : lt.includes('free-personal')
            ? 'free-personal'
            : lt.includes('paid')
            ? 'paid-commercial'
            : 'unknown';

        return {
          family: String(c.family).trim(),
          styleName: String(c.styleName || 'Regular').trim(),
          weight: Number(c.weight) || numericWeight || 400,
          isItalic: Boolean(c.isItalic),
          foundryOrDesigner: String(c.foundryOrDesigner || 'Unknown Foundry').trim(),
          officialSourceName: String(c.officialSourceName || 'Foundry Catalogue').trim(),
          officialPageUrl: verifiedUrl,
          licenseType: normalizedLicenseType,
          licenseDetails: String(c.licenseDetails || 'License details unverified').trim(),
          matchRationale: String(c.matchRationale || '').trim(),
          diagnosticGlyphMatches: Array.isArray(c.diagnosticGlyphMatches)
            ? c.diagnosticGlyphMatches.map(String).slice(0, 6)
            : [],
          groundingVerified: Boolean(matchedGround || groundingUrls.length > 0),
        };
      });

    return {
      leads,
      groundingUrls,
      health: {
        source: 'Foundry & Web Font Research',
        ok: true,
        count: groundingUrls.length || leads.length,
        method: 'Web Search Grounding across Foundries & Marketplaces',
      },
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Search unavailable';
    const cleanErr = /429|RESOURCE_EXHAUSTED|quota/i.test(rawMsg)
      ? 'Web search temporarily rate-limited'
      : 'Web search temporarily unavailable';
    return {
      leads: [],
      groundingUrls: [],
      health: {
        source: 'Foundry & Web Font Research',
        ok: false,
        count: 0,
        method: 'Web Search Grounding',
        error: cleanErr,
      },
    };
  }
}
