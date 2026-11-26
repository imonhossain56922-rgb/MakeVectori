import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  AlignCenter,
  AlignLeft,
  AlignRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Crop,
  Loader2,
  RotateCcw,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  Type as TypeIcon,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  cancelProcessingJob,
  downloadVerifiedFontFile,
  pollJobUntilDone,
  removeUploadedImage,
  startFontDetectJob,
  startFontResearchJob,
  triggerBrowserDownload,
} from '../lib/apiClient.ts';
import { auth, verifyActiveAuthSession } from '../lib/firebase.ts';
import { logDownloadRecord, saveFontSearchToFirebase } from '../lib/firestoreService.ts';
import type {
  DetectedTextRegion,
  FontCropRect,
  FontDetectionResult,
  FontDownloadOption,
  FontResearchResult,
  PendingFontDesign,
  ProcessingJobState,
  UploadMetadata,
  VerifiedExactFontMatch,
} from '../types/vector.ts';
import { UploadDropzone } from '../components/UploadDropzone.tsx';
import { AuthDownloadModal } from '../components/AuthDownloadModal.tsx';
import {
  ExactFontResultCard,
  type LivePreviewStyleConfig,
} from '../components/ExactFontResultCard.tsx';
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
};

const DETECT_STAGES = [
  'Analyzing uploaded image...',
  'Detecting text regions...',
  'Extracting typography features...',
];

const RESEARCH_STAGES = [
  'Analyzing selected letterforms...',
  'Searching font databases...',
  'Investigating official foundries...',
  'Comparing font specimens...',
  'Verifying exact font identity...',
  'Preparing verified result...',
];

export const FontFinderPage: React.FC<FontFinderPageProps> = ({
  activeUpload,
  onSetUpload,
  onUseFontInDesign,
}) => {
  // Canvas & Optional Manual Re-Detect Crop/Rotation Controls
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [showCropTools, setShowCropTools] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [normCrop, setNormCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [rotateDeg, setRotateDeg] = useState(0);
  const dragCropStartRef = useRef<{ x: number; y: number } | null>(null);

  // Phase A: Automatic Multi-Region Detection state
  const [detectJob, setDetectJob] = useState<ProcessingJobState | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectionResult, setDetectionResult] = useState<FontDetectionResult | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);

  // Per-region OCR text edits + Phase B research cache
  const [editedTextByRegion, setEditedTextByRegion] = useState<Record<string, string>>({});
  const [showGlyphAnatomy, setShowGlyphAnatomy] = useState(false);
  const [showResearchNotes, setShowResearchNotes] = useState(false);

  // Phase B: Focused Exact Font Research state
  const [researchJob, setResearchJob] = useState<ProcessingJobState | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [researchByRegionId, setResearchByRegionId] = useState<Record<string, FontResearchResult>>({});

  // Live specimen preview & Side-by-Side Comparison state
  const [previewConfig, setPreviewConfig] = useState<LivePreviewStyleConfig>(DEFAULT_PREVIEW_STYLE);
  const [compareOpen, setCompareOpen] = useState(false);

  // Auth-gated download queue
  const [showAuthModal, setShowAuthModal] = useState(false);
  const pendingDownloadRef = useRef<{
    match: VerifiedExactFontMatch;
    option: FontDownloadOption;
  } | null>(null);

  const detectAbortRef = useRef<AbortController | null>(null);
  const researchAbortRef = useRef<AbortController | null>(null);
  const autoDetectedUploadIdRef = useRef<string | null>(null);
  const researchOutcomeRef = useRef<HTMLDivElement>(null);

  // Clean up running requests & blob preview URLs on unmount
  useEffect(() => {
    return () => {
      detectAbortRef.current?.abort();
      researchAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const previewUrl = activeUpload?.localPreviewUrl;
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [activeUpload?.localPreviewUrl]);

  const computePixelCrop = useCallback((): FontCropRect | null => {
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
  }, [activeUpload, normCrop, rotateDeg]);

  const runRegionDetection = useCallback(
    async (upload: UploadMetadata, cropOverride?: FontCropRect | null) => {
      detectAbortRef.current?.abort();
      researchAbortRef.current?.abort();
      const ac = new AbortController();
      detectAbortRef.current = ac;

      setDetectError(null);
      setResearchJob(null);
      setResearchError(null);
      setDetectionResult(null);
      setSelectedRegionId(null);
      setResearchByRegionId({});
      setEditedTextByRegion({});
      setShowGlyphAnatomy(false);
      setShowResearchNotes(false);

      setDetectJob({
        jobId: 'pending',
        jobType: 'font-detect',
        status: 'processing',
        stage: DETECT_STAGES[0],
        stageIndex: 1,
        totalStages: 3,
        progress: 12,
        isEstimate: false,
        engine: '',
      });

      try {
        const jobId = await startFontDetectJob(upload.uploadId, cropOverride ?? null);
        const completed = await pollJobUntilDone(jobId, setDetectJob, ac.signal);
        const det = completed.result?.fontDetectionResult;
        if (det) {
          setDetectionResult(det);
          if (det.regions.length > 0) {
            setSelectedRegionId(det.regions[0].regionId);
          }
        }
        setDetectJob(null);
      } catch (err) {
        if (ac.signal.aborted) {
          setDetectJob(null);
          return;
        }
        setDetectJob(null);
        setDetectError(
          err instanceof Error ? err.message : 'Unable to detect typography regions in this image.'
        );
      }
    },
    []
  );

  // Automatically trigger Phase A detection as soon as a new image is uploaded
  useEffect(() => {
    if (!activeUpload) {
      autoDetectedUploadIdRef.current = null;
      setDetectionResult(null);
      setSelectedRegionId(null);
      setDetectJob(null);
      setDetectError(null);
      setResearchJob(null);
      setResearchError(null);
      setResearchByRegionId({});
      setEditedTextByRegion({});
      setNormCrop(null);
      setRotateDeg(0);
      setCropMode(false);
      setCanvasZoom(1);
      return;
    }

    if (autoDetectedUploadIdRef.current !== activeUpload.uploadId) {
      autoDetectedUploadIdRef.current = activeUpload.uploadId;
      setNormCrop(null);
      setRotateDeg(0);
      setCropMode(false);
      setCanvasZoom(1);
      runRegionDetection(activeUpload, null);
    }
  }, [activeUpload, runRegionDetection]);

  const selectedRegion: DetectedTextRegion | null = useMemo(() => {
    if (!detectionResult || detectionResult.regions.length === 0) return null;
    return (
      detectionResult.regions.find((r) => r.regionId === selectedRegionId) ||
      detectionResult.regions[0]
    );
  }, [detectionResult, selectedRegionId]);

  const currentExtractedText = useMemo(() => {
    if (!selectedRegion) return '';
    const edited = editedTextByRegion[selectedRegion.regionId];
    return edited !== undefined ? edited : selectedRegion.extractedText;
  }, [selectedRegion, editedTextByRegion]);

  const activeResearchResult: FontResearchResult | null = useMemo(() => {
    if (!selectedRegion) return null;
    return researchByRegionId[selectedRegion.regionId] || null;
  }, [selectedRegion, researchByRegionId]);

  const runExactFontResearch = async () => {
    if (!activeUpload || !selectedRegion) return;
    researchAbortRef.current?.abort();
    const ac = new AbortController();
    researchAbortRef.current = ac;

    setResearchError(null);
    setShowResearchNotes(false);
    setResearchJob({
      jobId: 'pending',
      jobType: 'font-research',
      status: 'processing',
      stage: RESEARCH_STAGES[0],
      stageIndex: 1,
      totalStages: 6,
      progress: 8,
      isEstimate: false,
      engine: '',
    });

    try {
      const pixelCrop = computePixelCrop();
      const trimmedOverride = currentExtractedText.trim();
      const jobId = await startFontResearchJob(
        activeUpload.uploadId,
        selectedRegion,
        trimmedOverride || selectedRegion.extractedText,
        pixelCrop
      );
      const completed = await pollJobUntilDone(jobId, setResearchJob, ac.signal);
      const res = completed.result?.fontResearchResult;

      if (res) {
        setResearchByRegionId((prev) => ({
          ...prev,
          [selectedRegion.regionId]: res,
        }));
        setPreviewConfig((prev) => ({
          ...prev,
          customText: null,
          caseTransform: 'exact',
        }));

        // Persist ONLY verified exact font matches to user's search history
        if (
          auth.currentUser?.emailVerified &&
          res.outcome === 'verified_exact' &&
          res.verifiedMatch
        ) {
          saveFontSearchToFirebase({
            userId: auth.currentUser.uid,
            filename: activeUpload.filename,
            extractedText: res.searchedText || selectedRegion.extractedText,
            matchedFontFamily: res.verifiedMatch.family,
            matchedFontId: res.verifiedMatch.id,
            isExactMatch: true,
            confidencePercent: res.verifiedMatch.internalConfidence || 95,
            licenseClass: res.verifiedMatch.licenseClass,
            regionCount: detectionResult?.regions.length || 1,
            thumbnailDataUrl: activeUpload.previewDataUrl,
          }).catch(() => {});
        }

        setTimeout(() => {
          researchOutcomeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 80);
      }
      setResearchJob(null);
    } catch (err) {
      if (ac.signal.aborted) {
        setResearchJob(null);
        return;
      }
      setResearchJob(null);
      setResearchError(
        err instanceof Error
          ? err.message
          : 'Font verification encountered an error. Please try again.'
      );
    }
  };

  const handleRemoveImage = () => {
    detectAbortRef.current?.abort();
    researchAbortRef.current?.abort();
    if (detectJob?.jobId && detectJob.jobId !== 'pending') {
      cancelProcessingJob(detectJob.jobId).catch(() => {});
    }
    if (researchJob?.jobId && researchJob.jobId !== 'pending') {
      cancelProcessingJob(researchJob.jobId).catch(() => {});
    }
    if (activeUpload?.uploadId) {
      removeUploadedImage(activeUpload.uploadId).catch(() => {});
    }
    if (activeUpload?.localPreviewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(activeUpload.localPreviewUrl);
    }
    autoDetectedUploadIdRef.current = null;
    setDetectionResult(null);
    setSelectedRegionId(null);
    setResearchByRegionId({});
    setEditedTextByRegion({});
    setDetectJob(null);
    setDetectError(null);
    setResearchJob(null);
    setResearchError(null);
    onSetUpload(null);
  };

  const executeVerifiedDownload = async (
    match: VerifiedExactFontMatch,
    option: FontDownloadOption
  ) => {
    const { blob, filename } = await downloadVerifiedFontFile(
      option.proxyUrl,
      `${match.id}.${option.format.toLowerCase()}`
    );
    triggerBrowserDownload(blob, filename);

    if (auth.currentUser?.emailVerified) {
      logDownloadRecord({
        userId: auth.currentUser.uid,
        projectId: `font_${match.id}_${Date.now()}`,
        projectName: filename,
        format: option.format === 'ZIP' ? 'zip' : 'svg',
        byteSize: blob.size,
      }).catch(() => {});
    }
  };

  const handleDownloadWithAuthGate = async (
    match: VerifiedExactFontMatch,
    option: FontDownloadOption
  ) => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      pendingDownloadRef.current = { match, option };
      setShowAuthModal(true);
      return;
    }
    const { valid } = await verifyActiveAuthSession(currentUser, { force: true });
    if (!valid) {
      pendingDownloadRef.current = { match, option };
      setShowAuthModal(true);
      return;
    }
    await executeVerifiedDownload(match, option);
  };

  const handleUseInDesign = (match: VerifiedExactFontMatch, sampleText: string) => {
    onUseFontInDesign({
      fontId: match.id,
      family: match.family,
      sampleText,
      weight: match.weight || 400,
      isItalic: match.isItalic,
      cssUrl: match.specimenPreview.cssUrl,
      woff2Url: match.specimenPreview.previewFontUrls.woff2,
      ttfUrl: match.specimenPreview.previewFontUrls.ttf,
    });
  };

  const getRelativePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const imageSrc = activeUpload?.localPreviewUrl || activeUpload?.previewDataUrl || '';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            AI Font Finder &amp; Typography Recognition
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload an image to automatically detect and map every text region, select any typography block, and verify the exact original font across font registries and official foundries.
          </p>
        </div>

        {activeUpload && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => runRegionDetection(activeUpload, computePixelCrop())}
              disabled={Boolean(detectJob)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
              Re-Detect Regions
            </button>
            <button
              type="button"
              onClick={handleRemoveImage}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove Image
            </button>
          </div>
        )}
      </div>

      {!activeUpload ? (
        <UploadDropzone
          onUploaded={(meta) => {
            onSetUpload(meta);
          }}
          title="Drop an image to automatically detect all text and fonts"
          subtitle="Supports PNG, JPG, JPEG, WebP, GIF, and BMP · Drag & drop, choose file, or paste (Ctrl+V)"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* LEFT WORKSPACE: Untouched Image + Interactive Numbered Region Overlay */}
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-slate-900 truncate max-w-[220px]">
                  {activeUpload.filename}
                </span>
                <span className="font-mono tabular-nums text-slate-500">
                  {activeUpload.width}×{activeUpload.height}px
                </span>
              </div>

              {/* Zoom & Optional Crop Controls */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCanvasZoom((z) => Math.max(0.75, Number((z - 0.25).toFixed(2))))}
                  className="p-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
                  title="Zoom Out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="font-mono tabular-nums text-slate-700 w-10 text-center">
                  {Math.round(canvasZoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setCanvasZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))))}
                  className="p-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer"
                  title="Zoom In"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                {canvasZoom !== 1 && (
                  <button
                    type="button"
                    onClick={() => setCanvasZoom(1)}
                    className="px-2 py-1 text-[11px] font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer"
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowCropTools((v) => !v)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border font-medium cursor-pointer ${
                    showCropTools || normCrop || Math.abs(rotateDeg) >= 1
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Crop className="w-3.5 h-3.5" />
                  Crop / Tilt
                </button>
              </div>
            </div>

            {/* Automatic Phase A Detection Progress Bar */}
            {detectJob && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 p-3.5 space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-indigo-950">
                    <Loader2 className="w-4 h-4 text-indigo-600 animate-spin shrink-0" />
                    <span>{detectJob.stage}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono tabular-nums text-indigo-700">
                      {Math.round(detectJob.progress)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (detectJob.jobId !== 'pending') cancelProcessingJob(detectJob.jobId);
                        detectAbortRef.current?.abort();
                        setDetectJob(null);
                      }}
                      className="text-slate-600 hover:text-slate-900 underline cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                <div className="w-full h-1.5 bg-indigo-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-600 transition-all duration-200"
                    style={{ width: `${Math.max(8, Math.min(100, detectJob.progress))}%` }}
                  />
                </div>
              </div>
            )}

            {/* Detection Error Banner */}
            {detectError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs text-red-800">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{detectError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => runRegionDetection(activeUpload, computePixelCrop())}
                  className="px-3 py-1.5 bg-red-700 text-white font-semibold rounded-md hover:bg-red-800 cursor-pointer"
                >
                  Retry Detection
                </button>
              </div>
            )}

            {/* Untouched Uploaded Image with Interactive Selectable Region Overlays */}
            <div className="rounded-lg border border-slate-200 bg-checkerboard p-3 sm:p-4 overflow-auto min-h-[300px] max-h-[540px] flex items-center justify-center">
              <div
                className={`relative inline-block select-none origin-center transition-transform ${
                  cropMode ? 'cursor-crosshair' : ''
                }`}
                style={{
                  transform: `scale(${canvasZoom})`,
                }}
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
                  src={imageSrc}
                  alt={activeUpload.filename}
                  referrerPolicy="no-referrer"
                  draggable={false}
                  style={{
                    transform: rotateDeg ? `rotate(${rotateDeg}deg)` : undefined,
                  }}
                  className="max-h-[460px] max-w-full object-contain block"
                />

                {/* Optional Manual Crop Selection Box */}
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
                      Crop Box
                    </span>
                  </div>
                )}

                {/* Detected Numbered Text Region Boxes */}
                {!cropMode &&
                  detectionResult?.regions.map((region) => {
                    const b = region.bbox;
                    const isSelected = selectedRegion?.regionId === region.regionId;
                    const numLabel = String(region.regionNumber).padStart(2, '0');
                    const regionResearch = researchByRegionId[region.regionId];
                    const hasVerified = regionResearch?.outcome === 'verified_exact';

                    return (
                      <button
                        key={region.regionId}
                        type="button"
                        onClick={() => {
                          setSelectedRegionId(region.regionId);
                          setResearchError(null);
                        }}
                        style={{
                          top: `${b.ymin / 10}%`,
                          left: `${b.xmin / 10}%`,
                          height: `${Math.max(3, (b.ymax - b.ymin) / 10)}%`,
                          width: `${Math.max(4, (b.xmax - b.xmin) / 10)}%`,
                        }}
                        title={`${numLabel} · ${region.roleLabel}: "${region.extractedText}"`}
                        className={`group absolute border-2 transition-all cursor-pointer focus:outline-none ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-400/20 ring-2 ring-emerald-500/40 z-20'
                            : 'border-indigo-500/85 bg-indigo-500/10 hover:bg-indigo-500/20 hover:border-indigo-600 z-10'
                        }`}
                      >
                        <span
                          className={`absolute -top-5 left-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold whitespace-nowrap shadow-xs ${
                            isSelected
                              ? 'bg-emerald-600 text-white'
                              : hasVerified
                              ? 'bg-slate-900 text-emerald-300'
                              : 'bg-indigo-600 text-white opacity-95 group-hover:opacity-100'
                          }`}
                        >
                          {numLabel}
                          <span className="hidden sm:inline font-sans font-medium">
                            · {region.roleLabel}
                          </span>
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>

            {/* Optional Crop & Rotation Tools */}
            {showCropTools && (
              <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCropMode((m) => !m)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border font-medium cursor-pointer ${
                        cropMode
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Crop className="w-3.5 h-3.5" />
                      {cropMode ? 'Drawing Crop (Drag on Image)' : 'Draw Manual Crop'}
                    </button>
                    {normCrop && (
                      <button
                        type="button"
                        onClick={() => setNormCrop(null)}
                        className="text-slate-600 hover:text-slate-900 underline cursor-pointer"
                      >
                        Clear Crop
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRotateDeg((d) => ((d - 90 + 540) % 360) - 180)}
                      className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100 cursor-pointer"
                      title="Rotate -90°"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRotateDeg((d) => ((d + 90 + 540) % 360) - 180)}
                      className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100 cursor-pointer"
                      title="Rotate +90°"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCropMode(false);
                        runRegionDetection(activeUpload, computePixelCrop());
                      }}
                      className="px-3 py-1.5 rounded-md bg-indigo-600 text-white font-semibold hover:bg-indigo-700 cursor-pointer ml-1"
                    >
                      Apply &amp; Re-Detect
                    </button>
                  </div>
                </div>

                <label className="block">
                  <div className="flex justify-between text-slate-600 mb-1">
                    <span>Deskew / Rotation Angle</span>
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
            )}

            {/* Touch-Friendly Detected Region Strip */}
            {detectionResult && (
              <div className="space-y-2 pt-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-slate-900">
                    {detectionResult.regions.length > 0
                      ? `Detected Typography Regions (${detectionResult.regions.length})`
                      : 'No Readable Typography Detected'}
                  </span>
                  <span className="text-slate-500">
                    Tap any box on the image or select below to inspect
                  </span>
                </div>

                {detectionResult.regions.length === 0 ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">No distinct readable text found.</div>
                      <p className="mt-0.5 text-amber-800">
                        Try opening Crop / Tilt above to isolate a specific word or deskew rotated lettering, then click Apply &amp; Re-Detect.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {detectionResult.regions.map((region) => {
                      const isSelected = selectedRegion?.regionId === region.regionId;
                      const numLabel = String(region.regionNumber).padStart(2, '0');
                      const rr = researchByRegionId[region.regionId];
                      return (
                        <button
                          key={region.regionId}
                          type="button"
                          onClick={() => {
                            setSelectedRegionId(region.regionId);
                            setResearchError(null);
                          }}
                          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors cursor-pointer max-w-full ${
                            isSelected
                              ? 'bg-emerald-50 border-emerald-400 text-emerald-950 font-semibold'
                              : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          <span
                            className={`font-mono font-bold px-1.5 py-0.5 rounded text-[10px] ${
                              isSelected
                                ? 'bg-emerald-600 text-white'
                                : 'bg-slate-200 text-slate-700'
                            }`}
                          >
                            {numLabel}
                          </span>
                          <span className="truncate max-w-[180px]">
                            {region.roleLabel}: &ldquo;{region.extractedText}&rdquo;
                          </span>
                          {rr?.outcome === 'verified_exact' && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* RIGHT INSPECTOR PANEL: Selected Region Details + Editable OCR + "Find This Font" */}
          <div className="lg:col-span-5 space-y-4">
            {!detectionResult && detectJob ? (
              <div className="bg-white border border-slate-200 rounded-xl p-6 text-center space-y-3">
                <Loader2 className="w-6 h-6 text-indigo-600 animate-spin mx-auto" />
                <div className="text-sm font-bold text-slate-900">
                  Scanning Image for Distinct Typography
                </div>
                <p className="text-xs text-slate-600">
                  Segmenting headlines, subheadings, body copy, and display lettering into selectable regions.
                </p>
              </div>
            ) : selectedRegion ? (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-700">
                      Region {String(selectedRegion.regionNumber).padStart(2, '0')} · {selectedRegion.roleLabel}
                    </div>
                    <h2 className="text-base font-bold text-slate-900 mt-0.5">
                      Selected Typography Inspector
                    </h2>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-slate-500">
                    {selectedRegion.rasterMetrics.widthPx}×{selectedRegion.rasterMetrics.heightPx}px
                  </span>
                </div>

                {/* High-Res Cropped Preview of Selected Region Only */}
                <div className="rounded-lg border border-slate-200 bg-checkerboard p-4 flex items-center justify-center min-h-[110px]">
                  <img
                    src={selectedRegion.cropDataUrl}
                    alt={`Selected crop: ${selectedRegion.extractedText}`}
                    referrerPolicy="no-referrer"
                    className="max-h-32 max-w-full object-contain"
                  />
                </div>

                {/* Quality Warnings if image/crop is blurry/low contrast/tiny */}
                {selectedRegion.imageQualityWarnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      {selectedRegion.imageQualityWarnings.map((w, i) => (
                        <div key={i}>{w}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* User-Editable Extracted Text */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label
                      htmlFor="selected-region-ocr"
                      className="font-semibold text-slate-800"
                    >
                      Extracted Text (Editable Before Search)
                    </label>
                    {editedTextByRegion[selectedRegion.regionId] !== undefined &&
                      editedTextByRegion[selectedRegion.regionId] !== selectedRegion.extractedText && (
                        <button
                          type="button"
                          onClick={() =>
                            setEditedTextByRegion((prev) => {
                              const next = { ...prev };
                              delete next[selectedRegion.regionId];
                              return next;
                            })
                          }
                          className="text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
                        >
                          Reset OCR Text
                        </button>
                      )}
                  </div>
                  <textarea
                    id="selected-region-ocr"
                    rows={2}
                    value={currentExtractedText}
                    onChange={(e) =>
                      setEditedTextByRegion((prev) => ({
                        ...prev,
                        [selectedRegion.regionId]: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 focus:bg-white"
                    placeholder="Correct any OCR characters if needed..."
                  />
                </div>

                {/* Concise Typography Traits Grid */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <div className="text-[11px] text-slate-500">Classification</div>
                    <div className="font-semibold text-slate-900 truncate">
                      {selectedRegion.appearance.primaryClassification}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <div className="text-[11px] text-slate-500">Weight &amp; Posture</div>
                    <div className="font-semibold text-slate-900 truncate">
                      {selectedRegion.appearance.weightEstimate}
                      {selectedRegion.appearance.isItalic ? ' · Italic' : ''}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <div className="text-[11px] text-slate-500">Proportions</div>
                    <div className="font-semibold text-slate-900 truncate">
                      {selectedRegion.appearance.widthClass} · {selectedRegion.letterSpacingEstimate} tracking
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <div className="text-[11px] text-slate-500">Orientation</div>
                    <div className="font-semibold text-slate-900 capitalize truncate">
                      {selectedRegion.orientation}
                      {Math.abs(selectedRegion.rotationDeg) >= 2
                        ? ` (${selectedRegion.rotationDeg.toFixed(0)}°)`
                        : ''}
                    </div>
                  </div>
                </div>

                {selectedRegion.distortionsAndEffects.length > 0 && (
                  <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <span className="font-semibold text-slate-800">Visual Effects Detected:</span>{' '}
                    {selectedRegion.distortionsAndEffects.join(', ')} (ignored during font identification)
                  </div>
                )}

                {/* Collapsible Glyph Anatomy */}
                <div className="border border-slate-200 rounded-lg bg-slate-50/70">
                  <button
                    type="button"
                    onClick={() => setShowGlyphAnatomy((v) => !v)}
                    className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-800 cursor-pointer"
                  >
                    <span>Glyph Anatomy Profile</span>
                    {showGlyphAnatomy ? (
                      <ChevronUp className="w-4 h-4 text-slate-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    )}
                  </button>
                  {showGlyphAnatomy && (
                    <div className="px-3 pb-3 pt-1 border-t border-slate-200 text-xs text-slate-600 space-y-1.5">
                      <div>
                        <strong className="text-slate-800">Serifs:</strong>{' '}
                        {selectedRegion.glyphAnalysis.serifConstruction}
                      </div>
                      <div>
                        <strong className="text-slate-800">Contrast:</strong>{' '}
                        {selectedRegion.glyphAnalysis.strokeContrast} ({selectedRegion.glyphAnalysis.strokeThickness})
                      </div>
                      <div>
                        <strong className="text-slate-800">Terminals:</strong>{' '}
                        {selectedRegion.glyphAnalysis.terminalShapes}
                      </div>
                      <div>
                        <strong className="text-slate-800">Apertures &amp; Bowls:</strong>{' '}
                        {selectedRegion.glyphAnalysis.apertureSize}; {selectedRegion.glyphAnalysis.counterAndBowlShape}
                      </div>
                      {selectedRegion.glyphAnalysis.distinctiveGlyphObservations.length > 0 && (
                        <div>
                          <strong className="text-slate-800">Key Letterforms:</strong>{' '}
                          {selectedRegion.glyphAnalysis.distinctiveGlyphObservations.join(' · ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Primary Action: Find This Font */}
                <button
                  type="button"
                  disabled={Boolean(researchJob) || !currentExtractedText.trim()}
                  onClick={runExactFontResearch}
                  className="w-full py-3 px-5 text-sm font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 shadow-xs cursor-pointer"
                >
                  {researchJob ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Researching Exact Font...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Find This Font
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-6 text-center space-y-2 text-xs text-slate-600">
                <Search className="w-5 h-5 text-slate-400 mx-auto" />
                <div className="font-semibold text-slate-900">Select a Text Region</div>
                <p>
                  Click any numbered region on the image to inspect its extracted text and research its exact original font.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PHASE B: Focused Research Progress, Verified Exact Match OR Strict "Exact font not found" */}
      {activeUpload && selectedRegion && (researchJob || researchError || activeResearchResult) && (
        <div ref={researchOutcomeRef} className="space-y-4 scroll-mt-16">
          {/* Step-by-Step Live Research Progress */}
          {researchJob && (
            <div className="bg-white border border-indigo-200 rounded-xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Researching Exact Original Font for &ldquo;{currentExtractedText}&rdquo;
                    </h3>
                    <p className="text-xs text-slate-500">{researchJob.stage}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono tabular-nums font-semibold text-indigo-700">
                    {Math.round(researchJob.progress)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (researchJob.jobId !== 'pending') {
                        cancelProcessingJob(researchJob.jobId);
                      }
                      researchAbortRef.current?.abort();
                      setResearchJob(null);
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-600 transition-all duration-200"
                  style={{ width: `${Math.max(6, Math.min(100, researchJob.progress))}%` }}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {RESEARCH_STAGES.map((label, idx) => {
                  const stepNum = idx + 1;
                  const isDone = stepNum < researchJob.stageIndex;
                  const isCurrent = stepNum === researchJob.stageIndex;
                  return (
                    <div
                      key={label}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border ${
                        isCurrent
                          ? 'border-indigo-200 bg-indigo-50 text-indigo-900 font-medium'
                          : isDone
                          ? 'border-slate-200 bg-slate-50 text-slate-700'
                          : 'border-slate-100 bg-white text-slate-400'
                      }`}
                    >
                      {isDone ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      ) : isCurrent ? (
                        <Loader2 className="w-3.5 h-3.5 text-indigo-600 animate-spin shrink-0" />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />
                      )}
                      <span className="truncate">{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Research Network / Service Error */}
          {researchError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3 text-xs text-red-800">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-red-900">Font Identification Failed</div>
                  <p className="mt-0.5">{researchError}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={runExactFontResearch}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-700 rounded-lg hover:bg-red-800 cursor-pointer"
              >
                Retry Find This Font
              </button>
            </div>
          )}

          {/* Outcome: VERIFIED EXACT FONT MATCH */}
          {activeResearchResult &&
            activeResearchResult.outcome === 'verified_exact' &&
            activeResearchResult.verifiedMatch && (
              <div className="space-y-4">
                {/* Live Specimen Customization Controls (shown when interactive preview is available) */}
                {activeResearchResult.verifiedMatch.specimenPreview.available && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end text-xs">
                      <div className="lg:col-span-5">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                            <TypeIcon className="w-3.5 h-3.5 text-indigo-600" />
                            Specimen Preview Text
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
                              Reset to Region Text
                            </button>
                          )}
                        </div>
                        <input
                          type="text"
                          value={
                            previewConfig.customText !== null
                              ? previewConfig.customText
                              : activeResearchResult.searchedText
                          }
                          onChange={(e) =>
                            setPreviewConfig((p) => ({ ...p, customText: e.target.value }))
                          }
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500"
                          placeholder="Type custom text to inspect glyphs..."
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

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
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
                )}

                <ExactFontResultCard
                  match={activeResearchResult.verifiedMatch}
                  region={selectedRegion}
                  searchedText={activeResearchResult.searchedText}
                  previewConfig={previewConfig}
                  onOpenSideBySide={() => setCompareOpen(true)}
                  onUseInDesign={handleUseInDesign}
                  onDownloadOption={handleDownloadWithAuthGate}
                />
              </div>
            )}

          {/* Outcome: NOT FOUND (Strict Exact-Match Policy — Never Display Similar Fonts) */}
          {activeResearchResult && activeResearchResult.outcome === 'not_found' && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-6 h-6 text-slate-700 shrink-0 mt-0.5" />
                <div className="space-y-1.5">
                  <h3 className="text-lg font-extrabold text-slate-900">
                    {activeResearchResult.notFoundHeading || 'Exact font not found.'}
                  </h3>
                  <p className="text-sm text-slate-600 max-w-2xl">
                    {activeResearchResult.notFoundMessage ||
                      'We could not verify the original font from the available sources. Try uploading a higher-resolution image or selecting a clearer text region.'}
                  </p>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg bg-slate-50">
                <button
                  type="button"
                  onClick={() => setShowResearchNotes((v) => !v)}
                  className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-semibold text-slate-800 cursor-pointer"
                >
                  <span>
                    Sources Investigated ({activeResearchResult.sourcesInvestigated.length}) &amp; Verification Notes
                  </span>
                  {showResearchNotes ? (
                    <ChevronUp className="w-4 h-4 text-slate-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-500" />
                  )}
                </button>
                {showResearchNotes && (
                  <div className="px-4 pb-4 pt-2 border-t border-slate-200 space-y-3 text-xs text-slate-600">
                    <p>{activeResearchResult.researchSummary}</p>
                    <div className="flex flex-wrap gap-2">
                      {activeResearchResult.sourcesInvestigated.map((s) => (
                        <span
                          key={s.source}
                          className={`px-2.5 py-1 rounded-md border ${
                            s.ok
                              ? 'bg-white border-slate-200 text-slate-700'
                              : 'bg-amber-50 border-amber-200 text-amber-800'
                          }`}
                        >
                          {s.source}: {s.ok ? `${s.count.toLocaleString()} checked` : s.error || 'Unavailable'}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <FontCompareModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        region={selectedRegion}
        verifiedMatch={activeResearchResult?.verifiedMatch || null}
        searchedText={activeResearchResult?.searchedText || currentExtractedText}
        previewConfig={previewConfig}
        onUseInDesign={handleUseInDesign}
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
            await executeVerifiedDownload(pending.match, pending.option);
          }
        }}
        title="Sign in to download font files"
        subtitle="Typography detection and exact font verification are free without an account. Sign in once on this device to download verified font files."
      />
    </div>
  );
};
