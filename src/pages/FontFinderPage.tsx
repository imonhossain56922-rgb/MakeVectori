import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlertTriangle,
  CheckCircle2,
  Columns2,
  Crop,
  Heart,
  RotateCcw,
  RotateCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Type as TypeIcon,
  Upload,
} from 'lucide-react';
import {
  cancelProcessingJob,
  downloadVerifiedFontFile,
  pollJobUntilDone,
  startFontFinderJob,
  triggerBrowserDownload,
} from '../lib/apiClient.ts';
import { auth, verifyActiveAuthSession } from '../lib/firebase.ts';
import { logDownloadRecord, saveFontSearchToFirebase } from '../lib/firestoreService.ts';
import type {
  FontCandidateMatch,
  FontCropRect,
  FontDownloadOption,
  FontFinderResult,
  FontSearchFilters,
  PendingFontDesign,
  ProcessingJobState,
  RegionFontResult,
  TextRegionDetection,
  UploadMetadata,
} from '../types/vector.ts';
import { UploadDropzone } from '../components/UploadDropzone.tsx';
import { ProcessingModal } from '../components/ProcessingModal.tsx';
import { AuthDownloadModal } from '../components/AuthDownloadModal.tsx';
import { FontResultCard, type LivePreviewStyleConfig } from '../components/FontResultCard.tsx';
import { FontCompareModal } from '../components/FontCompareModal.tsx';

interface FontFinderPageProps {
  activeUpload: UploadMetadata | null;
  onSetUpload: (meta: UploadMetadata | null) => void;
  onUseFontInDesign: (design: PendingFontDesign) => void;
}

const DEFAULT_PREVIEW_STYLE: LivePreviewStyleConfig = {
  customText: null,
  caseTransform: 'exact',
  fontSize: 34,
  letterSpacingEm: 0,
  lineHeight: 1.25,
  textColor: '#0f172a',
  bgColor: '#ffffff',
  align: 'left',
  wideCard: false,
};

export const FontFinderPage: React.FC<FontFinderPageProps> = ({
  activeUpload,
  onSetUpload,
  onUseFontInDesign,
}) => {
  const [filters, setFilters] = useState<FontSearchFilters>({
    category: 'all',
    license: 'all',
    format: 'all',
    style: 'all',
    language: 'all',
    customHint: '',
  });
  const [showFilters, setShowFilters] = useState(false);

  // Manual Crop & Rotation Tool state (normalized 0..1 coordinates on preview image)
  const [cropMode, setCropMode] = useState(false);
  const [normCrop, setNormCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [rotateDeg, setRotateDeg] = useState(0);
  const dragCropStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewImgRef = useRef<HTMLImageElement>(null);

  // Job & Result state
  const [job, setJob] = useState<ProcessingJobState | null>(null);
  const [result, setResult] = useState<FontFinderResult | null>(null);
  const [activeRegionId, setActiveRegionId] = useState<string>('all');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [previewConfig, setPreviewConfig] = useState<LivePreviewStyleConfig>(DEFAULT_PREVIEW_STYLE);

  // Side-by-Side Comparison Modal state
  const [compareModalState, setCompareModalState] = useState<{
    region: TextRegionDetection;
    candidates: FontCandidateMatch[];
  } | null>(null);

  // Auth-gated download queue
  const [showAuthModal, setShowAuthModal] = useState(false);
  const pendingDownloadRef = useRef<{
    candidate: FontCandidateMatch;
    option: FontDownloadOption;
  } | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const resultsSectionRef = useRef<HTMLDivElement>(null);
  const lastAnalyzedUploadRef = useRef<string | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Reset local results if upload changes
  useEffect(() => {
    if (activeUpload?.uploadId !== lastAnalyzedUploadRef.current) {
      setResult(null);
      setNormCrop(null);
      setRotateDeg(0);
      setCropMode(false);
      setActiveRegionId('all');
      setCompareIds(new Set());
      setPreviewConfig(DEFAULT_PREVIEW_STYLE);
      setStatusNotice(null);
    }
  }, [activeUpload?.uploadId]);

  const computePixelCrop = (): FontCropRect | null => {
    if (!activeUpload) return null;
    if (!normCrop && Math.abs(rotateDeg) < 0.5) return null;
    if (normCrop && normCrop.w > 0.02 && normCrop.h > 0.02) {
      return {
        x: Math.round(normCrop.x * activeUpload.width),
        y: Math.round(normCrop.y * activeUpload.height),
        width: Math.round(normCrop.w * activeUpload.width),
        height: Math.round(normCrop.h * activeUpload.height),
        rotateDeg,
      };
    }
    return {
      x: 0,
      y: 0,
      width: activeUpload.width,
      height: activeUpload.height,
      rotateDeg,
    };
  };

  const runFontFinder = async () => {
    if (!activeUpload) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatusNotice(null);

    setJob({
      jobId: 'pending',
      jobType: 'font-finder',
      status: 'processing',
      stage: 'Uploading Image',
      stageIndex: 1,
      totalStages: 8,
      progress: 8,
      isEstimate: false,
      engine: 'Gemini 4 Typography Agent + Google Fonts & Fontsource',
    });

    try {
      const pixelCrop = computePixelCrop();
      const jobId = await startFontFinderJob(activeUpload.uploadId, pixelCrop, filters);
      const completed = await pollJobUntilDone(jobId, setJob, ac.signal);

      if (completed.result?.fontFinderResult) {
        const ffRes = completed.result.fontFinderResult;
        lastAnalyzedUploadRef.current = activeUpload.uploadId;
        setResult(ffRes);
        setActiveRegionId('all');
        setCompareIds(new Set());
        setPreviewConfig((prev) => ({ ...prev, customText: null, caseTransform: 'exact' }));
        setJob(null);

        // Save search history to Firestore if user is signed in & verified
        const topRegion = ffRes.regions[0];
        const topMatch = topRegion?.exactMatch || topRegion?.candidates[0];
        if (auth.currentUser?.emailVerified && topRegion && topMatch) {
          saveFontSearchToFirebase({
            userId: auth.currentUser.uid,
            filename: activeUpload.filename,
            extractedText: topRegion.region.extractedText,
            matchedFontFamily: topMatch.family,
            matchedFontId: topMatch.id,
            isExactMatch: topMatch.isExactMatch,
            confidencePercent: topMatch.confidencePercent,
            licenseClass: topMatch.licenseClass,
            regionCount: ffRes.regions.length,
            thumbnailDataUrl: activeUpload.previewDataUrl,
          }).catch(() => {});
        }

        setTimeout(() => {
          resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 120);
      }
    } catch (err) {
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: 'failed',
              stage: 'Failed',
              error: err instanceof Error ? err.message : 'Font Finder analysis failed.',
            }
          : null
      );
    }
  };

  const executeVerifiedDownload = async (
    candidate: FontCandidateMatch,
    option: FontDownloadOption
  ) => {
    const { blob, filename } = await downloadVerifiedFontFile(
      option.proxyUrl,
      `${candidate.id}.${option.format.toLowerCase()}`
    );
    triggerBrowserDownload(blob, filename);

    if (auth.currentUser?.emailVerified) {
      logDownloadRecord({
        userId: auth.currentUser.uid,
        projectId: `font_${candidate.id}_${Date.now()}`,
        projectName: filename,
        format: option.format === 'ZIP' ? 'zip' : 'svg',
        byteSize: blob.size,
      }).catch(() => {});
    }
  };

  const handleDownloadWithAuthGate = async (
    candidate: FontCandidateMatch,
    option: FontDownloadOption
  ) => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      pendingDownloadRef.current = { candidate, option };
      setShowAuthModal(true);
      return;
    }
    const { valid } = await verifyActiveAuthSession(currentUser, { force: true });
    if (!valid) {
      pendingDownloadRef.current = { candidate, option };
      setShowAuthModal(true);
      return;
    }
    await executeVerifiedDownload(candidate, option);
  };

  const handleUseInDesign = (
    candidate: FontCandidateMatch,
    weight: number,
    sampleText: string,
    isItalic: boolean
  ) => {
    onUseFontInDesign({
      fontId: candidate.id,
      family: candidate.family,
      sampleText,
      weight,
      isItalic,
      cssUrl: candidate.cssUrl,
      woff2Url: candidate.previewFontUrls.woff2,
      ttfUrl: candidate.previewFontUrls.ttf,
    });
  };

  // Interactive Pointer Drag Cropping on Source Preview
  const getRelativePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const visibleRegions = useMemo(() => {
    if (!result) return [];
    return activeRegionId === 'all'
      ? result.regions
      : result.regions.filter((r) => r.region.regionId === activeRegionId);
  }, [result, activeRegionId]);

  const compareSelectedCandidates = useMemo(() => {
    if (!result || compareIds.size === 0) return null;
    for (const rr of result.regions) {
      const pool = [...(rr.exactMatch ? [rr.exactMatch] : []), ...rr.candidates];
      const matched = pool.filter((c) => compareIds.has(`${rr.region.regionId}::${c.id}`));
      if (matched.length > 0) {
        return { region: rr.region, candidates: matched };
      }
    }
    return null;
  }, [result, compareIds]);

  const toggleCompareKey = (regionId: string, candId: string) => {
    const key = `${regionId}::${candId}`;
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleFavorite = (candId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(candId)) next.delete(candId);
      else next.add(candId);
      return next;
    });
  };

  const filterVisibleCandidates = (list: FontCandidateMatch[]) => {
    if (!favoritesOnly) return list;
    return list.filter((c) => favorites.has(c.id));
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            AI Font Finder &amp; Typography Recognition
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload any poster, logo, screenshot, or packaging image to identify fonts, verify free licenses, preview the exact extracted text live, and download genuine font files.
          </p>
        </div>

        {activeUpload && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onSetUpload(null);
                setResult(null);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              New Image
            </button>
            <button
              type="button"
              onClick={runFontFinder}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              Find Font
            </button>
          </div>
        )}
      </div>

      {!activeUpload ? (
        <UploadDropzone
          onUploaded={(meta) => {
            onSetUpload(meta);
            setResult(null);
          }}
          title="Drop an image containing text to identify its font"
          subtitle="Supports PNG, JPG, JPEG, WebP, and BMP · Drag & drop or paste (Ctrl+V)"
        />
      ) : (
        <>
          {/* Source Image Inspection, Crop & Orientation Controls + Search Filters */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left: Image Preview + Crop/Rotate + Primary [ Find Font ] Button */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900 truncate max-w-[220px]">
                  {activeUpload.filename}
                </span>
                <span className="font-mono tabular-nums text-slate-500">
                  {activeUpload.width}×{activeUpload.height}px
                </span>
              </div>

              {/* Interactive Preview Canvas with Drag Crop & Detected Text Bounding Boxes */}
              <div className="rounded-lg border border-slate-200 bg-checkerboard p-3 flex items-center justify-center overflow-hidden min-h-[260px]">
                <div
                  className={`relative inline-block select-none ${cropMode ? 'cursor-crosshair' : ''}`}
                  onPointerDown={(e) => {
                    if (!cropMode) return;
                    e.preventDefault();
                    const pt = getRelativePointer(e);
                    dragCropStartRef.current = pt;
                    setNormCrop({ x: pt.x, y: pt.y, w: 0, h: 0 });
                  }}
                  onPointerMove={(e) => {
                    if (!cropMode || !dragCropStartRef.current) return;
                    const pt = getRelativePointer(e);
                    const s = dragCropStartRef.current;
                    setNormCrop({
                      x: Math.min(s.x, pt.x),
                      y: Math.min(s.y, pt.y),
                      w: Math.abs(pt.x - s.x),
                      h: Math.abs(pt.y - s.y),
                    });
                  }}
                  onPointerUp={() => {
                    dragCropStartRef.current = null;
                  }}
                >
                  <img
                    ref={previewImgRef}
                    src={activeUpload.previewDataUrl}
                    alt={activeUpload.filename}
                    referrerPolicy="no-referrer"
                    draggable={false}
                    style={{
                      transform: rotateDeg ? `rotate(${rotateDeg}deg)` : undefined,
                    }}
                    className="max-h-[340px] max-w-full object-contain block transition-transform"
                  />

                  {/* User Manual Crop Overlay */}
                  {normCrop && normCrop.w > 0.01 && normCrop.h > 0.01 && (
                    <div
                      style={{
                        left: `${normCrop.x * 100}%`,
                        top: `${normCrop.y * 100}%`,
                        width: `${normCrop.w * 100}%`,
                        height: `${normCrop.h * 100}%`,
                      }}
                      className="absolute border-2 border-indigo-600 bg-indigo-500/15 pointer-events-none"
                    >
                      <span className="absolute -top-5 left-0 bg-indigo-600 text-white text-[10px] font-mono px-1.5 py-0.5 rounded">
                        Crop Region
                      </span>
                    </div>
                  )}

                  {/* Detected Multi-Region Text Boxes after Analysis */}
                  {!cropMode &&
                    result?.regions.map((rr) => {
                      const b = rr.region.bbox;
                      const isSel = activeRegionId === rr.region.regionId;
                      return (
                        <button
                          key={rr.region.regionId}
                          type="button"
                          onClick={() => setActiveRegionId(rr.region.regionId)}
                          style={{
                            top: `${b.ymin / 10}%`,
                            left: `${b.xmin / 10}%`,
                            height: `${Math.max(3, (b.ymax - b.ymin) / 10)}%`,
                            width: `${Math.max(4, (b.xmax - b.xmin) / 10)}%`,
                          }}
                          title={`Select ${rr.region.roleLabel}: "${rr.region.extractedText}"`}
                          className={`absolute border-2 transition-colors cursor-pointer ${
                            isSel
                              ? 'border-emerald-500 bg-emerald-400/20'
                              : 'border-indigo-500/80 bg-indigo-400/10 hover:bg-indigo-400/25'
                          }`}
                        >
                          <span className="sr-only">{rr.region.roleLabel}</span>
                        </button>
                      );
                    })}
                </div>
              </div>

              {/* Prominent [ Find Font ] Button Underneath Uploaded Image Preview */}
              <button
                type="button"
                onClick={runFontFinder}
                className="w-full py-3 px-5 text-sm font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2 shadow-xs cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                Find Font
              </button>

              {/* Crop & Orientation Correction Bar */}
              <div className="pt-3 border-t border-slate-100 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setCropMode((m) => !m)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium cursor-pointer ${
                      cropMode
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Crop className="w-3.5 h-3.5" />
                    {cropMode ? 'Done Cropping (Drag on Image)' : 'Manual Text Crop'}
                  </button>

                  {normCrop && (
                    <button
                      type="button"
                      onClick={() => setNormCrop(null)}
                      className="text-slate-500 hover:text-slate-900 underline cursor-pointer"
                    >
                      Clear Crop
                    </button>
                  )}

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setRotateDeg((d) => ((d - 90 + 540) % 360) - 180)}
                      className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 cursor-pointer"
                      title="Rotate -90°"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRotateDeg((d) => ((d + 90 + 540) % 360) - 180)}
                      className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 cursor-pointer"
                      title="Rotate +90°"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <label className="block">
                  <div className="flex justify-between text-slate-600 mb-1">
                    <span>Fine Deskew / Rotation Correction</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">
                      {rotateDeg}°
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={1}
                    value={rotateDeg}
                    onChange={(e) => setRotateDeg(Number(e.target.value))}
                    className="w-full accent-indigo-600"
                  />
                </label>
              </div>
            </div>

            {/* Right: Search Filters & Recognition Capabilities */}
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-indigo-600" />
                    Optional Font Search Filters &amp; Agent Hints
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Leave on &ldquo;All&rdquo; for unconstrained automatic font recognition across multiple text lines, or narrow results by category, license, style, format, or language.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowFilters((s) => !s)}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap cursor-pointer"
                >
                  {showFilters ? 'Compact View' : 'All Filters'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                <label className="block">
                  <span className="font-medium text-slate-700">Font Category</span>
                  <select
                    value={filters.category || 'all'}
                    onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="all">All Categories (Auto-Detect)</option>
                    <option value="Sans Serif">Sans Serif</option>
                    <option value="Serif">Serif</option>
                    <option value="Slab Serif">Slab Serif</option>
                    <option value="Display">Display</option>
                    <option value="Geometric">Geometric</option>
                    <option value="Script">Script</option>
                    <option value="Handwritten">Handwritten</option>
                    <option value="Blackletter">Blackletter</option>
                    <option value="Monospaced">Monospaced</option>
                    <option value="Decorative">Decorative</option>
                    <option value="Vintage">Vintage</option>
                    <option value="Modern">Modern</option>
                    <option value="Condensed">Condensed</option>
                    <option value="Extended">Extended</option>
                  </select>
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">License Type</span>
                  <select
                    value={filters.license || 'all'}
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        license: e.target.value as FontSearchFilters['license'],
                      }))
                    }
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="all">All Verified Open Licenses</option>
                    <option value="commercial-free">Free for Personal &amp; Commercial Use</option>
                    <option value="personal-free">Free for Personal Use Included</option>
                  </select>
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">Font Format</span>
                  <select
                    value={filters.format || 'all'}
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        format: e.target.value as FontSearchFilters['format'],
                      }))
                    }
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="all">All Formats (ZIP / TTF / WOFF2)</option>
                    <option value="TTF">TTF (Desktop TrueType)</option>
                    <option value="WOFF2">WOFF2 (Modern Webfont)</option>
                    <option value="WOFF">WOFF</option>
                  </select>
                </label>

                {(showFilters || filters.style !== 'all' || filters.language !== 'all') && (
                  <>
                    <label className="block">
                      <span className="font-medium text-slate-700">Font Weight / Style</span>
                      <select
                        value={filters.style || 'all'}
                        onChange={(e) =>
                          setFilters((f) => ({
                            ...f,
                            style: e.target.value as FontSearchFilters['style'],
                          }))
                        }
                        className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="all">Any Weight / Style</option>
                        <option value="regular">Regular (400)</option>
                        <option value="bold">Bold (700+)</option>
                        <option value="black">ExtraBold / Black (800-900)</option>
                        <option value="light">Light / Thin (100-300)</option>
                        <option value="italic">Includes Italic</option>
                        <option value="condensed">Condensed Width</option>
                      </select>
                    </label>

                    <label className="block">
                      <span className="font-medium text-slate-700">Language / Script Support</span>
                      <select
                        value={filters.language || 'all'}
                        onChange={(e) =>
                          setFilters((f) => ({
                            ...f,
                            language: e.target.value as FontSearchFilters['language'],
                          }))
                        }
                        className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="all">All Scripts (Auto-Detect)</option>
                        <option value="latin">English / Latin</option>
                        <option value="arabic">Arabic</option>
                        <option value="bengali">Bengali</option>
                        <option value="cyrillic">Cyrillic</option>
                        <option value="multilingual">Multilingual (3+ scripts)</option>
                      </select>
                    </label>
                  </>
                )}

                <label className="block sm:col-span-2 lg:col-span-3">
                  <span className="font-medium text-slate-700">Target Focus Hint (Optional)</span>
                  <input
                    type="text"
                    value={filters.customHint || ''}
                    onChange={(e) => setFilters((f) => ({ ...f, customHint: e.target.value }))}
                    placeholder='e.g. "Focus on the main serif headline" or "Ignore small watermark text"'
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500"
                  />
                </label>
              </div>

              <div className="pt-2 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-slate-600">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="font-semibold text-slate-900">Multi-Region Detection</div>
                  <div className="mt-0.5">Identifies headings, subheadings, body text, and decorative logos separately.</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="font-semibold text-slate-900">Exact Image Text Preview</div>
                  <div className="mt-0.5">Renders your exact uploaded words using verified webfont binaries.</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="font-semibold text-slate-900">License &amp; Binary Verified</div>
                  <div className="mt-0.5">Checks OFL, Apache, MIT, or marks commercial paid fonts honestly.</div>
                </div>
              </div>
            </div>
          </div>

          {statusNotice && (
            <div className="rounded-lg bg-indigo-50 border border-indigo-200 px-4 py-2.5 text-xs text-indigo-800">
              {statusNotice}
            </div>
          )}

          {/* RESULTS SECTION */}
          {result && (
            <div ref={resultsSectionRef} className="space-y-6 scroll-mt-20">
              {/* Summary & Source Health Bar */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span className="text-sm font-bold text-slate-900">
                      Detected {result.regions.length} Text Region{result.regions.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-500">
                      · {result.processingMs} ms
                      {Math.abs(result.detectedRotationDeg) >= 2
                        ? ` · ~${result.detectedRotationDeg.toFixed(0)}° tilt detected`
                        : ''}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600">{result.overallSummary}</p>
                </div>

                {/* Catalog Source Status */}
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  {result.sourceHealth.map((s) => (
                    <span
                      key={s.source}
                      className={`px-2.5 py-1 rounded-md border ${
                        s.ok
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                          : 'bg-amber-50 border-amber-200 text-amber-800'
                      }`}
                    >
                      {s.source}: {s.ok ? `${s.count.toLocaleString()} fonts` : `Unavailable (${s.error || 'timeout'})`}
                    </span>
                  ))}
                </div>
              </div>

              {result.regions.length === 0 ? (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-8 text-center space-y-2">
                  <AlertTriangle className="w-6 h-6 text-amber-600 mx-auto" />
                  <h3 className="text-sm font-bold text-slate-900">No Readable Typography Found</h3>
                  <p className="text-xs text-slate-600 max-w-md mx-auto">
                    Try drawing a tight manual crop box around the text or correcting rotation above, then click Find Font again.
                  </p>
                </div>
              ) : (
                <>
                  {/* Region Filter Tabs + Interactive Live Preview Customization Bar */}
                  <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                    {/* Region Pills & Compare/Favorites Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setActiveRegionId('all')}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                            activeRegionId === 'all'
                              ? 'bg-indigo-600 border-indigo-600 text-white'
                              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          All Regions ({result.regions.length})
                        </button>
                        {result.regions.map((rr) => (
                          <button
                            key={rr.region.regionId}
                            type="button"
                            onClick={() => setActiveRegionId(rr.region.regionId)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                              activeRegionId === rr.region.regionId
                                ? 'bg-indigo-50 border-indigo-300 text-indigo-800 font-semibold'
                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            {rr.region.roleLabel}: &ldquo;{rr.region.extractedText.slice(0, 22)}
                            {rr.region.extractedText.length > 22 ? '…' : ''}&rdquo;
                          </button>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setFavoritesOnly((v) => !v)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                            favoritesOnly
                              ? 'bg-rose-50 border-rose-200 text-rose-700'
                              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <Heart className={`w-3.5 h-3.5 ${favoritesOnly ? 'fill-rose-500' : ''}`} />
                          Favorites ({favorites.size})
                        </button>

                        {compareSelectedCandidates && (
                          <button
                            type="button"
                            onClick={() => setCompareModalState(compareSelectedCandidates)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer"
                          >
                            <Columns2 className="w-3.5 h-3.5" />
                            Compare Selected ({compareIds.size})
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Global Live Text Preview Controls */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end text-xs">
                      <div className="lg:col-span-5">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                            <TypeIcon className="w-3.5 h-3.5 text-indigo-600" />
                            Live Preview Text (Defaults to Exact Image Text)
                          </span>
                          {previewConfig.customText !== null && (
                            <button
                              type="button"
                              onClick={() =>
                                setPreviewConfig((p) => ({
                                  ...p,
                                  customText: null,
                                  caseTransform: 'exact',
                                }))
                              }
                              className="text-indigo-600 hover:text-indigo-800 font-semibold cursor-pointer"
                            >
                              Reset to Exact Image Text
                            </button>
                          )}
                        </div>
                        <input
                          type="text"
                          value={
                            previewConfig.customText !== null
                              ? previewConfig.customText
                              : visibleRegions[0]?.region.extractedText || ''
                          }
                          onChange={(e) =>
                            setPreviewConfig((p) => ({ ...p, customText: e.target.value }))
                          }
                          placeholder="Type custom text to test across all candidate fonts..."
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div className="lg:col-span-4 flex flex-wrap items-center gap-1.5">
                        {(
                          [
                            { id: 'exact', label: 'Exact' },
                            { id: 'upper', label: 'UPPER' },
                            { id: 'lower', label: 'lower' },
                            { id: 'title', label: 'Title' },
                            { id: 'digits', label: '0-9 & !?' },
                          ] as const
                        ).map((mode) => (
                          <button
                            key={mode.id}
                            type="button"
                            onClick={() =>
                              setPreviewConfig((p) => ({ ...p, caseTransform: mode.id }))
                            }
                            className={`px-2.5 py-2 rounded-lg border font-medium cursor-pointer ${
                              previewConfig.caseTransform === mode.id
                                ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            {mode.label}
                          </button>
                        ))}
                      </div>

                      <div className="lg:col-span-3 flex flex-wrap items-center justify-end gap-2">
                        <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden">
                          {(
                            [
                              { id: 'left', icon: <AlignLeft className="w-3.5 h-3.5" /> },
                              { id: 'center', icon: <AlignCenter className="w-3.5 h-3.5" /> },
                              { id: 'right', icon: <AlignRight className="w-3.5 h-3.5" /> },
                            ] as const
                          ).map((al) => (
                            <button
                              key={al.id}
                              type="button"
                              onClick={() => setPreviewConfig((p) => ({ ...p, align: al.id }))}
                              className={`p-2 cursor-pointer ${
                                previewConfig.align === al.id
                                  ? 'bg-indigo-50 text-indigo-700'
                                  : 'bg-white text-slate-500 hover:bg-slate-50'
                              }`}
                              title={`Align ${al.id}`}
                            >
                              {al.icon}
                            </button>
                          ))}
                        </div>

                        <label className="flex items-center gap-1 border border-slate-200 rounded-lg px-2 py-1 bg-white cursor-pointer">
                          <span className="text-[11px] text-slate-500">Ink</span>
                          <input
                            type="color"
                            value={previewConfig.textColor}
                            onChange={(e) =>
                              setPreviewConfig((p) => ({ ...p, textColor: e.target.value }))
                            }
                            className="w-5 h-5 border-0 bg-transparent cursor-pointer p-0"
                          />
                        </label>
                        <label className="flex items-center gap-1 border border-slate-200 rounded-lg px-2 py-1 bg-white cursor-pointer">
                          <span className="text-[11px] text-slate-500">BG</span>
                          <input
                            type="color"
                            value={previewConfig.bgColor}
                            onChange={(e) =>
                              setPreviewConfig((p) => ({ ...p, bgColor: e.target.value }))
                            }
                            className="w-5 h-5 border-0 bg-transparent cursor-pointer p-0"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1 text-xs">
                      <label className="block">
                        <div className="flex justify-between text-slate-600 mb-1">
                          <span>Preview Size</span>
                          <span className="font-mono tabular-nums text-slate-900">
                            {previewConfig.fontSize}px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={16}
                          max={72}
                          value={previewConfig.fontSize}
                          onChange={(e) =>
                            setPreviewConfig((p) => ({ ...p, fontSize: Number(e.target.value) }))
                          }
                          className="w-full accent-indigo-600"
                        />
                      </label>

                      <label className="block">
                        <div className="flex justify-between text-slate-600 mb-1">
                          <span>Letter Spacing</span>
                          <span className="font-mono tabular-nums text-slate-900">
                            {previewConfig.letterSpacingEm.toFixed(2)}em
                          </span>
                        </div>
                        <input
                          type="range"
                          min={-0.08}
                          max={0.28}
                          step={0.01}
                          value={previewConfig.letterSpacingEm}
                          onChange={(e) =>
                            setPreviewConfig((p) => ({
                              ...p,
                              letterSpacingEm: Number(e.target.value),
                            }))
                          }
                          className="w-full accent-indigo-600"
                        />
                      </label>

                      <label className="block">
                        <div className="flex justify-between text-slate-600 mb-1">
                          <span>Line Height</span>
                          <span className="font-mono tabular-nums text-slate-900">
                            {previewConfig.lineHeight.toFixed(2)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0.9}
                          max={2}
                          step={0.05}
                          value={previewConfig.lineHeight}
                          onChange={(e) =>
                            setPreviewConfig((p) => ({ ...p, lineHeight: Number(e.target.value) }))
                          }
                          className="w-full accent-indigo-600"
                        />
                      </label>
                    </div>
                  </div>

                  {/* Per-Region Typography Results */}
                  {visibleRegions.map((rr: RegionFontResult) => {
                    const region = rr.region;
                    const similarList = filterVisibleCandidates(rr.candidates);
                    const showExact =
                      rr.exactMatch && (!favoritesOnly || favorites.has(rr.exactMatch.id));

                    return (
                      <section
                        key={region.regionId}
                        className="space-y-4 border border-slate-200 rounded-xl bg-slate-50/50 p-5 sm:p-6"
                      >
                        {/* Region Header: Extracted Text + Crop Thumbnail + Forensic Traits */}
                        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
                          <div className="lg:col-span-4 rounded-lg border border-slate-200 bg-checkerboard p-3 flex items-center justify-center min-h-[100px]">
                            <img
                              src={region.cropDataUrl}
                              alt={`Cropped region: ${region.extractedText}`}
                              referrerPolicy="no-referrer"
                              className="max-h-24 object-contain"
                            />
                          </div>

                          <div className="lg:col-span-8 space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                                {region.roleLabel} FONT RESULTS
                              </span>
                              <span className="text-xs font-mono text-slate-500">
                                {region.rasterMetrics.widthPx}×{region.rasterMetrics.heightPx}px · Contrast{' '}
                                {region.rasterMetrics.contrastRatio}:1
                              </span>
                            </div>

                            <div className="text-sm font-semibold text-slate-900">
                              Extracted Image Text:{' '}
                              <span className="font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-900">
                                &ldquo;{region.extractedText}&rdquo;
                              </span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-slate-600">
                              <div>
                                <span className="text-slate-400">Category:</span>{' '}
                                <strong className="text-slate-800">{region.traits.primaryStyle}</strong>
                              </div>
                              <div>
                                <span className="text-slate-400">Weight:</span>{' '}
                                <strong className="text-slate-800">
                                  {region.traits.weightName} ({region.traits.numericWeight})
                                </strong>
                              </div>
                              <div>
                                <span className="text-slate-400">Width:</span>{' '}
                                <strong className="text-slate-800">{region.traits.widthClass}</strong>
                              </div>
                              <div>
                                <span className="text-slate-400">Terminals:</span>{' '}
                                <strong className="text-slate-800">{region.traits.terminalStyle}</strong>
                              </div>
                            </div>

                            {region.traits.distinctiveFeatures.length > 0 && (
                              <div className="text-xs text-slate-600">
                                <span className="font-medium text-slate-700">Distinctive glyphs:</span>{' '}
                                {region.traits.distinctiveFeatures.join(' · ')}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Notices (Commercial Exact Font or Fallback Similar Notice) */}
                        {rr.paidExactNotice && (
                          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900">
                            {rr.paidExactNotice}
                          </div>
                        )}
                        {rr.fallbackMessage && (
                          <div className="rounded-lg bg-indigo-50 border border-indigo-200 px-4 py-3 text-xs font-medium text-indigo-900">
                            {rr.fallbackMessage}
                          </div>
                        )}

                        {/* Exact Match Card (if found) */}
                        {showExact && rr.exactMatch && (
                          <div className="space-y-2">
                            <div className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                              {rr.exactMatch.matchType === 'exact-paid'
                                ? 'Commercial Exact Match Reference'
                                : 'Exact Free Font Match Found'}
                            </div>
                            <FontResultCard
                              candidate={rr.exactMatch}
                              region={region}
                              previewConfig={previewConfig}
                              isFavorite={favorites.has(rr.exactMatch.id)}
                              isSelectedForCompare={compareIds.has(
                                `${region.regionId}::${rr.exactMatch.id}`
                              )}
                              onToggleFavorite={() => toggleFavorite(rr.exactMatch!.id)}
                              onToggleCompare={() =>
                                toggleCompareKey(region.regionId, rr.exactMatch!.id)
                              }
                              onOpenSideBySide={(c) =>
                                setCompareModalState({ region, candidates: [c] })
                              }
                              onUseInDesign={(c, w, txt) =>
                                handleUseInDesign(c, w, txt, region.traits.isItalic)
                              }
                              onDownloadOption={handleDownloadWithAuthGate}
                            />
                          </div>
                        )}

                        {/* Visually Similar Free Fonts */}
                        <div className="space-y-3">
                          <div className="text-xs font-bold uppercase tracking-wider text-slate-700">
                            {rr.exactMatch
                              ? `Visually Similar Free Alternatives (${similarList.length})`
                              : `Closest Matching Free Fonts (${similarList.length})`}
                          </div>
                          {similarList.length === 0 ? (
                            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-xs text-slate-500">
                              No fonts matched the active filter criteria for this region. Try broadening your category or license filters above.
                            </div>
                          ) : (
                            <div className="space-y-4">
                              {similarList.map((cand) => (
                                <FontResultCard
                                  key={cand.id}
                                  candidate={cand}
                                  region={region}
                                  previewConfig={previewConfig}
                                  isFavorite={favorites.has(cand.id)}
                                  isSelectedForCompare={compareIds.has(
                                    `${region.regionId}::${cand.id}`
                                  )}
                                  onToggleFavorite={() => toggleFavorite(cand.id)}
                                  onToggleCompare={() =>
                                    toggleCompareKey(region.regionId, cand.id)
                                  }
                                  onOpenSideBySide={(c) =>
                                    setCompareModalState({ region, candidates: [c] })
                                  }
                                  onUseInDesign={(c, w, txt) =>
                                    handleUseInDesign(c, w, txt, region.traits.isItalic)
                                  }
                                  onDownloadOption={handleDownloadWithAuthGate}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </>
      )}

      <ProcessingModal
        job={job}
        onCancel={() => {
          if (job?.jobId && job.jobId !== 'pending') cancelProcessingJob(job.jobId);
          abortRef.current?.abort();
          setJob(null);
        }}
        onRetry={runFontFinder}
        onClose={() => setJob(null)}
      />

      <FontCompareModal
        open={Boolean(compareModalState)}
        onClose={() => setCompareModalState(null)}
        region={compareModalState?.region || null}
        candidates={compareModalState?.candidates || []}
        previewConfig={previewConfig}
        onUseInDesign={(c, w, txt) =>
          handleUseInDesign(
            c,
            w,
            txt,
            compareModalState?.region.traits.isItalic || false
          )
        }
        onDownloadOption={handleDownloadWithAuthGate}
      />

      <AuthDownloadModal
        open={showAuthModal}
        onClose={() => {
          setShowAuthModal(false);
          pendingDownloadRef.current = null;
        }}
        onAuthenticated={async () => {
          const pending = pendingDownloadRef.current;
          pendingDownloadRef.current = null;
          if (pending) {
            await executeVerifiedDownload(pending.candidate, pending.option);
          }
        }}
        title="Sign in to download font files"
        subtitle="AI Font Finder recognition and live font previews are free without an account. Sign in once on this device to download verified font files."
      />
    </div>
  );
};
