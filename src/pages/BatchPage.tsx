import React, { useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Download,
  Loader2,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  downloadBatchZip,
  pollJobUntilDone,
  startBgRemoveJob,
  startUpscaleJob,
  startVectorizeJob,
  triggerBrowserDownload,
  uploadImageFile,
} from '../lib/apiClient.ts';
import { auth, verifyActiveAuthSession } from '../lib/firebase.ts';
import { dataUrlToBlob } from '../lib/imageUtils.ts';
import { AuthDownloadModal } from '../components/AuthDownloadModal.tsx';
import {
  DEFAULT_BG_REMOVE_OPTIONS,
  DEFAULT_UPSCALE_OPTIONS,
  DEFAULT_VECTORIZE_OPTIONS,
  type BatchQueueItem,
  type VectorPreset,
} from '../types/vector.ts';

export const BatchPage: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<BatchQueueItem[]>([]);
  const [defaultMode, setDefaultMode] = useState<'vectorize' | 'upscale' | 'remove-background'>(
    'vectorize'
  );
  const [running, setRunning] = useState(false);
  const [zipLoading, setZipLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingDownload, setPendingDownload] = useState<(() => void) | null>(null);

  const handleFilesSelected = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    for (const file of Array.from(files)) {
      try {
        const meta = await uploadImageFile(file);
        const item: BatchQueueItem = {
          id: `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          uploadId: meta.uploadId,
          filename: meta.filename,
          previewDataUrl: meta.previewDataUrl,
          width: meta.width,
          height: meta.height,
          mode: defaultMode,
          status: 'waiting',
          progress: 0,
          stage: 'Waiting in queue',
          vectorOptions: { ...DEFAULT_VECTORIZE_OPTIONS },
          upscaleOptions: { ...DEFAULT_UPSCALE_OPTIONS },
          bgOptions: { ...DEFAULT_BG_REMOVE_OPTIONS },
        };
        setItems((prev) => [...prev, item]);
      } catch (err) {
        const label = file.name || 'selected_image';
        setUploadError(
          `${label}: ${err instanceof Error ? err.message : 'Upload failed'}`
        );
      }
    }
  };

  const processSingleItem = async (item: BatchQueueItem) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? { ...it, status: 'processing', progress: 10, stage: 'Starting', error: undefined }
          : it
      )
    );
    try {
      let jobId = '';
      if (item.mode === 'vectorize') {
        jobId = await startVectorizeJob(
          item.uploadId,
          item.vectorOptions || DEFAULT_VECTORIZE_OPTIONS
        );
      } else if (item.mode === 'upscale') {
        jobId = await startUpscaleJob(
          item.uploadId,
          item.upscaleOptions || DEFAULT_UPSCALE_OPTIONS
        );
      } else {
        jobId = await startBgRemoveJob(
          item.uploadId,
          item.bgOptions || DEFAULT_BG_REMOVE_OPTIONS
        );
      }

      const completed = await pollJobUntilDone(jobId, (state) => {
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? { ...it, jobId, progress: state.progress, stage: state.stage }
              : it
          )
        );
      });

      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? {
                ...it,
                status: 'completed',
                progress: 100,
                stage: 'Completed',
                resultSvg: completed.result?.svgContent,
                resultImageDataUrl: completed.result?.imageDataUrl,
                resultVectorDoc: completed.result?.vectorDocument,
              }
            : it
        )
      );
    } catch (err) {
      // Isolated per-item failure: never interrupts remaining batch items
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? {
                ...it,
                status: 'failed',
                stage: 'Failed',
                error: err instanceof Error ? err.message : 'Processing failed.',
              }
            : it
        )
      );
    }
  };

  const runBatchQueue = async () => {
    setRunning(true);
    const pending = items.filter((it) => it.status === 'waiting');
    for (const item of pending) {
      await processSingleItem(item);
    }
    setRunning(false);
  };

  const retryFailed = async () => {
    setRunning(true);
    const failed = items.filter((it) => it.status === 'failed');
    for (const item of failed) {
      await processSingleItem(item);
    }
    setRunning(false);
  };

  const runWithDownloadAuth = async (action: () => Promise<void>) => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      setPendingDownload(() => () => {
        action();
      });
      return;
    }
    const { valid } = await verifyActiveAuthSession(currentUser, { force: true });
    if (!valid) {
      setPendingDownload(() => () => {
        action();
      });
      return;
    }
    await action();
  };

  const performDownloadSingle = async (item: BatchQueueItem) => {
    const base = item.filename.replace(/\.[^/.]+$/, '');
    if (item.resultSvg) {
      const blob = new Blob([item.resultSvg], { type: 'image/svg+xml' });
      triggerBrowserDownload(blob, `${base}.svg`);
    } else if (item.resultImageDataUrl) {
      const blob = dataUrlToBlob(item.resultImageDataUrl, 'image/png');
      triggerBrowserDownload(blob, `${base}_processed.png`);
    }
  };

  const downloadSingle = async (item: BatchQueueItem) => {
    await runWithDownloadAuth(() => performDownloadSingle(item));
  };

  const performDownloadZip = async () => {
    const completed = items.filter((i) => i.status === 'completed');
    if (completed.length === 0) return;
    setZipLoading(true);
    try {
      const blob = await downloadBatchZip(
        completed.map((c) => ({
          filename: c.filename,
          svg: c.resultSvg,
          imageDataUrl: c.resultImageDataUrl,
        }))
      );
      triggerBrowserDownload(blob, 'makevectorizer_batch.zip');
    } finally {
      setZipLoading(false);
    }
  };

  const handleDownloadZip = async () => {
    const completed = items.filter((i) => i.status === 'completed');
    if (completed.length === 0) return;
    await runWithDownloadAuth(performDownloadZip);
  };

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const failedCount = items.filter((i) => i.status === 'failed').length;
  const waitingCount = items.filter((i) => i.status === 'waiting').length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Batch Image Processing Queue
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload multiple files, configure individual vector/upscale/cutout settings, retry failed jobs independently, and download as a ZIP archive.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={defaultMode}
            onChange={(e) =>
              setDefaultMode(e.target.value as 'vectorize' | 'upscale' | 'remove-background')
            }
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg"
          >
            <option value="vectorize">Default: Vectorize (SVG)</option>
            <option value="upscale">Default: 4X Upscale</option>
            <option value="remove-background">Default: Remove BG</option>
          </select>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/heic,image/heif,.png,.jpg,.jpeg,.webp,.bmp,.gif,.heic,.heif"
            className="hidden"
            onChange={(e) => {
              handleFilesSelected(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Add Images
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-xs text-red-700">
          {uploadError}
        </div>
      )}

      {/* Action Bar */}
      {items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4 text-xs text-slate-600 font-mono tabular-nums">
            <span>Total: {items.length}</span>
            <span>Waiting: {waitingCount}</span>
            <span className="text-emerald-700">Completed: {completedCount}</span>
            {failedCount > 0 && <span className="text-red-600">Failed: {failedCount}</span>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {failedCount > 0 && (
              <button
                type="button"
                disabled={running}
                onClick={retryFailed}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 disabled:opacity-50 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry Failed ({failedCount})
              </button>
            )}
            <button
              type="button"
              disabled={running || waitingCount === 0}
              onClick={runBatchQueue}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 cursor-pointer"
            >
              {running ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              Process Queue ({waitingCount})
            </button>
            <button
              type="button"
              disabled={completedCount === 0 || zipLoading}
              onClick={handleDownloadZip}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
            >
              {zipLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Archive className="w-3.5 h-3.5" />
              )}
              Download All ZIP ({completedCount})
            </button>
          </div>
        </div>
      )}

      {/* Queue List */}
      {items.length === 0 ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFilesSelected(e.dataTransfer.files);
          }}
          className="border-2 border-dashed border-slate-300 rounded-xl bg-slate-50/70 p-12 text-center"
        >
          <p className="text-sm font-semibold text-slate-900 mb-1">
            Drop multiple PNG, JPG, WebP, BMP, or GIF images here
          </p>
          <p className="text-xs text-slate-500 mb-5">
            Each image runs independently—one error will never stop the rest of your batch.
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            Select Multiple Images
          </button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200 overflow-hidden">
          {items.map((item) => (
            <div
              key={item.id}
              className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={item.previewDataUrl}
                  alt={item.filename}
                  referrerPolicy="no-referrer"
                  className="w-12 h-12 rounded-lg border border-slate-200 object-contain bg-checkerboard shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">
                    {item.filename}
                  </div>
                  <div className="text-xs text-slate-500 font-mono tabular-nums">
                    {item.width}×{item.height}px · {item.stage}
                  </div>
                  {item.error && (
                    <div className="text-xs text-red-600 mt-0.5">{item.error}</div>
                  )}
                </div>
              </div>

              {/* Per-item Configuration */}
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <select
                  disabled={item.status === 'processing'}
                  value={item.mode}
                  onChange={(e) => {
                    const nextMode = e.target.value as BatchQueueItem['mode'];
                    setItems((prev) =>
                      prev.map((it) =>
                        it.id === item.id ? { ...it, mode: nextMode, status: 'waiting', progress: 0 } : it
                      )
                    );
                  }}
                  className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-md"
                >
                  <option value="vectorize">Vectorize (SVG)</option>
                  <option value="upscale">AI Upscale</option>
                  <option value="remove-background">Remove BG</option>
                </select>

                {item.mode === 'vectorize' && (
                  <select
                    disabled={item.status === 'processing'}
                    value={item.vectorOptions?.preset || 'logo'}
                    onChange={(e) => {
                      const preset = e.target.value as VectorPreset;
                      setItems((prev) =>
                        prev.map((it) =>
                          it.id === item.id
                            ? {
                                ...it,
                                vectorOptions: {
                                  ...(it.vectorOptions || DEFAULT_VECTORIZE_OPTIONS),
                                  preset,
                                },
                              }
                            : it
                        )
                      );
                    }}
                    className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-md"
                  >
                    <option value="logo">Logo</option>
                    <option value="illustration">Illustration</option>
                    <option value="photography">Photo</option>
                    <option value="sketch">Sketch</option>
                    <option value="screenprint">Screen Print</option>
                    <option value="cnc">CNC / Laser</option>
                    <option value="typography">Typography</option>
                  </select>
                )}

                {item.mode === 'upscale' && (
                  <select
                    disabled={item.status === 'processing'}
                    value={item.upscaleOptions?.scaleFactor || 4}
                    onChange={(e) => {
                      const scale = Number(e.target.value) as 1 | 2 | 3 | 4;
                      setItems((prev) =>
                        prev.map((it) =>
                          it.id === item.id
                            ? {
                                ...it,
                                upscaleOptions: {
                                  ...(it.upscaleOptions || DEFAULT_UPSCALE_OPTIONS),
                                  scaleFactor: scale,
                                },
                              }
                            : it
                        )
                      );
                    }}
                    className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-md font-mono"
                  >
                    <option value={2}>2X</option>
                    <option value={3}>3X</option>
                    <option value={4}>4X</option>
                  </select>
                )}

                {/* Status Indicator */}
                <div className="w-28 flex items-center gap-1.5 font-medium">
                  {item.status === 'completed' ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                      <CheckCircle2 className="w-4 h-4" />
                      Completed
                    </span>
                  ) : item.status === 'failed' ? (
                    <span className="inline-flex items-center gap-1 text-red-600">
                      <XCircle className="w-4 h-4" />
                      Failed
                    </span>
                  ) : item.status === 'processing' ? (
                    <span className="inline-flex items-center gap-1 text-indigo-600 font-mono tabular-nums">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {Math.round(item.progress)}%
                    </span>
                  ) : (
                    <span className="text-slate-500">Waiting</span>
                  )}
                </div>

                {/* Actions */}
                {item.status === 'completed' && (
                  <button
                    type="button"
                    onClick={() => downloadSingle(item)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                )}
                {item.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => processSingleItem(item)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-amber-50 text-amber-700 hover:bg-amber-100 font-medium cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setItems((prev) => prev.filter((it) => it.id !== item.id))}
                  className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                  title="Remove from queue"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AuthDownloadModal
        open={Boolean(pendingDownload)}
        onClose={() => setPendingDownload(null)}
        onAuthenticated={() => {
          const fn = pendingDownload;
          setPendingDownload(null);
          fn?.();
        }}
      />
    </div>
  );
};
