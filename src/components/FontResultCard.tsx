import React, { useState } from 'react';
import {
  Check,
  Columns2,
  Download,
  ExternalLink,
  Heart,
  Layers,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useCandidateWebfont } from '../lib/fontLoader.ts';
import type {
  FontCandidateMatch,
  FontDownloadOption,
  TextRegionDetection,
} from '../types/vector.ts';

export interface LivePreviewStyleConfig {
  customText: string | null; // null => use exact extracted text from image
  caseTransform: 'exact' | 'upper' | 'lower' | 'title' | 'digits';
  fontSize: number;
  letterSpacingEm: number;
  lineHeight: number;
  textColor: string;
  bgColor: string;
  align: 'left' | 'center' | 'right';
  wideCard: boolean;
}

interface FontResultCardProps {
  candidate: FontCandidateMatch;
  region: TextRegionDetection;
  previewConfig: LivePreviewStyleConfig;
  isFavorite: boolean;
  isSelectedForCompare: boolean;
  onToggleFavorite: () => void;
  onToggleCompare: () => void;
  onOpenSideBySide: (candidate: FontCandidateMatch) => void;
  onUseInDesign: (candidate: FontCandidateMatch, weight: number, sampleText: string) => void;
  onDownloadOption: (candidate: FontCandidateMatch, option: FontDownloadOption) => Promise<void>;
}

export function applyTextCaseMode(
  extractedText: string,
  customText: string | null,
  mode: LivePreviewStyleConfig['caseTransform']
): string {
  const base = customText !== null ? customText : extractedText;
  if (mode === 'upper') return base.toUpperCase();
  if (mode === 'lower') return base.toLowerCase();
  if (mode === 'title') {
    return base.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
  }
  if (mode === 'digits') {
    return `${base}  0123456789  &!?@#%`;
  }
  return base;
}

export const FontResultCard: React.FC<FontResultCardProps> = ({
  candidate,
  region,
  previewConfig,
  isFavorite,
  isSelectedForCompare,
  onToggleFavorite,
  onToggleCompare,
  onOpenSideBySide,
  onUseInDesign,
  onDownloadOption,
}) => {
  const [selectedWeight, setSelectedWeight] = useState<number>(candidate.recommendedWeight || 400);
  const [downloadingFmt, setDownloadingFmt] = useState<string | null>(null);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  const isItalic = region.traits.isItalic && candidate.styles.includes('italic');
  const { cssFamily, status: fontLoadStatus } = useCandidateWebfont(
    candidate,
    selectedWeight,
    isItalic
  );

  const renderedText = applyTextCaseMode(
    region.extractedText,
    previewConfig.customText,
    previewConfig.caseTransform
  );

  const licenseTone =
    candidate.licenseClass === 'Free for Personal and Commercial Use'
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : candidate.licenseClass === 'Free for Personal Use Only'
      ? 'text-amber-800 bg-amber-50 border-amber-200'
      : candidate.licenseClass === 'Paid Font'
      ? 'text-rose-700 bg-rose-50 border-rose-200'
      : 'text-slate-700 bg-slate-100 border-slate-200';

  const handleDownloadClick = async (opt: FontDownloadOption) => {
    setDownloadErr(null);
    setDownloadingFmt(opt.format);
    try {
      await onDownloadOption(candidate, opt);
    } catch (err) {
      setDownloadErr(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingFmt(null);
    }
  };

  return (
    <div
      className={`bg-white border rounded-xl overflow-hidden transition-colors ${
        candidate.isExactMatch
          ? 'border-indigo-300 shadow-xs'
          : isSelectedForCompare
          ? 'border-indigo-400'
          : 'border-slate-200'
      }`}
    >
      {/* Top Metadata Header */}
      <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h4 className="text-base font-bold text-slate-900 tracking-tight">
              {candidate.family}
            </h4>
            <span className="text-xs font-mono tabular-nums font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md">
              {candidate.confidencePercent}% Match
            </span>
            {candidate.matchType === 'exact-free' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                <Sparkles className="w-3 h-3" />
                Exact Match
              </span>
            )}
            {candidate.matchType === 'exact-paid' && (
              <span className="text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md">
                Exact Paid Match
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{candidate.primaryCategory}</span>
            <span>·</span>
            <span>By {candidate.designer}</span>
            <span>·</span>
            <span>{candidate.source}</span>
          </div>
        </div>

        {/* Right Controls: License Badge + Favorite + Compare Checkbox */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md border ${licenseTone}`}
          >
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            {candidate.licenseClass}
          </span>

          <button
            type="button"
            onClick={onToggleFavorite}
            className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
              isFavorite
                ? 'border-rose-200 bg-rose-50 text-rose-600'
                : 'border-slate-200 bg-white text-slate-400 hover:text-rose-500'
            }`}
            title={isFavorite ? 'Remove favorite' : 'Save to favorites'}
          >
            <Heart className={`w-4 h-4 ${isFavorite ? 'fill-rose-500' : ''}`} />
          </button>

          <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isSelectedForCompare}
              onChange={onToggleCompare}
              className="accent-indigo-600"
            />
            <span>Compare</span>
          </label>
        </div>
      </div>

      {/* MANDATORY LIVE FONT PREVIEW PANEL — Uses Exact Image Text + Real Loaded Font */}
      <div className="px-5 py-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-700">Live Font Preview</span>
            {candidate.matchType === 'exact-paid' ? (
              <span className="text-rose-600">
                (Commercial font file not hosted — compare free verified alternatives below)
              </span>
            ) : fontLoadStatus === 'loading' ? (
              <span className="inline-flex items-center gap-1 text-indigo-600">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading real webfont...
              </span>
            ) : fontLoadStatus === 'loaded' ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <Check className="w-3 h-3" />
                Authentic {candidate.family} glyphs loaded
              </span>
            ) : (
              <span className="text-amber-700">
                Webfont CDN unavailable in browser preview
              </span>
            )}
          </div>

          {/* Per-card Weight Selector */}
          {candidate.weights.length > 1 && (
            <div className="flex items-center gap-1.5">
              <span>Weight:</span>
              <select
                value={selectedWeight}
                onChange={(e) => setSelectedWeight(Number(e.target.value))}
                className="px-2 py-0.5 border border-slate-200 rounded bg-white text-slate-800 font-mono text-[11px]"
              >
                {candidate.weights.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div
          className="rounded-lg border border-slate-200 px-5 py-6 overflow-x-auto transition-colors"
          style={{
            backgroundColor: previewConfig.bgColor,
            textAlign: previewConfig.align,
          }}
        >
          <div
            style={{
              fontFamily: cssFamily,
              fontSize: `${previewConfig.fontSize}px`,
              fontWeight: selectedWeight,
              fontStyle: isItalic ? 'italic' : 'normal',
              letterSpacing: `${previewConfig.letterSpacingEm}em`,
              lineHeight: previewConfig.lineHeight,
              color: previewConfig.textColor,
              wordBreak: 'break-word',
            }}
          >
            {renderedText || region.extractedText}
          </div>
        </div>

        {/* Similarity Breakdown & Match Reasons */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 text-[11px]">
          <div className="p-2 rounded-md bg-slate-50 border border-slate-100">
            <div className="text-slate-500">Shape Match</div>
            <div className="font-mono font-bold text-slate-900 tabular-nums">
              {candidate.similarityBreakdown.shapeSimilarity}%
            </div>
          </div>
          <div className="p-2 rounded-md bg-slate-50 border border-slate-100">
            <div className="text-slate-500">Weight</div>
            <div className="font-mono font-bold text-slate-900 tabular-nums">
              {candidate.similarityBreakdown.weightMatch}%
            </div>
          </div>
          <div className="p-2 rounded-md bg-slate-50 border border-slate-100">
            <div className="text-slate-500">Width</div>
            <div className="font-mono font-bold text-slate-900 tabular-nums">
              {candidate.similarityBreakdown.widthMatch}%
            </div>
          </div>
          <div className="p-2 rounded-md bg-slate-50 border border-slate-100">
            <div className="text-slate-500">Style</div>
            <div className="font-mono font-bold text-slate-900 tabular-nums">
              {candidate.similarityBreakdown.styleMatch}%
            </div>
          </div>
          <div className="p-2 rounded-md bg-slate-50 border border-slate-100 col-span-2 sm:col-span-1">
            <div className="text-slate-500">License</div>
            <div className="font-semibold text-slate-900 truncate" title={candidate.licenseName}>
              {candidate.licenseName}
            </div>
          </div>
        </div>

        {candidate.matchReasons.length > 0 && (
          <div className="text-xs text-slate-600 space-y-0.5 pt-1">
            {candidate.matchReasons.map((reason, idx) => (
              <div key={idx}>· {reason}</div>
            ))}
          </div>
        )}

        {downloadErr && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {downloadErr}
          </div>
        )}
      </div>

      {/* Footer Actions: Side-by-Side Compare, Use Font in Design, Official Link, Downloads */}
      <div className="px-5 py-3.5 bg-slate-50/80 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenSideBySide(candidate)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <Columns2 className="w-3.5 h-3.5 text-indigo-600" />
            Compare vs Original
          </button>

          {candidate.matchType !== 'exact-paid' && (
            <button
              type="button"
              onClick={() => onUseInDesign(candidate, selectedWeight, region.extractedText)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5" />
              Use Font in Design
            </button>
          )}

          {candidate.officialUrl && (
            <a
              href={candidate.officialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-indigo-700"
            >
              Official Page
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        {/* Download Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {candidate.downloadFormats.length > 0 ? (
            candidate.downloadFormats.map((opt) => (
              <button
                key={opt.format}
                type="button"
                disabled={downloadingFmt !== null}
                onClick={() => handleDownloadClick(opt)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
                  opt.format === 'ZIP'
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {downloadingFmt === opt.format ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                {opt.format === 'ZIP' ? 'Download Font ZIP' : opt.format}
              </button>
            ))
          ) : (
            <span className="text-[11px] font-medium text-slate-500">
              No free binary download available
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
