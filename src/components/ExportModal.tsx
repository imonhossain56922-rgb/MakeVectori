import React, { useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { exportVectorFile, triggerBrowserDownload } from '../lib/apiClient.ts';
import { auth, verifyActiveAuthSession } from '../lib/firebase.ts';
import { logDownloadRecord } from '../lib/firestoreService.ts';
import type { ExportFormat, ExportOptions, VectorDocument } from '../types/vector.ts';
import { AuthDownloadModal } from './AuthDownloadModal.tsx';

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  document: VectorDocument;
  filename: string;
  projectId?: string;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  open,
  onClose,
  document,
  filename,
  projectId,
}) => {
  const [selectedFormats, setSelectedFormats] = useState<ExportFormat[]>(['svg']);
  const [svgVersion, setSvgVersion] = useState<'1.0' | '1.1'>('1.1');
  const [svgSizeMode, setSvgSizeMode] = useState<'scalable' | 'fixed'>('scalable');
  const [preserveLayers, setPreserveLayers] = useState(true);
  const [illustratorCompat, setIllustratorCompat] = useState(false);

  const [pdfPageSize, setPdfPageSize] = useState<'fit' | 'a4' | 'letter' | 'custom'>('fit');
  const [pdfWidth, setPdfWidth] = useState(Math.round(document.width));
  const [pdfHeight, setPdfHeight] = useState(Math.round(document.height));

  const [dxfMode, setDxfMode] = useState<'lines-only' | 'lines-arcs' | 'lines-arcs-splines'>(
    'lines-arcs-splines'
  );

  const [pngScale, setPngScale] = useState<1 | 2 | 3 | 4>(2);
  const [pngTransparent, setPngTransparent] = useState(true);
  const [pngDpi, setPngDpi] = useState(300);

  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);

  if (!open) return null;

  const toggleFormat = (fmt: ExportFormat) => {
    setSelectedFormats((prev) =>
      prev.includes(fmt)
        ? prev.length > 1
          ? prev.filter((f) => f !== fmt)
          : prev
        : [...prev, fmt]
    );
  };

  const performDownloadAll = async () => {
    setExporting(true);
    setError(null);
    try {
      for (const fmt of selectedFormats) {
        const opts: ExportOptions = {
          format: fmt,
          svgVersion,
          svgSizeMode,
          preserveLayers,
          illustratorCompat,
          pdfPageSize,
          pdfWidth,
          pdfHeight,
          dxfMode,
          pngScale,
          pngTransparent,
          pngDpi,
        };
        const { blob, filename: outName } = await exportVectorFile(document, opts, filename);
        triggerBrowserDownload(blob, outName);

        if (auth.currentUser?.emailVerified && projectId) {
          logDownloadRecord({
            userId: auth.currentUser.uid,
            projectId,
            projectName: filename,
            format: fmt,
            byteSize: blob.size,
          }).catch(() => {});
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const handleDownloadAll = async () => {
    setError(null);
    const currentUser = auth.currentUser;
    if (!currentUser) {
      setShowAuthPrompt(true);
      return;
    }
    const { valid, revoked } = await verifyActiveAuthSession(currentUser, { force: true });
    if (!valid || revoked) {
      setError(
        revoked
          ? 'Your Google or account password changed. Please sign in again to download.'
          : 'Please sign in to download files.'
      );
      setShowAuthPrompt(true);
      return;
    }
    await performDownloadAll();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Export Vector & Print Formats</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Genuine file generation directly from your edited vector paths ({document.shapes.length} shapes)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
          {/* Format Selection */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              Select Output Formats (single or multi-format download)
            </label>
            <div className="grid grid-cols-5 gap-2">
              {(
                [
                  { id: 'svg', label: 'SVG', sub: 'Web & Edit' },
                  { id: 'pdf', label: 'PDF', sub: 'Vector Print' },
                  { id: 'eps', label: 'EPS', sub: 'PostScript 3' },
                  { id: 'dxf', label: 'DXF', sub: 'CAD / CNC' },
                  { id: 'png', label: 'PNG', sub: 'Raster 1X-4X' },
                ] as const
              ).map((fmt) => {
                const active = selectedFormats.includes(fmt.id);
                return (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => toggleFormat(fmt.id)}
                    className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                      active
                        ? 'border-indigo-600 bg-indigo-50/80 text-indigo-900'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="text-sm font-bold">{fmt.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{fmt.sub}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* SVG Settings */}
          {selectedFormats.includes('svg') && (
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/60 space-y-3">
              <div className="text-xs font-semibold text-slate-900">SVG Options</div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="block">
                  <span className="text-slate-600">SVG Version</span>
                  <select
                    value={svgVersion}
                    onChange={(e) => setSvgVersion(e.target.value as '1.0' | '1.1')}
                    className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md"
                  >
                    <option value="1.1">SVG 1.1 (Recommended)</option>
                    <option value="1.0">SVG 1.0 Legacy</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-slate-600">Sizing</span>
                  <select
                    value={svgSizeMode}
                    onChange={(e) => setSvgSizeMode(e.target.value as 'scalable' | 'fixed')}
                    className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md"
                  >
                    <option value="scalable">Scalable (viewBox 100%)</option>
                    <option value="fixed">Fixed Pixel Dimensions</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-5 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preserveLayers}
                    onChange={(e) => setPreserveLayers(e.target.checked)}
                    className="accent-indigo-600"
                  />
                  Preserve color groups & layers
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={illustratorCompat}
                    onChange={(e) => setIllustratorCompat(e.target.checked)}
                    className="accent-indigo-600"
                  />
                  Adobe Illustrator compatibility mode
                </label>
              </div>
            </div>
          )}

          {/* PDF Settings */}
          {selectedFormats.includes('pdf') && (
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/60 space-y-3 text-xs">
              <div className="text-xs font-semibold text-slate-900">Vector PDF Options</div>
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-slate-600">Page Size</span>
                  <select
                    value={pdfPageSize}
                    onChange={(e) =>
                      setPdfPageSize(e.target.value as 'fit' | 'a4' | 'letter' | 'custom')
                    }
                    className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md"
                  >
                    <option value="fit">Fit Artwork</option>
                    <option value="a4">A4 (595 × 842 pt)</option>
                    <option value="letter">US Letter (612 × 792 pt)</option>
                    <option value="custom">Custom Points</option>
                  </select>
                </label>
                {pdfPageSize === 'custom' && (
                  <>
                    <label className="block">
                      <span className="text-slate-600">Width (pt)</span>
                      <input
                        type="number"
                        value={pdfWidth}
                        onChange={(e) => setPdfWidth(Number(e.target.value) || 500)}
                        className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md font-mono"
                      />
                    </label>
                    <label className="block">
                      <span className="text-slate-600">Height (pt)</span>
                      <input
                        type="number"
                        value={pdfHeight}
                        onChange={(e) => setPdfHeight(Number(e.target.value) || 500)}
                        className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md font-mono"
                      />
                    </label>
                  </>
                )}
              </div>
            </div>
          )}

          {/* DXF Settings */}
          {selectedFormats.includes('dxf') && (
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/60 space-y-2 text-xs">
              <div className="font-semibold text-slate-900">AutoCAD DXF / CNC Options</div>
              <select
                value={dxfMode}
                onChange={(e) =>
                  setDxfMode(
                    e.target.value as 'lines-only' | 'lines-arcs' | 'lines-arcs-splines'
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md"
              >
                <option value="lines-arcs-splines">Lines, Arcs & Splines (Smooth CAD)</option>
                <option value="lines-arcs">Lines and Arcs (Laser / Plotter)</option>
                <option value="lines-only">Lines Only (Universal CNC G-Code)</option>
              </select>
            </div>
          )}

          {/* PNG Settings */}
          {selectedFormats.includes('png') && (
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/60 space-y-3 text-xs">
              <div className="font-semibold text-slate-900">High-Resolution PNG Raster Export</div>
              <div className="grid grid-cols-3 gap-3 items-end">
                <label className="block">
                  <span className="text-slate-600">Scale Multiplier</span>
                  <select
                    value={pngScale}
                    onChange={(e) => setPngScale(Number(e.target.value) as 1 | 2 | 3 | 4)}
                    className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md"
                  >
                    <option value={1}>1X ({Math.round(document.width)}×{Math.round(document.height)})</option>
                    <option value={2}>2X ({Math.round(document.width * 2)}×{Math.round(document.height * 2)})</option>
                    <option value={3}>3X ({Math.round(document.width * 3)}×{Math.round(document.height * 3)})</option>
                    <option value={4}>4X ({Math.round(document.width * 4)}×{Math.round(document.height * 4)})</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-slate-600">DPI Metadata</span>
                  <input
                    type="number"
                    min={72}
                    max={600}
                    value={pngDpi}
                    onChange={(e) => setPngDpi(Number(e.target.value) || 300)}
                    className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-md font-mono"
                  />
                </label>
                <label className="flex items-center gap-2 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pngTransparent}
                    onChange={(e) => setPngTransparent(e.target.checked)}
                    className="accent-indigo-600"
                  />
                  Transparent background
                </label>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50/70">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={exporting}
            onClick={handleDownloadAll}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-60 transition-colors cursor-pointer"
          >
            {exporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            Download {selectedFormats.map((f) => f.toUpperCase()).join(', ')}
          </button>
        </div>
      </div>
      <AuthDownloadModal
        open={showAuthPrompt}
        onClose={() => setShowAuthPrompt(false)}
        onAuthenticated={() => {
          performDownloadAll();
        }}
      />
    </div>
  );
};
