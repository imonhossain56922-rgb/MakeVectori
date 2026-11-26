import React, { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  Download,
  ExternalLink,
  Info,
  Layers,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useCandidateWebfont } from '../lib/fontLoader.ts';
import type {
  DetectedTextRegion,
  FontDownloadOption,
  VerifiedExactFontMatch,
} from '../types/vector.ts';

export interface LivePreviewStyleConfig {
  customText: string | null; // null => use exact extracted/edited text from region
  caseTransform: 'exact' | 'upper' | 'lower' | 'title' | 'digits';
  fontSize: number;
  letterSpacingEm: number;
  lineHeight: number;
  textColor: string;
  bgColor: string;
  align: 'left' | 'center' | 'right';
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
    return `${base}\n0123456789 &!?@#%`;
  }
  return base;
}

interface ExactFontResultCardProps {
  match: VerifiedExactFontMatch;
  region: DetectedTextRegion;
  searchedText: string;
  previewConfig: LivePreviewStyleConfig;
  onOpenSideBySide: () => void;
  onUseInDesign?: (match: VerifiedExactFontMatch, sampleText: string) => void;
  onDownloadOption: (match: VerifiedExactFontMatch, option: FontDownloadOption) => Promise<void>;
}

export const ExactFontResultCard: React.FC<ExactFontResultCardProps> = ({
  match,
  region,
  searchedText,
  previewConfig,
  onOpenSideBySide,
  onUseInDesign,
  onDownloadOption,
}) => {
  const [downloadingFmt, setDownloadingFmt] = useState<string | null>(null);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  const { cssFamily, status: fontLoadStatus } = useCandidateWebfont(
    match,
    match.weight || 400,
    match.isItalic
  );

  const displayText = applyTextCaseMode(
    searchedText || region.extractedText,
    previewConfig.customText,
    previewConfig.caseTransform
  );

  const canConvertToVector = Boolean(
    onUseInDesign &&
      (match.specimenPreview.previewFontUrls.ttf ||
        match.download.options.some((o) => o.format === 'TTF' || o.format === 'OTF') ||
        /google fonts|fontsource/i.test(match.officialSourceName))
  );

  const licenseTone =
    match.licenseClass === 'Free for Personal and Commercial Use'
      ? 'text-emerald-800 bg-emerald-50 border-emerald-200'
      : match.licenseClass === 'Free for Personal Use Only'
      ? 'text-amber-800 bg-amber-50 border-amber-200'
      : match.licenseClass === 'Paid Font' || match.licenseClass === 'Commercial Proprietary License'
      ? 'text-rose-800 bg-rose-50 border-rose-200'
      : 'text-slate-700 bg-slate-100 border-slate-200';

  const handleDownloadClick = async (opt: FontDownloadOption) => {
    setDownloadErr(null);
    setDownloadingFmt(opt.format);
    try {
      await onDownloadOption(match, opt);
    } catch (err) {
      setDownloadErr(err instanceof Error ? err.message : 'Font download failed.');
    } finally {
      setDownloadingFmt(null);
    }
  };

  return (
    <div className="bg-white border border-emerald-300 rounded-xl overflow-hidden shadow-xs">
      {/* Header: Font Family, Verified Style, Foundry & License */}
      <div className="px-5 py-4 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h4 className="text-lg font-extrabold text-slate-900 tracking-tight">
              {match.family}
            </h4>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-md">
              <Check className="w-3 h-3" />
              {match.verificationStatus}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-600">
            <span className="font-semibold text-slate-800">{match.verifiedStyle}</span>
            <span>·</span>
            <span>Weight {match.weight} ({match.weightLabel}){match.isItalic ? ' · Italic' : ''}</span>
            <span>·</span>
            <span>Foundry / Designer: <strong className="text-slate-800">{match.foundryOrDesigner}</strong></span>
          </div>
        </div>

        <div className="flex flex-col items-start sm:items-end gap-1.5">
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md border ${licenseTone}`}
          >
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            {match.licenseClass}
          </span>
          <span className="text-[11px] text-slate-500">
            {match.licenseName} · Source: {match.officialSourceName}
          </span>
        </div>
      </div>

      {/* Authentic Specimen Preview */}
      <div className="px-5 py-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="font-semibold text-slate-800">
            Verified Exact Font Specimen Preview
          </span>
          {match.specimenPreview.available ? (
            fontLoadStatus === 'loading' ? (
              <span className="inline-flex items-center gap-1 text-indigo-600">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading authentic font binary...
              </span>
            ) : fontLoadStatus === 'loaded' ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                <Check className="w-3 h-3" />
                Authentic {match.family} font file loaded
              </span>
            ) : (
              <span className="text-amber-700 font-medium">
                Browser font load blocked; fallback fonts are not substituted
              </span>
            )
          ) : (
            <span className="text-slate-600 font-medium">
              Commercial / foundry-hosted font
            </span>
          )}
        </div>

        {match.specimenPreview.available && fontLoadStatus === 'loaded' ? (
          <div
            className="rounded-lg border border-slate-200 px-5 py-6 overflow-x-auto transition-colors"
            style={{
              backgroundColor: previewConfig.bgColor,
              textAlign: previewConfig.align,
            }}
          >
            <div
              className="whitespace-pre-wrap"
              style={{
                fontFamily: cssFamily,
                fontSize: `${previewConfig.fontSize}px`,
                fontWeight: match.weight || 400,
                fontStyle: match.isItalic ? 'italic' : 'normal',
                letterSpacing: `${previewConfig.letterSpacingEm}em`,
                lineHeight: previewConfig.lineHeight,
                color: previewConfig.textColor,
                wordBreak: 'break-word',
              }}
            >
              {displayText}
            </div>
          </div>
        ) : match.specimenPreview.available && fontLoadStatus === 'loading' ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-8 flex items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
            <span>Loading authentic {match.family} glyphs for live preview...</span>
          </div>
        ) : match.specimenPreview.renderedSpecimenDataUrl ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-slate-200 bg-white px-5 py-5 flex items-center justify-center overflow-x-auto">
              <img
                src={match.specimenPreview.renderedSpecimenDataUrl}
                alt={`Verified specimen render of ${match.family}`}
                referrerPolicy="no-referrer"
                className="max-h-36 object-contain"
              />
            </div>
            <p className="text-[11px] text-slate-500">
              {match.specimenPreview.unavailableReason ||
                'Interactive live text input is unavailable because the browser could not stream the font directly. Showing server-rendered specimen from the authentic font file.'}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-4 flex items-start gap-2.5 text-xs text-slate-700">
            <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-slate-900">
                Interactive browser preview unavailable
              </div>
              <p className="text-slate-600 mt-0.5">
                {match.specimenPreview.unavailableReason ||
                  'This commercial/proprietary font file is not openly redistributable for live browser rendering. No generic system fallback font is substituted.'}
              </p>
            </div>
          </div>
        )}

        {/* Verification Summary & Evidence Accordion */}
        <div className="border border-slate-200 rounded-lg bg-slate-50/70">
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs font-semibold text-slate-800 hover:bg-slate-100/70 transition-colors cursor-pointer"
          >
            <span>Verification Evidence &amp; Glyph Comparison</span>
            {showEvidence ? (
              <ChevronUp className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            )}
          </button>

          {showEvidence && (
            <div className="px-3.5 pb-3.5 pt-1 border-t border-slate-200 space-y-3 text-xs text-slate-700">
              {match.glyphComparisonNotes && (
                <p className="text-slate-700 leading-relaxed">{match.glyphComparisonNotes}</p>
              )}

              {match.verificationEvidence.length > 0 && (
                <ul className="space-y-1 text-slate-600">
                  {match.verificationEvidence.map((item, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}

              {match.metricsSummary &&
                (match.metricsSummary.silhouetteIoU !== undefined ||
                  match.metricsSummary.edgeCorrelation !== undefined ||
                  match.metricsSummary.aspectMatch !== undefined ||
                  match.metricsSummary.glyphCoverage !== undefined) && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                    {match.metricsSummary.silhouetteIoU !== undefined && (
                      <div className="p-2 rounded bg-white border border-slate-200">
                        <div className="text-[10px] text-slate-500">Silhouette IoU</div>
                        <div className="font-mono tabular-nums font-bold text-slate-900">
                          {Math.round(match.metricsSummary.silhouetteIoU * 100)}%
                        </div>
                      </div>
                    )}
                    {match.metricsSummary.edgeCorrelation !== undefined && (
                      <div className="p-2 rounded bg-white border border-slate-200">
                        <div className="text-[10px] text-slate-500">Edge Match</div>
                        <div className="font-mono tabular-nums font-bold text-slate-900">
                          {Math.round(match.metricsSummary.edgeCorrelation * 100)}%
                        </div>
                      </div>
                    )}
                    {match.metricsSummary.aspectMatch !== undefined && (
                      <div className="p-2 rounded bg-white border border-slate-200">
                        <div className="text-[10px] text-slate-500">Proportion Match</div>
                        <div className="font-mono tabular-nums font-bold text-slate-900">
                          {Math.round(match.metricsSummary.aspectMatch * 100)}%
                        </div>
                      </div>
                    )}
                    {match.metricsSummary.glyphCoverage !== undefined && (
                      <div className="p-2 rounded bg-white border border-slate-200">
                        <div className="text-[10px] text-slate-500">Glyph Coverage</div>
                        <div className="font-mono tabular-nums font-bold text-slate-900">
                          {Math.round(match.metricsSummary.glyphCoverage * 100)}%
                        </div>
                      </div>
                    )}
                  </div>
                )}
            </div>
          )}
        </div>

        {downloadErr && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {downloadErr}
          </div>
        )}
      </div>

      {/* Footer Actions: Compare, Vector Outline Export, Official Source Link, Verified Downloads */}
      <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenSideBySide}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <Columns2 className="w-3.5 h-3.5 text-indigo-600" />
            Compare Side-by-Side
          </button>

          {canConvertToVector && onUseInDesign && (
            <button
              type="button"
              onClick={() => onUseInDesign(match, searchedText || region.extractedText)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5" />
              Use Font in Design
            </button>
          )}

          {match.officialPageUrl && (
            <a
              href={match.officialPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-indigo-700"
            >
              Official Source ({match.officialSourceName})
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {match.download.status === 'direct_files' && match.download.options.length > 0 ? (
            match.download.options.map((opt) => (
              <button
                key={opt.format}
                type="button"
                disabled={downloadingFmt !== null}
                onClick={() => handleDownloadClick(opt)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
                  opt.format === 'ZIP'
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
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
          ) : match.officialPageUrl ? (
            <a
              href={match.officialPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
            >
              View on {match.officialSourceName}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          ) : (
            <span className="text-[11px] font-medium text-slate-600">
              {match.download.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
