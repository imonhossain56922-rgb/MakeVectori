import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Crop,
  Download,
  Eraser,
  FolderPlus,
  FolderX,
  Grid,
  Hand,
  Layers,
  Maximize2,
  Merge,
  Minimize2,
  MousePointer,
  MousePointer2,
  Move,
  PenTool,
  Pipette,
  Redo2,
  RotateCcw,
  Ruler,
  Save,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Spline,
  Square,
  Trash2,
  Type as TypeIcon,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { rebuildPaletteFromShapes, serializeDocumentToSvg } from '../lib/svgClient.ts';
import { convertFontTextToVectorShape } from '../lib/apiClient.ts';
import { loadWebfontTarget } from '../lib/fontLoader.ts';
import type { PendingFontDesign, VectorDocument, VectorShape } from '../types/vector.ts';
import { PalettePanel } from './PalettePanel.tsx';
import { BeforeAfterViewer } from './BeforeAfterViewer.tsx';

type EditorTool =
  | 'select'
  | 'direct'
  | 'move'
  | 'pen'
  | 'node'
  | 'shape'
  | 'eyedropper'
  | 'eraser'
  | 'bg-remove'
  | 'crop'
  | 'zoom'
  | 'pan';

interface VectorEditorWorkspaceProps {
  initialDocument: VectorDocument;
  originalImageUrl?: string;
  filename: string;
  pendingFontDesign?: PendingFontDesign | null;
  onRequestExport: (doc: VectorDocument) => void;
  onRequestSave?: (doc: VectorDocument) => Promise<void>;
  onRequestBgRemove?: () => void;
  onRequestCrop?: () => void;
  saving?: boolean;
}

interface EditableAnchor {
  index: number;
  x: number;
  y: number;
  tokenIdxX: number;
  tokenIdxY: number;
}

function extractPathVertices(pathData: string): {
  tokens: string[];
  anchors: EditableAnchor[];
} {
  const tokens = pathData.match(/[MLCQZmlcqz]|-?\d*\.?\d+/g) || [];
  const anchors: EditableAnchor[] = [];
  let i = 0;
  let idx = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'M' || t === 'L') {
      if (i + 2 < tokens.length) {
        anchors.push({
          index: idx++,
          x: parseFloat(tokens[i + 1]),
          y: parseFloat(tokens[i + 2]),
          tokenIdxX: i + 1,
          tokenIdxY: i + 2,
        });
        i += 3;
        continue;
      }
    } else if (t === 'C') {
      if (i + 6 < tokens.length) {
        anchors.push({
          index: idx++,
          x: parseFloat(tokens[i + 5]),
          y: parseFloat(tokens[i + 6]),
          tokenIdxX: i + 5,
          tokenIdxY: i + 6,
        });
        i += 7;
        continue;
      }
    }
    i++;
  }
  return { tokens, anchors };
}

export const VectorEditorWorkspace: React.FC<VectorEditorWorkspaceProps> = ({
  initialDocument,
  originalImageUrl,
  filename,
  pendingFontDesign,
  onRequestExport,
  onRequestSave,
  onRequestBgRemove,
  onRequestCrop,
  saving = false,
}) => {
  const [doc, setDoc] = useState<VectorDocument>(initialDocument);
  const [loadedFontCss, setLoadedFontCss] = useState<string | null>(null);
  const [convertingOutline, setConvertingOutline] = useState(false);
  const [history, setHistory] = useState<VectorDocument[]>([]);
  const [future, setFuture] = useState<VectorDocument[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const fg = initialDocument.shapes.find(
      (s) =>
        s.bounds.width < initialDocument.width * 0.95 ||
        s.bounds.height < initialDocument.height * 0.95
    );
    const first = fg || initialDocument.shapes[0];
    return first ? [first.id] : [];
  });

  const [tool, setTool] = useState<EditorTool>('select');
  const [rightTab, setRightTab] = useState<'properties' | 'palette' | 'layers'>('properties');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState(false);
  const [showRulers, setShowRulers] = useState(true);
  const [checkerboard, setCheckerboard] = useState(true);
  const [compareMode, setCompareMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [isolatedColor, setIsolatedColor] = useState<string | null>(null);
  const [sampledHex, setSampledHex] = useState<string | null>(null);

  // Pen tool state
  const [penPoints, setPenPoints] = useState<Array<{ x: number; y: number }>>([]);

  // Dragging state
  const dragStateRef = useRef<{
    kind: 'none' | 'pan' | 'move-shape' | 'drag-node';
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
    origOffsets: Map<string, { tx: number; ty: number }>;
    nodeTokenX?: number;
    nodeTokenY?: number;
  }>({
    kind: 'none',
    startX: 0,
    startY: 0,
    origPanX: 0,
    origPanY: 0,
    origOffsets: new Map(),
  });
  const svgRef = useRef<SVGSVGElement>(null);

  React.useEffect(() => {
    if (!pendingFontDesign) return;
    loadWebfontTarget(
      {
        id: pendingFontDesign.fontId,
        family: pendingFontDesign.family,
        weight: pendingFontDesign.weight || 400,
        previewFontUrls: {
          woff2: pendingFontDesign.woff2Url,
          ttf: pendingFontDesign.ttfUrl,
        },
        cssUrl: pendingFontDesign.cssUrl || '',
        unavailable: false,
      },
      pendingFontDesign.weight,
      pendingFontDesign.isItalic
    ).then((res) => setLoadedFontCss(res.cssFamily));
  }, [pendingFontDesign]);

  const commitDoc = (next: VectorDocument) => {
    setHistory((h) => [...h.slice(-39), doc]);
    setFuture([]);
    setDoc(next);
  };

  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setFuture((f) => [doc, ...f]);
    setHistory((h) => h.slice(0, -1));
    setDoc(prev);
  };

  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setHistory((h) => [...h, doc]);
    setFuture((f) => f.slice(1));
    setDoc(next);
  };

  const resetToOriginal = () => {
    commitDoc(initialDocument);
    setSelectedIds(initialDocument.shapes[0] ? [initialDocument.shapes[0].id] : []);
  };

  const selectedShapes = useMemo(
    () => doc.shapes.filter((s) => selectedIds.includes(s.id)),
    [doc.shapes, selectedIds]
  );
  const primaryShape = selectedShapes[0] || null;

  const primaryVertices = useMemo(() => {
    if (!primaryShape || (tool !== 'node' && tool !== 'direct')) return null;
    return extractPathVertices(primaryShape.pathData);
  }, [primaryShape, tool]);

  const toSvgCoords = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * doc.width;
    const y = ((clientY - rect.top) / rect.height) * doc.height;
    return { x, y };
  };

  const updateSelectedShapes = (updater: (s: VectorShape) => VectorShape) => {
    if (selectedIds.length === 0) return;
    const shapes = doc.shapes.map((s) => (selectedIds.includes(s.id) ? updater(s) : s));
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    const shapes = doc.shapes.filter((s) => !selectedIds.includes(s.id));
    setSelectedIds([]);
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const duplicateSelected = () => {
    if (selectedShapes.length === 0) return;
    const clones = selectedShapes.map((s, idx) => ({
      ...s,
      id: `${s.id}_copy_${Date.now().toString(36)}_${idx}`,
      tx: (s.tx || 0) + 16,
      ty: (s.ty || 0) + 16,
    }));
    const shapes = [...doc.shapes, ...clones];
    setSelectedIds(clones.map((c) => c.id));
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const mergeSelected = () => {
    if (selectedShapes.length < 2) return;
    const base = selectedShapes[0];
    const combinedD = selectedShapes.map((s) => s.pathData).join(' ');
    const merged: VectorShape = {
      ...base,
      id: `merged_${Date.now().toString(36)}`,
      pathData: combinedD,
      nodeCount: selectedShapes.reduce((acc, s) => acc + s.nodeCount, 0),
    };
    const remaining = doc.shapes.filter((s) => !selectedIds.includes(s.id));
    const shapes = [...remaining, merged];
    setSelectedIds([merged.id]);
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const separateSelected = () => {
    if (!primaryShape) return;
    const subpaths = primaryShape.pathData
      .split(/(?=M\s)/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (subpaths.length <= 1) return;

    const separated: VectorShape[] = subpaths.map((sub, idx) => ({
      ...primaryShape,
      id: `${primaryShape.id}_part_${idx + 1}`,
      pathData: sub,
      nodeCount: Math.max(3, Math.round(primaryShape.nodeCount / subpaths.length)),
    }));
    const idxInDoc = doc.shapes.findIndex((s) => s.id === primaryShape.id);
    const shapes = [...doc.shapes];
    shapes.splice(idxInDoc, 1, ...separated);
    setSelectedIds(separated.map((s) => s.id));
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const groupSelected = () => {
    if (selectedShapes.length < 2) return;
    const newGroupId = `group_${Date.now().toString(36)}`;
    updateSelectedShapes((s) => ({ ...s, groupId: newGroupId }));
  };

  const ungroupSelected = () => {
    if (selectedShapes.length === 0) return;
    updateSelectedShapes((s, ) => ({ ...s, groupId: `ungrouped_${s.id}` }));
  };

  const reorderSelected = (dir: 'up' | 'down') => {
    if (!primaryShape) return;
    const idx = doc.shapes.findIndex((s) => s.id === primaryShape.id);
    if (idx < 0) return;
    const targetIdx = dir === 'up' ? Math.min(doc.shapes.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (targetIdx === idx) return;
    const next = [...doc.shapes];
    const [moved] = next.splice(idx, 1);
    next.splice(targetIdx, 0, moved);
    commitDoc({ ...doc, shapes: next });
  };

  const finishPenPath = () => {
    if (penPoints.length < 3) {
      setPenPoints([]);
      return;
    }
    const d =
      penPoints
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ') + ' Z';
    const xs = penPoints.map((p) => p.x);
    const ys = penPoints.map((p) => p.y);
    const newShape: VectorShape = {
      id: `pen_${Date.now().toString(36)}`,
      groupId: 'layer_drawn',
      layerName: 'Drawn Vector Path',
      type: 'path',
      pathData: d,
      fill: sampledHex || '#4f46e5',
      stroke: 'none',
      strokeWidth: 0,
      opacity: 1,
      visible: true,
      locked: false,
      bounds: {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(2, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(2, Math.max(...ys) - Math.min(...ys)),
      },
      nodeCount: penPoints.length,
    };
    const shapes = [...doc.shapes, newShape];
    setPenPoints([]);
    setSelectedIds([newShape.id]);
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const addBasicRectShape = () => {
    const w = Math.round(doc.width * 0.2);
    const h = Math.round(doc.height * 0.2);
    const x = Math.round((doc.width - w) / 2);
    const y = Math.round((doc.height - h) / 2);
    const newShape: VectorShape = {
      id: `rect_${Date.now().toString(36)}`,
      groupId: 'layer_shapes',
      layerName: 'Rectangle Shape',
      type: 'rect',
      pathData: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`,
      fill: sampledHex || '#4f46e5',
      stroke: 'none',
      strokeWidth: 0,
      opacity: 1,
      visible: true,
      locked: false,
      bounds: { x, y, width: w, height: h },
      nodeCount: 4,
    };
    const shapes = [...doc.shapes, newShape];
    setSelectedIds([newShape.id]);
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const addTypographyLayer = () => {
    const fSize = Math.max(24, Math.min(72, Math.round(doc.height * 0.09)));
    const x = Math.round(doc.width * 0.12);
    const y = Math.round(doc.height * 0.45);
    const textValue = pendingFontDesign?.sampleText || 'MakeVectorizer';
    const fontFamily = loadedFontCss || pendingFontDesign?.family || 'Plus Jakarta Sans';
    const newShape: VectorShape = {
      id: `text_${Date.now().toString(36)}`,
      groupId: 'layer_typography',
      layerName: `Text (${pendingFontDesign?.family || 'Typography'})`,
      type: 'text',
      pathData: `M ${x} ${y} L ${x + 220} ${y} L ${x + 220} ${y + fSize} L ${x} ${y + fSize} Z`,
      fill: sampledHex || '#0f172a',
      stroke: 'none',
      strokeWidth: 0,
      opacity: 1,
      visible: true,
      locked: false,
      bounds: { x, y, width: 220, height: fSize },
      nodeCount: 4,
      textContent: textValue,
      fontFamily,
      fontSize: fSize,
      fontWeight: pendingFontDesign?.weight || 600,
      letterSpacing: 0,
    };
    const shapes = [...doc.shapes, newShape];
    setSelectedIds([newShape.id]);
    commitDoc({
      ...doc,
      shapes,
      palette: rebuildPaletteFromShapes(shapes),
    });
  };

  const handleConvertTextToOutlines = async (shape: VectorShape) => {
    if (!pendingFontDesign?.fontId || !shape.textContent) return;
    setConvertingOutline(true);
    try {
      const outlined = await convertFontTextToVectorShape({
        fontId: pendingFontDesign.fontId,
        family: pendingFontDesign.family,
        text: shape.textContent,
        fontSize: shape.fontSize || 48,
        weight: shape.fontWeight || pendingFontDesign.weight || 400,
        isItalic: pendingFontDesign.isItalic,
        x: shape.bounds.x + (shape.tx || 0),
        y: shape.bounds.y + (shape.ty || 0) + (shape.fontSize || 48) * 0.85,
        fill: shape.fill,
      });
      const shapes = doc.shapes.map((s) => (s.id === shape.id ? outlined : s));
      setSelectedIds([outlined.id]);
      commitDoc({
        ...doc,
        shapes,
        palette: rebuildPaletteFromShapes(shapes),
      });
    } finally {
      setConvertingOutline(false);
    }
  };

  const toolsList: Array<{ id: EditorTool | 'text'; label: string; icon: React.ReactNode }> = [
    { id: 'select', label: 'Select', icon: <MousePointer className="w-4 h-4" /> },
    { id: 'direct', label: 'Direct Select', icon: <MousePointer2 className="w-4 h-4" /> },
    { id: 'move', label: 'Move', icon: <Move className="w-4 h-4" /> },
    { id: 'pen', label: 'Pen Path', icon: <PenTool className="w-4 h-4" /> },
    { id: 'node', label: 'Node Editor', icon: <Spline className="w-4 h-4" /> },
    { id: 'shape', label: 'Add Shape', icon: <Square className="w-4 h-4" /> },
    { id: 'text', label: pendingFontDesign ? `Add "${pendingFontDesign.family}" Text` : 'Add Text Layer', icon: <TypeIcon className="w-4 h-4" /> },
    { id: 'eyedropper', label: 'Color Picker', icon: <Pipette className="w-4 h-4" /> },
    { id: 'eraser', label: 'Eraser', icon: <Eraser className="w-4 h-4" /> },
    { id: 'bg-remove', label: 'Remove BG', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'crop', label: 'Crop Source', icon: <Crop className="w-4 h-4" /> },
    { id: 'zoom', label: 'Zoom', icon: <ZoomIn className="w-4 h-4" /> },
    { id: 'pan', label: 'Pan', icon: <Hand className="w-4 h-4" /> },
  ];

  const liveSvg = useMemo(() => serializeDocumentToSvg(doc), [doc]);

  return (
    <div
      className={`flex flex-col border border-slate-200 rounded-xl bg-white overflow-hidden ${
        fullscreen ? 'fixed inset-2 z-50 shadow-2xl' : 'min-h-[680px]'
      }`}
    >
      {/* Top Studio Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-200 bg-slate-50/90">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={undo}
            disabled={history.length === 0}
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
            title="Undo"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={future.length === 0}
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
            title="Redo"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={resetToOriginal}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          <span className="hidden sm:inline text-xs text-slate-400 px-1">|</span>
          <span className="text-xs font-mono tabular-nums text-slate-600">
            {doc.width}×{doc.height} · {doc.shapes.length} shapes
          </span>
        </div>

        {/* Canvas View Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.25, Number((z - 0.25).toFixed(2))))}
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
            title="Zoom Out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-mono tabular-nums text-slate-700 w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(6, Number((z + 0.25).toFixed(2))))}
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
            title="Zoom In"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className="px-2 py-1 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Fit
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="px-2 py-1 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            100%
          </button>

          <button
            type="button"
            onClick={() => setCheckerboard((c) => !c)}
            className={`px-2 py-1 text-xs rounded-lg border cursor-pointer ${
              checkerboard
                ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                : 'bg-white border-slate-200 text-slate-600'
            }`}
            title="Toggle Checkerboard Transparency"
          >
            Alpha
          </button>
          <button
            type="button"
            onClick={() => setShowGrid((g) => !g)}
            className={`p-1.5 rounded-lg border cursor-pointer ${
              showGrid
                ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                : 'bg-white border-slate-200 text-slate-600'
            }`}
            title="Toggle Grid"
          >
            <Grid className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShowRulers((r) => !r)}
            className={`p-1.5 rounded-lg border cursor-pointer ${
              showRulers
                ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                : 'bg-white border-slate-200 text-slate-600'
            }`}
            title="Toggle Rulers & Guides"
          >
            <Ruler className="w-3.5 h-3.5" />
          </button>
          {originalImageUrl && (
            <button
              type="button"
              onClick={() => setCompareMode((m) => !m)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border cursor-pointer ${
                compareMode
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Compare
            </button>
          )}
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
            title="Fullscreen Preview"
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Save & Export Actions */}
        <div className="flex items-center gap-2">
          {onRequestSave && (
            <button
              type="button"
              disabled={saving}
              onClick={() => onRequestSave(doc)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Save Project'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onRequestExport(doc)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export ({filename.split('.')[0]})
          </button>
        </div>
      </div>

      {/* Three-Panel Body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[64px_1fr_300px] min-h-[600px]">
        {/* LEFT PANEL — TOOLS */}
        <aside className="border-b lg:border-b-0 lg:border-r border-slate-200 bg-slate-50/70 p-2 flex lg:flex-col items-center gap-1 overflow-x-auto">
          {toolsList.map((item) => {
            const active = tool === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id === 'bg-remove' && onRequestBgRemove) {
                    onRequestBgRemove();
                    return;
                  }
                  if (item.id === 'crop' && onRequestCrop) {
                    onRequestCrop();
                    return;
                  }
                  if (item.id === 'shape') {
                    addBasicRectShape();
                    setTool('select');
                    return;
                  }
                  if (item.id === 'text') {
                    addTypographyLayer();
                    setTool('select');
                    return;
                  }
                  setTool(item.id);
                }}
                title={item.label}
                className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors shrink-0 cursor-pointer ${
                  active
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                {item.icon}
              </button>
            );
          })}
        </aside>

        {/* CENTER PANEL — CANVAS */}
        <main className="relative flex flex-col overflow-hidden bg-slate-100/70">
          {compareMode && originalImageUrl ? (
            <div className="p-4 flex-1 flex items-center justify-center">
              <BeforeAfterViewer
                beforeUrl={originalImageUrl}
                afterSvg={liveSvg}
                checkerboard={checkerboard}
              />
            </div>
          ) : (
            <div
              className={`relative flex-1 overflow-hidden flex items-center justify-center ${
                checkerboard ? 'bg-checkerboard' : 'bg-white'
              } ${showGrid ? 'bg-canvas-grid' : ''}`}
              onPointerDown={(e) => {
                if (tool === 'pan' || e.button === 1) {
                  dragStateRef.current = {
                    kind: 'pan',
                    startX: e.clientX,
                    startY: e.clientY,
                    origPanX: pan.x,
                    origPanY: pan.y,
                    origOffsets: new Map(),
                  };
                  return;
                }
                if (tool === 'zoom') {
                  setZoom((z) =>
                    e.shiftKey ? Math.max(0.25, z - 0.5) : Math.min(6, z + 0.5)
                  );
                  return;
                }
                if (tool === 'pen') {
                  const pt = toSvgCoords(e.clientX, e.clientY);
                  setPenPoints((pts) => [...pts, pt]);
                }
              }}
              onPointerMove={(e) => {
                const st = dragStateRef.current;
                if (st.kind === 'none') return;
                if (st.kind === 'pan') {
                  setPan({
                    x: st.origPanX + (e.clientX - st.startX),
                    y: st.origPanY + (e.clientY - st.startY),
                  });
                } else if (st.kind === 'move-shape') {
                  const rect = svgRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  const dx = ((e.clientX - st.startX) / rect.width) * doc.width;
                  const dy = ((e.clientY - st.startY) / rect.height) * doc.height;
                  setDoc((prev) => ({
                    ...prev,
                    shapes: prev.shapes.map((s) => {
                      const orig = st.origOffsets.get(s.id);
                      if (!orig) return s;
                      return {
                        ...s,
                        tx: Number((orig.tx + dx).toFixed(2)),
                        ty: Number((orig.ty + dy).toFixed(2)),
                      };
                    }),
                  }));
                } else if (
                  st.kind === 'drag-node' &&
                  primaryShape &&
                  st.nodeTokenX !== undefined &&
                  st.nodeTokenY !== undefined
                ) {
                  const pt = toSvgCoords(e.clientX, e.clientY);
                  const { tokens } = extractPathVertices(primaryShape.pathData);
                  tokens[st.nodeTokenX] = (pt.x - (primaryShape.tx || 0)).toFixed(2);
                  tokens[st.nodeTokenY] = (pt.y - (primaryShape.ty || 0)).toFixed(2);
                  const newD = tokens.join(' ');
                  setDoc((prev) => ({
                    ...prev,
                    shapes: prev.shapes.map((s) =>
                      s.id === primaryShape.id ? { ...s, pathData: newD } : s
                    ),
                  }));
                }
              }}
              onPointerUp={() => {
                if (
                  dragStateRef.current.kind === 'move-shape' ||
                  dragStateRef.current.kind === 'drag-node'
                ) {
                  setHistory((h) => [...h.slice(-39), doc]);
                }
                dragStateRef.current.kind = 'none';
              }}
            >
              {/* Rulers & Guides */}
              {showRulers && (
                <>
                  <div className="absolute top-0 left-6 right-0 h-5 bg-white/90 border-b border-slate-200 flex items-center justify-between px-3 text-[10px] font-mono tabular-nums text-slate-400 pointer-events-none z-10">
                    <span>0</span>
                    <span>{Math.round(doc.width * 0.25)}</span>
                    <span>{Math.round(doc.width * 0.5)}</span>
                    <span>{Math.round(doc.width * 0.75)}</span>
                    <span>{doc.width}px</span>
                  </div>
                  <div className="absolute top-5 bottom-0 left-0 w-6 bg-white/90 border-r border-slate-200 flex flex-col items-center justify-between py-3 text-[10px] font-mono tabular-nums text-slate-400 pointer-events-none z-10">
                    <span>0</span>
                    <span>{Math.round(doc.height * 0.5)}</span>
                    <span>{doc.height}</span>
                  </div>
                </>
              )}

              {/* Pen Tool Action Bar */}
              {tool === 'pen' && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-slate-900 text-white px-3.5 py-2 rounded-lg text-xs shadow-lg">
                  <span>Click canvas to add vertices ({penPoints.length})</span>
                  {penPoints.length >= 3 && (
                    <button
                      type="button"
                      onClick={finishPenPath}
                      className="px-2.5 py-1 bg-indigo-500 rounded font-medium hover:bg-indigo-400 cursor-pointer"
                    >
                      Close Path
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPenPoints([])}
                    className="px-2 py-1 text-slate-300 hover:text-white cursor-pointer"
                  >
                    Clear
                  </button>
                </div>
              )}

              {/* Interactive Vector SVG Canvas */}
              {(() => {
                const safeW = Math.max(1, doc.width);
                const safeH = Math.max(1, doc.height);
                const fitScale = Math.min(660 / safeW, 500 / safeH, 1.5);
                const displayW = Math.max(180, Math.round(safeW * fitScale));
                return (
                  <div
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transformOrigin: 'center center',
                    }}
                    className="p-8 w-full h-full flex items-center justify-center"
                  >
                    <svg
                      ref={svgRef}
                      viewBox={doc.viewBox}
                      width={doc.width}
                      height={doc.height}
                      className="shadow-sm border border-slate-200/80 block"
                      style={{
                        width: '100%',
                        maxWidth: `${displayW}px`,
                        height: 'auto',
                        aspectRatio: `${safeW} / ${safeH}`,
                        backgroundColor: doc.backgroundColor || 'transparent',
                      }}
                    >
                  {doc.shapes.map((shape) => {
                    if (!shape.visible) return null;
                    const isSelected = selectedIds.includes(shape.id);
                    const dimmed =
                      isolatedColor &&
                      shape.fill.toLowerCase() !== isolatedColor.toLowerCase();

                    if (shape.type === 'text' && shape.textContent) {
                      const fSize = shape.fontSize || 48;
                      return (
                        <text
                          key={shape.id}
                          x={shape.bounds.x}
                          y={shape.bounds.y + fSize * 0.85}
                          fontFamily={shape.fontFamily || 'sans-serif'}
                          fontSize={fSize}
                          fontWeight={shape.fontWeight || 600}
                          letterSpacing={shape.letterSpacing || 0}
                          fill={shape.fill}
                          stroke={isSelected ? '#4f46e5' : shape.stroke !== 'none' ? shape.stroke : 'none'}
                          strokeWidth={isSelected ? 1 : shape.strokeWidth}
                          opacity={dimmed ? 0.12 : shape.opacity}
                          transform={
                            shape.tx || shape.ty
                              ? `translate(${shape.tx || 0} ${shape.ty || 0})`
                              : undefined
                          }
                          className="cursor-pointer select-none"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (tool === 'eraser') {
                              const shapes = doc.shapes.filter((s) => s.id !== shape.id);
                              setSelectedIds((ids) => ids.filter((id) => id !== shape.id));
                              commitDoc({
                                ...doc,
                                shapes,
                                palette: rebuildPaletteFromShapes(shapes),
                              });
                              return;
                            }
                            setSelectedIds([shape.id]);
                            if (tool === 'select' || tool === 'move') {
                              const offsets = new Map<string, { tx: number; ty: number }>();
                              offsets.set(shape.id, { tx: shape.tx || 0, ty: shape.ty || 0 });
                              dragStateRef.current = {
                                kind: 'move-shape',
                                startX: e.clientX,
                                startY: e.clientY,
                                origPanX: 0,
                                origPanY: 0,
                                origOffsets: offsets,
                              };
                            }
                          }}
                        >
                          {shape.textContent}
                        </text>
                      );
                    }

                    return (
                      <path
                        key={shape.id}
                        d={shape.pathData}
                        fill={shape.fill}
                        fillRule="evenodd"
                        stroke={
                          isSelected
                            ? '#4f46e5'
                            : shape.stroke !== 'none'
                            ? shape.stroke
                            : 'none'
                        }
                        strokeWidth={
                          isSelected
                            ? Math.max(1.5, shape.strokeWidth)
                            : shape.strokeWidth
                        }
                        strokeDasharray={isSelected ? '4 2' : undefined}
                        opacity={dimmed ? 0.12 : shape.opacity}
                        transform={
                          shape.tx || shape.ty
                            ? `translate(${shape.tx || 0} ${shape.ty || 0})`
                            : undefined
                        }
                        className="cursor-pointer"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (tool === 'eraser') {
                            const shapes = doc.shapes.filter((s) => s.id !== shape.id);
                            setSelectedIds((ids) => ids.filter((id) => id !== shape.id));
                            commitDoc({
                              ...doc,
                              shapes,
                              palette: rebuildPaletteFromShapes(shapes),
                            });
                            return;
                          }
                          if (tool === 'eyedropper') {
                            setSampledHex(shape.fill);
                            return;
                          }
                          const nextSelected = e.shiftKey
                            ? selectedIds.includes(shape.id)
                              ? selectedIds.filter((id) => id !== shape.id)
                              : [...selectedIds, shape.id]
                            : [shape.id];
                          setSelectedIds(nextSelected);

                          if (tool === 'select' || tool === 'move') {
                            const offsets = new Map<string, { tx: number; ty: number }>();
                            for (const s of doc.shapes) {
                              if (nextSelected.includes(s.id)) {
                                offsets.set(s.id, { tx: s.tx || 0, ty: s.ty || 0 });
                              }
                            }
                            dragStateRef.current = {
                              kind: 'move-shape',
                              startX: e.clientX,
                              startY: e.clientY,
                              origPanX: 0,
                              origPanY: 0,
                              origOffsets: offsets,
                            };
                          }
                        }}
                      />
                    );
                  })}

                  {/* Node Editor Handles */}
                  {(tool === 'node' || tool === 'direct') &&
                    primaryShape &&
                    primaryVertices &&
                    primaryVertices.anchors.slice(0, 120).map((pt) => (
                      <circle
                        key={pt.index}
                        cx={pt.x + (primaryShape.tx || 0)}
                        cy={pt.y + (primaryShape.ty || 0)}
                        r={Math.max(2.5, Math.min(doc.width, doc.height) * 0.006)}
                        fill="#ffffff"
                        stroke="#4f46e5"
                        strokeWidth={1.5}
                        className="cursor-crosshair"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          dragStateRef.current = {
                            kind: 'drag-node',
                            startX: e.clientX,
                            startY: e.clientY,
                            origPanX: 0,
                            origPanY: 0,
                            origOffsets: new Map(),
                            nodeTokenX: pt.tokenIdxX,
                            nodeTokenY: pt.tokenIdxY,
                          };
                        }}
                      />
                    ))}

                  {/* Live Pen Preview */}
                  {tool === 'pen' && penPoints.length > 0 && (
                    <polyline
                      points={penPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke="#4f46e5"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                    />
                  )}
                    </svg>
                  </div>
                );
              })()}
            </div>
          )}
        </main>

        {/* RIGHT PANEL — PROPERTIES / PALETTE / LAYERS */}
        <aside className="border-t lg:border-t-0 lg:border-l border-slate-200 bg-white flex flex-col">
          {/* Tabs */}
          <div className="grid grid-cols-3 border-b border-slate-200 bg-slate-50/70 p-1 gap-1">
            {(
              [
                { id: 'properties', label: 'Properties' },
                { id: 'palette', label: 'Palette' },
                { id: 'layers', label: 'Layers' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setRightTab(t.id)}
                className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  rightTab === t.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-4 flex-1 overflow-y-auto">
            {sampledHex && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                <span className="text-slate-600">Picked Color</span>
                <span className="inline-flex items-center gap-1.5 font-mono font-semibold text-slate-900">
                  <span
                    className="w-3.5 h-3.5 rounded border border-slate-300"
                    style={{ backgroundColor: sampledHex }}
                  />
                  {sampledHex.toUpperCase()}
                </span>
              </div>
            )}

            {rightTab === 'properties' && (
              <div className="space-y-4 text-xs">
                {/* Multi-shape Actions */}
                <div>
                  <div className="text-[11px] font-semibold text-slate-500 mb-2">
                    Shape Actions ({selectedShapes.length} selected)
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      disabled={selectedShapes.length === 0}
                      onClick={duplicateSelected}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Duplicate
                    </button>
                    <button
                      type="button"
                      disabled={selectedShapes.length === 0}
                      onClick={deleteSelected}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border border-slate-200 text-red-600 hover:bg-red-50 disabled:opacity-40 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </button>
                    <button
                      type="button"
                      disabled={selectedShapes.length < 2}
                      onClick={mergeSelected}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                    >
                      <Merge className="w-3.5 h-3.5" />
                      Merge
                    </button>
                    <button
                      type="button"
                      disabled={!primaryShape}
                      onClick={separateSelected}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                    >
                      <Scissors className="w-3.5 h-3.5" />
                      Separate
                    </button>
                    <button
                      type="button"
                      disabled={selectedShapes.length < 2}
                      onClick={groupSelected}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      Group
                    </button>
                    <button
                      type="button"
                      disabled={selectedShapes.length === 0}
                      onClick={ungroupSelected}
                      className="inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                    >
                      <FolderX className="w-3.5 h-3.5" />
                      Ungroup
                    </button>
                  </div>
                </div>

                {primaryShape ? (
                  <div className="space-y-3 pt-3 border-t border-slate-200">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-900">{primaryShape.id}</span>
                      <span className="font-mono text-[11px] text-slate-500">
                        {primaryShape.type === 'text' ? 'text layer' : `${primaryShape.nodeCount} nodes`}
                      </span>
                    </div>

                    {primaryShape.type === 'text' && (
                      <div className="p-3 rounded-lg bg-indigo-50/60 border border-indigo-200 space-y-2.5">
                        <label className="block">
                          <span className="font-semibold text-slate-800">Text Content</span>
                          <input
                            type="text"
                            value={primaryShape.textContent || ''}
                            onChange={(e) =>
                              updateSelectedShapes((s) => ({ ...s, textContent: e.target.value }))
                            }
                            className="mt-1 w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded"
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="text-slate-600">Font Size</span>
                            <input
                              type="number"
                              min={10}
                              max={240}
                              value={primaryShape.fontSize || 48}
                              onChange={(e) =>
                                updateSelectedShapes((s) => ({
                                  ...s,
                                  fontSize: Math.max(10, Number(e.target.value) || 48),
                                }))
                              }
                              className="mt-1 w-full px-2 py-1 bg-white border border-slate-200 rounded font-mono"
                            />
                          </label>
                          <label className="block">
                            <span className="text-slate-600">Weight</span>
                            <input
                              type="number"
                              min={100}
                              max={900}
                              step={100}
                              value={primaryShape.fontWeight || 600}
                              onChange={(e) =>
                                updateSelectedShapes((s) => ({
                                  ...s,
                                  fontWeight: Math.max(100, Math.min(900, Number(e.target.value) || 400)),
                                }))
                              }
                              className="mt-1 w-full px-2 py-1 bg-white border border-slate-200 rounded font-mono"
                            />
                          </label>
                        </div>
                        {pendingFontDesign && (
                          <button
                            type="button"
                            disabled={convertingOutline}
                            onClick={() => handleConvertTextToOutlines(primaryShape)}
                            className="w-full py-1.5 px-2.5 bg-indigo-600 text-white rounded font-semibold hover:bg-indigo-700 disabled:opacity-60 cursor-pointer"
                          >
                            {convertingOutline
                              ? 'Converting Outlines...'
                              : 'Convert Text to Vector Outlines'}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Fill Color */}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Fill Color</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={primaryShape.fill === 'none' ? '#000000' : primaryShape.fill}
                          onChange={(e) =>
                            updateSelectedShapes((s) => ({ ...s, fill: e.target.value }))
                          }
                          className="w-7 h-7 rounded border border-slate-200 cursor-pointer p-0"
                        />
                        <span className="font-mono text-[11px] text-slate-800">
                          {primaryShape.fill.toUpperCase()}
                        </span>
                      </div>
                    </div>

                    {/* Stroke Color & Width */}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Stroke</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={primaryShape.stroke === 'none' ? '#0f172a' : primaryShape.stroke}
                          onChange={(e) =>
                            updateSelectedShapes((s) => ({
                              ...s,
                              stroke: e.target.value,
                              strokeWidth: Math.max(1, s.strokeWidth),
                            }))
                          }
                          className="w-7 h-7 rounded border border-slate-200 cursor-pointer p-0"
                        />
                        <input
                          type="number"
                          min={0}
                          max={24}
                          step={0.5}
                          value={primaryShape.strokeWidth}
                          onChange={(e) => {
                            const w = Number(e.target.value) || 0;
                            updateSelectedShapes((s) => ({
                              ...s,
                              strokeWidth: w,
                              stroke: w === 0 ? 'none' : s.stroke === 'none' ? '#0f172a' : s.stroke,
                            }));
                          }}
                          className="w-16 px-2 py-1 border border-slate-200 rounded font-mono tabular-nums"
                        />
                      </div>
                    </div>

                    {/* Opacity */}
                    <label className="block">
                      <div className="flex justify-between text-slate-600 mb-1">
                        <span>Opacity</span>
                        <span className="font-mono tabular-nums">
                          {Math.round(primaryShape.opacity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={primaryShape.opacity}
                        onChange={(e) =>
                          updateSelectedShapes((s) => ({
                            ...s,
                            opacity: parseFloat(e.target.value),
                          }))
                        }
                        className="w-full accent-indigo-600"
                      />
                    </label>

                    {/* Layer Order */}
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-slate-600">Layer Order</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => reorderSelected('up')}
                          className="inline-flex items-center gap-1 px-2 py-1 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          <ArrowUp className="w-3 h-3" />
                          Forward
                        </button>
                        <button
                          type="button"
                          onClick={() => reorderSelected('down')}
                          className="inline-flex items-center gap-1 px-2 py-1 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          <ArrowDown className="w-3 h-3" />
                          Back
                        </button>
                      </div>
                    </div>

                    {/* Dimensions & Position */}
                    <div className="pt-2 border-t border-slate-200 grid grid-cols-2 gap-2 font-mono tabular-nums text-[11px] text-slate-600">
                      <div className="p-2 rounded bg-slate-50">
                        X: {(primaryShape.bounds.x + (primaryShape.tx || 0)).toFixed(1)}
                      </div>
                      <div className="p-2 rounded bg-slate-50">
                        Y: {(primaryShape.bounds.y + (primaryShape.ty || 0)).toFixed(1)}
                      </div>
                      <div className="p-2 rounded bg-slate-50">
                        W: {primaryShape.bounds.width.toFixed(1)}
                      </div>
                      <div className="p-2 rounded bg-slate-50">
                        H: {primaryShape.bounds.height.toFixed(1)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-slate-500 pt-4 text-center">
                    Click any vector shape on the canvas to inspect or edit its geometry, fill, and layer order. Hold Shift to multi-select.
                  </p>
                )}
              </div>
            )}

            {rightTab === 'palette' && (
              <PalettePanel
                document={doc}
                onUpdateDocument={commitDoc}
                isolatedColor={isolatedColor}
                onIsolateColor={setIsolatedColor}
              />
            )}

            {rightTab === 'layers' && (
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-slate-900 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-indigo-600" />
                    Vector Shapes ({doc.shapes.length})
                  </span>
                </div>
                <div className="max-h-[460px] overflow-y-auto space-y-1 pr-1">
                  {doc.shapes.slice().reverse().map((s) => {
                    const active = selectedIds.includes(s.id);
                    return (
                      <div
                        key={s.id}
                        onClick={() => setSelectedIds([s.id])}
                        className={`flex items-center justify-between px-2.5 py-2 rounded-lg border cursor-pointer ${
                          active
                            ? 'border-indigo-400 bg-indigo-50/70'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-3.5 h-3.5 rounded-xs border border-slate-300 shrink-0"
                            style={{ backgroundColor: s.fill === 'none' ? '#fff' : s.fill }}
                          />
                          <span className="truncate font-medium text-slate-800">
                            {s.id}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const shapes = doc.shapes.map((item) =>
                              item.id === s.id ? { ...item, visible: !item.visible } : item
                            );
                            commitDoc({ ...doc, shapes });
                          }}
                          className="text-[11px] text-slate-500 hover:text-slate-900 cursor-pointer"
                        >
                          {s.visible ? 'Hide' : 'Show'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
