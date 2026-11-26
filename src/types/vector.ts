export type VectorPreset =
  | 'logo'
  | 'illustration'
  | 'photography'
  | 'sketch'
  | 'screenprint'
  | 'cnc'
  | 'typography';

export type DetailLevel = 'low' | 'medium' | 'high' | 'maximum';

export type ColorCountOption = 'auto' | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 'unlimited';

export type BackgroundHandling = 'keep' | 'remove' | 'white' | 'transparent';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  aspect?: string;
}

export interface PreprocessingOptions {
  crop?: CropRect | null;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  brightness: number; // 0.5 to 1.5, default 1
  contrast: number; // 0.5 to 1.5, default 1
  saturation: number; // 0 to 2, default 1
  exposure: number; // -1 to 1, default 0
  grayscale: boolean;
  threshold: number | null; // 0-255 or null
  blur: number; // 0 to 5
  sharpen: number; // 0 to 5
  noiseRemoval: number; // 0 to 5
}

export type VectorEngineMode = 'auto' | 'potrace' | 'vtracer' | 'vtracer-polygon';

export interface VectorizeOptions {
  preset: VectorPreset;
  engine?: VectorEngineMode;
  detailLevel: DetailLevel;
  colorCount: ColorCountOption;
  curveSmoothing: number; // 0 to 100
  cornerPrecision: number; // 0 to 100
  pathSimplification: number; // 0 to 100
  noiseReduction: number; // 0 to 100
  backgroundHandling: BackgroundHandling;
  preserveTransparency: boolean;
  shapeComplexity: number; // 0 to 100
  detectPrimitives: boolean;
  preprocessing?: PreprocessingOptions;
}

export interface VectorShape {
  id: string;
  groupId?: string;
  layerName: string;
  type: 'path' | 'circle' | 'ellipse' | 'rect' | 'text';
  pathData: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  nodeCount: number;
  tx?: number;
  ty?: number;
  textContent?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  letterSpacing?: number;
}

export interface PaletteSwatch {
  hex: string;
  rgb: [number, number, number];
  areaPercent: number;
  shapeCount: number;
}

export interface VectorDocument {
  width: number;
  height: number;
  viewBox: string;
  backgroundColor: string | null;
  shapes: VectorShape[];
  palette: PaletteSwatch[];
  metadata: {
    preset: VectorPreset;
    engine: string;
    processingMs: number;
    totalShapes: number;
    totalNodes: number;
  };
}

export type UpscaleFactor = 1 | 2 | 3 | 4;
export type UpscalePreset = 'standard' | 'high-quality' | 'maximum-detail';

export interface UpscaleOptions {
  scaleFactor: UpscaleFactor;
  preset: UpscalePreset;
  detailRecovery: number; // 0 to 100
  sharpness: number; // 0 to 100
  noiseReduction: number; // 0 to 100
  textureEnhancement: number; // 0 to 100
  edgeEnhancement: number; // 0 to 100
  faceEnhancement: boolean;
  artifactRemoval: number; // 0 to 100
  colorRestoration: number; // 0 to 100
  outputFormat: 'png' | 'jpg' | 'webp';
}

export interface BackgroundRemoveOptions {
  mode: 'auto' | 'manual';
  bgColor: 'transparent' | 'white' | 'black' | string;
  tolerance: number; // 5 to 80
  edgeRefinement: number; // 0 to 100
  feather: number; // 0 to 20
  preserveHairDetail: boolean;
  fgSeeds?: Array<{ x: number; y: number }>;
  bgSeeds?: Array<{ x: number; y: number }>;
}

export type ExportFormat = 'svg' | 'pdf' | 'eps' | 'dxf' | 'png';

export interface ExportOptions {
  format: ExportFormat;
  svgVersion?: '1.0' | '1.1';
  svgSizeMode?: 'scalable' | 'fixed';
  preserveLayers?: boolean;
  illustratorCompat?: boolean;
  pdfPageSize?: 'fit' | 'a4' | 'letter' | 'custom';
  pdfWidth?: number;
  pdfHeight?: number;
  dxfMode?: 'lines-only' | 'lines-arcs' | 'lines-arcs-splines';
  pngScale?: 1 | 2 | 3 | 4;
  pngTransparent?: boolean;
  pngBackgroundColor?: string;
  pngWidth?: number;
  pngHeight?: number;
  pngDpi?: number;
}

export interface UploadMetadata {
  uploadId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  hasAlpha: boolean;
  previewDataUrl: string;
  localPreviewUrl?: string;
  dominantColors: string[];
  serverless?: boolean;
}

export interface ProcessingJobState {
  jobId: string;
  jobType: 'vectorize' | 'upscale' | 'remove-background' | 'font-finder' | 'font-detect' | 'font-research';
  status: 'waiting' | 'processing' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  stageIndex: number;
  totalStages: number;
  progress: number;
  isEstimate: boolean;
  engine: string;
  error?: string;
  result?: {
    vectorDocument?: VectorDocument;
    svgContent?: string;
    imageDataUrl?: string;
    uploadId?: string;
    originalWidth?: number;
    originalHeight?: number;
    outputWidth?: number;
    outputHeight?: number;
    byteSize?: number;
    mimeType?: string;
    processingMs?: number;
    fontFinderResult?: FontFinderResult;
    fontDetectionResult?: FontDetectionResult;
    fontResearchResult?: FontResearchResult;
  };
}

export interface BatchQueueItem {
  id: string;
  uploadId: string;
  filename: string;
  previewDataUrl: string;
  width: number;
  height: number;
  mode: 'vectorize' | 'upscale' | 'remove-background';
  status: 'waiting' | 'processing' | 'completed' | 'failed';
  progress: number;
  stage: string;
  jobId?: string;
  error?: string;
  vectorOptions?: VectorizeOptions;
  upscaleOptions?: UpscaleOptions;
  bgOptions?: BackgroundRemoveOptions;
  resultSvg?: string;
  resultImageDataUrl?: string;
  resultVectorDoc?: VectorDocument;
}

export const DEFAULT_PREPROCESSING: PreprocessingOptions = {
  crop: null,
  rotate: 0,
  flipH: false,
  flipV: false,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  exposure: 0,
  grayscale: false,
  threshold: null,
  blur: 0,
  sharpen: 0,
  noiseRemoval: 0,
};

export const PRESET_DEFAULTS: Record<VectorPreset, Partial<VectorizeOptions>> = {
  logo: {
    detailLevel: 'high',
    colorCount: 'auto',
    curveSmoothing: 70,
    cornerPrecision: 85,
    pathSimplification: 45,
    noiseReduction: 40,
    detectPrimitives: true,
    shapeComplexity: 60,
  },
  illustration: {
    detailLevel: 'high',
    colorCount: 32,
    curveSmoothing: 80,
    cornerPrecision: 65,
    pathSimplification: 30,
    noiseReduction: 25,
    detectPrimitives: false,
    shapeComplexity: 80,
  },
  photography: {
    detailLevel: 'maximum',
    colorCount: 64,
    curveSmoothing: 65,
    cornerPrecision: 45,
    pathSimplification: 35,
    noiseReduction: 45,
    detectPrimitives: false,
    shapeComplexity: 90,
  },
  sketch: {
    detailLevel: 'high',
    colorCount: 2,
    curveSmoothing: 65,
    cornerPrecision: 75,
    pathSimplification: 35,
    noiseReduction: 50,
    detectPrimitives: false,
    shapeComplexity: 65,
  },
  screenprint: {
    detailLevel: 'medium',
    colorCount: 8,
    curveSmoothing: 75,
    cornerPrecision: 80,
    pathSimplification: 50,
    noiseReduction: 55,
    detectPrimitives: true,
    shapeComplexity: 50,
  },
  cnc: {
    detailLevel: 'high',
    colorCount: 2,
    curveSmoothing: 40,
    cornerPrecision: 95,
    pathSimplification: 55,
    noiseReduction: 65,
    detectPrimitives: true,
    shapeComplexity: 45,
  },
  typography: {
    detailLevel: 'maximum',
    colorCount: 4,
    curveSmoothing: 55,
    cornerPrecision: 95,
    pathSimplification: 25,
    noiseReduction: 35,
    detectPrimitives: false,
    shapeComplexity: 75,
  },
};

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  preset: 'logo',
  engine: 'auto',
  detailLevel: 'high',
  colorCount: 'auto',
  curveSmoothing: 70,
  cornerPrecision: 85,
  pathSimplification: 45,
  noiseReduction: 40,
  backgroundHandling: 'keep',
  preserveTransparency: true,
  shapeComplexity: 60,
  detectPrimitives: true,
  preprocessing: DEFAULT_PREPROCESSING,
};

export const DEFAULT_UPSCALE_OPTIONS: UpscaleOptions = {
  scaleFactor: 4,
  preset: 'high-quality',
  detailRecovery: 72,
  sharpness: 58,
  noiseReduction: 42,
  textureEnhancement: 55,
  edgeEnhancement: 68,
  faceEnhancement: false,
  artifactRemoval: 50,
  colorRestoration: 35,
  outputFormat: 'png',
};

export const DEFAULT_BG_REMOVE_OPTIONS: BackgroundRemoveOptions = {
  mode: 'auto',
  bgColor: 'transparent',
  tolerance: 26,
  edgeRefinement: 70,
  feather: 2,
  preserveHairDetail: true,
  fgSeeds: [],
  bgSeeds: [],
};

// ============================================================
// AI Font Finder & Visual Typography Recognition Types
// ============================================================

export type FontLicenseClass =
  | 'Free for Personal and Commercial Use'
  | 'Free for Personal Use Only'
  | 'Paid Font'
  | 'Unknown or Unverified License';

export interface FontCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  rotateDeg?: number;
}

export interface FontSearchFilters {
  category?: string;
  license?: 'all' | 'commercial-free' | 'personal-free';
  format?: 'all' | 'TTF' | 'WOFF2' | 'WOFF';
  style?: 'all' | 'regular' | 'bold' | 'black' | 'light' | 'italic' | 'condensed';
  language?: 'all' | 'latin' | 'arabic' | 'bengali' | 'cyrillic' | 'multilingual';
  customHint?: string;
}

export interface TypographyTraits {
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
  reasoning: string;
}

export interface TextRegionDetection {
  regionId: string;
  role: 'heading' | 'subheading' | 'body' | 'decorative' | 'wordmark';
  roleLabel: string;
  extractedText: string;
  bbox: { ymin: number; xmin: number; ymax: number; xmax: number };
  rotationDeg: number;
  cropDataUrl: string;
  rasterMetrics: {
    widthPx: number;
    heightPx: number;
    aspectRatio: number;
    foregroundDensity: number;
    contrastRatio: number;
    dominantTextColor: string;
    dominantBgColor: string;
  };
  traits: TypographyTraits;
}

export interface FontDownloadOption {
  format: 'ZIP' | 'OTF' | 'TTF' | 'WOFF2' | 'WOFF';
  url: string;
  proxyUrl: string;
  verified: boolean;
}

export interface FontCandidateMatch {
  id: string;
  family: string;
  designer: string;
  source: 'Google Fonts & Fontsource' | 'Fontsource' | 'Commercial Foundry Reference';
  isExactMatch: boolean;
  matchType: 'exact-free' | 'exact-paid' | 'similar-free';
  confidencePercent: number;
  categories: string[];
  primaryCategory: string;
  recommendedWeight: number;
  weights: number[];
  styles: string[];
  subsets: string[];
  licenseName: string;
  licenseClass: FontLicenseClass;
  licenseVerified: boolean;
  officialUrl: string;
  cssUrl: string;
  previewFontUrls: {
    woff2?: string;
    woff?: string;
    ttf?: string;
  };
  downloadFormats: FontDownloadOption[];
  matchReasons: string[];
  similarityBreakdown: {
    shapeSimilarity: number;
    weightMatch: number;
    widthMatch: number;
    styleMatch: number;
    glyphCorrelation?: number;
  };
}

export interface RegionFontResult {
  region: TextRegionDetection;
  exactMatch: FontCandidateMatch | null;
  fallbackMessage: string | null;
  paidExactNotice: string | null;
  candidates: FontCandidateMatch[];
}

export interface FontSourceHealth {
  source: string;
  ok: boolean;
  count: number;
  method?: string;
  error?: string;
}

export interface FontFinderResult {
  uploadId: string;
  imageWidth: number;
  imageHeight: number;
  detectedRotationDeg: number;
  overallSummary: string;
  regions: RegionFontResult[];
  sourceHealth: FontSourceHealth[];
  processingMs: number;
}

// ============================================================
// Two-Phase Automatic Detection & Exact Font Research Types
// ============================================================

export type TextRegionRole =
  | 'main_headline'
  | 'secondary_headline'
  | 'subheading'
  | 'body_text'
  | 'brand_name'
  | 'logo_lettering'
  | 'product_name'
  | 'caption'
  | 'decorative'
  | 'small_text'
  | 'display';

export interface GlyphAnatomyAnalysis {
  serifConstruction: string;
  strokeThickness: string;
  strokeContrast: 'Low' | 'Medium' | 'High' | 'Variable';
  terminalShapes: string;
  apertureSize: string;
  counterAndBowlShape: string;
  ascenderDescenderProportion: string;
  crossbarAndArmAngles: string;
  numeralAndPunctuationNotes: string;
  distinctiveGlyphObservations: string[];
  distortionsAndEffectsSeparated: string[];
}

export interface DetectedTextRegion {
  regionId: string;
  regionNumber: number;
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
  appearance: {
    weightEstimate: string;
    numericWeight: number;
    isItalic: boolean;
    widthClass: 'Condensed' | 'Normal' | 'Extended';
    styleClassifications: string[];
    primaryClassification: string;
  };
  distortionsAndEffects: string[];
  imageQualityWarnings: string[];
  cropDataUrl: string;
  rasterMetrics: {
    widthPx: number;
    heightPx: number;
    aspectRatio: number;
    foregroundDensity: number;
    contrastRatio: number;
    dominantTextColor: string;
    dominantBgColor: string;
  };
  glyphAnalysis: GlyphAnatomyAnalysis;
}

export interface FontDetectionResult {
  uploadId: string;
  imageWidth: number;
  imageHeight: number;
  detectedRotationDeg: number;
  overallSummary: string;
  regions: DetectedTextRegion[];
  processingMs: number;
}

export interface VerifiedExactFontMatch {
  id: string;
  family: string;
  verifiedStyle: string;
  weight: number;
  weightLabel: string;
  isItalic: boolean;
  foundryOrDesigner: string;
  verificationStatus: 'Verified Exact Match';
  verificationEvidence: string[];
  glyphComparisonNotes: string;
  internalConfidence: number;
  licenseName: string;
  licenseClass: FontLicenseClass | 'Commercial Proprietary License';
  commercialUseAllowed: boolean | null;
  officialSourceName: string;
  officialPageUrl: string | null;
  specimenPreview: {
    available: boolean;
    unavailableReason?: string;
    cssUrl: string;
    previewFontUrls: {
      woff2?: string;
      woff?: string;
      ttf?: string;
      otf?: string;
    };
    renderedSpecimenDataUrl?: string;
  };
  download: {
    status: 'direct_files' | 'official_page_only' | 'unavailable';
    message: string;
    options: FontDownloadOption[];
  };
  metricsSummary?: {
    silhouetteIoU?: number;
    edgeCorrelation?: number;
    aspectMatch?: number;
    glyphCoverage?: number;
  };
}

export interface FontResearchResult {
  uploadId: string;
  regionId: string;
  searchedText: string;
  outcome: 'verified_exact' | 'not_found';
  verifiedMatch: VerifiedExactFontMatch | null;
  notFoundHeading?: string;
  notFoundMessage?: string;
  researchSummary: string;
  glyphAnalysis: GlyphAnatomyAnalysis;
  sourcesInvestigated: FontSourceHealth[];
  candidatesEvaluatedCount: number;
  processingMs: number;
}

export interface PendingFontDesign {
  fontId: string;
  family: string;
  sampleText: string;
  weight: number;
  isItalic: boolean;
  cssUrl?: string;
  woff2Url?: string;
  ttfUrl?: string;
}


