import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Download, Info, Layers, Type as TypeIcon, Upload } from 'lucide-react';
import {
  cancelProcessingJob,
  fetchEngineHealth,
  pollJobUntilDone,
  startUpscaleJob,
  triggerBrowserDownload,
} from '../lib/apiClient.ts';
import { auth, verifyActiveAuthSession } from '../lib/firebase.ts';
import { logDownloadRecord, saveUpscaleOrBgProjectToFirebase } from '../lib/firestoreService.ts';
import {
  DEFAULT_UPSCALE_OPTIONS,
  type ProcessingJobState,
  type UploadMetadata,
  type UpscaleFactor,
  type UpscaleOptions,
  type UpscalePreset,
} from '../types/vector.ts';
import { UploadDropzone } from '../components/UploadDropzone.tsx';
import { ProcessingModal } from '../components/ProcessingModal.tsx';
import { BeforeAfterViewer } from '../components/BeforeAfterViewer.tsx';
import { AuthDownloadModal } from '../components/AuthDownloadModal.tsx';
import type { AppRoute } from '../components/Navbar.tsx';

interface UpscalerPageProps {
  activeUpload: UploadMetadata | null;
  onSetUpload: (meta: UploadMetadata | null) => void;
  onSendToVectorizer: (meta: UploadMetadata) => void;
  onNavigate: (route: AppRoute) => void;
}

const UPSCALE_PRESET_VALUES: Record<UpscalePreset, Partial<UpscaleOptions>> = {
  standard: {
    detailRecovery: 48,
    sharpness: 38,
    noiseReduction: 30,
    textureEnhancement: 35,
    edgeEnhancement: 45,
    artifactRemoval: 35,
    colorRestoration: 20,
  },
  'high-quality': {
    detailRecovery: 72,
    sharpness: 58,
    noiseReduction: 45,
    textureEnhancement: 55,
    edgeEnhancement: 68,
    artifactRemoval: 55,
    colorRestoration: 35,
  },
  'maximum-detail': {
    detailRecovery: 92,
    sharpness: 76,
    noiseReduction: 60,
    textureEnhancement: 80,
    edgeEnhancement: 85,
    artifactRemoval: 75,
    colorRestoration: 50,
  },
};

export const UpscalerPage: React.FC<UpscalerPageProps> = ({
  activeUpload,
  onSetUpload,
  onSendToVectorizer,
  onNavigate,
}) => {
  const [options, setOptions] = useState<UpscaleOptions>(DEFAULT_UPSCALE_OPTIONS);
  const [job, setJob] = useState<ProcessingJobState | null>(null);
  const [result, setResult] = useState<{
    imageDataUrl: string;
    uploadId: string;
    originalWidth: number;
    originalHeight: number;
    outputWidth: number;
    outputHeight: number;
    byteSize: number;
    mimeType: string;
    engine: string;
    processingMs: number;
  } | null>(null);
  const [engineBanner, setEngineBanner] = useState<string>('');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchEngineHealth()
      .then((h) => setEngineBanner(h.engines.upscaler.name))
      .catch(() => {});
    return () => abortRef.current?.abort();
  }, []);

  const applyPreset = (preset: UpscalePreset) => {
    setOptions((prev) => ({
      ...prev,
      preset,
      ...UPSCALE_PRESET_VALUES[preset],
    }));
  };

  const runUpscale = async () => {
    if (!activeUpload) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setJob({
      jobId: 'pending',
      jobType: 'upscale',
      status: 'processing',
      stage: 'Loading AI Model',
      stageIndex: 1,
      totalStages: 6,
      progress: 8,
      isEstimate: false,
      engine: engineBanner || 'Server Super-Resolution Engine',
    });

    try {
      const jobId = await startUpscaleJob(activeUpload.uploadId, options);
      const completed = await pollJobUntilDone(jobId, setJob, ac.signal);
      if (completed.result?.imageDataUrl && completed.result.uploadId) {
        const resData = {
          imageDataUrl: completed.result.imageDataUrl,
          uploadId: completed.result.uploadId,
          originalWidth: completed.result.originalWidth || activeUpload.width,
          originalHeight: completed.result.originalHeight || activeUpload.height,
          outputWidth:
            completed.result.outputWidth || activeUpload.width * options.scaleFactor,
          outputHeight:
            completed.result.outputHeight || activeUpload.height * options.scaleFactor,
          byteSize: completed.result.byteSize || 0,
          mimeType: completed.result.mimeType || 'image/png',
          engine: completed.engine,
          processingMs: completed.result.processingMs || 0,
        };
        setResult(resData);
        setJob(null);

        if (auth.currentUser?.emailVerified) {
          saveUpscaleOrBgProjectToFirebase({
            user: auth.currentUser,
            kind: 'upscale',
            name: `${activeUpload.filename.replace(/\.[^/.]+$/, '')}_${options.scaleFactor}x`,
            scaleFactor: options.scaleFactor,
            preset: options.preset,
            engine: resData.engine,
            originalWidth: resData.originalWidth,
            originalHeight: resData.originalHeight,
            outputWidth: resData.outputWidth,
            outputHeight: resData.outputHeight,
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
              error: err instanceof Error ? err.message : 'Upscaling failed.',
            }
          : null
      );
    }
  };

  const performDownloadResult = async () => {
    if (!result || !activeUpload) return;
    const res = await fetch(result.imageDataUrl);
    const blob = await res.blob();
    const base = activeUpload.filename.replace(/\.[^/.]+$/, '');
    const outName = `${base}_${options.scaleFactor}x.${options.outputFormat}`;
    triggerBrowserDownload(blob, outName);

    if (auth.currentUser?.emailVerified) {
      logDownloadRecord({
        userId: auth.currentUser.uid,
        projectId: `ups_${Date.now()}`,
        projectName: outName,
        format: options.outputFormat,
        byteSize: blob.size,
      }).catch(() => {});
    }
  };

  const handleDownloadResult = async () => {
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
    await performDownloadResult();
  };

  const handleVectorizeEnhanced = () => {
    if (!result || !activeUpload) return;
    onSendToVectorizer({
      ...activeUpload,
      uploadId: result.uploadId,
      width: result.outputWidth,
      height: result.outputHeight,
      previewDataUrl: result.imageDataUrl,
      filename: `${activeUpload.filename.replace(/\.[^/.]+$/, '')}_${options.scaleFactor}x.png`,
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            AI 4X Image Upscaler & Detail Enhancer
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Upscale images 2X, 3X, or 4X with aspect ratio lock, alpha preservation, and direct vectorization chaining.
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
            Upload Different Image
          </button>
        )}
      </div>

      {engineBanner && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600 flex items-center gap-2">
          <Info className="w-4 h-4 text-indigo-600 shrink-0" />
          <span>
            Active Super-Resolution Engine: <strong className="text-slate-900">{engineBanner}</strong>
            {!engineBanner.includes('Real-ESRGAN') &&
              ' — Set PROCESSING_WORKER_URL in environment to route 4X jobs to the GPU Real-ESRGAN Cloud Run container.'}
          </span>
        </div>
      )}

      {!activeUpload ? (
        <UploadDropzone
          onUploaded={(meta) => {
            onSetUpload(meta);
            setResult(null);
          }}
          title="Drop a raster image to enhance & upscale up to 4X"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Controls Sidebar */}
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-5 text-xs">
            {/* Dimensions Summary */}
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
              <div className="flex justify-between text-slate-600">
                <span>Original Dimensions</span>
                <span className="font-mono tabular-nums font-semibold text-slate-900">
                  {activeUpload.width} × {activeUpload.height} px
                </span>
              </div>
              <div className="flex justify-between text-indigo-700">
                <span>Target Output ({options.scaleFactor}X)</span>
                <span className="font-mono tabular-nums font-bold">
                  {activeUpload.width * options.scaleFactor} ×{' '}
                  {activeUpload.height * options.scaleFactor} px
                </span>
              </div>
            </div>

            {/* Scale Factor */}
            <div>
              <div className="font-semibold text-slate-900 mb-2">Scale Multiplier</div>
              <div className="grid grid-cols-4 gap-2">
                {([1, 2, 3, 4] as UpscaleFactor[]).map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    onClick={() => setOptions((o) => ({ ...o, scaleFactor: scale }))}
                    className={`py-2 rounded-lg border font-mono font-bold transition-colors cursor-pointer ${
                      options.scaleFactor === scale
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {scale}X
                  </button>
                ))}
              </div>
            </div>

            {/* Enhancement Presets */}
            <div>
              <div className="font-semibold text-slate-900 mb-2">Enhancement Preset</div>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'standard', label: 'Standard' },
                    { id: 'high-quality', label: 'High Quality' },
                    { id: 'maximum-detail', label: 'Max Detail' },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p.id)}
                    className={`py-2 px-2 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                      options.preset === p.id
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 7 Sliders + Face Enhancement */}
            <div className="space-y-2.5">
              {[
                { key: 'detailRecovery', label: 'Detail Recovery' },
                { key: 'sharpness', label: 'Sharpness' },
                { key: 'noiseReduction', label: 'Noise Reduction' },
                { key: 'textureEnhancement', label: 'Texture Enhancement' },
                { key: 'edgeEnhancement', label: 'Edge Enhancement' },
                { key: 'artifactRemoval', label: 'Artifact Removal' },
                { key: 'colorRestoration', label: 'Color Restoration' },
              ].map((ctrl) => {
                const val = options[ctrl.key as keyof UpscaleOptions] as number;
                return (
                  <label key={ctrl.key} className="block">
                    <div className="flex justify-between text-slate-600 mb-0.5">
                      <span>{ctrl.label}</span>
                      <span className="font-mono tabular-nums text-slate-900">{val}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={val}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, [ctrl.key]: Number(e.target.value) }))
                      }
                      className="w-full accent-indigo-600"
                    />
                  </label>
                );
              })}

              <label className="flex items-center justify-between pt-1 cursor-pointer">
                <span className="text-slate-700">Face Enhancement (Optional)</span>
                <input
                  type="checkbox"
                  checked={options.faceEnhancement}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, faceEnhancement: e.target.checked }))
                  }
                  className="accent-indigo-600"
                />
              </label>
            </div>

            {/* Output Format */}
            <div>
              <div className="font-semibold text-slate-900 mb-1.5">Output Format</div>
              <div className="grid grid-cols-3 gap-2">
                {(['png', 'jpg', 'webp'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setOptions((o) => ({ ...o, outputFormat: fmt }))}
                    className={`py-1.5 rounded-lg border uppercase font-semibold cursor-pointer ${
                      options.outputFormat === fmt
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                        : 'bg-white border-slate-200 text-slate-600'
                    }`}
                  >
                    {fmt}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={runUpscale}
              className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              Upscale {options.scaleFactor}X Now
            </button>
          </div>

          {/* Preview & Result Canvas */}
          <div className="lg:col-span-8 space-y-4">
            {result ? (
              <>
                <BeforeAfterViewer
                  beforeUrl={activeUpload.previewDataUrl}
                  afterImageUrl={result.imageDataUrl}
                  beforeLabel={`Original (${result.originalWidth}×${result.originalHeight})`}
                  afterLabel={`Upscaled ${options.scaleFactor}X (${result.outputWidth}×${result.outputHeight})`}
                />

                <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="text-xs space-y-1">
                    <div className="font-semibold text-slate-900">
                      Output Ready: {result.outputWidth} × {result.outputHeight} px ({(result.byteSize / 1024).toFixed(1)} KB)
                    </div>
                    <div className="text-slate-500">
                      Processed in {result.processingMs} ms · {result.engine}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleDownloadResult}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      Download {options.outputFormat.toUpperCase()}
                    </button>
                    <button
                      type="button"
                      onClick={handleVectorizeEnhanced}
                      className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
                    >
                      <Layers className="w-4 h-4" />
                      Vectorize Enhanced Image
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col items-center justify-center min-h-[440px] gap-4">
                <img
                  src={activeUpload.previewDataUrl}
                  alt={activeUpload.filename}
                  referrerPolicy="no-referrer"
                  className="max-h-[340px] object-contain rounded-lg border border-slate-100"
                />
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => onNavigate('/font-finder')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    <TypeIcon className="w-3.5 h-3.5 text-indigo-600" />
                    Find Font
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Choose 2X, 3X, or 4X and click &ldquo;Upscale {options.scaleFactor}X Now&rdquo; to inspect the before/after comparison.
                </p>
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
        onRetry={runUpscale}
        onClose={() => setJob(null)}
      />

      <AuthDownloadModal
        open={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuthenticated={() => {
          performDownloadResult();
        }}
      />
    </div>
  );
};
