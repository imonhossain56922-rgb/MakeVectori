import React from 'react';
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, X } from 'lucide-react';
import type { ProcessingJobState } from '../types/vector.ts';

const VECTOR_STAGES = [
  'Uploading Image',
  'Analyzing Image',
  'Preprocessing',
  'Detecting Shapes and Colors',
  'Generating Vector Paths',
  'Optimizing Geometry',
  'Preparing Output',
  'Completed',
];

const UPSCALE_STAGES = [
  'Loading AI Model',
  'Analyzing Image',
  'Enhancing Details',
  'Upscaling Image',
  'Refining Output',
  'Completed',
];

const BG_STAGES = [
  'Analyzing Image',
  'Detecting Background Region',
  'Refining Edges & Alpha Matte',
  'Feathering & Compositing',
  'Preparing Output',
  'Completed',
];

const FONT_FINDER_STAGES = [
  'Uploading Image',
  'Detecting Text',
  'Extracting Typography',
  'Analyzing Letterforms',
  'Searching Font Databases',
  'Comparing Font Candidates',
  'Verifying Licenses',
  'Preparing Results',
];

interface ProcessingModalProps {
  job: ProcessingJobState | null;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export const ProcessingModal: React.FC<ProcessingModalProps> = ({
  job,
  onCancel,
  onRetry,
  onClose,
}) => {
  if (!job) return null;

  const stages =
    job.jobType === 'upscale'
      ? UPSCALE_STAGES
      : job.jobType === 'remove-background'
      ? BG_STAGES
      : job.jobType === 'font-finder'
      ? FONT_FINDER_STAGES
      : VECTOR_STAGES;

  const title =
    job.jobType === 'upscale'
      ? 'Enhancing & Upscaling Image'
      : job.jobType === 'remove-background'
      ? 'Removing Background'
      : job.jobType === 'font-finder'
      ? 'AI Font Finder Agent Analyzing Typography'
      : 'Converting Pixels Into Vector Paths';

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-xl p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h3 className="text-lg font-bold text-slate-900">{title}</h3>
            <p className="text-xs text-slate-500 mt-1">
              Engine: {job.engine}
            </p>
          </div>
          {(job.status === 'failed' || job.status === 'cancelled' || job.status === 'completed') && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
              aria-label="Close processing dialog"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Progress Bar */}
        <div className="mb-5">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-medium text-slate-700">{job.stage}</span>
            <span className="font-mono tabular-nums text-slate-600">
              {Math.round(job.progress)}%
              {job.isEstimate ? ' (est.)' : ''}
            </span>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-200 ${
                job.status === 'failed'
                  ? 'bg-red-600'
                  : job.status === 'completed'
                  ? 'bg-emerald-600'
                  : 'bg-indigo-600'
              }`}
              style={{ width: `${Math.max(4, Math.min(100, job.progress))}%` }}
            />
          </div>
        </div>

        {/* Stage Checklist */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-6">
          {stages.map((label, idx) => {
            const stepNum = idx + 1;
            const isDone =
              job.status === 'completed' || stepNum < job.stageIndex;
            const isCurrent =
              job.status === 'processing' && stepNum === job.stageIndex;
            return (
              <div
                key={label}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs border ${
                  isCurrent
                    ? 'border-indigo-200 bg-indigo-50/70 text-indigo-900 font-medium'
                    : isDone
                    ? 'border-slate-100 bg-slate-50 text-slate-700'
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

        {job.status === 'failed' && (
          <div className="mb-5 rounded-lg bg-red-50 border border-red-200 p-3.5 flex items-start gap-2.5 text-xs text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{job.error || 'Processing encountered an unexpected error.'}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          {job.status === 'processing' || job.status === 'waiting' ? (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              Cancel Operation
            </button>
          ) : job.status === 'failed' || job.status === 'cancelled' ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
