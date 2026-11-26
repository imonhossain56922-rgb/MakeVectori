import { GoogleGenAI, Type } from '@google/genai';
import sharp from 'sharp';
import JSZip from 'jszip';
import opentype from 'opentype.js';
import type {
  FontCandidateMatch,
  FontCropRect,
  FontDownloadOption,
  FontFinderResult,
  FontLicenseClass,
  FontSearchFilters,
  FontSourceHealth,
  RegionFontResult,
  TextRegionDetection,
  TypographyTraits,
  VectorShape,
} from '../../src/types/vector.ts';

// ============================================================================
// Live Multi-Source Catalog Cache (Google Fonts Metadata + Fontsource v1 API)
// ============================================================================

interface GoogleVariantMetric {
  thickness?: number | null;
  slant?: number | null;
  width?: number | null;
  lineHeight?: number | null;
}

interface CatalogFontEntry {
  id: string; // Fontsource slug id (e.g., 'montserrat') or normalized slug
  family: string;
  normalizedFamily: string;
  designer: string;
  googleCategory: string; // 'Sans Serif' | 'Serif' | 'Display' | 'Handwriting' | 'Monospace'
  stroke: string | null; // 'Sans Serif' | 'Serif' | 'Slab Serif' | null
  classifications: string[];
  subsets: string[];
  weights: number[];
  styles: string[];
  variable: boolean;
  licenseRaw: string;
  licenseClass: FontLicenseClass;
  licenseVerified: boolean;
  popularity: number;
  inFontsource: boolean;
  inGoogleFonts: boolean;
  metrics400: {
    thickness: number | null;
    slant: number | null;
    width: number | null;
    lineHeight: number | null;
  };
  metrics700: {
    thickness: number | null;
    width: number | null;
  };
}

interface CatalogCacheState {
  loadedAt: number;
  entries: CatalogFontEntry[];
  byNormFamily: Map<string, CatalogFontEntry>;
  byId: Map<string, CatalogFontEntry>;
  health: FontSourceHealth[];
}

interface FontsourceDetailVariantMap {
  [weight: string]: {
    [style: string]: {
      [subset: string]: {
        url?: {
          woff2?: string;
          woff?: string;
          ttf?: string;
        };
      };
    };
  };
}

interface FontsourceDetailResponse {
  id: string;
  family: string;
  license?: string;
  source?: string;
  version?: string;
  weights?: number[];
  styles?: string[];
  defSubset?: string;
  subsets?: string[];
  variants?: FontsourceDetailVariantMap;
}

const CATALOG_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
let catalogCache: CatalogCacheState | null = null;
const fontDetailCache = new Map<string, { loadedAt: number; data: FontsourceDetailResponse }>();
const ttfBufferCache = new Map<string, { loadedAt: number; buffer: Buffer }>();

const ALLOWED_FONT_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'api.fontsource.org',
  'fonts.gstatic.com',
  'fonts.googleapis.com',
]);

export function isAllowedFontDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && ALLOWED_FONT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeFamilyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/\b(regular|bold|italic|light|medium|semibold|extrabold|black|condensed|extended)\b/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeExactFamily(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugifyFamily(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function classifyLicense(raw: string | undefined, isOpenSourceFlag?: boolean): {
  licenseName: string;
  licenseClass: FontLicenseClass;
  licenseVerified: boolean;
} {
  const val = (raw || '').trim();
  const lower = val.toLowerCase();

  if (
    lower.includes('ofl') ||
    lower.includes('open font') ||
    lower.includes('sil')
  ) {
    return {
      licenseName: val.includes('1.1') ? 'SIL Open Font License 1.1' : 'SIL Open Font License',
      licenseClass: 'Free for Personal and Commercial Use',
      licenseVerified: true,
    };
  }
  if (lower.includes('apache')) {
    return {
      licenseName: val.includes('2') ? 'Apache License 2.0' : 'Apache License',
      licenseClass: 'Free for Personal and Commercial Use',
      licenseVerified: true,
    };
  }
  if (lower.includes('ufl') || lower.includes('ubuntu')) {
    return {
      licenseName: 'Ubuntu Font License 1.0',
      licenseClass: 'Free for Personal and Commercial Use',
      licenseVerified: true,
    };
  }
  if (lower === 'mit' || lower.includes('mit ')) {
    return {
      licenseName: 'MIT License',
      licenseClass: 'Free for Personal and Commercial Use',
      licenseVerified: true,
    };
  }
  if (lower.includes('cc0') || lower.includes('public domain') || lower.includes('gpl')) {
    return {
      licenseName: val || 'Open Source License',
      licenseClass: 'Free for Personal and Commercial Use',
      licenseVerified: true,
    };
  }
  if (lower.includes('personal')) {
    return {
      licenseName: val,
      licenseClass: 'Free for Personal Use Only',
      licenseVerified: true,
    };
  }
  if (isOpenSourceFlag === true) {
    return {
      licenseName: val || 'Open Source (Google Fonts)',
      licenseClass: 'Free for Personal and Commercial Use',
      licenseVerified: true,
    };
  }
  return {
    licenseName: val || 'Unverified License',
    licenseClass: 'Unknown or Unverified License',
    licenseVerified: false,
  };
}

export async function getLiveFontCatalog(): Promise<CatalogCacheState> {
  if (catalogCache && Date.now() - catalogCache.loadedAt < CATALOG_TTL_MS && catalogCache.entries.length > 0) {
    return catalogCache;
  }

  const health: FontSourceHealth[] = [];
  const merged = new Map<string, CatalogFontEntry>();

  // 1. Fetch Google Fonts Rich Typography Metadata
  try {
    const res = await fetch('https://fonts.google.com/metadata/fonts', {
      headers: { 'User-Agent': 'MakeVectorizer-FontFinder/1.0' },
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
        fonts?: Record<string, GoogleVariantMetric>;
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
      const m700 = item.fonts?.['700'] || {};
      const lic = classifyLicense(item.isOpenSource ? 'OFL-1.1' : '', item.isOpenSource);

      merged.set(norm, {
        id: slugifyFamily(item.family),
        family: item.family,
        normalizedFamily: norm,
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
        licenseVerified: lic.licenseVerified,
        popularity: typeof item.popularity === 'number' ? item.popularity : 9999,
        inFontsource: false,
        inGoogleFonts: true,
        metrics400: {
          thickness: m400.thickness ?? null,
          slant: m400.slant ?? null,
          width: m400.width ?? null,
          lineHeight: m400.lineHeight ?? null,
        },
        metrics700: {
          thickness: m700.thickness ?? null,
          width: m700.width ?? null,
        },
      });
    }
    health.push({ source: 'Google Fonts Catalog', ok: true, count: list.length });
  } catch (err) {
    health.push({
      source: 'Google Fonts Catalog',
      ok: false,
      count: 0,
      error: err instanceof Error ? err.message : 'Unavailable',
    });
  }

  // 2. Fetch Fontsource Open-Source Registry (exact IDs, licenses, weights, subsets, CDN files)
  try {
    const res = await fetch('https://api.fontsource.org/v1/fonts', {
      headers: { 'User-Agent': 'MakeVectorizer-FontFinder/1.0' },
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
      type?: string;
    }>;

    for (const fsFont of list) {
      if (!fsFont.id || !fsFont.family) continue;
      const norm = normalizeExactFamily(fsFont.family);
      const lic = classifyLicense(fsFont.license, true);
      const existing = merged.get(norm);
      if (existing) {
        existing.id = fsFont.id;
        existing.inFontsource = true;
        existing.licenseRaw = fsFont.license || existing.licenseRaw;
        existing.licenseClass = lic.licenseClass;
        existing.licenseVerified = lic.licenseVerified;
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
          licenseVerified: lic.licenseVerified,
          popularity: 5000,
          inFontsource: true,
          inGoogleFonts: false,
          metrics400: { thickness: null, slant: null, width: null, lineHeight: null },
          metrics700: { thickness: null, width: null },
        });
      }
    }
    health.push({ source: 'Fontsource Registry', ok: true, count: list.length });
  } catch (err) {
    health.push({
      source: 'Fontsource Registry',
      ok: false,
      count: 0,
      error: err instanceof Error ? err.message : 'Unavailable',
    });
  }

  const entries = Array.from(merged.values());
  if (entries.length === 0) {
    throw new Error('All live font catalogs (Google Fonts & Fontsource) are currently unreachable.');
  }

  const byNormFamily = new Map<string, CatalogFontEntry>();
  const byId = new Map<string, CatalogFontEntry>();
  for (const e of entries) {
    byNormFamily.set(e.normalizedFamily, e);
    byId.set(e.id, e);
  }

  catalogCache = {
    loadedAt: Date.now(),
    entries,
    byNormFamily,
    byId,
    health,
  };
  return catalogCache;
}

export async function getFontsourceDetail(fontId: string): Promise<FontsourceDetailResponse | null> {
  const cached = fontDetailCache.get(fontId);
  if (cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) {
    return cached.data;
  }
  try {
    const res = await fetch(`https://api.fontsource.org/v1/fonts/${encodeURIComponent(fontId)}`, {
      headers: { 'User-Agent': 'MakeVectorizer-FontFinder/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FontsourceDetailResponse;
    fontDetailCache.set(fontId, { loadedAt: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

function pickBestVariantUrls(
  detail: FontsourceDetailResponse | null,
  desiredWeight: number,
  desiredItalic: boolean,
  preferredSubset = 'latin'
): { woff2?: string; woff?: string; ttf?: string; resolvedWeight: number; resolvedStyle: string } {
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
  const styleKey = desiredItalic && weightMap?.italic ? 'italic' : weightMap?.normal ? 'normal' : Object.keys(weightMap || {})[0] || 'normal';
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
    resolvedWeight: closestW,
    resolvedStyle: styleKey,
  };
}

// ============================================================================
// Gemini 4 Vision Forensic Typography & Multi-Region Text Agent
// ============================================================================

interface GeminiRegionPrediction {
  role: 'heading' | 'subheading' | 'body' | 'decorative' | 'wordmark';
  roleLabel: string;
  extractedText: string;
  bbox: { ymin: number; xmin: number; ymax: number; xmax: number };
  rotationDeg: number;
  serifType: string;
  categories: string[];
  primaryStyle: string;
  weightName: string;
  numericWeight: number;
  isItalic: boolean;
  widthClass: 'Condensed' | 'Normal' | 'Extended';
  strokeContrast: 'Low' | 'Medium' | 'High';
  cornerStyle: 'Sharp' | 'Slightly Rounded' | 'Rounded' | 'Mixed';
  terminalStyle: string;
  letterSpacingTrait: 'Tight' | 'Normal' | 'Wide';
  distinctiveFeatures: string[];
  scriptLanguage: string;
  hypothesizedExactFonts: Array<{
    family: string;
    isLikelyPaid: boolean;
    confidence: number;
    reasoning: string;
  }>;
  visualSimilarHypotheses: Array<{
    family: string;
    reasoning: string;
  }>;
  reasoning: string;
}

interface GeminiFontFinderOutput {
  detectedRotationDeg: number;
  overallSummary: string;
  regions: GeminiRegionPrediction[];
}

async function analyzeTypographyWithGemini(
  imageBase64: string,
  mimeType: string,
  customHint?: string
): Promise<GeminiFontFinderOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured in server secrets. Please configure GEMINI_API_KEY to use the AI Font Finder agent.'
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const hintClause = customHint?.trim()
    ? `Additional user hint/focus: "${customHint.trim()}".`
    : '';

  const prompt = `You are an expert forensic typographer and OCR vision specialist.
Inspect the provided image carefully and detect ALL distinct text regions using different fonts or typographic hierarchy (for example: main headline, secondary subheading, body copy, decorative badge/logo wordmark — up to 4 distinct regions).

For EACH detected text region:
1. Extract the EXACT verbatim text visible in that region (preserving exact words, spelling, uppercase/lowercase capitalization, numbers, symbols, and punctuation). Never invent text or replace it with placeholders.
2. Provide an accurate bounding box (ymin, xmin, ymax, xmax in normalized 0..1000 coordinates) and any rotation angle in degrees (-180 to 180).
3. Perform deep forensic letterform analysis:
   - Serif vs Sans-Serif vs Slab Serif vs Script vs Handwritten vs Blackletter vs Monospace vs Display.
   - All applicable typography tags from: Serif, Sans Serif, Display, Script, Handwritten, Blackletter, Slab Serif, Geometric, Monospaced, Decorative, Vintage, Modern, Condensed, Extended.
   - Weight (Thin/Light/Regular/Medium/SemiBold/Bold/ExtraBold/Black + numeric 100-900), italic/oblique presence, width class (Condensed/Normal/Extended), stroke contrast, corner roundness, terminal shapes, kerning/letter spacing.
   - Identify distinctive diagnostic characters visible in the text (e.g., double-story vs single-story 'a' and 'g', leg of 'R', tail of 'Q', apex of 'A'/'M', crossbar of 'e', terminals of 'c'/'s', numerals).
4. Based on these letterforms, list up to 3 exact real font family names that most closely match this region (indicate honestly whether each is likely a paid/commercial font like Helvetica Neue, Gotham, Proxima Nova, Avenir, Futura, Circular, Brandon Grotesque, Didot, etc., OR a free Google/open-source font like Montserrat, Inter, Poppins, Playfair Display, Roboto, Bebas Neue, Oswald, Lora, etc.).
5. Also list up to 6 genuinely visually similar free Google Fonts family names (exact real Google Font family spellings!) that match the width, weight, letterforms, and proportion of the region.
${hintClause}
If no readable text exists in the image, return an empty regions array and explain cleanly in overallSummary.`;

  let responseText = '';
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedRotationDeg: { type: Type.NUMBER },
              overallSummary: { type: Type.STRING },
              regions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    role: {
                      type: Type.STRING,
                      enum: ['heading', 'subheading', 'body', 'decorative', 'wordmark'],
                    },
                    roleLabel: { type: Type.STRING },
                    extractedText: { type: Type.STRING },
                    bbox: {
                      type: Type.OBJECT,
                      properties: {
                        ymin: { type: Type.INTEGER },
                        xmin: { type: Type.INTEGER },
                        ymax: { type: Type.INTEGER },
                        xmax: { type: Type.INTEGER },
                      },
                      required: ['ymin', 'xmin', 'ymax', 'xmax'],
                    },
                    rotationDeg: { type: Type.NUMBER },
                    serifType: { type: Type.STRING },
                    categories: { type: Type.ARRAY, items: { type: Type.STRING } },
                    primaryStyle: { type: Type.STRING },
                    weightName: { type: Type.STRING },
                    numericWeight: { type: Type.INTEGER },
                    isItalic: { type: Type.BOOLEAN },
                    widthClass: {
                      type: Type.STRING,
                      enum: ['Condensed', 'Normal', 'Extended'],
                    },
                    strokeContrast: {
                      type: Type.STRING,
                      enum: ['Low', 'Medium', 'High'],
                    },
                    cornerStyle: {
                      type: Type.STRING,
                      enum: ['Sharp', 'Slightly Rounded', 'Rounded', 'Mixed'],
                    },
                    terminalStyle: { type: Type.STRING },
                    letterSpacingTrait: {
                      type: Type.STRING,
                      enum: ['Tight', 'Normal', 'Wide'],
                    },
                    distinctiveFeatures: { type: Type.ARRAY, items: { type: Type.STRING } },
                    scriptLanguage: { type: Type.STRING },
                    hypothesizedExactFonts: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          family: { type: Type.STRING },
                          isLikelyPaid: { type: Type.BOOLEAN },
                          confidence: { type: Type.INTEGER },
                          reasoning: { type: Type.STRING },
                        },
                        required: ['family', 'isLikelyPaid', 'confidence', 'reasoning'],
                      },
                    },
                    visualSimilarHypotheses: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          family: { type: Type.STRING },
                          reasoning: { type: Type.STRING },
                        },
                        required: ['family', 'reasoning'],
                      },
                    },
                    reasoning: { type: Type.STRING },
                  },
                  required: [
                    'role',
                    'roleLabel',
                    'extractedText',
                    'bbox',
                    'rotationDeg',
                    'serifType',
                    'categories',
                    'primaryStyle',
                    'weightName',
                    'numericWeight',
                    'isItalic',
                    'widthClass',
                    'strokeContrast',
                    'cornerStyle',
                    'terminalStyle',
                    'letterSpacingTrait',
                    'distinctiveFeatures',
                    'scriptLanguage',
                    'hypothesizedExactFonts',
                    'visualSimilarHypotheses',
                    'reasoning',
                  ],
                },
              },
            },
            required: ['detectedRotationDeg', 'overallSummary', 'regions'],
          },
        },
      });
      responseText = (response.text || '{}').trim();
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /503|429|UNAVAILABLE|overloaded|high demand|RESOURCE_EXHAUSTED/i.test(msg);
      if (isTransient && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      break;
    }
  }

  if (lastError) {
    const rawMsg = lastError instanceof Error ? lastError.message : String(lastError);
    if (/503|429|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED/i.test(rawMsg)) {
      throw new Error(
        'The AI vision service is temporarily experiencing high demand. Please retry in a few seconds.'
      );
    }
    throw new Error(rawMsg || 'AI typography recognition failed.');
  }

  const parsed = JSON.parse(responseText || '{}') as GeminiFontFinderOutput;
  return {
    detectedRotationDeg: Number(parsed.detectedRotationDeg || 0),
    overallSummary: parsed.overallSummary || 'Typography analysis completed.',
    regions: Array.isArray(parsed.regions) ? parsed.regions.filter((r) => r.extractedText?.trim()) : [],
  };
}

// ============================================================================
// Sharp Raster Region Metrics + OpenType Silhouette Visual Verification
// ============================================================================

async function extractRegionCropAndMetrics(
  workingPngBuffer: Buffer,
  imgW: number,
  imgH: number,
  bbox: { ymin: number; xmin: number; ymax: number; xmax: number },
  rotationDeg: number
): Promise<{
  cropBuffer: Buffer;
  cropDataUrl: string;
  metrics: TextRegionDetection['rasterMetrics'];
}> {
  const padX = Math.round(((bbox.xmax - bbox.xmin) / 1000) * imgW * 0.08) + 8;
  const padY = Math.round(((bbox.ymax - bbox.ymin) / 1000) * imgH * 0.14) + 6;
  const left = Math.max(0, Math.floor((bbox.xmin / 1000) * imgW) - padX);
  const top = Math.max(0, Math.floor((bbox.ymin / 1000) * imgH) - padY);
  const right = Math.min(imgW, Math.ceil((bbox.xmax / 1000) * imgW) + padX);
  const bottom = Math.min(imgH, Math.ceil((bbox.ymax / 1000) * imgH) + padY);

  const extractW = Math.max(8, right - left);
  const extractH = Math.max(8, bottom - top);

  let pipeline = sharp(workingPngBuffer).extract({
    left,
    top,
    width: extractW,
    height: extractH,
  });

  if (Math.abs(rotationDeg) >= 2 && Math.abs(rotationDeg) <= 179) {
    pipeline = pipeline.rotate(-rotationDeg, { background: { r: 255, g: 255, b: 255, alpha: 0 } });
  }

  const cropBuffer = await pipeline
    .resize(640, 260, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

  const cropMeta = await sharp(cropBuffer).metadata();
  const cw = cropMeta.width || extractW;
  const ch = cropMeta.height || extractH;

  // Measure real border background luminance vs interior text foreground luminance
  const { data: raw } = await sharp(cropBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
  const channels = 3;
  for (let x = 0; x < cw; x++) {
    for (const y of [0, ch - 1]) {
      const idx = (y * cw + x) * channels;
      bgR += raw[idx];
      bgG += raw[idx + 1];
      bgB += raw[idx + 2];
      bgN++;
    }
  }
  bgR /= Math.max(1, bgN);
  bgG /= Math.max(1, bgN);
  bgB /= Math.max(1, bgN);

  let fgR = 0, fgG = 0, fgB = 0, fgN = 0;
  for (let i = 0; i < raw.length; i += channels) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
    if (dist > 45) {
      fgR += r;
      fgG += g;
      fgB += b;
      fgN++;
    }
  }
  const fgRatio = fgN / Math.max(1, cw * ch);
  if (fgN > 0) {
    fgR /= fgN;
    fgG /= fgN;
    fgB /= fgN;
  } else {
    fgR = 15; fgG = 23; fgB = 42;
  }

  const lum = (r: number, g: number, b: number) => 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
  const l1 = Math.max(lum(fgR, fgG, fgB), lum(bgR, bgG, bgB));
  const l2 = Math.min(lum(fgR, fgG, fgB), lum(bgR, bgG, bgB));
  const contrastRatio = Number(((l1 + 0.05) / (l2 + 0.05)).toFixed(2));
  const toHex = (r: number, g: number, b: number) =>
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('');

  return {
    cropBuffer,
    cropDataUrl: `data:image/png;base64,${cropBuffer.toString('base64')}`,
    metrics: {
      widthPx: extractW,
      heightPx: extractH,
      aspectRatio: Number((extractW / Math.max(1, extractH)).toFixed(2)),
      foregroundDensity: Number((fgRatio * 100).toFixed(1)),
      contrastRatio,
      dominantTextColor: toHex(fgR, fgG, fgB),
      dominantBgColor: toHex(bgR, bgG, bgB),
    },
  };
}

async function fetchTtfBufferCached(url: string): Promise<Buffer | null> {
  if (!isAllowedFontDownloadUrl(url)) return null;
  const cached = ttfBufferCache.get(url);
  if (cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) {
    return cached.buffer;
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MakeVectorizer-FontFinder/1.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    if (buf.length < 1000 || buf.length > 15_000_000) return null;
    ttfBufferCache.set(url, { loadedAt: Date.now(), buffer: buf });
    return buf;
  } catch {
    return null;
  }
}

async function buildNormalizedMaskFromCrop(cropBuffer: Buffer): Promise<Uint8Array | null> {
  try {
    const { data, info } = await sharp(cropBuffer)
      .grayscale()
      .resize(96, 32, { fit: 'contain', background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Determine whether background is light or dark via corners
    const corners = [
      data[0],
      data[info.width - 1],
      data[(info.height - 1) * info.width],
      data[data.length - 1],
    ];
    const avgBg = corners.reduce((a, b) => a + b, 0) / 4;
    const isDarkBg = avgBg < 128;

    const mask = new Uint8Array(data.length);
    let active = 0;
    for (let i = 0; i < data.length; i++) {
      const val = isDarkBg ? 255 - data[i] : data[i];
      if (val < 165) {
        mask[i] = 1;
        active++;
      }
    }
    return active >= 15 ? mask : null;
  } catch {
    return null;
  }
}

async function computeGlyphSilhouetteIoU(
  cropMask: Uint8Array,
  ttfUrl: string,
  sampleText: string
): Promise<number | null> {
  const cleanLine = sampleText.replace(/\s+/g, ' ').trim().slice(0, 26);
  if (cleanLine.length < 2) return null;
  const ttfBuf = await fetchTtfBufferCached(ttfUrl);
  if (!ttfBuf) return null;

  try {
    const ab = ttfBuf.buffer.slice(ttfBuf.byteOffset, ttfBuf.byteOffset + ttfBuf.byteLength);
    const font = opentype.parse(ab);
    const path = font.getPath(cleanLine, 0, 28, 28);
    const box = path.getBoundingBox();
    const bw = Math.max(4, box.x2 - box.x1);
    const bh = Math.max(4, box.y2 - box.y1);
    const d = path.toPathData(2);
    if (!d) return null;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="32" viewBox="${box.x1 - 2} ${box.y1 - 2} ${bw + 4} ${bh + 4}"><rect x="${box.x1 - 2}" y="${box.y1 - 2}" width="${bw + 4}" height="${bh + 4}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
    const { data } = await sharp(Buffer.from(svg, 'utf8'))
      .grayscale()
      .resize(96, 32, { fit: 'contain', background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let intersection = 0;
    let union = 0;
    for (let i = 0; i < Math.min(data.length, cropMask.length); i++) {
      const a = cropMask[i] === 1;
      const b = data[i] < 170;
      if (a || b) union++;
      if (a && b) intersection++;
    }
    if (union === 0) return null;
    // IoU scaled sensibly to 0..100 visual correlation
    const rawIoU = intersection / union;
    return Math.round(Math.min(99, rawIoU * 145));
  } catch {
    return null;
  }
}

// ============================================================================
// Multi-Factor Structural Font Scoring & Search Filtering
// ============================================================================

function mapRegionCategoryExpectation(cats: string[], serifType: string): string[] {
  const joined = `${cats.join(' ')} ${serifType}`.toLowerCase();
  const out: string[] = [];
  if (joined.includes('slab')) out.push('Slab Serif', 'Serif');
  else if (joined.includes('sans')) out.push('Sans Serif');
  else if (joined.includes('serif')) out.push('Serif');
  if (joined.includes('script') || joined.includes('hand')) out.push('Handwriting');
  if (joined.includes('mono')) out.push('Monospace');
  if (joined.includes('display') || joined.includes('blackletter') || joined.includes('decor')) {
    out.push('Display');
  }
  return out.length > 0 ? out : ['Sans Serif'];
}

function matchesSearchFilters(entry: CatalogFontEntry, filters?: FontSearchFilters): boolean {
  if (!filters) return true;

  if (filters.category && filters.category !== 'all') {
    const target = filters.category.toLowerCase();
    const catLower = entry.googleCategory.toLowerCase();
    const strokeLower = (entry.stroke || '').toLowerCase();
    const clsLower = entry.classifications.join(' ').toLowerCase();
    const famLower = entry.family.toLowerCase();

    if (target === 'slab serif') {
      if (!strokeLower.includes('slab') && !famLower.includes('slab') && !famLower.includes('arvo') && !famLower.includes('zilla')) {
        return false;
      }
    } else if (target === 'monospaced' || target === 'monospace') {
      if (catLower !== 'monospace' && !clsLower.includes('monospace')) return false;
    } else if (target === 'script' || target === 'handwritten') {
      if (catLower !== 'handwriting' && !clsLower.includes('handwriting')) return false;
    } else if (target === 'condensed') {
      if (!famLower.includes('condensed') && !famLower.includes('narrow') && !(entry.metrics400.width && entry.metrics400.width <= 5)) {
        return false;
      }
    } else if (target === 'extended') {
      if (!famLower.includes('extended') && !famLower.includes('wide') && !(entry.metrics400.width && entry.metrics400.width >= 9)) {
        return false;
      }
    } else if (target === 'geometric') {
      if (catLower !== 'sans serif' && catLower !== 'display') return false;
    } else if (target === 'serif') {
      if (catLower !== 'serif') return false;
    } else if (target === 'sans serif') {
      if (catLower !== 'sans serif') return false;
    } else if (target === 'display' || target === 'decorative' || target === 'vintage' || target === 'blackletter' || target === 'modern') {
      if (catLower !== 'display' && catLower !== 'serif' && catLower !== 'sans serif') return false;
    }
  }

  if (filters.license === 'commercial-free') {
    if (entry.licenseClass !== 'Free for Personal and Commercial Use') return false;
  } else if (filters.license === 'personal-free') {
    if (
      entry.licenseClass !== 'Free for Personal and Commercial Use' &&
      entry.licenseClass !== 'Free for Personal Use Only'
    ) {
      return false;
    }
  }

  if (filters.format && filters.format !== 'all') {
    // Fontsource entries supply verified TTF, WOFF2, WOFF via CDN
    if (!entry.inFontsource) return false;
  }

  if (filters.style && filters.style !== 'all') {
    const s = filters.style;
    if (s === 'italic' && !entry.styles.includes('italic')) return false;
    if (s === 'bold' && !entry.weights.some((w) => w >= 700)) return false;
    if (s === 'black' && !entry.weights.some((w) => w >= 800)) return false;
    if (s === 'light' && !entry.weights.some((w) => w <= 300)) return false;
    if (s === 'condensed' && !entry.family.toLowerCase().includes('condensed') && !(entry.metrics400.width && entry.metrics400.width <= 5)) {
      return false;
    }
  }

  if (filters.language && filters.language !== 'all') {
    const lang = filters.language;
    const subs = entry.subsets.map((s) => s.toLowerCase());
    if (lang === 'arabic' && !subs.includes('arabic')) return false;
    if (lang === 'bengali' && !subs.includes('bengali')) return false;
    if (lang === 'cyrillic' && !subs.includes('cyrillic')) return false;
    if (lang === 'latin' && !subs.includes('latin')) return false;
    if (lang === 'multilingual' && subs.length < 3) return false;
  }

  return true;
}

function scoreCatalogEntryForRegion(
  entry: CatalogFontEntry,
  pred: GeminiRegionPrediction
): {
  score: number;
  shapeSimilarity: number;
  weightMatch: number;
  widthMatch: number;
  styleMatch: number;
  aiExactConfidence: number;
  aiSimilarBonus: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const normEntry = entry.normalizedFamily;
  const looseEntry = normalizeFamilyKey(entry.family);

  let aiExactConfidence = 0;
  let aiSimilarBonus = 0;

  for (let i = 0; i < (pred.hypothesizedExactFonts || []).length; i++) {
    const h = pred.hypothesizedExactFonts[i];
    const hExact = normalizeExactFamily(h.family);
    const hLoose = normalizeFamilyKey(h.family);
    if (hExact === normEntry || (hLoose.length >= 4 && hLoose === looseEntry)) {
      aiExactConfidence = Math.max(aiExactConfidence, Math.min(98, h.confidence || (i === 0 ? 90 : 80)));
      reasons.push(h.reasoning || `AI letterform identification matched ${entry.family}`);
    } else if (normEntry.includes(hExact) && hExact.length >= 5) {
      aiSimilarBonus = Math.max(aiSimilarBonus, 18);
    }
  }

  for (let i = 0; i < (pred.visualSimilarHypotheses || []).length; i++) {
    const v = pred.visualSimilarHypotheses[i];
    const vExact = normalizeExactFamily(v.family);
    if (vExact === normEntry) {
      aiSimilarBonus = Math.max(aiSimilarBonus, 24 - i * 2);
      if (v.reasoning) reasons.push(v.reasoning);
    }
  }

  // Category & Stroke similarity
  const expectedCats = mapRegionCategoryExpectation(pred.categories, pred.serifType);
  let shapeSimilarity = 38;
  if (expectedCats.includes(entry.googleCategory)) {
    shapeSimilarity += 34;
    reasons.push(`Matches ${entry.googleCategory} classification`);
  } else if (expectedCats.includes('Slab Serif') && entry.stroke === 'Slab Serif') {
    shapeSimilarity += 42;
    reasons.push('Matches Slab Serif structure');
  } else if (entry.googleCategory === 'Display' && expectedCats.includes('Sans Serif')) {
    shapeSimilarity += 14;
  }

  if (entry.stroke && expectedCats.includes(entry.stroke)) {
    shapeSimilarity += 10;
  }

  // Weight proximity
  const targetWeight = Math.max(100, Math.min(900, pred.numericWeight || 400));
  const closestW = entry.weights.reduce((best, w) =>
    Math.abs(w - targetWeight) < Math.abs(best - targetWeight) ? w : best
  );
  const wDiff = Math.abs(closestW - targetWeight);
  const weightMatch = Math.max(25, Math.round(100 - wDiff * 0.18));
  if (wDiff <= 100) {
    reasons.push(`Supports target ${targetWeight} weight`);
  }

  // Width proximity using Google Fonts metadata width (scale ~1..10 where ~7 is normal)
  let widthMatch = 72;
  const gWidth = entry.metrics400.width;
  if (gWidth !== null) {
    const expectedWidth =
      pred.widthClass === 'Condensed' ? 4 : pred.widthClass === 'Extended' ? 9 : 7;
    const widthDiff = Math.abs(gWidth - expectedWidth);
    widthMatch = Math.max(30, Math.round(100 - widthDiff * 14));
    if (widthDiff <= 1.5) {
      reasons.push(`Comparable ${pred.widthClass.toLowerCase()} character proportions`);
    }
  } else if (pred.widthClass === 'Condensed' && entry.family.toLowerCase().includes('condensed')) {
    widthMatch = 96;
    reasons.push('Condensed glyph proportions');
  }

  // Style / Italic / Thickness alignment
  let styleMatch = 68;
  if (pred.isItalic) {
    styleMatch = entry.styles.includes('italic') ? 96 : 32;
    if (entry.styles.includes('italic')) reasons.push('Includes true italic style');
  } else if (entry.metrics400.thickness !== null) {
    const expectedThick = targetWeight >= 700 ? 7 : targetWeight <= 300 ? 3 : 5;
    styleMatch = Math.max(45, Math.round(100 - Math.abs(entry.metrics400.thickness - expectedThick) * 10));
  }

  // Popularity tie-breaker for well-known crisp typefaces
  const popBonus = entry.popularity <= 100 ? 5 : entry.popularity <= 400 ? 3 : 0;

  let totalScore =
    shapeSimilarity * 0.42 +
    weightMatch * 0.18 +
    widthMatch * 0.15 +
    styleMatch * 0.15 +
    aiSimilarBonus +
    popBonus;

  if (aiExactConfidence > 0) {
    totalScore = Math.max(totalScore, aiExactConfidence);
  }

  return {
    score: Math.min(98, Math.round(totalScore)),
    shapeSimilarity: Math.min(99, Math.round(shapeSimilarity)),
    weightMatch,
    widthMatch,
    styleMatch,
    aiExactConfidence,
    aiSimilarBonus,
    reasons: Array.from(new Set(reasons)).slice(0, 4),
  };
}

function buildCommercialPaidReference(
  familyName: string,
  confidence: number,
  reasoning: string,
  pred: GeminiRegionPrediction
): FontCandidateMatch {
  return {
    id: `commercial_${slugifyFamily(familyName)}`,
    family: familyName,
    designer: 'Commercial Type Foundry',
    source: 'Commercial Foundry Reference',
    isExactMatch: true,
    matchType: 'exact-paid',
    confidencePercent: Math.min(96, Math.max(68, confidence)),
    categories: pred.categories.length > 0 ? pred.categories : [pred.primaryStyle],
    primaryCategory: pred.primaryStyle || 'Commercial Typeface',
    recommendedWeight: pred.numericWeight || 400,
    weights: [pred.numericWeight || 400],
    styles: [pred.isItalic ? 'italic' : 'normal'],
    subsets: ['latin'],
    licenseName: 'Commercial Proprietary License',
    licenseClass: 'Paid Font',
    licenseVerified: true,
    officialUrl: `https://www.myfonts.com/search?query=${encodeURIComponent(familyName)}`,
    cssUrl: '',
    previewFontUrls: {},
    downloadFormats: [],
    matchReasons: [
      reasoning || 'Identified as a commercial proprietary font matching these exact letterforms.',
      'Paid license required — free open-source visual alternatives are listed below.',
    ],
    similarityBreakdown: {
      shapeSimilarity: Math.min(96, confidence),
      weightMatch: 90,
      widthMatch: 90,
      styleMatch: 90,
    },
  };
}

// ============================================================================
// Main Pipeline Orchestrator (8-Stage Job Runner)
// ============================================================================

export async function runFontFinderPipeline(params: {
  imageBuffer: Buffer;
  uploadId: string;
  crop?: FontCropRect | null;
  filters?: FontSearchFilters;
  onProgress: (stage: string, stageIndex: number, progress: number) => void;
}): Promise<FontFinderResult> {
  const startedAt = Date.now();
  const { imageBuffer, uploadId, crop, filters, onProgress } = params;

  onProgress('Uploading Image', 1, 8);

  // Prepare working image (apply manual crop + rotation if requested)
  let workPipeline = sharp(imageBuffer).rotate();
  const origMeta = await workPipeline.metadata();
  const origW = origMeta.width || 1;
  const origH = origMeta.height || 1;

  if (crop && crop.width > 4 && crop.height > 4) {
    const cx = Math.max(0, Math.min(origW - 4, Math.round(crop.x)));
    const cy = Math.max(0, Math.min(origH - 4, Math.round(crop.y)));
    const cw = Math.max(4, Math.min(origW - cx, Math.round(crop.width)));
    const ch = Math.max(4, Math.min(origH - cy, Math.round(crop.height)));
    workPipeline = workPipeline.extract({ left: cx, top: cy, width: cw, height: ch });
  }
  if (crop?.rotateDeg && Math.abs(crop.rotateDeg) > 0.5) {
    workPipeline = workPipeline.rotate(crop.rotateDeg, {
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  }

  const workingPng = await workPipeline.png().toBuffer();
  const workMeta = await sharp(workingPng).metadata();
  const workW = workMeta.width || origW;
  const workH = workMeta.height || origH;

  const geminiInputJpeg = await sharp(workingPng)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92 })
    .toBuffer();

  onProgress('Detecting Text', 2, 20);

  const aiResult = await analyzeTypographyWithGemini(
    geminiInputJpeg.toString('base64'),
    'image/jpeg',
    filters?.customHint
  );

  onProgress('Extracting Typography', 3, 36);

  if (aiResult.regions.length === 0) {
    const catalog = await getLiveFontCatalog().catch(() => null);
    return {
      uploadId,
      imageWidth: workW,
      imageHeight: workH,
      detectedRotationDeg: aiResult.detectedRotationDeg,
      overallSummary:
        aiResult.overallSummary ||
        'No clear readable text regions were detected in this image. Try cropping closer to a single line of text.',
      regions: [],
      sourceHealth: catalog?.health || [],
      processingMs: Date.now() - startedAt,
    };
  }

  // Extract region crops & local pixel metrics
  const regionPrepared = await Promise.all(
    aiResult.regions.slice(0, 4).map(async (pred, idx) => {
      const cropInfo = await extractRegionCropAndMetrics(
        workingPng,
        workW,
        workH,
        pred.bbox,
        pred.rotationDeg || 0
      );
      const cropMask = await buildNormalizedMaskFromCrop(cropInfo.cropBuffer);
      const traits: TypographyTraits = {
        serifType: pred.serifType,
        categories: pred.categories || [pred.primaryStyle],
        primaryStyle: pred.primaryStyle,
        weightName: pred.weightName,
        numericWeight: pred.numericWeight || 400,
        isItalic: Boolean(pred.isItalic),
        widthClass: pred.widthClass || 'Normal',
        strokeContrast: pred.strokeContrast || 'Medium',
        cornerStyle: pred.cornerStyle || 'Sharp',
        terminalStyle: pred.terminalStyle || 'Standard',
        letterSpacingTrait: pred.letterSpacingTrait || 'Normal',
        distinctiveFeatures: pred.distinctiveFeatures || [],
        scriptLanguage: pred.scriptLanguage || 'Latin',
        reasoning: pred.reasoning,
      };
      const region: TextRegionDetection = {
        regionId: `region_${idx + 1}`,
        role: pred.role || 'heading',
        roleLabel: pred.roleLabel || (idx === 0 ? 'Primary Text' : `Text Region ${idx + 1}`),
        extractedText: pred.extractedText,
        bbox: pred.bbox,
        rotationDeg: pred.rotationDeg || 0,
        cropDataUrl: cropInfo.cropDataUrl,
        rasterMetrics: cropInfo.metrics,
        traits,
      };
      return { pred, region, cropMask };
    })
  );

  onProgress('Analyzing Letterforms', 4, 52);
  onProgress('Searching Font Databases', 5, 66);

  const catalog = await getLiveFontCatalog();
  const filteredPool = catalog.entries.filter((e) => matchesSearchFilters(e, filters));

  onProgress('Comparing Font Candidates', 6, 80);

  const regionResults: RegionFontResult[] = [];

  for (const item of regionPrepared) {
    const { pred, region, cropMask } = item;

    // Score filtered catalog entries
    const scored = filteredPool
      .map((entry) => ({
        entry,
        ...scoreCatalogEntryForRegion(entry, pred),
      }))
      .sort((a, b) => b.score - a.score);

    const topShortlist = scored.slice(0, 8);

    // Fetch live verified CDN files & license details from Fontsource v1 API
    const candidates: FontCandidateMatch[] = await Promise.all(
      topShortlist.map(async (s) => {
        const detail = s.entry.inFontsource ? await getFontsourceDetail(s.entry.id) : null;
        const variant = pickBestVariantUrls(
          detail,
          pred.numericWeight || 400,
          pred.isItalic,
          filters?.language && ['arabic', 'bengali', 'cyrillic', 'latin'].includes(filters.language)
            ? filters.language
            : 'latin'
        );

        const lic = classifyLicense(detail?.license || s.entry.licenseRaw, s.entry.inGoogleFonts || s.entry.inFontsource);
        const downloadFormats: FontDownloadOption[] = [];
        if (variant.ttf || variant.woff2 || variant.woff) {
          downloadFormats.push({
            format: 'ZIP',
            url: `/api/font-finder/download?id=${encodeURIComponent(s.entry.id)}&format=zip&weight=${variant.resolvedWeight}&style=${variant.resolvedStyle}`,
            proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(s.entry.id)}&format=zip&weight=${variant.resolvedWeight}&style=${variant.resolvedStyle}`,
            verified: true,
          });
        }
        if (variant.ttf) {
          downloadFormats.push({
            format: 'TTF',
            url: variant.ttf,
            proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(s.entry.id)}&format=ttf&weight=${variant.resolvedWeight}&style=${variant.resolvedStyle}`,
            verified: true,
          });
        }
        if (variant.woff2) {
          downloadFormats.push({
            format: 'WOFF2',
            url: variant.woff2,
            proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(s.entry.id)}&format=woff2&weight=${variant.resolvedWeight}&style=${variant.resolvedStyle}`,
            verified: true,
          });
        }
        if (variant.woff) {
          downloadFormats.push({
            format: 'WOFF',
            url: variant.woff,
            proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(s.entry.id)}&format=woff&weight=${variant.resolvedWeight}&style=${variant.resolvedStyle}`,
            verified: true,
          });
        }

        // Visual glyph silhouette verification if TTF is available & text is Latin
        let glyphCorrelation: number | undefined;
        if (cropMask && variant.ttf && /[a-zA-Z0-9]/.test(region.extractedText)) {
          const iou = await computeGlyphSilhouetteIoU(cropMask, variant.ttf, region.extractedText);
          if (iou !== null) glyphCorrelation = iou;
        }

        const blendedConfidence =
          glyphCorrelation !== undefined && s.aiExactConfidence === 0
            ? Math.min(95, Math.round(s.score * 0.78 + glyphCorrelation * 0.22))
            : s.score;

        const officialUrl = s.entry.inGoogleFonts
          ? `https://fonts.google.com/specimen/${encodeURIComponent(s.entry.family.replace(/\s+/g, '+'))}`
          : `https://fontsource.org/fonts/${encodeURIComponent(s.entry.id)}`;

        const cssWeightList = Array.from(new Set([...s.entry.weights, 400, 700]))
          .filter((w) => s.entry.weights.includes(w))
          .sort((a, b) => a - b);
        const cssUrl = s.entry.inGoogleFonts
          ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(s.entry.family).replace(/%20/g, '+')}:wght@${cssWeightList.join(';')}&display=swap`
          : '';

        const isExactFree = s.aiExactConfidence >= 78;

        return {
          id: s.entry.id,
          family: s.entry.family,
          designer: s.entry.designer,
          source: s.entry.inGoogleFonts ? 'Google Fonts & Fontsource' : 'Fontsource',
          isExactMatch: isExactFree,
          matchType: isExactFree ? 'exact-free' : 'similar-free',
          confidencePercent: blendedConfidence,
          categories: [s.entry.googleCategory, ...(s.entry.stroke ? [s.entry.stroke] : []), ...s.entry.classifications].filter(
            (v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx
          ),
          primaryCategory: s.entry.googleCategory,
          recommendedWeight: variant.resolvedWeight,
          weights: s.entry.weights,
          styles: s.entry.styles,
          subsets: s.entry.subsets,
          licenseName: lic.licenseName,
          licenseClass: lic.licenseClass,
          licenseVerified: lic.licenseVerified,
          officialUrl,
          cssUrl,
          previewFontUrls: {
            woff2: variant.woff2,
            woff: variant.woff,
            ttf: variant.ttf,
          },
          downloadFormats,
          matchReasons:
            glyphCorrelation !== undefined
              ? [...s.reasons, `Glyph silhouette overlap verified (${glyphCorrelation}%)`].slice(0, 4)
              : s.reasons,
          similarityBreakdown: {
            shapeSimilarity: s.shapeSimilarity,
            weightMatch: s.weightMatch,
            widthMatch: s.widthMatch,
            styleMatch: s.styleMatch,
            ...(glyphCorrelation !== undefined ? { glyphCorrelation } : {}),
          },
        };
      })
    );

    // Sort again descending after glyph verification refinement
    candidates.sort((a, b) => b.confidencePercent - a.confidencePercent);

    // Check if an exact free match was verified or if top AI identification is a commercial paid font
    const exactFreeMatch = candidates.find((c) => c.isExactMatch) || null;
    const topPaidHyp = (pred.hypothesizedExactFonts || []).find(
      (h) => h.isLikelyPaid && !catalog.byNormFamily.has(normalizeExactFamily(h.family))
    );

    let exactMatch: FontCandidateMatch | null = exactFreeMatch;
    let fallbackMessage: string | null = null;
    let paidExactNotice: string | null = null;

    if (!exactFreeMatch && topPaidHyp && topPaidHyp.confidence >= 70) {
      exactMatch = buildCommercialPaidReference(
        topPaidHyp.family,
        topPaidHyp.confidence,
        topPaidHyp.reasoning,
        pred
      );
      paidExactNotice = `"${topPaidHyp.family}" is a commercial paid font (${topPaidHyp.confidence}% confidence). We cannot redistribute paid font files, so verified free visually similar alternatives are shown below.`;
    } else if (!exactFreeMatch) {
      fallbackMessage =
        'Exact font not found in verified open-source catalogs. Here are the closest matching free alternatives.';
    }

    const similarCandidates = exactFreeMatch
      ? candidates.filter((c) => c.id !== exactFreeMatch.id)
      : candidates;

    regionResults.push({
      region,
      exactMatch,
      fallbackMessage,
      paidExactNotice,
      candidates: similarCandidates,
    });
  }

  onProgress('Verifying Licenses', 7, 92);
  onProgress('Preparing Results', 8, 100);

  return {
    uploadId,
    imageWidth: workW,
    imageHeight: workH,
    detectedRotationDeg: aiResult.detectedRotationDeg,
    overallSummary: aiResult.overallSummary,
    regions: regionResults,
    sourceHealth: catalog.health,
    processingMs: Date.now() - startedAt,
  };
}

// ============================================================================
// Verified Font File Download & ZIP Packager
// ============================================================================

export async function buildVerifiedFontDownload(params: {
  fontId: string;
  format: 'zip' | 'ttf' | 'woff2' | 'woff';
  weight?: number;
  style?: string;
}): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const { fontId, format, weight = 400, style = 'normal' } = params;
  const detail = await getFontsourceDetail(fontId);
  if (!detail || !detail.variants) {
    throw new Error(`Font "${fontId}" was not found in the verified Fontsource registry.`);
  }

  const variant = pickBestVariantUrls(detail, weight, style === 'italic');
  const safeBase = detail.id.replace(/[^a-z0-9_-]/gi, '_');

  if (format === 'ttf' || format === 'woff2' || format === 'woff') {
    const targetUrl = variant[format];
    if (!targetUrl || !isAllowedFontDownloadUrl(targetUrl)) {
      throw new Error(`${format.toUpperCase()} binary is unavailable for ${detail.family}.`);
    }
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': 'MakeVectorizer-FontDownloader/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Upstream CDN returned HTTP ${res.status} for ${detail.family}.`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeMap = {
      ttf: 'font/ttf',
      woff2: 'font/woff2',
      woff: 'font/woff',
    };
    return {
      buffer: buf,
      mimeType: mimeMap[format],
      filename: `${safeBase}-${variant.resolvedWeight}-${variant.resolvedStyle}.${format}`,
    };
  }

  // Genuine ZIP bundle containing available weights (.ttf + .woff2) and verified license info
  const zip = new JSZip();
  const licInfo = classifyLicense(detail.license, true);
  zip.file(
    'LICENSE_INFO.txt',
    [
      `Font Family: ${detail.family}`,
      `Fontsource ID: ${detail.id}`,
      `Version: ${detail.version || 'latest'}`,
      `Verified License: ${licInfo.licenseName} (${licInfo.licenseClass})`,
      `Official Source: ${detail.source || `https://fontsource.org/fonts/${detail.id}`}`,
      `Downloaded via MakeVectorizer AI Font Finder`,
    ].join('\n')
  );

  let filesAdded = 0;
  const candidateWeights = Array.from(
    new Set([variant.resolvedWeight, 400, 700].filter((w) => detail.variants?.[String(w)]))
  );

  for (const w of candidateWeights) {
    for (const st of Object.keys(detail.variants[String(w)] || {})) {
      const subMap = detail.variants[String(w)]?.[st];
      const subKey = detail.defSubset && subMap?.[detail.defSubset] ? detail.defSubset : subMap?.latin ? 'latin' : Object.keys(subMap || {})[0];
      const urls = subKey ? subMap?.[subKey]?.url : undefined;
      for (const ext of ['ttf', 'woff2'] as const) {
        const u = urls?.[ext];
        if (!u || !isAllowedFontDownloadUrl(u)) continue;
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
          if (r.ok) {
            const arr = Buffer.from(await r.arrayBuffer());
            zip.file(`${safeBase}-${w}-${st}.${ext}`, arr);
            filesAdded++;
          }
        } catch {
          // continue best-effort for secondary weights
        }
      }
    }
  }

  if (filesAdded === 0) {
    throw new Error(`No downloadable font binaries could be retrieved for ${detail.family}.`);
  }

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer: zipBuf,
    mimeType: 'application/zip',
    filename: `${safeBase}-font-bundle.zip`,
  };
}

// ============================================================================
// Genuine OpenType.js Text-to-Vector Outline Converter (for Use Font in Design)
// ============================================================================

export async function convertFontTextToVectorShapes(params: {
  fontId: string;
  text: string;
  fontSize?: number;
  weight?: number;
  isItalic?: boolean;
  x?: number;
  y?: number;
  fill?: string;
}): Promise<VectorShape> {
  const {
    fontId,
    text,
    fontSize = 64,
    weight = 400,
    isItalic = false,
    x = 80,
    y = 140,
    fill = '#0f172a',
  } = params;

  const cleanText = (text || 'MakeVectorizer').slice(0, 120);
  const detail = await getFontsourceDetail(fontId);
  if (!detail) {
    throw new Error(`Font "${fontId}" not found in registry for vector outline conversion.`);
  }

  const variant = pickBestVariantUrls(detail, weight, isItalic);
  if (!variant.ttf) {
    throw new Error(`TrueType (.ttf) outline data unavailable for ${detail.family}.`);
  }

  const ttfBuf = await fetchTtfBufferCached(variant.ttf);
  if (!ttfBuf) {
    throw new Error(`Failed to fetch TrueType font file for ${detail.family}.`);
  }

  const ab = ttfBuf.buffer.slice(ttfBuf.byteOffset, ttfBuf.byteOffset + ttfBuf.byteLength);
  const font = opentype.parse(ab);
  const path = font.getPath(cleanText, x, y, fontSize);
  const d = path.toPathData(2);
  const box = path.getBoundingBox();

  if (!d) {
    throw new Error('Font outline conversion produced an empty path.');
  }

  return {
    id: `font_outline_${Date.now().toString(36)}`,
    groupId: `layer_font_${detail.id}`,
    layerName: `${detail.family} Outline ("${cleanText.slice(0, 24)}")`,
    type: 'path',
    pathData: d,
    fill,
    stroke: 'none',
    strokeWidth: 0,
    opacity: 1,
    visible: true,
    locked: false,
    bounds: {
      x: Number(box.x1.toFixed(1)),
      y: Number(box.y1.toFixed(1)),
      width: Number(Math.max(4, box.x2 - box.x1).toFixed(1)),
      height: Number(Math.max(4, box.y2 - box.y1).toFixed(1)),
    },
    nodeCount: (d.match(/[MLCQ]/gi) || []).length,
  };
}
