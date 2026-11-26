import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Loader2,
  Sliders,
  Sparkles,
  Type as TypeIcon,
  Upload,
} from 'lucide-react';
import {
  analyzeImageAi,
  cancelProcessingJob,
  pollJobUntilDone,
  startVectorizeJob,
} from '../lib/apiClient.ts';
import { auth } from '../lib/firebase.ts';
import { saveVectorProjectToFirebase } from '../lib/firestoreService.ts';
import { serializeDocumentToSvg } from '../lib/svgClient.ts';
import {
  DEFAULT_PREPROCESSING,
  DEFAULT_VECTORIZE_OPTIONS,
  PRESET_DEFAULTS,
  type ProcessingJobState,
  type UploadMetadata,
  type VectorDocument,
  type VectorPreset,
  type VectorizeOptions,
} from '../types/vector.ts';
import { UploadDropzone } from '../components/UploadDropzone.tsx';
import { PreprocessPanel } from '../components/PreprocessPanel.tsx';
import { ProcessingModal } from '../components/ProcessingModal.tsx';
import { VectorEditorWorkspace } from '../components/VectorEditorWorkspace.tsx';
import { ExportModal } from '../components/ExportModal.tsx';
import type { AppRoute } from '../components/Navbar.tsx';

interface VectorizerPageProps {
  activeUpload: UploadMetadata | null;
  onSetUpload: (meta: UploadMetadata | null) => void;
  activeVectorDoc: VectorDocument | null;
  onSetVectorDoc: (doc: VectorDocument | null, projectId?: string) => void;
  activeProjectId?: string;
  onNavigate: (route: AppRoute) => void;
}

const PRESETS: Array<{ id: VectorPreset; label: string; desc: string }> = [
  { id: 'logo', label: 'Logo & Branding', desc: 'Sharp edges, accurate flat colors, minimal nodes' },
  { id: 'illustration', label: 'Illustration', desc: 'Full-color tracing with smooth Bezier curves' },
  { id: 'photography', label: 'Photography', desc: 'Multi-color region quantization & fine detail' },
  { id: 'sketch', label: 'Sketch & Line Art', desc: 'Clean outlines with monochrome line extraction' },
  { id: 'screenprint', label: 'Screen Printing', desc: 'Limited color layers & closed print shapes' },
  { id: 'cnc', label: 'Laser Cutting & CNC', desc: 'Clean closed outlines ready for DXF cutting' },
  { id: 'typography', label: 'Text & Typography', desc: 'High corner accuracy for letterforms' },
];

export const VectorizerPage: React.FC<VectorizerPageProps> = ({
  activeUpload,
  onSetUpload,
  activeVectorDoc,
  onSetVectorDoc,
  activeProjectId,
  onNavigate,
}) => {
  const [options, setOptions] = useState<VectorizeOptions>(DEFAULT_VECTORIZE_OPTIONS);
  const [showPreprocess, setShowPreprocess] = useState(false);
  const [analyzingAi, setAnalyzingAi] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [job, setJob] = useState<ProcessingJobState | null>(null);
  const [exportDoc, setExportDoc] = useState<VectorDocument | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const applyPreset = (presetId: VectorPreset) => {
    setOptions((prev) => ({
      ...prev,
      preset: presetId,
      ...PRESET_DEFAULTS[presetId],
    }));
  };

  const runAiAdvisor = async () => {
    if (!activeUpload) return;
    setAnalyzingAi(true);
    setAiNote(null);
    try {
      const rec = await analyzeImageAi(activeUpload.uploadId);
      setOptions((prev) => ({
        ...prev,
        preset: rec.recommendedPreset,
        ...PRESET_DEFAULTS[rec.recommendedPreset],
        colorCount: rec.recommendedColorCount,
        curveSmoothing: rec.curveSmoothing,
        cornerPrecision: rec.cornerPrecision,
        noiseReduction: rec.noiseReduction,
      }));
      setAiNote(`AI Recommended "${rec.recommendedPreset}" (${rec.recommendedColorCount} colors): ${rec.subjectSummary}`);
    } catch (err) {
      setAiNote(err instanceof Error ? err.message : 'AI recommendation unavailable.');
    } finally {
      setAnalyzingAi(false);
    }
  };

  const runVectorization = async () => {
    if (!activeUpload) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setJob({
      jobId: 'pending',
      jobType: 'vectorize',
      status: 'processing',
      stage: 'Uploading Image',
      stageIndex: 1,
      totalStages: 8,
      progress: 5,
      isEstimate: false,
      engine: 'MakeVectorizer Bezier Engine',
    });

    try {
      const jobId = await startVectorizeJob(activeUpload.uploadId, options);
      const completed = await pollJobUntilDone(
        jobId,
        (state) => setJob(state),
        ac.signal
      );

      if (completed.result?.vectorDocument) {
        onSetVectorDoc(completed.result.vectorDocument, activeProjectId);
        setJob(null);
        setTimeout(() => {
          resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 120);
      }
    } catch (err) {
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: 'failed',
              stage: 'Failed',
              error: err instanceof Error ? err.message : 'Vectorization failed.',
            }
          : null
      );
    }
  };

  const handleSaveToDashboard = async (docToSave: VectorDocument) => {
    const user = auth.currentUser;
    if (!user) {
      onNavigate('/signin');
      return;
    }
    if (!user.emailVerified) {
      setSaveMessage('Please verify your email address before saving projects.');
      return;
    }
    setSavingProject(true);
    setSaveMessage(null);
    try {
      const svg = serializeDocumentToSvg(docToSave);
      const projectId = await saveVectorProjectToFirebase({
        user,
        existingProjectId: activeProjectId,
        name: activeUpload?.filename?.replace(/\.[^/.]+$/, '') || 'Vector Artwork',
        folder: 'Vectors',
        width: docToSave.width,
        height: docToSave.height,
        shapeCount: docToSave.shapes.length,
        colorCount: docToSave.palette.length,
        preset: options.preset,
        paletteColors: docToSave.palette.map((p) => p.hex),
        svgContent: svg,
        thumbnailDataUrl: activeUpload?.previewDataUrl,
      });
      onSetVectorDoc(docToSave, projectId);
      setSaveMessage('Saved to your Firestore Dashboard.');
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : 'Unable to save project.');
    } finally {
      setSavingProject(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            AI Image to Vector Converter
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Convert PNG, JPG, WebP, BMP, or GIF into genuine editable Bezier vector paths.
          </p>
        </div>

        {activeUpload && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onSetUpload(null);
                onSetVectorDoc(null);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              New Image
            </button>
            <button
              type="button"
              onClick={runVectorization}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              {activeVectorDoc ? 'Re-Trace Vector' : 'Vectorize Image'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {!activeUpload && !activeVectorDoc ? (
        <UploadDropzone
          onUploaded={(meta) => {
            onSetUpload(meta);
            onSetVectorDoc(null);
          }}
        />
      ) : (
        <>
          {/* Configuration Bar (Collapsible / Always accessible above Editor) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Source Preview & Preprocessing */}
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              {activeUpload && (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-900 truncate max-w-[200px]">
                      {activeUpload.filename}
                    </span>
                    <span className="font-mono tabular-nums text-slate-500">
                      {activeUpload.width}×{activeUpload.height}px
                    </span>
                  </div>
                  <div className="aspect-4/3 rounded-lg border border-slate-200 bg-checkerboard flex items-center justify-center p-3 overflow-hidden">
                    <img
                      src={activeUpload.previewDataUrl}
                      alt={activeUpload.filename}
                      referrerPolicy="no-referrer"
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <button
                      type="button"
                      onClick={runAiAdvisor}
                      disabled={analyzingAi}
                      className="w-full inline-flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-60 transition-colors cursor-pointer"
                    >
                      {analyzingAi ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      Auto-Detect Optimal Settings with AI
                    </button>
                    <button
                      type="button"
                      onClick={() => onNavigate('/font-finder')}
                      className="w-full inline-flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <TypeIcon className="w-3.5 h-3.5 text-indigo-600" />
                      Find Font
                    </button>
                  </div>
                  {aiNote && (
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 leading-relaxed">
                      {aiNote}
                    </div>
                  )}
                </>
              )}

              <div className="pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowPreprocess((s) => !s)}
                  className="w-full flex items-center justify-between text-xs font-semibold text-slate-800 py-1 cursor-pointer"
                >
                  <span>Crop & Image Preprocessing</span>
                  <span className="text-indigo-600">{showPreprocess ? 'Hide' : 'Configure'}</span>
                </button>
                {showPreprocess && activeUpload && (
                  <div className="mt-3">
                    <PreprocessPanel
                      imageWidth={activeUpload.width}
                      imageHeight={activeUpload.height}
                      value={options.preprocessing || DEFAULT_PREPROCESSING}
                      onChange={(prep) => setOptions((o) => ({ ...o, preprocessing: prep }))}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Presets & Vector Quality Controls */}
            <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-6">
              <div>
                <div className="text-xs font-semibold text-slate-900 mb-3 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-indigo-600" />
                  Vectorization Presets
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {PRESETS.map((p) => {
                    const active = options.preset === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyPreset(p.id)}
                        className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                          active
                            ? 'border-indigo-600 bg-indigo-50/70'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="text-xs font-semibold text-slate-900 flex items-center justify-between">
                          <span className="truncate">{p.label}</span>
                          {active && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                          {p.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
                <label className="block">
                  <span className="font-medium text-slate-700">Tracing Engine</span>
                  <select
                    value={options.engine || 'auto'}
                    onChange={(e) =>
                      setOptions((o) => ({
                        ...o,
                        engine: e.target.value as VectorizeOptions['engine'],
                      }))
                    }
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="auto">Auto (Smart Potrace + VTracer)</option>
                    <option value="potrace">Potrace Precision (Logos & Text)</option>
                    <option value="vtracer">VTracer Spline (Shading & Photo)</option>
                    <option value="vtracer-polygon">VTracer Polygon (Sharp Edges)</option>
                  </select>
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">Detail Level</span>
                  <select
                    value={options.detailLevel}
                    onChange={(e) =>
                      setOptions((o) => ({
                        ...o,
                        detailLevel: e.target.value as VectorizeOptions['detailLevel'],
                      }))
                    }
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="low">Low (Fastest / Minimal Paths)</option>
                    <option value="medium">Medium (Balanced)</option>
                    <option value="high">High (Crisp Artwork)</option>
                    <option value="maximum">Maximum (Micro Detail)</option>
                  </select>
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">Color Count</span>
                  <select
                    value={String(options.colorCount)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOptions((o) => ({
                        ...o,
                        colorCount:
                          v === 'auto' || v === 'unlimited'
                            ? v
                            : (Number(v) as VectorizeOptions['colorCount']),
                      }));
                    }}
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="auto">Auto Detect</option>
                    <option value="2">2 Colors (Monochrome)</option>
                    <option value="4">4 Colors</option>
                    <option value="8">8 Colors</option>
                    <option value="16">16 Colors</option>
                    <option value="32">32 Colors</option>
                    <option value="64">64 Colors</option>
                    <option value="128">128 Colors</option>
                    <option value="unlimited">Unlimited</option>
                  </select>
                </label>

                <label className="block">
                  <span className="font-medium text-slate-700">Background Handling</span>
                  <select
                    value={options.backgroundHandling}
                    onChange={(e) =>
                      setOptions((o) => ({
                        ...o,
                        backgroundHandling: e.target.value as VectorizeOptions['backgroundHandling'],
                      }))
                    }
                    className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="keep">Keep Original Background</option>
                    <option value="transparent">Make Background Transparent</option>
                    <option value="remove">Auto-Remove Perimeter BG</option>
                    <option value="white">Solid White Background</option>
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
                {[
                  { key: 'curveSmoothing', label: 'Curve Smoothing' },
                  { key: 'cornerPrecision', label: 'Corner Precision' },
                  { key: 'pathSimplification', label: 'Path Simplification' },
                  { key: 'noiseReduction', label: 'Noise Reduction' },
                  { key: 'shapeComplexity', label: 'Shape Complexity' },
                ].map((slider) => {
                  const val = options[slider.key as keyof VectorizeOptions] as number;
                  return (
                    <label key={slider.key} className="block">
                      <div className="flex justify-between text-slate-700 mb-1">
                        <span>{slider.label}</span>
                        <span className="font-mono tabular-nums text-slate-900 font-semibold">
                          {val}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={val}
                        onChange={(e) =>
                          setOptions((o) => ({
                            ...o,
                            [slider.key]: Number(e.target.value),
                          }))
                        }
                        className="w-full accent-indigo-600"
                      />
                    </label>
                  );
                })}

                <div className="flex flex-col justify-center gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.preserveTransparency}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, preserveTransparency: e.target.checked }))
                      }
                      className="accent-indigo-600"
                    />
                    <span>Preserve Transparency</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.detectPrimitives}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, detectPrimitives: e.target.checked }))
                      }
                      className="accent-indigo-600"
                    />
                    <span>Shape & Rect Recognition</span>
                  </label>
                </div>
              </div>

              <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100">
                <span className="text-xs text-slate-500">
                  {activeVectorDoc
                    ? `Last traced: ${activeVectorDoc.shapes.length} vector paths · ${activeVectorDoc.metadata.totalNodes} nodes · ${activeVectorDoc.metadata.processingMs} ms`
                    : 'Ready to convert pixels into editable Bezier paths'}
                </span>
                <button
                  type="button"
                  onClick={runVectorization}
                  className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
                >
                  {activeVectorDoc ? 'Re-Run Vectorization' : 'Convert to Vector'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {saveMessage && (
            <div className="rounded-lg bg-indigo-50 border border-indigo-200 px-4 py-2.5 text-xs text-indigo-800">
              {saveMessage}
            </div>
          )}

          {/* 3-Panel Vector Editor Workspace */}
          {activeVectorDoc && (
            <div ref={resultRef} className="scroll-mt-20">
              <VectorEditorWorkspace
                key={`${activeUpload?.uploadId || 'doc'}_${activeVectorDoc.shapes.length}_${activeVectorDoc.metadata.totalNodes}_${activeVectorDoc.metadata.processingMs}`}
                initialDocument={activeVectorDoc}
                originalImageUrl={activeUpload?.previewDataUrl}
                filename={activeUpload?.filename || 'vector_artwork.svg'}
                onRequestExport={(doc) => setExportDoc(doc)}
                onRequestSave={handleSaveToDashboard}
                onRequestBgRemove={() => onNavigate('/background-remover')}
                onRequestCrop={() => setShowPreprocess(true)}
                saving={savingProject}
              />
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
        onRetry={runVectorization}
        onClose={() => setJob(null)}
      />

      {exportDoc && (
        <ExportModal
          open={Boolean(exportDoc)}
          onClose={() => setExportDoc(null)}
          document={exportDoc}
          filename={activeUpload?.filename || 'makevectorizer_artwork.svg'}
          projectId={activeProjectId}
        />
      )}
    </div>
  );
};
