import React, { useRef, useState } from 'react';
import { Columns2, Maximize2, Minimize2, Move, SlidersHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import { sanitizeSvgXml } from '../lib/svgClient.ts';

interface BeforeAfterViewerProps {
  beforeUrl: string;
  afterSvg?: string;
  afterImageUrl?: string;
  beforeLabel?: string;
  afterLabel?: string;
  checkerboard?: boolean;
}

export const BeforeAfterViewer: React.FC<BeforeAfterViewerProps> = ({
  beforeUrl,
  afterSvg,
  afterImageUrl,
  beforeLabel = 'Original Raster',
  afterLabel = 'Vector / Enhanced',
  checkerboard = true,
}) => {
  const [mode, setMode] = useState<'slider' | 'side-by-side'>('slider');
  const [splitPos, setSplitPos] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [panning, setPanning] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const safeSvg = afterSvg ? sanitizeSvgXml(afterSvg) : null;

  const updateSplitFromPointer = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplitPos(Math.max(2, Math.min(98, pct)));
  };

  const renderAfterContent = () => {
    if (safeSvg) {
      return (
        <div
          className="w-full h-full flex items-center justify-center [&>svg]:max-w-full [&>svg]:max-h-full [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain"
          dangerouslySetInnerHTML={{ __html: safeSvg }}
        />
      );
    }
    if (afterImageUrl) {
      return (
        <img
          src={afterImageUrl}
          alt={afterLabel}
          referrerPolicy="no-referrer"
          className="w-full h-full object-contain select-none pointer-events-none"
        />
      );
    }
    return null;
  };

  const viewerBody = (
    <div
      className={`flex flex-col border border-slate-200 rounded-xl bg-white overflow-hidden ${
        fullscreen ? 'fixed inset-4 z-50 shadow-2xl' : 'w-full'
      }`}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-200 bg-slate-50/70">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setMode('slider')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              mode === 'slider' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Slider
          </button>
          <button
            type="button"
            onClick={() => setMode('side-by-side')}
            className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              mode === 'side-by-side' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" />
            Side by Side
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.5).toFixed(1))))}
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
            onClick={() => setZoom((z) => Math.min(8, Number((z + 0.5).toFixed(1))))}
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
            className="px-2.5 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
            title={fullscreen ? 'Exit Fullscreen' : 'Fullscreen Inspection'}
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Viewport */}
      {mode === 'slider' ? (
        <div
          ref={containerRef}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).dataset.handle === 'true') {
              setDraggingSplit(true);
              return;
            }
            setPanning(true);
            panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
          }}
          onPointerMove={(e) => {
            if (draggingSplit) {
              updateSplitFromPointer(e.clientX);
            } else if (panning) {
              setPan({
                x: panStartRef.current.panX + (e.clientX - panStartRef.current.x),
                y: panStartRef.current.panY + (e.clientY - panStartRef.current.y),
              });
            }
          }}
          onPointerUp={() => {
            setDraggingSplit(false);
            setPanning(false);
          }}
          onPointerLeave={() => {
            setDraggingSplit(false);
            setPanning(false);
          }}
          className={`relative w-full ${
            fullscreen ? 'flex-1' : 'h-[420px]'
          } overflow-hidden select-none cursor-grab active:cursor-grabbing ${
            checkerboard ? 'bg-checkerboard' : 'bg-white'
          }`}
        >
          {/* After layer (full canvas) */}
          <div
            className="absolute inset-0 flex items-center justify-center p-6"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }}
          >
            {renderAfterContent()}
          </div>

          {/* Before layer (clipped left portion) */}
          <div
            className="absolute inset-0 flex items-center justify-center p-6 bg-white/85"
            style={{
              clipPath: `inset(0 ${100 - splitPos}% 0 0)`,
            }}
          >
            <div
              className="w-full h-full flex items-center justify-center"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
              }}
            >
              <img
                src={beforeUrl}
                alt={beforeLabel}
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain select-none pointer-events-none"
              />
            </div>
          </div>

          {/* Labels */}
          <div className="absolute top-3 left-3 px-2.5 py-1 rounded bg-slate-900/75 text-white text-[11px] font-medium pointer-events-none">
            {beforeLabel}
          </div>
          <div className="absolute top-3 right-3 px-2.5 py-1 rounded bg-indigo-600/90 text-white text-[11px] font-medium pointer-events-none">
            {afterLabel}
          </div>

          {/* Draggable Vertical Handle */}
          <div
            data-handle="true"
            style={{ left: `${splitPos}%` }}
            className="absolute top-0 bottom-0 w-0.5 bg-indigo-600 cursor-ew-resize z-10"
          >
            <div
              data-handle="true"
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-indigo-600 text-white shadow-md flex items-center justify-center border-2 border-white"
            >
              <Move className="w-3.5 h-3.5 pointer-events-none" />
            </div>
          </div>
        </div>
      ) : (
        <div
          onPointerDown={(e) => {
            setPanning(true);
            panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
          }}
          onPointerMove={(e) => {
            if (panning) {
              setPan({
                x: panStartRef.current.panX + (e.clientX - panStartRef.current.x),
                y: panStartRef.current.panY + (e.clientY - panStartRef.current.y),
              });
            }
          }}
          onPointerUp={() => setPanning(false)}
          onPointerLeave={() => setPanning(false)}
          className={`grid grid-cols-2 divide-x divide-slate-200 ${
            fullscreen ? 'flex-1' : 'h-[420px]'
          } cursor-grab active:cursor-grabbing`}
        >
          <div className="relative overflow-hidden bg-slate-50 flex items-center justify-center p-4">
            <div className="absolute top-3 left-3 px-2.5 py-1 rounded bg-slate-900/75 text-white text-[11px] font-medium z-10 pointer-events-none">
              {beforeLabel}
            </div>
            <img
              src={beforeUrl}
              alt={beforeLabel}
              referrerPolicy="no-referrer"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
              }}
              className="max-w-full max-h-full object-contain select-none pointer-events-none"
            />
          </div>
          <div
            className={`relative overflow-hidden flex items-center justify-center p-4 ${
              checkerboard ? 'bg-checkerboard' : 'bg-white'
            }`}
          >
            <div className="absolute top-3 right-3 px-2.5 py-1 rounded bg-indigo-600/90 text-white text-[11px] font-medium z-10 pointer-events-none">
              {afterLabel}
            </div>
            <div
              className="w-full h-full flex items-center justify-center"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
              }}
            >
              {renderAfterContent()}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {fullscreen && <div className="fixed inset-0 z-40 bg-slate-950/60" onClick={() => setFullscreen(false)} />}
      {viewerBody}
    </>
  );
};
