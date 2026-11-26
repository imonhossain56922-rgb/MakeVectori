import React, { useEffect, useState } from 'react';
import { CheckCircle2, Save } from 'lucide-react';
import type { User } from 'firebase/auth';
import { getUserSettings, saveUserSettings } from '../lib/firestoreService.ts';
import type { VectorPreset } from '../types/vector.ts';
import type { AppRoute } from '../components/Navbar.tsx';

interface SettingsPageProps {
  user: User | null;
  onNavigate: (route: AppRoute) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ user, onNavigate }) => {
  const [defaultPreset, setDefaultPreset] = useState<VectorPreset>('logo');
  const [defaultExportFormat, setDefaultExportFormat] = useState<
    'svg' | 'pdf' | 'eps' | 'dxf' | 'png'
  >('svg');
  const [defaultUpscaleFactor, setDefaultUpscaleFactor] = useState<1 | 2 | 3 | 4>(4);
  const [showGrid, setShowGrid] = useState(false);
  const [showRulers, setShowRulers] = useState(true);
  const [checkerboardBg, setCheckerboardBg] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    getUserSettings(user.uid)
      .then((s) => {
        if (!s) return;
        setDefaultPreset(s.defaultPreset);
        setDefaultExportFormat(s.defaultExportFormat);
        setDefaultUpscaleFactor(s.defaultUpscaleFactor);
        setShowGrid(s.showGrid);
        setShowRulers(s.showRulers);
        setCheckerboardBg(s.checkerboardBg);
      })
      .catch(() => {});
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <h1 className="text-2xl font-extrabold text-slate-900">Account Settings</h1>
        <p className="text-sm text-slate-600">Sign in to customize your default studio settings.</p>
        <button
          type="button"
          onClick={() => onNavigate('/signin')}
          className="px-5 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg cursor-pointer"
        >
          Sign In
        </button>
      </div>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await saveUserSettings(user.uid, {
        defaultPreset,
        defaultExportFormat,
        defaultUpscaleFactor,
        showGrid,
        showRulers,
        checkerboardBg,
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
          User & Studio Settings
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Configure defaults for vector tracing, 4X upscaling, and canvas guides.
        </p>
      </div>

      <form
        onSubmit={handleSave}
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 text-xs"
      >
        <div className="pb-4 border-b border-slate-100">
          <div className="font-semibold text-slate-900">Account Identity</div>
          <div className="text-slate-600 mt-1">
            {user.displayName || 'MakeVectorizer User'} · {user.email}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="block">
            <span className="font-medium text-slate-700">Default Vector Preset</span>
            <select
              value={defaultPreset}
              onChange={(e) => setDefaultPreset(e.target.value as VectorPreset)}
              className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
            >
              <option value="logo">Logo & Branding</option>
              <option value="illustration">Illustration</option>
              <option value="photography">Photography</option>
              <option value="sketch">Sketch & Line Art</option>
              <option value="screenprint">Screen Printing</option>
              <option value="cnc">Laser Cutting & CNC</option>
              <option value="typography">Text & Typography</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700">Default Export Format</span>
            <select
              value={defaultExportFormat}
              onChange={(e) =>
                setDefaultExportFormat(
                  e.target.value as 'svg' | 'pdf' | 'eps' | 'dxf' | 'png'
                )
              }
              className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg"
            >
              <option value="svg">SVG</option>
              <option value="pdf">Vector PDF</option>
              <option value="eps">PostScript EPS</option>
              <option value="dxf">AutoCAD DXF</option>
              <option value="png">PNG</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700">Default Upscale Factor</span>
            <select
              value={defaultUpscaleFactor}
              onChange={(e) => setDefaultUpscaleFactor(Number(e.target.value) as 1 | 2 | 3 | 4)}
              className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg font-mono"
            >
              <option value={2}>2X</option>
              <option value={3}>3X</option>
              <option value={4}>4X</option>
            </select>
          </label>
        </div>

        <div className="space-y-2.5 pt-2">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-slate-700">Show canvas grid by default</span>
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(e) => setShowGrid(e.target.checked)}
              className="accent-indigo-600"
            />
          </label>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-slate-700">Show pixel rulers by default</span>
            <input
              type="checkbox"
              checked={showRulers}
              onChange={(e) => setShowRulers(e.target.checked)}
              className="accent-indigo-600"
            />
          </label>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-slate-700">Show checkerboard transparency background</span>
            <input
              type="checkbox"
              checked={checkerboardBg}
              onChange={(e) => setCheckerboardBg(e.target.checked)}
              className="accent-indigo-600"
            />
          </label>
        </div>

        <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
          {saved ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
              <CheckCircle2 className="w-4 h-4" />
              Preferences saved to Firestore
            </span>
          ) : (
            <span />
          )}
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-60 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>
    </div>
  );
};
