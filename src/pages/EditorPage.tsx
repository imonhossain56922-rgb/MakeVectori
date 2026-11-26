import React, { useRef, useState } from 'react';
import { FileCode, Upload } from 'lucide-react';
import { parseSvgStringToDocument } from '../lib/svgClient.ts';
import { auth } from '../lib/firebase.ts';
import { saveVectorProjectToFirebase } from '../lib/firestoreService.ts';
import { serializeDocumentToSvg } from '../lib/svgClient.ts';
import type { PendingFontDesign, UploadMetadata, VectorDocument } from '../types/vector.ts';
import { VectorEditorWorkspace } from '../components/VectorEditorWorkspace.tsx';
import { ExportModal } from '../components/ExportModal.tsx';
import type { AppRoute } from '../components/Navbar.tsx';

interface EditorPageProps {
  activeVectorDoc: VectorDocument | null;
  activeUpload: UploadMetadata | null;
  activeProjectId?: string;
  pendingFontDesign?: PendingFontDesign | null;
  onSetVectorDoc: (doc: VectorDocument | null, projectId?: string) => void;
  onNavigate: (route: AppRoute) => void;
}

export const EditorPage: React.FC<EditorPageProps> = ({
  activeVectorDoc,
  activeUpload,
  activeProjectId,
  pendingFontDesign,
  onSetVectorDoc,
  onNavigate,
}) => {
  const svgInputRef = useRef<HTMLInputElement>(null);
  const [exportDoc, setExportDoc] = useState<VectorDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [svgFilename, setSvgFilename] = useState(
    activeUpload?.filename || 'makevectorizer_artwork.svg'
  );

  React.useEffect(() => {
    if (!pendingFontDesign) return;
    if (!activeVectorDoc) {
      const fSize = 56;
      const fontDoc: VectorDocument = {
        width: 800,
        height: 450,
        viewBox: '0 0 800 450',
        backgroundColor: '#ffffff',
        shapes: [
          {
            id: `text_${Date.now().toString(36)}`,
            groupId: 'layer_typography',
            layerName: `${pendingFontDesign.family} Layer`,
            type: 'text',
            pathData: 'M 80 180 L 720 180 L 720 250 L 80 250 Z',
            fill: '#0f172a',
            stroke: 'none',
            strokeWidth: 0,
            opacity: 1,
            visible: true,
            locked: false,
            bounds: { x: 80, y: 180, width: 640, height: fSize },
            nodeCount: 4,
            textContent: pendingFontDesign.sampleText || pendingFontDesign.family,
            fontFamily: pendingFontDesign.family,
            fontSize: fSize,
            fontWeight: pendingFontDesign.weight || 600,
            letterSpacing: 0,
          },
        ],
        palette: [{ hex: '#0f172a', rgb: [15, 23, 42], areaPercent: 100, shapeCount: 1 }],
        metadata: {
          preset: 'typography',
          engine: `MakeVectorizer Studio · Font: ${pendingFontDesign.family}`,
          processingMs: 0,
          totalShapes: 1,
          totalNodes: 4,
        },
      };
      setSvgFilename(`${pendingFontDesign.fontId}_design.svg`);
      setStatusMsg(
        `Loaded "${pendingFontDesign.family}" into the Vector Editor. Click "Add Text Layer" or "Convert Text to Vector Outlines" in the Properties panel.`
      );
      onSetVectorDoc(fontDoc);
    } else {
      setStatusMsg(
        `Font "${pendingFontDesign.family}" is active in the editor—click the T (Add Text Layer) button in the left toolbar to insert it onto your canvas.`
      );
    }
  }, [pendingFontDesign?.fontId, pendingFontDesign?.sampleText]);

  const handleLoadSvgFile = async (file: File) => {
    const text = await file.text();
    const doc = parseSvgStringToDocument(text);
    setSvgFilename(file.name);
    onSetVectorDoc(doc);
  };

  const createBlankCanvas = () => {
    const blank: VectorDocument = {
      width: 800,
      height: 600,
      viewBox: '0 0 800 600',
      backgroundColor: null,
      shapes: [
        {
          id: 'shape_starter_1',
          groupId: 'layer_default',
          layerName: 'Starter Shape',
          type: 'rect',
          pathData: 'M 260 180 L 540 180 L 540 420 L 260 420 Z',
          fill: '#4f46e5',
          stroke: 'none',
          strokeWidth: 0,
          opacity: 1,
          visible: true,
          locked: false,
          bounds: { x: 260, y: 180, width: 280, height: 240 },
          nodeCount: 4,
        },
      ],
      palette: [{ hex: '#4f46e5', rgb: [79, 70, 229], areaPercent: 100, shapeCount: 1 }],
      metadata: {
        preset: 'logo',
        engine: 'MakeVectorizer Studio Canvas',
        processingMs: 0,
        totalShapes: 1,
        totalNodes: 4,
      },
    };
    setSvgFilename('untitled_vector.svg');
    onSetVectorDoc(blank);
  };

  const handleSave = async (docToSave: VectorDocument) => {
    const user = auth.currentUser;
    if (!user) {
      onNavigate('/signin');
      return;
    }
    if (!user.emailVerified) {
      setStatusMsg('Please verify your email address before saving projects.');
      return;
    }
    setSaving(true);
    setStatusMsg(null);
    try {
      const svg = serializeDocumentToSvg(docToSave);
      const pid = await saveVectorProjectToFirebase({
        user,
        existingProjectId: activeProjectId,
        name: svgFilename.replace(/\.[^/.]+$/, ''),
        folder: 'Studio',
        width: docToSave.width,
        height: docToSave.height,
        shapeCount: docToSave.shapes.length,
        colorCount: docToSave.palette.length,
        preset: docToSave.metadata.preset,
        paletteColors: docToSave.palette.map((p) => p.hex),
        svgContent: svg,
        thumbnailDataUrl: activeUpload?.previewDataUrl,
      });
      onSetVectorDoc(docToSave, pid);
      setStatusMsg('Saved vector document to your Firestore Dashboard.');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Advanced Vector Editor
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Edit vector shapes, anchor nodes, fill colors, groups, and layer order—every edit updates the exportable vector document.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={svgInputRef}
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleLoadSvgFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => svgInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Open Existing SVG
          </button>
          <button
            type="button"
            onClick={() => onNavigate('/vectorizer')}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
          >
            Trace Raster Image
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className="rounded-lg bg-indigo-50 border border-indigo-200 px-4 py-2.5 text-xs text-indigo-800">
          {statusMsg}
        </div>
      )}

      {activeVectorDoc ? (
        <VectorEditorWorkspace
          key={`${activeVectorDoc.shapes.length}_${activeProjectId || 'local'}`}
          initialDocument={activeVectorDoc}
          originalImageUrl={activeUpload?.previewDataUrl}
          filename={svgFilename}
          pendingFontDesign={pendingFontDesign}
          onRequestExport={(d) => setExportDoc(d)}
          onRequestSave={handleSave}
          onRequestBgRemove={() => onNavigate('/background-remover')}
          onRequestCrop={() => onNavigate('/vectorizer')}
          saving={saving}
        />
      ) : (
        <div className="border border-slate-200 rounded-xl bg-slate-50/70 p-12 text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-xl bg-white border border-slate-200 flex items-center justify-center text-indigo-600">
            <FileCode className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">No active vector document loaded</h2>
            <p className="text-xs text-slate-600 mt-1 max-w-md mx-auto">
              Trace a PNG/JPG/WebP in the Vectorizer, open an existing SVG file from your computer, or start from a blank vector canvas.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => onNavigate('/vectorizer')}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
            >
              Go to Image Vectorizer
            </button>
            <button
              type="button"
              onClick={() => svgInputRef.current?.click()}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Import SVG File
            </button>
            <button
              type="button"
              onClick={createBlankCanvas}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              New Blank Vector Canvas
            </button>
          </div>
        </div>
      )}

      {exportDoc && (
        <ExportModal
          open={Boolean(exportDoc)}
          onClose={() => setExportDoc(null)}
          document={exportDoc}
          filename={svgFilename}
          projectId={activeProjectId}
        />
      )}
    </div>
  );
};
