import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import sharp from 'sharp';
import opentype from 'opentype.js';
import type {
  FontDownloadOption,
  GlyphAnatomyAnalysis,
  VerifiedExactFontMatch,
} from '../../src/types/vector.ts';
import {
  isAllowedFontDownloadUrl,
  type GroundedWebFontLead,
  type NormalizedFontCandidate,
} from './fontConnectors.ts';

const BINARY_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const fontBinaryCache = new Map<string, { loadedAt: number; buffer: Buffer }>();

export async function fetchFontBinaryCached(url: string): Promise<Buffer | null> {
  const cleanUrl = String(url || '').trim();
  if (!isAllowedFontDownloadUrl(cleanUrl)) return null;
  const cached = fontBinaryCache.get(cleanUrl);
  if (cached && Date.now() - cached.loadedAt < BINARY_CACHE_TTL_MS) {
    return cached.buffer;
  }
  try {
    const res = await fetch(cleanUrl, {
      headers: { 'User-Agent': 'MakeVectorizer-FontResearch/2.0' },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    if (buf.length < 1000 || buf.length > 20_000_000) return null;
    fontBinaryCache.set(cleanUrl, { loadedAt: Date.now(), buffer: buf });
    return buf;
  } catch {
    return null;
  }
}

export interface BinarySpecimenRender {
  specimenPng: Buffer;
  specimenDataUrl: string;
  fontFamilyMeta: string;
  fontSubfamilyMeta: string;
  designerMeta: string;
  licenseMeta: string;
  glyphCoverage: number;
  aspectRatio: number;
}

function getLangText(entry: Record<string, string> | undefined): string {
  if (!entry) return '';
  return entry.en || Object.values(entry)[0] || '';
}

export async function renderFontSpecimenFromBinary(
  fontBuffer: Buffer,
  extractedText: string
): Promise<BinarySpecimenRender | null> {
  try {
    const ab = fontBuffer.buffer.slice(
      fontBuffer.byteOffset,
      fontBuffer.byteOffset + fontBuffer.byteLength
    );
    const font = opentype.parse(ab);
    const cleanText = String(extractedText || '').trim();
    if (!cleanText) return null;

    const chars = Array.from(cleanText.replace(/\s+/g, ''));
    let covered = 0;
    for (const ch of chars) {
      const glyph = font.charToGlyph(ch);
      if (glyph && glyph.index !== 0) covered++;
    }
    const glyphCoverage = chars.length > 0 ? covered / chars.length : 1;

    const lines = cleanText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (lines.length === 0) return null;

    const fontSize = 72;
    const lineHeightPx = 88;
    const paths: Array<{ d: string; x1: number; y1: number; x2: number; y2: number }> = [];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].slice(0, 48);
      const p = font.getPath(line, 0, (i + 1) * lineHeightPx, fontSize);
      const box = p.getBoundingBox();
      const d = p.toPathData(2);
      if (!d) continue;
      paths.push({ d, x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 });
      minX = Math.min(minX, box.x1);
      minY = Math.min(minY, box.y1);
      maxX = Math.max(maxX, box.x2);
      maxY = Math.max(maxY, box.y2);
    }

    if (paths.length === 0 || !Number.isFinite(minX)) return null;

    const pad = 18;
    const vbW = Math.max(24, maxX - minX + pad * 2);
    const vbH = Math.max(24, maxY - minY + pad * 2);
    const targetW = Math.min(1100, Math.max(220, Math.round(vbW * 1.4)));
    const targetH = Math.min(480, Math.max(96, Math.round((vbH / vbW) * targetW)));

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${targetW}" height="${targetH}" viewBox="${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}"><rect x="${(minX - pad).toFixed(1)}" y="${(minY - pad).toFixed(1)}" width="${vbW.toFixed(1)}" height="${vbH.toFixed(1)}" fill="#ffffff"/>${paths
      .map((p) => `<path d="${p.d}" fill="#0f172a"/>`)
      .join('')}</svg>`;

    const specimenPng = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();

    return {
      specimenPng,
      specimenDataUrl: `data:image/png;base64,${specimenPng.toString('base64')}`,
      fontFamilyMeta: getLangText(font.names.fontFamily),
      fontSubfamilyMeta: getLangText(font.names.fontSubfamily),
      designerMeta: getLangText(font.names.designer) || getLangText(font.names.manufacturer),
      licenseMeta: getLangText(font.names.license),
      glyphCoverage: Number(glyphCoverage.toFixed(2)),
      aspectRatio: Number((vbW / vbH).toFixed(2)),
    };
  } catch {
    return null;
  }
}

/**
 * Extracts a trimmed foreground mask + edge gradient map from a text image crop
 * so aspect ratio, silhouette overlap, and stroke contours can be compared fairly.
 */
async function extractNormalizedGlyphMask(
  pngBuffer: Buffer,
  width = 160,
  height = 56
): Promise<{ mask: Uint8Array; edges: Uint8Array; rawAspectRatio: number } | null> {
  try {
    // First compute tight foreground bounding box from medium gray image
    const { data: src, info } = await sharp(pngBuffer)
      .grayscale()
      .resize(320, 140, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    if (w < 8 || h < 8) return null;

    // Sample border median/average to infer background luminance
    let borderSum = 0;
    let borderN = 0;
    for (let x = 0; x < w; x++) {
      borderSum += src[x] + src[(h - 1) * w + x];
      borderN += 2;
    }
    for (let y = 0; y < h; y++) {
      borderSum += src[y * w] + src[y * w + (w - 1)];
      borderN += 2;
    }
    const avgBg = borderSum / Math.max(1, borderN);
    const isDarkBg = avgBg < 128;

    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let fgCount = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const lum = src[y * w + x];
        const diff = isDarkBg ? lum - avgBg : avgBg - lum;
        if (diff > 36) {
          fgCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (fgCount < 16 || maxX <= minX || maxY <= minY) return null;

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const rawAspectRatio = cropW / Math.max(1, cropH);

    // Resize tight foreground box onto normalized binary grid
    const tightBuf = await sharp(src, { raw: { width: w, height: h, channels: 1 } })
      .extract({ left: minX, top: minY, width: cropW, height: cropH })
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer();

    const mask = new Uint8Array(width * height);
    for (let i = 0; i < tightBuf.length; i++) {
      const diff = isDarkBg ? tightBuf[i] - avgBg : avgBg - tightBuf[i];
      mask[i] = diff > 38 ? 1 : 0;
    }

    // Simple 4-neighbor gradient contour mask
    const edges = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (mask[idx] === 1) {
          if (
            mask[idx - 1] === 0 ||
            mask[idx + 1] === 0 ||
            mask[idx - width] === 0 ||
            mask[idx + width] === 0
          ) {
            edges[idx] = 1;
          }
        }
      }
    }

    return { mask, edges, rawAspectRatio };
  } catch {
    return null;
  }
}

export async function computeProgrammaticGlyphMetrics(
  cropPngBuffer: Buffer,
  specimenPngBuffer: Buffer
): Promise<{
  silhouetteIoU: number;
  edgeCorrelation: number;
  aspectMatch: number;
} | null> {
  const [a, b] = await Promise.all([
    extractNormalizedGlyphMask(cropPngBuffer),
    extractNormalizedGlyphMask(specimenPngBuffer),
  ]);
  if (!a || !b) return null;

  let inter = 0;
  let union = 0;
  let edgeInter = 0;
  let edgeUnion = 0;

  for (let i = 0; i < a.mask.length; i++) {
    const ma = a.mask[i] === 1;
    const mb = b.mask[i] === 1;
    if (ma || mb) union++;
    if (ma && mb) inter++;

    const ea = a.edges[i] === 1;
    const eb = b.edges[i] === 1;
    if (ea || eb) edgeUnion++;
    if (ea && eb) edgeInter++;
  }

  const silhouetteIoU = union > 0 ? Math.round(Math.min(100, (inter / union) * 145)) : 0;
  const edgeCorrelation = edgeUnion > 0 ? Math.round(Math.min(100, (edgeInter / edgeUnion) * 195)) : 0;
  const ratioDiff = Math.abs(a.rawAspectRatio - b.rawAspectRatio) / Math.max(a.rawAspectRatio, b.rawAspectRatio, 0.1);
  const aspectMatch = Math.max(0, Math.round((1 - ratioDiff) * 100));

  return { silhouetteIoU, edgeCorrelation, aspectMatch };
}

export interface MultimodalVerificationOutcome {
  isExactMatch: boolean;
  contradictionFound: boolean;
  contradictions: string[];
  matchingEvidence: string[];
  glyphComparisonNotes: string;
  confidence: number;
}

export async function verifySpecimenVisuallyWithGemini(params: {
  cropPngBuffer: Buffer;
  specimenPngBuffer: Buffer;
  candidateFamily: string;
  candidateStyle: string;
  extractedText: string;
  glyphAnalysis: GlyphAnatomyAnalysis;
}): Promise<MultimodalVerificationOutcome> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const prompt = `You are a strict forensic typography verifier.
Image 1 is the original uploaded text crop ("${params.extractedText}").
Image 2 is a genuine specimen rendering of the candidate typeface "${params.candidateFamily}" (${params.candidateStyle}) rendering the exact same text.

Your ONLY task is to determine whether Image 1 was set in the EXACT SAME typeface family as Image 2 (NOT merely a similar-looking font!).

Rules:
1. Ignore Image 1's color, background, drop shadows, outlines, gradients, slight perspective warp, or raster blur/compression. Focus strictly on the underlying letterform anatomy.
2. Compare character-by-character across distinctive visible glyphs (e.g., A, G, R, S, M, Q, a, g, e, t, &, numerals, punctuation):
   - Single-story vs double-story 'a' and 'g'
   - Apex shape of 'A', 'M', 'W', 'V' (pointed vs flat vs notched)
   - Leg of 'R' and 'K', tail of 'Q' and 'y', spur of 'G' and 'b'
   - Aperture and terminal angles of 'c', 'e', 's', 'a'
   - Serif brackets, ball terminals, slab geometry, stroke contrast, x-height, cap-height, and glyph width proportions
3. If you spot ANY unmistakable anatomical glyph contradiction (for example: Image 1 has single-story 'a' and Image 2 has double-story 'a'; or Image 1 has geometric circular 'O' and Image 2 has narrow oval 'O'; or Image 1 has curved 'R' leg and Image 2 has straight 'R' leg; or obvious width/weight-family mismatch), set contradictionFound = true and isExactMatch = false.
4. If the text is too tiny/blurry/short/generic to rule out lookalikes with confidence, set isExactMatch = false.
5. Set isExactMatch = true ONLY when the diagnostic glyph geometry across multiple visible characters clearly confirms this exact typeface.`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        { inlineData: { mimeType: 'image/png', data: params.cropPngBuffer.toString('base64') } },
        { inlineData: { mimeType: 'image/png', data: params.specimenPngBuffer.toString('base64') } },
        { text: prompt },
      ],
    },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isExactMatch: { type: Type.BOOLEAN },
          contradictionFound: { type: Type.BOOLEAN },
          contradictions: { type: Type.ARRAY, items: { type: Type.STRING } },
          matchingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
          glyphComparisonNotes: { type: Type.STRING },
          confidence: { type: Type.INTEGER },
        },
        required: [
          'isExactMatch',
          'contradictionFound',
          'contradictions',
          'matchingEvidence',
          'glyphComparisonNotes',
          'confidence',
        ],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim()) as MultimodalVerificationOutcome;
  const contradictionFound = Boolean(parsed.contradictionFound) || (parsed.contradictions?.length || 0) > 0;
  return {
    isExactMatch: Boolean(parsed.isExactMatch) && !contradictionFound,
    contradictionFound,
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
    matchingEvidence: Array.isArray(parsed.matchingEvidence) ? parsed.matchingEvidence : [],
    glyphComparisonNotes: parsed.glyphComparisonNotes || '',
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence || 0))),
  };
}

export async function verifyCommercialFoundryLeadWithGemini(params: {
  cropPngBuffer: Buffer;
  lead: GroundedWebFontLead;
  extractedText: string;
  glyphAnalysis: GlyphAnatomyAnalysis;
}): Promise<MultimodalVerificationOutcome> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const prompt = `You are a strict forensic typography verifier evaluating whether the commercial/foundry typeface "${params.lead.family}" (${params.lead.styleName}) by ${params.lead.foundryOrDesigner} is the EXACT original font in this image crop.

Extracted Text: "${params.extractedText}"
Candidate Source: ${params.lead.officialSourceName}
Candidate Rationale: ${params.lead.matchRationale}
Diagnostic Glyphs Claimed: ${params.lead.diagnosticGlyphMatches.join('; ')}

Forensic Check:
1. Inspect the image crop carefully. Does every visible character in "${params.extractedText}" genuinely match the known, documented glyph anatomy of "${params.lead.family}" (e.g., exact 'a', 'g', 'e', 'R', 'S', 'M', 'Q', 't', '&', stroke contrast, terminals, width, weight)?
2. Is this custom hand-lettered / bespoke brand artwork rather than a commercial font, OR is the text too generic/short/blurry/low-res to prove "${params.lead.family}" over lookalikes (e.g., Helvetica vs Neue Haas Grotesk vs Arial vs Inter on generic characters)?
3. Only set isExactMatch = true if the visible glyphs provide clear, unambiguous diagnostic proof of "${params.lead.family}" with ZERO contradictions.`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        { inlineData: { mimeType: 'image/png', data: params.cropPngBuffer.toString('base64') } },
        { text: prompt },
      ],
    },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isExactMatch: { type: Type.BOOLEAN },
          contradictionFound: { type: Type.BOOLEAN },
          contradictions: { type: Type.ARRAY, items: { type: Type.STRING } },
          matchingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
          glyphComparisonNotes: { type: Type.STRING },
          confidence: { type: Type.INTEGER },
        },
        required: [
          'isExactMatch',
          'contradictionFound',
          'contradictions',
          'matchingEvidence',
          'glyphComparisonNotes',
          'confidence',
        ],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim()) as MultimodalVerificationOutcome;
  const contradictionFound = Boolean(parsed.contradictionFound) || (parsed.contradictions?.length || 0) > 0;
  return {
    isExactMatch: Boolean(parsed.isExactMatch) && !contradictionFound,
    contradictionFound,
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
    matchingEvidence: Array.isArray(parsed.matchingEvidence) ? parsed.matchingEvidence : [],
    glyphComparisonNotes: parsed.glyphComparisonNotes || '',
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence || 0))),
  };
}

export async function verifySpecimenBatchWithGemini(params: {
  cropPngBuffer: Buffer;
  candidates: Array<{
    family: string;
    style: string;
    specimenPngBuffer: Buffer;
    progMetrics?: { silhouetteIoU: number; edgeCorrelation: number; aspectMatch: number } | null;
  }>;
  extractedText: string;
  glyphAnalysis: GlyphAnatomyAnalysis;
}): Promise<Map<string, MultimodalVerificationOutcome>> {
  const results = new Map<string, MultimodalVerificationOutcome>();
  if (params.candidates.length === 0) return results;

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [
    {
      text: `ORIGINAL IMAGE CROP ("${params.extractedText}") — Reference Image 0:`,
    },
    {
      inlineData: { mimeType: 'image/png', data: params.cropPngBuffer.toString('base64') },
    },
  ];

  params.candidates.forEach((cand, idx) => {
    const metricsTag = cand.progMetrics
      ? ` [Measured Silhouette Overlap: ${cand.progMetrics.silhouetteIoU}%, Edge Match: ${cand.progMetrics.edgeCorrelation}%, Width/Aspect Match: ${cand.progMetrics.aspectMatch}%]`
      : '';
    parts.push({
      text: `CANDIDATE #${idx + 1}: "${cand.family}" (${cand.style})${metricsTag} — Genuine Font Specimen:`,
    });
    parts.push({
      inlineData: { mimeType: 'image/png', data: cand.specimenPngBuffer.toString('base64') },
    });
  });

  parts.push({
    text: `You are a strict forensic typography verifier.
Compare Reference Image 0 ("${params.extractedText}") side-by-side against each numbered Candidate Specimen (#1..#${params.candidates.length}).
Determine which single candidate (if ANY) is the EXACT SAME original typeface family used in Reference Image 0 (NOT a merely similar lookalike!).

Rules:
1. Ignore Reference Image 0's color, background, drop shadows, outlines, gradients, slight perspective warp, or raster blur. Inspect underlying letterform anatomy ONLY.
2. Check character-by-character across every visible glyph AND weight/proportion fidelity: serif construction/brackets, stroke contrast, stem thickness/weight match, ball/teardrop/sheared terminals, single- vs double-story 'a' & 'g', 'A'/'M'/'W' apexes, 'R'/'K' legs, 'Q'/'y' tails, apertures, counter shapes, x-height, width proportions.
3. Compare candidates directly against each other! If Candidate A matches the stroke weight, ball terminals, serif brackets, and character widths closer and more identically than Candidate B, mark ONLY the truly identical match as isExactMatch = true and mark lookalikes as isExactMatch = false.
4. For any candidate with even ONE clear anatomical glyph contradiction or wrong weight/width family, set contradictionFound = true and isExactMatch = false.
5. Set isExactMatch = true ONLY for the genuine exact original typeface across visible glyphs with zero contradictions. If none is genuinely exact, return isExactMatch = false for all.`,
  });

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: { parts },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          evaluations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                candidateNumber: { type: Type.INTEGER },
                family: { type: Type.STRING },
                isExactMatch: { type: Type.BOOLEAN },
                contradictionFound: { type: Type.BOOLEAN },
                contradictions: { type: Type.ARRAY, items: { type: Type.STRING } },
                matchingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
                glyphComparisonNotes: { type: Type.STRING },
                confidence: { type: Type.INTEGER },
              },
              required: [
                'candidateNumber',
                'family',
                'isExactMatch',
                'contradictionFound',
                'contradictions',
                'matchingEvidence',
                'glyphComparisonNotes',
                'confidence',
              ],
            },
          },
        },
        required: ['evaluations'],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim()) as {
    evaluations?: Array<MultimodalVerificationOutcome & { candidateNumber: number; family: string }>;
  };

  for (const ev of parsed.evaluations || []) {
    const cand = params.candidates[(ev.candidateNumber || 0) - 1] ||
      params.candidates.find((c) => c.family.toLowerCase() === String(ev.family || '').toLowerCase());
    if (!cand) continue;
    const contradictionFound =
      Boolean(ev.contradictionFound) || (Array.isArray(ev.contradictions) && ev.contradictions.length > 0);
    results.set(cand.family.toLowerCase(), {
      isExactMatch: Boolean(ev.isExactMatch) && !contradictionFound,
      contradictionFound,
      contradictions: Array.isArray(ev.contradictions) ? ev.contradictions : [],
      matchingEvidence: Array.isArray(ev.matchingEvidence) ? ev.matchingEvidence : [],
      glyphComparisonNotes: ev.glyphComparisonNotes || '',
      confidence: Math.max(0, Math.min(100, Number(ev.confidence || 0))),
    });
  }

  return results;
}

export async function verifyCommercialLeadsBatchWithGemini(params: {
  cropPngBuffer: Buffer;
  leads: GroundedWebFontLead[];
  extractedText: string;
  glyphAnalysis: GlyphAnatomyAnalysis;
}): Promise<Map<string, MultimodalVerificationOutcome>> {
  const results = new Map<string, MultimodalVerificationOutcome>();
  if (params.leads.length === 0) return results;

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const leadDescriptions = params.leads
    .map(
      (l, i) =>
        `#${i + 1}: "${l.family}" (${l.styleName}) by ${l.foundryOrDesigner} [Source: ${l.officialSourceName}] — Rationale: ${l.matchRationale}`
    )
    .join('\n');

  const prompt = `You are a strict forensic typography verifier evaluating commercial/foundry typeface leads against this image crop ("${params.extractedText}").

Candidates:
${leadDescriptions}

For each candidate #1..#${params.leads.length}:
1. Inspect the visible characters in the image crop carefully. Does every visible glyph match the known, documented anatomy of that typeface with ZERO contradictions?
2. If the lettering is custom hand-drawn artwork OR too generic/short/low-res to verify an exact match over lookalikes, set isExactMatch = false.
3. Only set isExactMatch = true when the diagnostic glyphs provide clear proof of that exact typeface.`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        { inlineData: { mimeType: 'image/png', data: params.cropPngBuffer.toString('base64') } },
        { text: prompt },
      ],
    },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          evaluations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                candidateNumber: { type: Type.INTEGER },
                family: { type: Type.STRING },
                isExactMatch: { type: Type.BOOLEAN },
                contradictionFound: { type: Type.BOOLEAN },
                contradictions: { type: Type.ARRAY, items: { type: Type.STRING } },
                matchingEvidence: { type: Type.ARRAY, items: { type: Type.STRING } },
                glyphComparisonNotes: { type: Type.STRING },
                confidence: { type: Type.INTEGER },
              },
              required: [
                'candidateNumber',
                'family',
                'isExactMatch',
                'contradictionFound',
                'contradictions',
                'matchingEvidence',
                'glyphComparisonNotes',
                'confidence',
              ],
            },
          },
        },
        required: ['evaluations'],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim()) as {
    evaluations?: Array<MultimodalVerificationOutcome & { candidateNumber: number; family: string }>;
  };

  for (const ev of parsed.evaluations || []) {
    const lead = params.leads[(ev.candidateNumber || 0) - 1] ||
      params.leads.find((l) => l.family.toLowerCase() === String(ev.family || '').toLowerCase());
    if (!lead) continue;
    const contradictionFound =
      Boolean(ev.contradictionFound) || (Array.isArray(ev.contradictions) && ev.contradictions.length > 0);
    results.set(lead.family.toLowerCase(), {
      isExactMatch: Boolean(ev.isExactMatch) && !contradictionFound,
      contradictionFound,
      contradictions: Array.isArray(ev.contradictions) ? ev.contradictions : [],
      matchingEvidence: Array.isArray(ev.matchingEvidence) ? ev.matchingEvidence : [],
      glyphComparisonNotes: ev.glyphComparisonNotes || '',
      confidence: Math.max(0, Math.min(100, Number(ev.confidence || 0))),
    });
  }

  return results;
}

export function buildVerifiedExactMatchObject(params: {
  candidate: NormalizedFontCandidate;
  verification: MultimodalVerificationOutcome;
  specimenRender: BinarySpecimenRender | null;
  progMetrics: { silhouetteIoU: number; edgeCorrelation: number; aspectMatch: number } | null;
  inFontsource: boolean;
}): VerifiedExactFontMatch {
  const { candidate, verification, specimenRender, progMetrics, inFontsource } = params;

  const downloadOptions: FontDownloadOption[] = [];
  const w = candidate.weight || 400;
  const st = candidate.isItalic ? 'italic' : 'normal';

  if (inFontsource && (candidate.binaryUrls.ttf || candidate.binaryUrls.woff2 || candidate.binaryUrls.woff || candidate.binaryUrls.otf)) {
    downloadOptions.push({
      format: 'ZIP',
      url: `/api/font-finder/download?id=${encodeURIComponent(candidate.id)}&format=zip&weight=${w}&style=${st}`,
      proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(candidate.id)}&format=zip&weight=${w}&style=${st}`,
      verified: true,
    });
  }
  if (candidate.binaryUrls.otf && isAllowedFontDownloadUrl(candidate.binaryUrls.otf)) {
    downloadOptions.push({
      format: 'OTF',
      url: candidate.binaryUrls.otf,
      proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(candidate.id)}&format=otf&weight=${w}&style=${st}${
        !inFontsource ? `&family=${encodeURIComponent(candidate.family)}` : ''
      }`,
      verified: true,
    });
  }
  if (candidate.binaryUrls.ttf && isAllowedFontDownloadUrl(candidate.binaryUrls.ttf)) {
    downloadOptions.push({
      format: 'TTF',
      url: candidate.binaryUrls.ttf,
      proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(candidate.id)}&format=ttf&weight=${w}&style=${st}${
        !inFontsource ? `&family=${encodeURIComponent(candidate.family)}` : ''
      }`,
      verified: true,
    });
  }
  if (candidate.binaryUrls.woff2 && isAllowedFontDownloadUrl(candidate.binaryUrls.woff2)) {
    downloadOptions.push({
      format: 'WOFF2',
      url: candidate.binaryUrls.woff2,
      proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(candidate.id)}&format=woff2&weight=${w}&style=${st}${
        !inFontsource ? `&family=${encodeURIComponent(candidate.family)}` : ''
      }`,
      verified: true,
    });
  }
  if (candidate.binaryUrls.woff && isAllowedFontDownloadUrl(candidate.binaryUrls.woff)) {
    downloadOptions.push({
      format: 'WOFF',
      url: candidate.binaryUrls.woff,
      proxyUrl: `/api/font-finder/download?id=${encodeURIComponent(candidate.id)}&format=woff&weight=${w}&style=${st}`,
      verified: true,
    });
  }

  const hasBrowserFont =
    Boolean(candidate.binaryUrls.woff2 || candidate.binaryUrls.ttf || candidate.binaryUrls.woff || candidate.cssUrl);

  let downloadStatus: VerifiedExactFontMatch['download']['status'] = 'unavailable';
  let downloadMessage = 'Font identified, but a verified download source is unavailable.';
  if (downloadOptions.length > 0) {
    downloadStatus = 'direct_files';
    downloadMessage = 'Verified open-source font files available from official distribution CDN.';
  } else if (candidate.officialPageUrl) {
    downloadStatus = 'official_page_only';
    downloadMessage =
      candidate.licenseClass === 'Paid Font' || candidate.licenseClass === 'Commercial Proprietary License'
        ? 'Commercial typeface — download or license directly from the official foundry/catalogue page.'
        : 'Available via the official source page.';
  }

  const weightLabels: Record<number, string> = {
    100: 'Thin',
    200: 'ExtraLight',
    300: 'Light',
    400: 'Regular',
    500: 'Medium',
    600: 'SemiBold',
    700: 'Bold',
    800: 'ExtraBold',
    900: 'Black',
  };

  // Compute evidence-grounded internal confidence (never invented)
  const evidenceParts: number[] = [verification.confidence];
  if (progMetrics) {
    evidenceParts.push(
      Math.round(
        progMetrics.aspectMatch * 0.35 +
          progMetrics.silhouetteIoU * 0.4 +
          progMetrics.edgeCorrelation * 0.25
      )
    );
  }
  const internalConfidence = Math.round(
    evidenceParts.reduce((a, b) => a + b, 0) / Math.max(1, evidenceParts.length)
  );

  const combinedEvidence = Array.from(
    new Set([
      ...verification.matchingEvidence,
      ...candidate.initialEvidence,
      ...(specimenRender?.fontFamilyMeta
        ? [`Verified OpenType font metadata: ${specimenRender.fontFamilyMeta}`]
        : []),
    ])
  ).slice(0, 6);

  return {
    id: candidate.id,
    family: candidate.family,
    verifiedStyle: candidate.styleName,
    weight: candidate.weight,
    weightLabel: weightLabels[candidate.weight] || `Weight ${candidate.weight}`,
    isItalic: candidate.isItalic,
    foundryOrDesigner:
      specimenRender?.designerMeta?.trim() || candidate.foundryOrDesigner || 'Unverified',
    verificationStatus: 'Verified Exact Match',
    verificationEvidence: combinedEvidence,
    glyphComparisonNotes: verification.glyphComparisonNotes,
    internalConfidence,
    licenseName: candidate.licenseName,
    licenseClass: candidate.licenseClass,
    commercialUseAllowed: candidate.commercialUseAllowed,
    officialSourceName: candidate.sourceName,
    officialPageUrl: candidate.officialPageUrl,
    specimenPreview: {
      available: hasBrowserFont,
      ...(!hasBrowserFont
        ? {
            unavailableReason:
              'The actual font file cannot be loaded in the browser because it is a proprietary or unhosted font. Do not substitute another font.',
          }
        : {}),
      cssUrl: candidate.cssUrl,
      previewFontUrls: {
        ...(candidate.binaryUrls.woff2 ? { woff2: candidate.binaryUrls.woff2 } : {}),
        ...(candidate.binaryUrls.woff ? { woff: candidate.binaryUrls.woff } : {}),
        ...(candidate.binaryUrls.ttf ? { ttf: candidate.binaryUrls.ttf } : {}),
        ...(candidate.binaryUrls.otf ? { otf: candidate.binaryUrls.otf } : {}),
      },
      ...(specimenRender?.specimenDataUrl
        ? { renderedSpecimenDataUrl: specimenRender.specimenDataUrl }
        : {}),
    },
    download: {
      status: downloadStatus,
      message: downloadMessage,
      options: downloadOptions,
    },
    ...(progMetrics || specimenRender
      ? {
          metricsSummary: {
            ...(progMetrics || {}),
            ...(specimenRender ? { glyphCoverage: Math.round(specimenRender.glyphCoverage * 100) } : {}),
          },
        }
      : {}),
  };
}
