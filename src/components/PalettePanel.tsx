import React, { useState } from 'react';
import { Eye, Layers, Merge, Palette, Trash2 } from 'lucide-react';
import { hexToRgb, rebuildPaletteFromShapes, rgbToHex } from '../lib/svgClient.ts';
import type { VectorDocument } from '../types/vector.ts';

interface PalettePanelProps {
  document: VectorDocument;
  onUpdateDocument: (next: VectorDocument) => void;
  isolatedColor: string | null;
  onIsolateColor: (hex: string | null) => void;
}

export const PalettePanel: React.FC<PalettePanelProps> = ({
  document,
  onUpdateDocument,
  isolatedColor,
  onIsolateColor,
}) => {
  const [editingHex, setEditingHex] = useState<string | null>(null);
  const [hexDraft, setHexDraft] = useState('');
  const [mergeThreshold, setMergeThreshold] = useState(35);

  const replaceColor = (oldHex: string, newHex: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(newHex)) return;
    const normalizedOld = oldHex.toLowerCase();
    const normalizedNew = newHex.toLowerCase();
    const shapes = document.shapes.map((s) =>
      s.fill.toLowerCase() === normalizedOld
        ? {
            ...s,
            fill: normalizedNew,
            layerName: `Layer ${normalizedNew.toUpperCase()}`,
          }
        : s
    );
    onUpdateDocument({
      ...document,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const removeColor = (hex: string) => {
    const target = hex.toLowerCase();
    const shapes = document.shapes.filter((s) => s.fill.toLowerCase() !== target);
    if (isolatedColor?.toLowerCase() === target) onIsolateColor(null);
    onUpdateDocument({
      ...document,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const mergeSimilarColors = () => {
    const swatches = document.palette;
    if (swatches.length <= 1) return;
    const mapping = new Map<string, string>();
    const kept: Array<{ hex: string; rgb: [number, number, number] }> = [];

    for (const sw of swatches) {
      const found = kept.find((k) => {
        const d = Math.hypot(
          k.rgb[0] - sw.rgb[0],
          k.rgb[1] - sw.rgb[1],
          k.rgb[2] - sw.rgb[2]
        );
        return d <= mergeThreshold;
      });
      if (found) {
        mapping.set(sw.hex.toLowerCase(), found.hex.toLowerCase());
      } else {
        kept.push({ hex: sw.hex, rgb: sw.rgb });
        mapping.set(sw.hex.toLowerCase(), sw.hex.toLowerCase());
      }
    }

    const shapes = document.shapes.map((s) => {
      const mapped = mapping.get(s.fill.toLowerCase());
      if (!mapped || mapped === s.fill.toLowerCase()) return s;
      return {
        ...s,
        fill: mapped,
        layerName: `Layer ${mapped.toUpperCase()}`,
      };
    });

    onUpdateDocument({
      ...document,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-slate-900 flex items-center gap-1.5">
          <Palette className="w-3.5 h-3.5 text-indigo-600" />
          Color Palette ({document.palette.length})
        </span>
        {isolatedColor && (
          <button
            type="button"
            onClick={() => onIsolateColor(null)}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800 cursor-pointer"
          >
            Show All Layers
          </button>
        )}
      </div>

      {/* Background Color Control */}
      <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-slate-700">Canvas Background</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onUpdateDocument({ ...document, backgroundColor: null })}
              className={`px-2 py-0.5 rounded text-[11px] border cursor-pointer ${
                document.backgroundColor === null
                  ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-medium'
                  : 'bg-white border-slate-200 text-slate-600'
              }`}
            >
              Transparent
            </button>
            <input
              type="color"
              value={document.backgroundColor || '#ffffff'}
              onChange={(e) =>
                onUpdateDocument({ ...document, backgroundColor: e.target.value })
              }
              className="w-6 h-6 rounded border border-slate-200 cursor-pointer p-0 bg-transparent"
              title="Set solid vector background color"
            />
          </div>
        </div>
      </div>

      {/* Merge Similar Colors */}
      <div className="p-3 rounded-lg border border-slate-200 bg-white space-y-2">
        <div className="flex items-center justify-between text-[11px] text-slate-600">
          <span>Merge Threshold</span>
          <span className="font-mono tabular-nums">{mergeThreshold}</span>
        </div>
        <input
          type="range"
          min={10}
          max={90}
          value={mergeThreshold}
          onChange={(e) => setMergeThreshold(Number(e.target.value))}
          className="w-full accent-indigo-600"
        />
        <button
          type="button"
          onClick={mergeSimilarColors}
          disabled={document.palette.length <= 1}
          className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-800 font-medium disabled:opacity-50 transition-colors cursor-pointer"
        >
          <Merge className="w-3.5 h-3.5" />
          Merge Similar Colors
        </button>
      </div>

      {/* Swatches List */}
      <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
        {document.palette.map((sw) => {
          const isIsolated = isolatedColor?.toLowerCase() === sw.hex.toLowerCase();
          const isEditing = editingHex === sw.hex;
          const [r, g, b] = hexToRgb(sw.hex);

          return (
            <div
              key={sw.hex}
              className={`p-2 rounded-lg border transition-colors ${
                isIsolated
                  ? 'border-indigo-400 bg-indigo-50/50'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <input
                  type="color"
                  value={sw.hex}
                  onChange={(e) => replaceColor(sw.hex, e.target.value)}
                  className="w-7 h-7 rounded-md border border-slate-200 cursor-pointer shrink-0 p-0"
                  title="Click to replace all regions of this color"
                />
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={hexDraft}
                        onChange={(e) => setHexDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            replaceColor(sw.hex, hexDraft);
                            setEditingHex(null);
                          }
                        }}
                        className="w-20 px-1.5 py-0.5 text-[11px] font-mono border border-indigo-300 rounded"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => {
                          replaceColor(sw.hex, hexDraft);
                          setEditingHex(null);
                        }}
                        className="text-[10px] px-1.5 py-0.5 bg-indigo-600 text-white rounded cursor-pointer"
                      >
                        Apply
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingHex(sw.hex);
                        setHexDraft(sw.hex);
                      }}
                      className="font-mono text-[11px] font-semibold text-slate-900 hover:text-indigo-600 cursor-pointer"
                    >
                      {sw.hex.toUpperCase()}
                    </button>
                  )}
                  <div className="text-[10px] text-slate-500 font-mono tabular-nums">
                    rgb({r},{g},{b}) · {sw.shapeCount} paths · {sw.areaPercent}%
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onIsolateColor(isIsolated ? null : sw.hex)}
                    className={`p-1 rounded cursor-pointer ${
                      isIsolated
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                    }`}
                    title="Color Separation Preview (isolate this color layer)"
                  >
                    {isIsolated ? <Layers className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeColor(sw.hex)}
                    className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                    title="Remove all shapes with this color"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Quick RGB Adjustment */}
              {isEditing && (
                <div className="grid grid-cols-3 gap-1 mt-2 pt-2 border-t border-slate-100">
                  {(['R', 'G', 'B'] as const).map((chan, idx) => (
                    <label key={chan} className="block text-[10px] text-slate-500">
                      {chan}
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={[r, g, b][idx]}
                        onChange={(e) => {
                          const vals: [number, number, number] = [r, g, b];
                          vals[idx] = Math.max(0, Math.min(255, Number(e.target.value) || 0));
                          replaceColor(sw.hex, rgbToHex(vals[0], vals[1], vals[2]));
                        }}
                        className="mt-0.5 w-full px-1 py-0.5 border border-slate-200 rounded font-mono text-[10px]"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
