import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import sharp from 'sharp';
import JSZip from 'jszip';
import opentype from 'opentype.js';
import type {
  DetectedTextRegion,
  FontCropRect,
  FontDetectionResult,
  FontResearchResult,
  FontSourceHealth,
  GlyphAnatomyAnalysis,
  TextRegionRole,
  VectorShape,
} from '../../src/types/vector.ts';
import {
  classifyFontLicense,
  getFontsourceDetail,
  getLiveFontCatalog,
  isAllowedFontDownloadUrl,
  normalizeExactFamily,
  normalizeFamilyKey,
  pickBestVariantUrls,
  resolveCatalogEntryToCandidate,
  resolveGoogleFontsCss2Binaries,
  runGroundedFoundryResearch,
  slugifyFamily,
  type CatalogFontEntry,
  type GroundedWebFontLead,
  type NormalizedFontCandidate,
} from './fontConnectors.ts';
import {
  buildVerifiedExactMatchObject,
  computeProgrammaticGlyphMetrics,
  fetchFontBinaryCached,
  renderFontSpecimenFromBinary,
  verifyCommercialLeadsBatchWithGemini,
  verifySpecimenBatchWithGemini,
  type BinarySpecimenRender,
  type MultimodalVerificationOutcome,
} from './fontVerifier.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'Typography recognition service is not configured on the server. Please set GEMINI_API_KEY.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withGeminiRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /503|429|UNAVAILABLE|overloaded|high demand|RESOURCE_EXHAUSTED/i.test(
        msg
      );
      if (isTransient && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  const rawMsg = lastError instanceof Error ? lastError.message : String(lastError || '');
  if (/503|429|UNAVAILABLE|high demand|RESOURCE_EXHAUSTED/i.test(rawMsg)) {
    throw new Error(
      'The typography analysis service is temporarily busy. Please retry in a few seconds.'
    );
  }
  throw new Error(rawMsg || 'Typography analysis request failed.');
}

// ============================================================================
// High-Resolution Crop & Raster Metrics Extraction (Untouched Original Preserved)
// ============================================================================

async function prepareWorkingImage(
  originalBuffer: Buffer,
  crop?: FontCropRect | null
): Promise<{ workingPng: Buffer; width: number; height: number }> {
  let pipeline = sharp(originalBuffer, { limitInputPixels: 40_000_000 }).rotate();
  const origMeta = await pipeline.metadata();
  const origW = origMeta.width || 1;
  const origH = origMeta.height || 1;

  if (crop && crop.width > 4 && crop.height > 4) {
    const cx = Math.max(0, Math.min(origW - 4, Math.round(crop.x)));
    const cy = Math.max(0, Math.min(origH - 4, Math.round(crop.y)));
    const cw = Math.max(4, Math.min(origW - cx, Math.round(crop.width)));
    const ch = Math.max(4, Math.min(origH - cy, Math.round(crop.height)));
    pipeline = pipeline.extract({ left: cx, top: cy, width: cw, height: ch });
  }

  if (crop?.rotateDeg && Math.abs(crop.rotateDeg) > 0.5) {
    pipeline = pipeline.rotate(crop.rotateDeg, {
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  }

  const workingPng = await pipeline.png().toBuffer();
  const meta = await sharp(workingPng).metadata();
  return {
    workingPng,
    width: meta.width || origW,
    height: meta.height || origH,
  };
}

async function extractRegionCropHighRes(
  workingPngBuffer: Buffer,
  imgW: number,
  imgH: number,
  bbox: { ymin: number; xmin: number; ymax: number; xmax: number },
  rotationDeg: number
): Promise<{
  cropBuffer: Buffer;
  cropDataUrl: string;
  metrics: DetectedTextRegion['rasterMetrics'];
}> {
  const boxW = Math.max(10, ((bbox.xmax - bbox.xmin) / 1000) * imgW);
  const boxH = Math.max(10, ((bbox.ymax - bbox.ymin) / 1000) * imgH);
  const padX = Math.round(boxW * 0.08) + 10;
  const padY = Math.round(boxH * 0.14) + 8;

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
    pipeline = pipeline.rotate(-rotationDeg, {
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    });
  }

  // Keep high resolution lossless PNG crop for accurate letterform forensics
  const cropBuffer = await pipeline
    .resize(1400, 700, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

  const cropMeta = await sharp(cropBuffer).metadata();
  const cw = cropMeta.width || extractW;
  const ch = cropMeta.height || extractH;

  const { data: raw } = await sharp(cropBuffer).raw().toBuffer({ resolveWithObject: true });

  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgN = 0;
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

  let fgR = 0;
  let fgG = 0;
  let fgB = 0;
  let fgN = 0;
  for (let i = 0; i < raw.length; i += channels) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
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
    fgR = 15;
    fgG = 23;
    fgB = 42;
  }

  const lum = (r: number, g: number, b: number) =>
    0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
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

// ============================================================================
// PHASE A: Automatic Multi-Region Image Typography Detection & Segmentation
// ============================================================================

const VALID_ROLES: TextRegionRole[] = [
  'main_headline',
  'secondary_headline',
  'subheading',
  'body_text',
  'brand_name',
  'logo_lettering',
  'product_name',
  'caption',
  'decorative',
  'small_text',
  'display',
];

interface RawDetectedRegion {
  role: TextRegionRole;
  roleLabel: string;
  extractedText: string;
  bbox: { ymin: number; xmin: number; ymax: number; xmax: number };
  orientation: 'horizontal' | 'vertical' | 'angled' | 'curved';
  rotationDeg: number;
  estimatedFontSizePx: number;
  alignment: 'left' | 'center' | 'right' | 'justified' | 'mixed';
  lineSpacingEstimate: 'Tight' | 'Normal' | 'Loose';
  letterSpacingEstimate: 'Tight' | 'Normal' | 'Wide';
  weightEstimate: string;
  numericWeight: number;
  isItalic: boolean;
  widthClass: 'Condensed' | 'Normal' | 'Extended';
  styleClassifications: string[];
  primaryClassification: string;
  distortionsAndEffects: string[];
  imageQualityWarnings: string[];
  glyphAnalysis: GlyphAnatomyAnalysis;
}

export async function runFontRegionDetection(params: {
  imageBuffer: Buffer;
  uploadId: string;
  crop?: FontCropRect | null;
  customHint?: string;
  onProgress: (stage: string, stageIndex: number, progress: number) => void;
}): Promise<FontDetectionResult> {
  const startedAt = Date.now();
  const { imageBuffer, uploadId, crop, customHint, onProgress } = params;

  onProgress('Analyzing uploaded image...', 1, 16);

  const { workingPng, width: workW, height: workH } = await prepareWorkingImage(
    imageBuffer,
    crop
  );

  // Use high-res clean PNG/JPEG up to 2200px so even small body text & captions remain sharp
  const resizedPng = await sharp(workingPng)
    .resize(2200, 2200, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 6 })
    .toBuffer();

  const useJpeg = resizedPng.length > 4_500_000;
  const visionBuf = useJpeg
    ? await sharp(workingPng)
        .resize(2200, 2200, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
        .toBuffer()
    : resizedPng;

  onProgress('Detecting text regions...', 2, 42);

  const ai = getGeminiClient();
  const hintClause = customHint?.trim()
    ? `\nUser guidance note: "${customHint.trim()}".`
    : '';

  const detectionPrompt = `You are a professional forensic typography and OCR segmentation engine.
Inspect the ENTIRE uploaded image (${workW}x${workH} px) from left edge to right edge and top edge to bottom edge, and detect EVERY visually distinct text region and typographic style.

Segmentation Rules:
1. Detect ALL text across the image: main headlines, secondary headlines, subheadings, body text, brand names, logo lettering, product names, captions, decorative typography, small text, and large display text (up to 12 regions).
2. Read the COMPLETE verbatim text of every line from its very first character to its very last character—NEVER truncate phrases or cut off words mid-word! Preserve spelling, case, punctuation, symbols, numerals, and line breaks ("\\n").
3. Group consecutive lines that share the EXACT SAME typeface, weight, and style into ONE selectable region.
4. Split text that uses DIFFERENT font families, clearly distinct weights (e.g., bold vs light), or different typographic treatments — even within the same headline or lockup — into SEPARATE regions.
5. For each region extract:
   - Accurate bounding box (ymin, xmin, ymax, xmax in 0..1000 normalized coordinates relative to the full ${workW}x${workH} image) enclosing the ENTIRE text block from first letter to last letter without clipping edges.
   - Orientation (horizontal, vertical, angled, curved) and rotation angle in degrees (-180..180).
   - Estimated font size in image pixels, alignment, line spacing, letter spacing.
   - Weight estimate, numeric weight (100-900), italic status, width class (Condensed/Normal/Extended), style classifications.
   - Visible distortions/effects (drop shadows, outlines, neon glow, metallic texture, curved baseline, perspective skew, background noise) separated from the underlying letterform anatomy.
   - Image quality warnings if text is tiny (<16px cap height), heavily blurred, low contrast, or truncated.
   - Initial glyph anatomy breakdown (serifs, stroke contrast, terminals, apertures, counters, crossbars, distinctive glyphs).
${hintClause}
If no readable text exists in the image, return an empty regions array.`;

  const aiParsed = await withGeminiRetry(async () => {
    const res = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: useJpeg ? 'image/jpeg' : 'image/png',
              data: visionBuf.toString('base64'),
            },
          },
          { text: detectionPrompt },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
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
                  role: { type: Type.STRING, enum: VALID_ROLES },
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
                  orientation: {
                    type: Type.STRING,
                    enum: ['horizontal', 'vertical', 'angled', 'curved'],
                  },
                  rotationDeg: { type: Type.NUMBER },
                  estimatedFontSizePx: { type: Type.INTEGER },
                  alignment: {
                    type: Type.STRING,
                    enum: ['left', 'center', 'right', 'justified', 'mixed'],
                  },
                  lineSpacingEstimate: { type: Type.STRING, enum: ['Tight', 'Normal', 'Loose'] },
                  letterSpacingEstimate: { type: Type.STRING, enum: ['Tight', 'Normal', 'Wide'] },
                  weightEstimate: { type: Type.STRING },
                  numericWeight: { type: Type.INTEGER },
                  isItalic: { type: Type.BOOLEAN },
                  widthClass: { type: Type.STRING, enum: ['Condensed', 'Normal', 'Extended'] },
                  styleClassifications: { type: Type.ARRAY, items: { type: Type.STRING } },
                  primaryClassification: { type: Type.STRING },
                  distortionsAndEffects: { type: Type.ARRAY, items: { type: Type.STRING } },
                  imageQualityWarnings: { type: Type.ARRAY, items: { type: Type.STRING } },
                  glyphAnalysis: {
                    type: Type.OBJECT,
                    properties: {
                      serifConstruction: { type: Type.STRING },
                      strokeThickness: { type: Type.STRING },
                      strokeContrast: {
                        type: Type.STRING,
                        enum: ['Low', 'Medium', 'High', 'Variable'],
                      },
                      terminalShapes: { type: Type.STRING },
                      apertureSize: { type: Type.STRING },
                      counterAndBowlShape: { type: Type.STRING },
                      ascenderDescenderProportion: { type: Type.STRING },
                      crossbarAndArmAngles: { type: Type.STRING },
                      numeralAndPunctuationNotes: { type: Type.STRING },
                      distinctiveGlyphObservations: { type: Type.ARRAY, items: { type: Type.STRING } },
                      distortionsAndEffectsSeparated: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                    },
                    required: [
                      'serifConstruction',
                      'strokeThickness',
                      'strokeContrast',
                      'terminalShapes',
                      'apertureSize',
                      'counterAndBowlShape',
                      'ascenderDescenderProportion',
                      'crossbarAndArmAngles',
                      'numeralAndPunctuationNotes',
                      'distinctiveGlyphObservations',
                      'distortionsAndEffectsSeparated',
                    ],
                  },
                },
                required: [
                  'role',
                  'roleLabel',
                  'extractedText',
                  'bbox',
                  'orientation',
                  'rotationDeg',
                  'estimatedFontSizePx',
                  'alignment',
                  'lineSpacingEstimate',
                  'letterSpacingEstimate',
                  'weightEstimate',
                  'numericWeight',
                  'isItalic',
                  'widthClass',
                  'styleClassifications',
                  'primaryClassification',
                  'distortionsAndEffects',
                  'imageQualityWarnings',
                  'glyphAnalysis',
                ],
              },
            },
          },
          required: ['detectedRotationDeg', 'overallSummary', 'regions'],
        },
      },
    });
    return JSON.parse((res.text || '{}').trim()) as {
      detectedRotationDeg: number;
      overallSummary: string;
      regions: RawDetectedRegion[];
    };
  });

  onProgress('Extracting typography features...', 3, 74);

  const rawRegions = Array.isArray(aiParsed.regions)
    ? aiParsed.regions.filter((r) => r.extractedText?.trim()).slice(0, 12)
    : [];

  const regions: DetectedTextRegion[] = await Promise.all(
    rawRegions.map(async (raw, idx) => {
      const clampedBbox = {
        ymin: Math.max(0, Math.min(995, Number(raw.bbox?.ymin ?? 0))),
        xmin: Math.max(0, Math.min(995, Number(raw.bbox?.xmin ?? 0))),
        ymax: Math.max(5, Math.min(1000, Number(raw.bbox?.ymax ?? 100))),
        xmax: Math.max(5, Math.min(1000, Number(raw.bbox?.xmax ?? 100))),
      };
      if (clampedBbox.ymax <= clampedBbox.ymin) {
        clampedBbox.ymax = Math.min(1000, clampedBbox.ymin + 25);
      }
      if (clampedBbox.xmax <= clampedBbox.xmin) {
        clampedBbox.xmax = Math.min(1000, clampedBbox.xmin + 25);
      }

      const cropInfo = await extractRegionCropHighRes(
        workingPng,
        workW,
        workH,
        clampedBbox,
        Number(raw.rotationDeg || 0)
      );

      return {
        regionId: `region_${idx + 1}`,
        regionNumber: idx + 1,
        role: VALID_ROLES.includes(raw.role) ? raw.role : 'display',
        roleLabel: raw.roleLabel || `Region ${idx + 1}`,
        extractedText: raw.extractedText.trim(),
        bbox: clampedBbox,
        orientation: raw.orientation || 'horizontal',
        rotationDeg: Number(raw.rotationDeg || 0),
        estimatedFontSizePx: Math.max(6, Number(raw.estimatedFontSizePx || 24)),
        alignment: raw.alignment || 'left',
        lineSpacingEstimate: raw.lineSpacingEstimate || 'Normal',
        letterSpacingEstimate: raw.letterSpacingEstimate || 'Normal',
        appearance: {
          weightEstimate: raw.weightEstimate || 'Regular',
          numericWeight: Math.max(100, Math.min(900, Number(raw.numericWeight || 400))),
          isItalic: Boolean(raw.isItalic),
          widthClass: raw.widthClass || 'Normal',
          styleClassifications: Array.isArray(raw.styleClassifications)
            ? raw.styleClassifications
            : [raw.primaryClassification || 'Sans Serif'],
          primaryClassification: raw.primaryClassification || 'Sans Serif',
        },
        distortionsAndEffects: Array.isArray(raw.distortionsAndEffects)
          ? raw.distortionsAndEffects
          : [],
        imageQualityWarnings: Array.isArray(raw.imageQualityWarnings)
          ? raw.imageQualityWarnings
          : [],
        cropDataUrl: cropInfo.cropDataUrl,
        rasterMetrics: cropInfo.metrics,
        glyphAnalysis: raw.glyphAnalysis,
      };
    })
  );

  onProgress('Extracting typography features...', 3, 100);

  return {
    uploadId,
    imageWidth: workW,
    imageHeight: workH,
    detectedRotationDeg: Number(aiParsed.detectedRotationDeg || 0),
    overallSummary:
      aiParsed.overallSummary ||
      (regions.length > 0
        ? `Detected ${regions.length} distinct text region${regions.length === 1 ? '' : 's'}. Select any region on the image to inspect and identify its exact font.`
        : 'No readable typography detected in the image.'),
    regions,
    processingMs: Date.now() - startedAt,
  };
}

// ============================================================================
// PHASE B: Deep Single-Region Exact Original Font Research & Verification
// ============================================================================

interface FocusedForensicAnalysis {
  glyphAnalysis: GlyphAnatomyAnalysis;
  initialExactHypotheses: Array<{
    family: string;
    likelyFoundry: string;
    rationale: string;
  }>;
  isCustomHandLettering: boolean;
  isTooDegradedToVerify: boolean;
  degradationReason?: string;
}

async function analyzeSelectedRegionForensics(params: {
  cropPngBuffer: Buffer;
  searchedText: string;
  region: DetectedTextRegion;
}): Promise<FocusedForensicAnalysis> {
  const ai = getGeminiClient();
  const { cropPngBuffer, searchedText, region } = params;

  const prompt = `You are a master forensic typographer analyzing ONLY this high-resolution cropped text region.
Target Text: "${searchedText}"
Role: ${region.roleLabel}
Estimated Classification: ${region.appearance.primaryClassification} (${region.appearance.weightEstimate}, ${region.appearance.widthClass}, Italic: ${region.appearance.isItalic ? 'Yes' : 'No'})

Perform razor-sharp letterform forensics:
1. Explicitly separate visual effects/distortions (shadows, outlines, gradients, warp, textures, lighting, perspective blur) from the true underlying letterforms.
2. Inspect every diagnostic glyph visible: A, G, R, S, M, Q, K, W, a, g, e, t, r, s, &, numerals, punctuation.
   - Serif construction (unbracketed hairline, bracketed old-style, heavy rectangular slab, triangular, none)
   - Stroke thickness & contrast (Low/Medium/High/Variable)
   - Terminal shapes (ball, teardrop, sheared diagonal, vertical, horizontal, rounded)
   - Aperture size, counter & bowl shapes, ascender/descender proportions, crossbar & arm angles
3. Provide up to 8 concrete hypotheses for the EXACT original typeface family (NOT "visually similar" alternatives! Include exact candidates across Google Fonts, Fontsource, Font Squirrel, Adobe Fonts, Monotype, and independent foundries).
4. Mark isCustomHandLettering = true ONLY if this is unmistakably bespoke calligraphic/hand-drawn logo artwork that does not correspond to a digital font.
5. Mark isTooDegradedToVerify = true ONLY if the crop is genuinely illegible/severely pixelated.`;

  return withGeminiRetry(async () => {
    const res = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/png', data: cropPngBuffer.toString('base64') } },
          { text: prompt },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            glyphAnalysis: {
              type: Type.OBJECT,
              properties: {
                serifConstruction: { type: Type.STRING },
                strokeThickness: { type: Type.STRING },
                strokeContrast: {
                  type: Type.STRING,
                  enum: ['Low', 'Medium', 'High', 'Variable'],
                },
                terminalShapes: { type: Type.STRING },
                apertureSize: { type: Type.STRING },
                counterAndBowlShape: { type: Type.STRING },
                ascenderDescenderProportion: { type: Type.STRING },
                crossbarAndArmAngles: { type: Type.STRING },
                numeralAndPunctuationNotes: { type: Type.STRING },
                distinctiveGlyphObservations: { type: Type.ARRAY, items: { type: Type.STRING } },
                distortionsAndEffectsSeparated: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: [
                'serifConstruction',
                'strokeThickness',
                'strokeContrast',
                'terminalShapes',
                'apertureSize',
                'counterAndBowlShape',
                'ascenderDescenderProportion',
                'crossbarAndArmAngles',
                'numeralAndPunctuationNotes',
                'distinctiveGlyphObservations',
                'distortionsAndEffectsSeparated',
              ],
            },
            initialExactHypotheses: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  family: { type: Type.STRING },
                  likelyFoundry: { type: Type.STRING },
                  rationale: { type: Type.STRING },
                },
                required: ['family', 'likelyFoundry', 'rationale'],
              },
            },
            isCustomHandLettering: { type: Type.BOOLEAN },
            isTooDegradedToVerify: { type: Type.BOOLEAN },
            degradationReason: { type: Type.STRING },
          },
          required: [
            'glyphAnalysis',
            'initialExactHypotheses',
            'isCustomHandLettering',
            'isTooDegradedToVerify',
          ],
        },
      },
    });
    return JSON.parse((res.text || '{}').trim()) as FocusedForensicAnalysis;
  });
}

function lookupCatalogEntriesForFamily(
  familyName: string,
  catalog: Awaited<ReturnType<typeof getLiveFontCatalog>>
): CatalogFontEntry[] {
  const norm = normalizeExactFamily(familyName);
  const exact = catalog.byNormFamily.get(norm);
  if (exact) return [exact];

  const loose = normalizeFamilyKey(familyName);
  if (loose.length >= 3) {
    const looseMatches = catalog.byLooseKey.get(loose) || [];
    if (looseMatches.length > 0) return looseMatches.slice(0, 2);
  }
  return [];
}

function buildLeadToCandidate(
  lead: GroundedWebFontLead,
  desiredWeight: number,
  desiredItalic: boolean
): NormalizedFontCandidate {
  const lic = classifyFontLicense(
    lead.licenseDetails,
    lead.licenseType === 'free-commercial'
  );
  const finalLicenseClass =
    lead.licenseType === 'paid-commercial'
      ? 'Paid Font'
      : lead.licenseType === 'free-personal'
      ? 'Free for Personal Use Only'
      : lead.licenseType === 'free-commercial'
      ? 'Free for Personal and Commercial Use'
      : lic.licenseClass;

  return {
    id: slugifyFamily(lead.family),
    family: lead.family,
    styleName: lead.styleName || `${desiredWeight}${desiredItalic ? ' Italic' : ''}`,
    weight: lead.weight || desiredWeight || 400,
    isItalic: Boolean(lead.isItalic ?? desiredItalic),
    foundryOrDesigner: lead.foundryOrDesigner,
    sourceName: lead.officialSourceName,
    sourceReliability: /myfonts|fontspring|creativemarket|youworkforthem|envato/i.test(
      lead.officialSourceName
    )
      ? 'marketplace-web'
      : 'official-foundry-web',
    officialPageUrl: lead.officialPageUrl,
    licenseName: lead.licenseDetails || lic.licenseName,
    licenseClass: finalLicenseClass,
    commercialUseAllowed:
      lead.licenseType === 'free-commercial'
        ? true
        : lead.licenseType === 'free-personal' || lead.licenseType === 'paid-commercial'
        ? false
        : lic.commercialUseAllowed,
    weights: [lead.weight || desiredWeight || 400],
    styles: [lead.isItalic ? 'italic' : 'normal'],
    subsets: ['latin'],
    binaryUrls: {},
    cssUrl: '',
    inOpenCatalog: false,
    initialEvidence: lead.diagnosticGlyphMatches,
  };
}

export async function runExactFontResearch(params: {
  imageBuffer: Buffer;
  uploadId: string;
  region: DetectedTextRegion;
  crop?: FontCropRect | null;
  extractedTextOverride?: string;
  onProgress: (stage: string, stageIndex: number, progress: number) => void;
}): Promise<FontResearchResult> {
  const startedAt = Date.now();
  const { imageBuffer, uploadId, region, crop, extractedTextOverride, onProgress } = params;
  const searchedText = (extractedTextOverride?.trim() || region.extractedText).trim();

  // Stage 1: Re-extract lossless high-res crop of ONLY the selected region
  onProgress('Analyzing selected letterforms...', 1, 14);
  const { workingPng, width: workW, height: workH } = await prepareWorkingImage(
    imageBuffer,
    crop
  );
  const { cropBuffer } = await extractRegionCropHighRes(
    workingPng,
    workW,
    workH,
    region.bbox,
    region.rotationDeg || 0
  );

  const forensics = await analyzeSelectedRegionForensics({
    cropPngBuffer: cropBuffer,
    searchedText,
    region,
  });

  // Stage 2 & 3: Search open-source catalogs & grounded foundry research concurrently
  onProgress('Searching font databases...', 2, 32);
  const initialHypNames = (forensics.initialExactHypotheses || [])
    .map((h) => h.family.trim())
    .filter(Boolean);

  onProgress('Investigating official foundries...', 3, 48);
  const [catalog, groundedOutput] = await Promise.all([
    getLiveFontCatalog(),
    runGroundedFoundryResearch({
      cropBase64: cropBuffer.toString('base64'),
      extractedText: searchedText,
      glyphAnalysis: forensics.glyphAnalysis,
      styleClassifications: region.appearance.styleClassifications,
      weightEstimate: region.appearance.weightEstimate,
      numericWeight: region.appearance.numericWeight,
      isItalic: region.appearance.isItalic,
      widthClass: region.appearance.widthClass,
      initialHypotheses: initialHypNames,
    }),
  ]);

  const sourcesInvestigated: FontSourceHealth[] = [
    ...catalog.health,
    groundedOutput.health,
  ];

  // If image is too degraded or custom non-font artwork and no grounded web leads found
  if (
    forensics.isTooDegradedToVerify &&
    groundedOutput.leads.length === 0 &&
    initialHypNames.length === 0
  ) {
    onProgress('Preparing verified result...', 6, 100);
    return {
      uploadId,
      regionId: region.regionId,
      searchedText,
      outcome: 'not_found',
      verifiedMatch: null,
      notFoundHeading: 'Exact font not found',
      notFoundMessage:
        'We could not verify the original font from the available sources. Try uploading a higher-resolution image or selecting a clearer text region.',
      researchSummary:
        forensics.degradationReason ||
        'The selected text region is too low resolution or degraded to verify its exact font.',
      glyphAnalysis: forensics.glyphAnalysis,
      sourcesInvestigated,
      candidatesEvaluatedCount: 0,
      processingMs: Date.now() - startedAt,
    };
  }

  // Gather unique candidate names from initial hypotheses + grounded search leads
  const candidateReasonMap = new Map<string, string[]>();
  const registerReason = (family: string, reason: string) => {
    const key = normalizeExactFamily(family);
    const list = candidateReasonMap.get(key) || [];
    if (reason) list.push(reason);
    candidateReasonMap.set(key, list);
  };

  for (const h of forensics.initialExactHypotheses || []) {
    registerReason(h.family, h.rationale);
  }
  for (const l of groundedOutput.leads) {
    registerReason(l.family, l.matchRationale);
    for (const d of l.diagnosticGlyphMatches) registerReason(l.family, d);
  }

  // Partition into:
  // A) Catalog-backed candidates (can download genuine .ttf/.otf/.woff2 and render real OpenType specimens)
  // B) Commercial / foundry leads not in Google Fonts or Fontsource
  const catalogEntriesMap = new Map<string, CatalogFontEntry>();
  const commercialLeadsMap = new Map<string, GroundedWebFontLead>();

  for (const h of forensics.initialExactHypotheses || []) {
    const matchedEntries = lookupCatalogEntriesForFamily(h.family, catalog);
    if (matchedEntries.length > 0) {
      for (const entry of matchedEntries) {
        catalogEntriesMap.set(entry.normalizedFamily, entry);
      }
    } else if (h.family.trim()) {
      const norm = normalizeExactFamily(h.family);
      if (norm && !commercialLeadsMap.has(norm)) {
        commercialLeadsMap.set(norm, {
          family: h.family.trim(),
          styleName: `${region.appearance.weightEstimate}${region.appearance.isItalic ? ' Italic' : ''}`,
          weight: region.appearance.numericWeight || 400,
          isItalic: Boolean(region.appearance.isItalic),
          foundryOrDesigner: h.likelyFoundry || 'Commercial Foundry',
          officialSourceName: h.likelyFoundry || 'Foundry Catalogue',
          officialPageUrl: null,
          licenseType: 'unknown',
          licenseDetails: 'Commercial / Foundry License',
          matchRationale: h.rationale,
          diagnosticGlyphMatches: [],
          groundingVerified: false,
        });
      }
    }
  }

  for (const lead of groundedOutput.leads) {
    const matchedEntries = lookupCatalogEntriesForFamily(lead.family, catalog);
    if (matchedEntries.length > 0) {
      for (const entry of matchedEntries) {
        catalogEntriesMap.set(entry.normalizedFamily, entry);
      }
    } else {
      const norm = normalizeExactFamily(lead.family);
      if (norm) {
        // Grounded lead upgrades ungrounded initial commercial hypothesis with real source URL & details
        commercialLeadsMap.set(norm, lead);
      }
    }
  }

  // Stage 4: Acquire binaries, render OpenType specimens, compute metrics, and batch-verify
  onProgress('Comparing font specimens...', 4, 72);

  interface EvaluatedCandidate {
    candidate: NormalizedFontCandidate;
    verification: MultimodalVerificationOutcome;
    specimenRender: BinarySpecimenRender | null;
    progMetrics: { silhouetteIoU: number; edgeCorrelation: number; aspectMatch: number } | null;
    inFontsource: boolean;
    hasBinarySpecimen: boolean;
  }

  const desiredWeight = region.appearance.numericWeight || 400;
  const desiredItalic = Boolean(region.appearance.isItalic);

  // 4A. Fetch real binaries & render specimens for catalog candidates in parallel (zero Gemini calls yet)
  interface PreparedCatalogSpecimen {
    entry: CatalogFontEntry;
    candidate: NormalizedFontCandidate;
    specimenRender: BinarySpecimenRender | null;
    progMetrics: { silhouetteIoU: number; edgeCorrelation: number; aspectMatch: number } | null;
  }

  const catalogList = Array.from(catalogEntriesMap.values()).slice(0, 6);
  const preparedCatalog: PreparedCatalogSpecimen[] = (
    await Promise.all(
      catalogList.map(async (entry): Promise<PreparedCatalogSpecimen | null> => {
        try {
          const detail = entry.inFontsource ? await getFontsourceDetail(entry.id) : null;
          const css2Binaries =
            entry.inGoogleFonts || !detail
              ? await resolveGoogleFontsCss2Binaries(entry.family, desiredWeight, desiredItalic)
              : undefined;

          const candidate = resolveCatalogEntryToCandidate(
            entry,
            desiredWeight,
            desiredItalic,
            detail,
            css2Binaries,
            candidateReasonMap.get(entry.normalizedFamily) || []
          );

          const outlineUrl =
            candidate.binaryUrls.ttf || candidate.binaryUrls.otf || css2Binaries?.ttf;
          const binaryBuf = outlineUrl ? await fetchFontBinaryCached(outlineUrl) : null;
          const specimenRender = binaryBuf
            ? await renderFontSpecimenFromBinary(binaryBuf, searchedText)
            : null;
          const progMetrics =
            specimenRender && specimenRender.glyphCoverage >= 0.5
              ? await computeProgrammaticGlyphMetrics(cropBuffer, specimenRender.specimenPng)
              : null;

          return {
            entry,
            candidate,
            specimenRender: specimenRender && specimenRender.glyphCoverage >= 0.5 ? specimenRender : null,
            progMetrics,
          };
        } catch {
          return null;
        }
      })
    )
  ).filter((x): x is PreparedCatalogSpecimen => x !== null);

  const binarySpecimens = preparedCatalog.filter((p) => p.specimenRender !== null);
  const nonBinaryCatalogLeads: Array<{ candidate: NormalizedFontCandidate; lead: GroundedWebFontLead; inFontsource: boolean }> =
    preparedCatalog
      .filter((p) => p.specimenRender === null)
      .map((p) => ({
        candidate: p.candidate,
        inFontsource: p.entry.inFontsource,
        lead: {
          family: p.candidate.family,
          styleName: p.candidate.styleName,
          weight: p.candidate.weight,
          isItalic: p.candidate.isItalic,
          foundryOrDesigner: p.candidate.foundryOrDesigner,
          officialSourceName: p.candidate.sourceName,
          officialPageUrl: p.candidate.officialPageUrl,
          licenseType: 'free-commercial',
          licenseDetails: p.candidate.licenseName,
          matchRationale: (p.candidate.initialEvidence || []).join('; '),
          diagnosticGlyphMatches: forensics.glyphAnalysis.distinctiveGlyphObservations,
          groundingVerified: true,
        },
      }));

  const commercialList = Array.from(commercialLeadsMap.values()).slice(0, 4);
  const allTextOnlyLeads = [
    ...nonBinaryCatalogLeads.map((x) => x.lead),
    ...commercialList,
  ].slice(0, 5);

  // 4B. Batch verify binary specimens in ONE multimodal call + commercial leads in ONE call
  const [binaryVerificationMap, commercialVerificationMap] = await Promise.all([
    binarySpecimens.length > 0
      ? verifySpecimenBatchWithGemini({
          cropPngBuffer: cropBuffer,
          candidates: binarySpecimens.map((p) => ({
            family: p.candidate.family,
            style: p.candidate.styleName,
            specimenPngBuffer: p.specimenRender!.specimenPng,
            progMetrics: p.progMetrics,
          })),
          extractedText: searchedText,
          glyphAnalysis: forensics.glyphAnalysis,
        })
      : Promise.resolve(new Map<string, MultimodalVerificationOutcome>()),
    allTextOnlyLeads.length > 0
      ? verifyCommercialLeadsBatchWithGemini({
          cropPngBuffer: cropBuffer,
          leads: allTextOnlyLeads,
          extractedText: searchedText,
          glyphAnalysis: forensics.glyphAnalysis,
        })
      : Promise.resolve(new Map<string, MultimodalVerificationOutcome>()),
  ]);

  const evaluated: EvaluatedCandidate[] = [];

  for (const p of binarySpecimens) {
    const verification = binaryVerificationMap.get(p.candidate.family.toLowerCase());
    if (verification) {
      evaluated.push({
        candidate: p.candidate,
        verification,
        specimenRender: p.specimenRender,
        progMetrics: p.progMetrics,
        inFontsource: p.entry.inFontsource,
        hasBinarySpecimen: true,
      });
    }
  }

  for (const item of nonBinaryCatalogLeads) {
    const verification = commercialVerificationMap.get(item.candidate.family.toLowerCase());
    if (verification) {
      evaluated.push({
        candidate: item.candidate,
        verification,
        specimenRender: null,
        progMetrics: null,
        inFontsource: item.inFontsource,
        hasBinarySpecimen: false,
      });
    }
  }

  for (const lead of commercialList) {
    const verification = commercialVerificationMap.get(lead.family.toLowerCase());
    if (verification) {
      evaluated.push({
        candidate: buildLeadToCandidate(lead, desiredWeight, desiredItalic),
        verification,
        specimenRender: null,
        progMetrics: null,
        inFontsource: false,
        hasBinarySpecimen: false,
      });
    }
  }

  // Stage 5: Strict Exact-Match Verification Gate (NEVER accept similar fonts or contradicted candidates)
  onProgress('Verifying exact font identity...', 5, 88);

  const verifiedPassList = evaluated
    .filter(
      (item) =>
        item.verification.isExactMatch === true &&
        item.verification.contradictionFound === false &&
        item.verification.confidence >= 78
    )
    .sort((a, b) => {
      // Strongly prefer binary-rendered verified matches if both pass cleanly
      if (a.hasBinarySpecimen !== b.hasBinarySpecimen) {
        if (a.hasBinarySpecimen && a.verification.confidence >= 80) return -1;
        if (b.hasBinarySpecimen && b.verification.confidence >= 80) return 1;
      }
      const progScore = (item: EvaluatedCandidate) =>
        item.progMetrics
          ? item.progMetrics.aspectMatch * 0.35 +
            item.progMetrics.silhouetteIoU * 0.4 +
            item.progMetrics.edgeCorrelation * 0.25
          : 0;
      const scoreA = a.verification.confidence * 0.7 + progScore(a) * 0.3;
      const scoreB = b.verification.confidence * 0.7 + progScore(b) * 0.3;
      return scoreB - scoreA;
    });

  // Stage 6: Prepare final verified result or strict "Exact font not found"
  onProgress('Preparing verified result...', 6, 100);

  if (verifiedPassList.length === 0) {
    return {
      uploadId,
      regionId: region.regionId,
      searchedText,
      outcome: 'not_found',
      verifiedMatch: null,
      notFoundHeading: 'Exact font not found',
      notFoundMessage:
        'We could not verify the original font from the available sources. Try uploading a higher-resolution image or selecting a clearer text region.',
      researchSummary:
        forensics.isCustomHandLettering
          ? 'This lettering appears to be bespoke/custom artwork rather than a verified digital typeface, or the original font could not be confirmed without contradictions.'
          : 'Evaluated candidate fonts across catalogs and official foundries, but none passed exact glyph verification without contradictions.',
      glyphAnalysis: forensics.glyphAnalysis,
      sourcesInvestigated,
      candidatesEvaluatedCount: evaluated.length,
      processingMs: Date.now() - startedAt,
    };
  }

  const winner = verifiedPassList[0];
  const verifiedMatch = buildVerifiedExactMatchObject({
    candidate: winner.candidate,
    verification: winner.verification,
    specimenRender: winner.specimenRender,
    progMetrics: winner.progMetrics,
    inFontsource: winner.inFontsource,
  });

  return {
    uploadId,
    regionId: region.regionId,
    searchedText,
    outcome: 'verified_exact',
    verifiedMatch,
    researchSummary:
      winner.verification.glyphComparisonNotes ||
      `Verified exact typeface "${verifiedMatch.family}" (${verifiedMatch.verifiedStyle}) across diagnostic letterforms.`,
    glyphAnalysis: forensics.glyphAnalysis,
    sourcesInvestigated,
    candidatesEvaluatedCount: evaluated.length,
    processingMs: Date.now() - startedAt,
  };
}

// ============================================================================
// Verified Font File Download & ZIP Packager (Fontsource + Google Fonts CSS2)
// ============================================================================

export async function buildVerifiedFontDownload(params: {
  fontId: string;
  family?: string;
  format: 'zip' | 'otf' | 'ttf' | 'woff2' | 'woff';
  weight?: number;
  style?: string;
}): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const { fontId, family, format, weight = 400, style = 'normal' } = params;
  const isItalic = style === 'italic';
  const detail = await getFontsourceDetail(fontId);

  const safeBase = (detail?.id || fontId).replace(/[^a-z0-9_-]/gi, '_');

  if (format === 'otf' || format === 'ttf' || format === 'woff2' || format === 'woff') {
    const variant = pickBestVariantUrls(detail, weight, isItalic);
    let targetUrl = variant[format];

    if (!targetUrl && (format === 'ttf' || format === 'woff2')) {
      const css2 = await resolveGoogleFontsCss2Binaries(
        detail?.family || family || fontId.replace(/-/g, ' '),
        weight,
        isItalic
      );
      targetUrl = css2[format];
    }

    if (!targetUrl || !isAllowedFontDownloadUrl(targetUrl)) {
      throw new Error(
        `${format.toUpperCase()} binary is unavailable for ${detail?.family || family || fontId}.`
      );
    }

    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': 'MakeVectorizer-FontDownloader/2.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Upstream CDN returned HTTP ${res.status}.`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeMap = {
      otf: 'font/otf',
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

  // Genuine ZIP bundle
  const zip = new JSZip();
  let filesAdded = 0;

  if (detail && detail.variants) {
    const variant = pickBestVariantUrls(detail, weight, isItalic);
    const licInfo = classifyFontLicense(detail.license, true);
    zip.file(
      'LICENSE_INFO.txt',
      [
        `Font Family: ${detail.family}`,
        `Font ID: ${detail.id}`,
        `Version: ${detail.version || 'latest'}`,
        `Verified License: ${licInfo.licenseName} (${licInfo.licenseClass})`,
        `Official Source: ${detail.source || `https://fontsource.org/fonts/${detail.id}`}`,
        `Downloaded via MakeVectorizer`,
      ].join('\n')
    );

    const candidateWeights = Array.from(
      new Set([variant.resolvedWeight, 400, 700].filter((w) => detail.variants?.[String(w)]))
    );

    for (const w of candidateWeights) {
      for (const st of Object.keys(detail.variants[String(w)] || {})) {
        const subMap = detail.variants[String(w)]?.[st];
        const subKey =
          detail.defSubset && subMap?.[detail.defSubset]
            ? detail.defSubset
            : subMap?.latin
            ? 'latin'
            : Object.keys(subMap || {})[0];
        const urls = subKey ? subMap?.[subKey]?.url : undefined;
        for (const ext of ['otf', 'ttf', 'woff2'] as const) {
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
            // ignore secondary weight fetch failure
          }
        }
      }
    }
  } else {
    // Fallback to Google Fonts CSS2 binaries for verified Google Fonts
    const fam = family || fontId.replace(/-/g, ' ');
    const css2 = await resolveGoogleFontsCss2Binaries(fam, weight, isItalic);
    zip.file(
      'LICENSE_INFO.txt',
      [
        `Font Family: ${fam}`,
        `Official Source: https://fonts.google.com/specimen/${encodeURIComponent(fam.replace(/\s+/g, '+'))}`,
        `Downloaded via MakeVectorizer`,
      ].join('\n')
    );
    for (const ext of ['ttf', 'woff2'] as const) {
      const u = css2[ext];
      if (!u || !isAllowedFontDownloadUrl(u)) continue;
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        zip.file(`${safeBase}-${weight}-${style}.${ext}`, Buffer.from(await r.arrayBuffer()));
        filesAdded++;
      }
    }
  }

  if (filesAdded === 0) {
    throw new Error(
      `No downloadable font binaries could be retrieved for ${detail?.family || family || fontId}.`
    );
  }

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer: zipBuf,
    mimeType: 'application/zip',
    filename: `${safeBase}-font-bundle.zip`,
  };
}

// ============================================================================
// Genuine OpenType.js Text-to-Vector Outline Converter
// ============================================================================

export async function convertFontTextToVectorShapes(params: {
  fontId: string;
  family?: string;
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
    family,
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
  const variant = pickBestVariantUrls(detail, weight, isItalic);
  let outlineUrl = variant.ttf || variant.otf;

  if (!outlineUrl) {
    const css2 = await resolveGoogleFontsCss2Binaries(
      detail?.family || family || fontId.replace(/-/g, ' '),
      weight,
      isItalic
    );
    outlineUrl = css2.ttf;
  }

  if (!outlineUrl) {
    throw new Error(
      `TrueType/OpenType outline file unavailable for ${detail?.family || family || fontId}.`
    );
  }

  const ttfBuf = await fetchFontBinaryCached(outlineUrl);
  if (!ttfBuf) {
    throw new Error(
      `Failed to fetch font file for ${detail?.family || family || fontId}.`
    );
  }

  const ab = ttfBuf.buffer.slice(ttfBuf.byteOffset, ttfBuf.byteOffset + ttfBuf.byteLength);
  const font = opentype.parse(ab);
  const p = font.getPath(cleanText, x, y, fontSize);
  const d = p.toPathData(2);
  const box = p.getBoundingBox();

  if (!d) {
    throw new Error('Font outline conversion produced an empty path.');
  }

  const displayFamily = detail?.family || family || fontId;
  return {
    id: `font_outline_${Date.now().toString(36)}`,
    groupId: `layer_font_${slugifyFamily(displayFamily)}`,
    layerName: `${displayFamily} Outline ("${cleanText.slice(0, 24)}")`,
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
