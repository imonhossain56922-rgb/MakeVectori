import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Brush, Download, Eraser, RotateCcw, Sparkles, Type as TypeIcon, Upload } from 'lucide-react';
import {
  cancelProcessingJob,
  pollJobUntilDone,
  startBgRemoveJob,
  triggerBrowserDownload,
} from '../lib/apiClient.ts';
import { auth, verifyActiveAuthSession } from '../lib/firebase.ts';
import { logDownloadRecord, saveUpscaleOrBgProjectToFirebase } from '../lib/firestoreService.ts';
import {
  DEFAULT_BG_REMOVE_OPTIONS,
  type BackgroundRemoveOptions,
  type ProcessingJobState,
  type UploadMetadata,
} from '../types/vector.ts';
import { UploadDropzone } from '../components/UploadDropzone.tsx';
import { ProcessingModal } from '../components/ProcessingModal.tsx';
import { BeforeAfterViewer } from '../components/BeforeAfterViewer.tsx';
import { AuthDownloadModal } from '../components/AuthDownloadModal.tsx';
import type { AppRoute } from '../components/Navbar.tsx';

interface BgRemoverPageProps {
  activeUpload: UploadMetadata | null;
  onSetUpload: (meta: UploadMetadata | null) => void;
  onSendToVectorizer: (meta: UploadMetadata) => void;
  onNavigate?: (route: AppRoute) => void;
}

export const BgRemoverPage: React.FC<BgRemoverPageProps> = ({
  activeUpload,
  onSetUpload,
  onSendToVectorizer,
  onNavigate,
}) => {
  const [options, setOptions] = useState<BackgroundRemoveOptions>(DEFAULT_BG_REMOVE_OPTIONS);
  const [brushType, setBrushType] = useState<'none' | 'fg' | 'bg'>('none');
  const [job, setJob] = useState<ProcessingJobState | null>(null);
  const [result, setResult] = useState<{
    imageDataUrl: string;
    uploadId: string;
    width: number;
    height: number;
    byteSize: number;
    engine: string;
    processingMs: number;
  } | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const runRemoval = async () => {
    if (!activeUpload) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setJob({
      jobId: 'pending',
      jobType: 'remove-background',
      status: 'processing',
      stage: 'Analyzing Image',
      stageIndex: 1,
      totalStages: 6,
      progress: 12,
      isEstimate: false,
      engine: 'Edge-Aware Alpha Matting Engine',
    });

    try {
      const jobId = await startBgRemoveJob(activeUpload.uploadId, options);
      const completed = await pollJobUntilDone(jobId, setJob, ac.signal);
      if (completed.result?.imageDataUrl && completed.result.uploadId) {
        const resData = {
          imageDataUrl: completed.result.imageDataUrl,
          uploadId: completed.result.uploadId,
          width: completed.result.outputWidth || activeUpload.width,
          height: completed.result.outputHeight || activeUpload.height,
          byteSize: completed.result.byteSize || 0,
          engine: completed.engine,
          processingMs: completed.result.processingMs || 0,
        };
        setResult(resData);
        setJob(null);

        if (auth.currentUser?.emailVerified) {
          saveUpscaleOrBgProjectToFirebase({
            user: auth.currentUser,
            kind: 'background-removal',
            name: `${activeUpload.filename.replace(/\.[^/.]+$/, '')}_cutout`,
            scaleFactor: 1,
            preset: options.mode,
            engine: resData.engine,
            originalWidth: activeUpload.width,
            originalHeight: activeUpload.height,
            outputWidth: resData.width,
            outputHeight: resData.height,
            thumbnailDataUrl: activeUpload.previewDataUrl,
          }).catch(() => {});
        }
      }
    } catch (err) {
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: 'failed',
              stage: 'Failed',
              error: err instanceof Error ? err.message : 'Background removal failed.',
            }
          : null
      );
    }
  };

  const handleCanvasSeedClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (brushType === 'none') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    if (brushType === 'fg') {
      setOptions((o) => ({
        ...o,
        fgSeeds: [...(o.fgSeeds || []), { x, y }],
      }));
    } else {
      setOptions((o) => ({
        ...o,
        bgSeeds: [...(o.bgSeeds || []), { x, y }],
      }));
    }
  };

  const performDownload = async () => {
    if (!result || !activeUpload) return;
    const res = await fetch(result.imageDataUrl);
    const blob = await res.blob();
    const outName = `${activeUpload.filename.replace(/\.[^/.]+$/, '')}_nobg.png`;
    triggerBrowserDownload(blob, outName);

    if (auth.currentUser?.emailVerified) {
      logDownloadRecord({
        userId: auth.currentUser.uid,
        projectId: `bg_${Date.now()}`,
        projectName: outName,
        format: 'png',
        byteSize: blob.size,
      }).catch(() => {});
    }
  };

  const handleDownload = async () => {
    if (!result || !activeUpload) return;
    const currentUser = auth.currentUser;
    if (!currentUser) {
      setShowAuthModal(true);
      return;
    }
    const { valid } = await verifyActiveAuthSession(currentUser, { force: true });
    if (!valid) {
      setShowAuthModal(true);
      return;
    }
    await performDownload();
  };

  const handleVectorizeCutout = () => {
    if (!result || !activeUpload) return;
    onSendToVectorizer({
      ...activeUpload,
      uploadId: result.uploadId,
      hasAlpha: true,
      previewDataUrl: result.imageDataUrl,
      filename: `${activeUpload.filename.replace(/\.[^/.]+$/, '')}_nobg.png`,
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Smart Background Remover
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Isolate subjects with edge refinement, feather control, manual brush hints, and checkerboard transparency preview.
          </p>
        </div>

        {activeUpload && (
          <button
            type="button"
            onClick={() => {
              onSetUpload(null);
              setResult(null);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer self-start"
          >
            <Upload className="w-3.5 h-3.5" />
            New Image
          </button>
        )}
      </div>

      {!activeUpload ? (
        <UploadDropzone
          onUploaded={(meta) => {
            onSetUpload(meta);
            setResult(null);
          }}
          title="Drop an image to isolate foreground & remove background"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Controls */}
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-5 text-xs">
            <div>
              <div className="font-semibold text-slate-900 mb-2">Detection Mode</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setOptions((o) => ({ ...o, mode: 'auto' }))}
                  className={`py-2 rounded-lg border font-medium cursor-pointer ${
                    options.mode === 'auto'
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                      : 'bg-white border-slate-200 text-slate-600'
                  }`}
                >
                  Auto Detect
                </button>
                <button
                  type="button"
                  onClick={() => setOptions((o) => ({ ...o, mode: 'manual' }))}
                  className={`py-2 rounded-lg border font-medium cursor-pointer ${
                    options.mode === 'manual'
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                      : 'bg-white border-slate-200 text-slate-600'
                  }`}
                >
                  Manual Seeds
                </button>
              </div>
            </div>

            {/* Manual Foreground / Background Brush Seeds */}
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800">Refine Subject / Background</span>
                <button
                  type="button"
                  onClick={() => setOptions((o) => ({ ...o, fgSeeds: [], bgSeeds: [] }))}
                  className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Clear ({(options.fgSeeds?.length || 0) + (options.bgSeeds?.length || 0)})
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setBrushType((b) => (b === 'fg' ? 'none' : 'fg'))}
                  className={`inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border cursor-pointer ${
                    brushType === 'fg'
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  <Brush className="w-3.5 h-3.5" />
                  Keep FG ({options.fgSeeds?.length || 0})
                </button>
                <button
                  type="button"
                  onClick={() => setBrushType((b) => (b === 'bg' ? 'none' : 'bg'))}
                  className={`inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border cursor-pointer ${
                    brushType === 'bg'
                      ? 'bg-red-600 border-red-600 text-white'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  <Eraser className="w-3.5 h-3.5" />
                  Drop BG ({options.bgSeeds?.length || 0})
                </button>
              </div>
              <p className="text-[11px] text-slate-500">
                Activate Keep FG or Drop BG, then click points directly on the source preview to guide removal.
              </p>
            </div>

            {/* Replacement Background */}
            <div>
              <div className="font-semibold text-slate-900 mb-2">Output Background</div>
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { id: 'transparent', label: 'Alpha' },
                  { id: 'white', label: 'White' },
                  { id: 'black', label: 'Black' },
                ].map((bg) => (
                  <button
                    key={bg.id}
                    type="button"
                    onClick={() => setOptions((o) => ({ ...o, bgColor: bg.id }))}
                    className={`py-1.5 rounded-md border font-medium cursor-pointer ${
                      options.bgColor === bg.id
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                        : 'bg-white border-slate-200 text-slate-600'
                    }`}
                  >
                    {bg.label}
                  </button>
                ))}
                <label className="flex items-center justify-center border border-slate-200 rounded-md bg-white cursor-pointer">
                  <input
                    type="color"
                    value={
                      options.bgColor.startsWith('#') ? options.bgColor : '#4f46e5'
                    }
                    onChange={(e) => setOptions((o) => ({ ...o, bgColor: e.target.value }))}
                    className="w-6 h-6 p-0 border-0 bg-transparent cursor-pointer"
                    title="Custom background color"
                  />
                </label>
              </div>
            </div>

            {/* Edge & Feather Controls */}
            <div className="space-y-3">
              <label className="block">
                <div className="flex justify-between text-slate-600 mb-1">
                  <span>Color Tolerance</span>
                  <span className="font-mono tabular-nums text-slate-900">{options.tolerance}</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={80}
                  value={options.tolerance}
                  onChange={(e) => setOptions((o) => ({ ...o, tolerance: Number(e.target.value) }))}
                  className="w-full accent-indigo-600"
                />
              </label>

              <label className="block">
                <div className="flex justify-between text-slate-600 mb-1">
                  <span>Edge Refinement</span>
                  <span className="font-mono tabular-nums text-slate-900">
                    {options.edgeRefinement}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={options.edgeRefinement}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, edgeRefinement: Number(e.target.value) }))
                  }
                  className="w-full accent-indigo-600"
                />
              </label>

              <label className="block">
                <div className="flex justify-between text-slate-600 mb-1">
                  <span>Edge Feather (px)</span>
                  <span className="font-mono tabular-nums text-slate-900">{options.feather}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={12}
                  value={options.feather}
                  onChange={(e) => setOptions((o) => ({ ...o, feather: Number(e.target.value) }))}
                  className="w-full accent-indigo-600"
                />
              </label>

              <label className="flex items-center justify-between pt-1 cursor-pointer">
                <span className="text-slate-700">Hair & Fine-Detail Preservation</span>
                <input
                  type="checkbox"
                  checked={options.preserveHairDetail}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, preserveHairDetail: e.target.checked }))
                  }
                  className="accent-indigo-600"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={runRemoval}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              Remove Background
            </button>
          </div>

          {/* Interactive Seed Canvas & Comparison Viewer */}
          <div className="lg:col-span-8 space-y-4">
            {brushType !== 'none' || !result ? (
              <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col items-center justify-center min-h-[420px]">
                <div className="relative inline-block">
                  <img
                    src={activeUpload.previewDataUrl}
                    alt={activeUpload.filename}
                    referrerPolicy="no-referrer"
                    onClick={handleCanvasSeedClick}
                    className={`max-h-[380px] object-contain rounded-lg border border-slate-200 ${
                      brushType !== 'none' ? 'cursor-crosshair' : ''
                    }`}
                  />
                  {options.fgSeeds?.map((pt, i) => (
                    <span
                      key={`fg_${i}`}
                      style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
                      className="absolute -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-white shadow pointer-events-none"
                    />
                  ))}
                  {options.bgSeeds?.map((pt, i) => (
                    <span
                      key={`bg_${i}`}
                      style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
                      className="absolute -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-red-500 border-2 border-white shadow pointer-events-none"
                    />
                  ))}
                </div>
                {result && brushType !== 'none' && (
                  <button
                    type="button"
                    onClick={() => setBrushType('none')}
                    className="mt-3 text-xs font-medium text-indigo-600 hover:text-indigo-800 cursor-pointer"
                  >
                    Done placing points — View Before/After Result
                  </button>
                )}
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('/font-finder')}
                    className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    <TypeIcon className="w-3.5 h-3.5 text-indigo-600" />
                    Find Font
                  </button>
                )}
              </div>
            ) : (
              <BeforeAfterViewer
                beforeUrl={activeUpload.previewDataUrl}
                afterImageUrl={result.imageDataUrl}
                beforeLabel="Original"
                afterLabel="Background Removed"
                checkerboard={true}
              />
            )}

            {result && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="text-xs">
                  <div className="font-semibold text-slate-900">
                    Cutout Ready ({result.width} × {result.height} px · {(result.byteSize / 1024).toFixed(1)} KB)
                  </div>
                  <div className="text-slate-500 mt-0.5">{result.engine}</div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    Download PNG
                  </button>
                  <button
                    type="button"
                    onClick={handleVectorizeCutout}
                    className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
                  >
                    Vectorize Cutout
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <ProcessingModal
        job={job}
        onCancel={() => {
          if (job?.jobId && job.jobId !== 'pending') cancelProcessingJob(job.jobId);
          abortRef.current?.abort();
          setJob(null);
        }}
        onRetry={runRemoval}
        onClose={() => setJob(null)}
      />

      <AuthDownloadModal
        open={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuthenticated={() => {
          performDownload();
        }}
      />
    </div>
  );
};
