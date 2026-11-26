import React, { useState } from 'react';
import { Columns2, Download, ExternalLink, Info, Layers, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCandidateWebfont } from '../lib/fontLoader.ts';
import type {
  DetectedTextRegion,
  FontDownloadOption,
  VerifiedExactFontMatch,
} from '../types/vector.ts';
import { applyTextCaseMode, type LivePreviewStyleConfig } from './ExactFontResultCard.tsx';

interface FontCompareModalProps {
  open: boolean;
  onClose: () => void;
  region: DetectedTextRegion | null;
  verifiedMatch: VerifiedExactFontMatch | null;
  searchedText: string;
  previewConfig: LivePreviewStyleConfig;
  onUseInDesign?: (match: VerifiedExactFontMatch, sampleText: string) => void;
  onDownloadOption: (match: VerifiedExactFontMatch, option: FontDownloadOption) => Promise<void>;
}

export const FontCompareModal: React.FC<FontCompareModalProps> = ({
  open,
  onClose,
  region,
  verifiedMatch,
  searchedText,
  previewConfig,
  onUseInDesign,
  onDownloadOption,
}) => {
  const [zoom, setZoom] = useState(1);

  const { cssFamily, status } = useCandidateWebfont(
    open && verifiedMatch ? verifiedMatch : null,
    verifiedMatch?.weight || 400,
    verifiedMatch?.isItalic || false
  );

  if (!open || !region || !verifiedMatch) return null;

  const displayText = applyTextCaseMode(
    searchedText || region.extractedText,
    previewConfig.customText,
    previewConfig.caseTransform
  );
  const zipOpt = verifiedMatch.download.options[0];
  const canConvertToVector = Boolean(
    onUseInDesign &&
      (verifiedMatch.specimenPreview.previewFontUrls.ttf ||
        verifiedMatch.download.options.some((o) => o.format === 'TTF' || o.format === 'OTF') ||
        /google fonts|fontsource/i.test(verifiedMatch.officialSourceName))
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-6xl max-h-[90vh] bg-white border border-slate-200 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <Columns2 className="w-5 h-5 text-indigo-600" />
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Original Crop vs Verified Exact Font Comparison
              </h3>
              <p className="text-xs text-slate-500">
                {verifiedMatch.family} ({verifiedMatch.verifiedStyle}) · &ldquo;{searchedText || region.extractedText}&rdquo;
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

        {/* Body: Left = Original Cropped Typography, Right = Verified Specimen */}
        <div className="p-6 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-3">
            <div className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Original Uploaded Typography ({region.roleLabel})
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
              <div className="font-semibold text-slate-900">Glyph Anatomy Notes</div>
              <div className="text-slate-600">{verifiedMatch.glyphComparisonNotes}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 pt-1">
                <span>Classification: {region.appearance.primaryClassification}</span>
                <span>Weight: {region.appearance.weightEstimate}</span>
                <span>Contrast: {region.glyphAnalysis.strokeContrast}</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-4">
            <div className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Verified Exact Font Specimen
            </div>

            <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-slate-900">{verifiedMatch.family}</span>
                  <span className="text-slate-600">{verifiedMatch.verifiedStyle}</span>
                  <span className="text-emerald-700 font-medium">
                    ·{' '}
                    {verifiedMatch.specimenPreview.available
                      ? status === 'loaded'
                        ? 'Authentic font loaded'
                        : status === 'loading'
                        ? 'Loading authentic font...'
                        : 'Browser preview blocked'
                      : 'Commercial reference'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {canConvertToVector && onUseInDesign && (
                    <button
                      type="button"
                      onClick={() =>
                        onUseInDesign(verifiedMatch, searchedText || region.extractedText)
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-md hover:bg-indigo-100 cursor-pointer"
                    >
                      <Layers className="w-3 h-3" />
                      Use in Design
                    </button>
                  )}
                  {zipOpt ? (
                    <button
                      type="button"
                      onClick={() => onDownloadOption(verifiedMatch, zipOpt)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      {zipOpt.format}
                    </button>
                  ) : verifiedMatch.officialPageUrl ? (
                    <a
                      href={verifiedMatch.officialPageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800"
                    >
                      Official Source
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : null}
                </div>
              </div>

              {verifiedMatch.specimenPreview.available && status === 'loaded' ? (
                <div
                  className="p-6 min-h-[220px] flex items-center justify-center overflow-auto"
                  style={{ backgroundColor: previewConfig.bgColor }}
                >
                  <div
                    className="whitespace-pre-wrap"
                    style={{
                      fontFamily: cssFamily,
                      fontSize: `${Math.round(previewConfig.fontSize * zoom)}px`,
                      fontWeight: verifiedMatch.weight || 400,
                      fontStyle: verifiedMatch.isItalic ? 'italic' : 'normal',
                      letterSpacing: `${previewConfig.letterSpacingEm}em`,
                      lineHeight: previewConfig.lineHeight,
                      color: previewConfig.textColor,
                      textAlign: previewConfig.align,
                      width: '100%',
                      wordBreak: 'break-word',
                    }}
                  >
                    {displayText}
                  </div>
                </div>
              ) : verifiedMatch.specimenPreview.renderedSpecimenDataUrl ? (
                <div className="p-6 min-h-[220px] flex items-center justify-center overflow-auto bg-white">
                  <img
                    src={verifiedMatch.specimenPreview.renderedSpecimenDataUrl}
                    alt={`Verified specimen render of ${verifiedMatch.family}`}
                    referrerPolicy="no-referrer"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                    className="max-w-full max-h-64 object-contain transition-transform"
                  />
                </div>
              ) : (
                <div className="p-6 min-h-[220px] flex items-center justify-center bg-slate-50 text-xs text-slate-600">
                  <div className="flex items-start gap-2.5 max-w-md">
                    <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                    <p>
                      {verifiedMatch.specimenPreview.unavailableReason ||
                        'Interactive webfont preview is unavailable for this commercial/proprietary font. System fallback fonts are never substituted.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
