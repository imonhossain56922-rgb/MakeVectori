import React, { useState } from 'react';
import { Columns2, Download, Layers, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCandidateWebfont } from '../lib/fontLoader.ts';
import type {
  FontCandidateMatch,
  FontDownloadOption,
  TextRegionDetection,
} from '../types/vector.ts';
import { applyTextCaseMode, type LivePreviewStyleConfig } from './FontResultCard.tsx';

interface CandidatePreviewPaneProps {
  candidate: FontCandidateMatch;
  region: TextRegionDetection;
  previewConfig: LivePreviewStyleConfig;
  zoom: number;
  onUseInDesign: (candidate: FontCandidateMatch, weight: number, sampleText: string) => void;
  onDownloadOption: (candidate: FontCandidateMatch, option: FontDownloadOption) => Promise<void>;
}

const CandidatePreviewPane: React.FC<CandidatePreviewPaneProps> = ({
  candidate,
  region,
  previewConfig,
  zoom,
  onUseInDesign,
  onDownloadOption,
}) => {
  const isItalic = region.traits.isItalic && candidate.styles.includes('italic');
  const { cssFamily, status } = useCandidateWebfont(
    candidate,
    candidate.recommendedWeight,
    isItalic
  );
  const text = applyTextCaseMode(
    region.extractedText,
    previewConfig.customText,
    previewConfig.caseTransform
  );
  const zipOpt = candidate.downloadFormats[0];

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-900">{candidate.family}</span>
          <span className="font-mono font-semibold text-indigo-700">
            {candidate.confidencePercent}%
          </span>
          <span className="text-slate-500">
            · {status === 'loaded' ? 'Real font loaded' : candidate.matchType === 'exact-paid' ? 'Commercial reference' : 'Loading...'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {candidate.matchType !== 'exact-paid' && (
            <button
              type="button"
              onClick={() =>
                onUseInDesign(candidate, candidate.recommendedWeight, region.extractedText)
              }
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-md hover:bg-indigo-100 cursor-pointer"
            >
              <Layers className="w-3 h-3" />
              Use in Design
            </button>
          )}
          {zipOpt && (
            <button
              type="button"
              onClick={() => onDownloadOption(candidate, zipOpt)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 cursor-pointer"
            >
              <Download className="w-3 h-3" />
              {zipOpt.format}
            </button>
          )}
        </div>
      </div>

      <div
        className="p-6 min-h-[130px] flex items-center justify-center overflow-auto"
        style={{ backgroundColor: previewConfig.bgColor }}
      >
        <div
          style={{
            fontFamily: cssFamily,
            fontSize: `${Math.round(previewConfig.fontSize * zoom)}px`,
            fontWeight: candidate.recommendedWeight || 400,
            fontStyle: isItalic ? 'italic' : 'normal',
            letterSpacing: `${previewConfig.letterSpacingEm}em`,
            lineHeight: previewConfig.lineHeight,
            color: previewConfig.textColor,
            textAlign: previewConfig.align,
            width: '100%',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
};

interface FontCompareModalProps {
  open: boolean;
  onClose: () => void;
  region: TextRegionDetection | null;
  candidates: FontCandidateMatch[];
  previewConfig: LivePreviewStyleConfig;
  onUseInDesign: (candidate: FontCandidateMatch, weight: number, sampleText: string) => void;
  onDownloadOption: (candidate: FontCandidateMatch, option: FontDownloadOption) => Promise<void>;
}

export const FontCompareModal: React.FC<FontCompareModalProps> = ({
  open,
  onClose,
  region,
  candidates,
  previewConfig,
  onUseInDesign,
  onDownloadOption,
}) => {
  const [zoom, setZoom] = useState(1);

  if (!open || !region || candidates.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-6xl max-h-[90vh] bg-white border border-slate-200 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <Columns2 className="w-5 h-5 text-indigo-600" />
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Original vs Candidate Typography Comparison
              </h3>
              <p className="text-xs text-slate-500">
                Extracted text: &ldquo;{region.extractedText}&rdquo; · {candidates.length} candidate{candidates.length > 1 ? 's' : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.2).toFixed(2))))}
              className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
              title="Zoom Out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-700 w-12 text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(2.2, Number((z + 0.2).toFixed(2))))}
              className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
              title="Zoom In"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer ml-2"
              aria-label="Close comparison"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body: Left = Original Uploaded Text Crop, Right = Candidate Live Renders */}
        <div className="p-6 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 lg:sticky lg:top-0 space-y-3">
            <div className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Original Uploaded Typography
            </div>
            <div className="border border-slate-200 rounded-xl bg-checkerboard p-5 flex items-center justify-center min-h-[220px] overflow-auto">
              <img
                src={region.cropDataUrl}
                alt={`Original cropped text: ${region.extractedText}`}
                referrerPolicy="no-referrer"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                className="max-w-full max-h-64 object-contain transition-transform"
              />
            </div>
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1.5">
              <div className="font-semibold text-slate-900">AI Forensic Notes</div>
              <div className="text-slate-600">{region.traits.reasoning}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 pt-1">
                <span>Style: {region.traits.primaryStyle}</span>
                <span>Weight: {region.traits.weightName}</span>
                <span>Contrast: {region.traits.strokeContrast}</span>
                <span>Corners: {region.traits.cornerStyle}</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-4">
            <div className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Candidate Font Live Render ({candidates.length})
            </div>
            {candidates.map((cand) => (
              <CandidatePreviewPane
                key={cand.id}
                candidate={cand}
                region={region}
                previewConfig={previewConfig}
                zoom={zoom}
                onUseInDesign={onUseInDesign}
                onDownloadOption={onDownloadOption}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
