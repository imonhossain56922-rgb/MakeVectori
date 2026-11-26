import React, { useEffect, useState } from 'react';
import {
  Download,
  Edit3,
  Folder,
  FolderOpen,
  History,
  Layers,
  LogOut,
  Plus,
  Settings,
  Trash2,
  Type as TypeIcon,
} from 'lucide-react';
import { signOut, type User } from 'firebase/auth';
import { auth, verifyActiveAuthSession } from '../lib/firebase.ts';
import {
  deleteFontSearchHistory,
  deleteUserProject,
  loadVectorResultSvg,
  renameUserProject,
  subscribeDownloadHistory,
  subscribeFontSearchHistory,
  subscribeUserProjects,
  type DownloadHistoryRecord,
  type FontSearchHistoryRecord,
  type ProjectRecord,
} from '../lib/firestoreService.ts';
import { parseSvgStringToDocument } from '../lib/svgClient.ts';
import { triggerBrowserDownload } from '../lib/apiClient.ts';
import type { VectorDocument } from '../types/vector.ts';
import type { AppRoute } from '../components/Navbar.tsx';

interface DashboardPageProps {
  user: User | null;
  onNavigate: (route: AppRoute) => void;
  onOpenVectorProject: (doc: VectorDocument, projectId: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  user,
  onNavigate,
  onOpenVectorProject,
}) => {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [downloads, setDownloads] = useState<DownloadHistoryRecord[]>([]);
  const [fontSearches, setFontSearches] = useState<FontSearchHistoryRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'projects' | 'downloads' | 'fonts'>('projects');
  const [selectedFolder, setSelectedFolder] = useState<string>('All');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editFolder, setEditFolder] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubProj = subscribeUserProjects(
      user.uid,
      (items) => {
        setProjects(items);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    const unsubDl = subscribeDownloadHistory(
      user.uid,
      (items) => setDownloads(items),
      () => {}
    );
    const unsubFonts = subscribeFontSearchHistory(
      user.uid,
      (items) => setFontSearches(items),
      () => {}
    );
    return () => {
      unsubProj();
      unsubDl();
      unsubFonts();
    };
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center space-y-4">
        <h1 className="text-2xl font-extrabold text-slate-900">Sign in to view your Dashboard</h1>
        <p className="text-sm text-slate-600">
          Access saved vector documents, folder organization, upscaled history, and download logs.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => onNavigate('/signin')}
            className="px-5 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => onNavigate('/signup')}
            className="px-5 py-2.5 text-sm font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            Create Account
          </button>
        </div>
      </div>
    );
  }

  const folders = ['All', ...Array.from(new Set(projects.map((p) => p.folder || 'Studio')))];
  const visibleProjects =
    selectedFolder === 'All'
      ? projects
      : projects.filter((p) => (p.folder || 'Studio') === selectedFolder);

  const handleReopen = async (proj: ProjectRecord) => {
    if (!proj.latestResultId) return;
    const svg = await loadVectorResultSvg(proj.latestResultId);
    if (!svg) {
      setError('Saved SVG payload not found for this project.');
      return;
    }
    const doc = parseSvgStringToDocument(svg);
    onOpenVectorProject(doc, proj.projectId);
    onNavigate('/editor');
  };

  const handleDownloadSavedSvg = async (proj: ProjectRecord) => {
    if (!proj.latestResultId) return;
    const { valid } = await verifyActiveAuthSession(auth.currentUser, { force: true });
    if (!valid) {
      onNavigate('/signin');
      return;
    }
    const svg = await loadVectorResultSvg(proj.latestResultId);
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    triggerBrowserDownload(blob, `${proj.name}.svg`);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Workspace Dashboard
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Signed in as {user.displayName || user.email} · {projects.length} saved projects
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate('/vectorizer')}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Vector Project
          </button>
          <button
            type="button"
            onClick={() => onNavigate('/settings')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => signOut(auth).then(() => onNavigate('/'))}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('projects')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'projects' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Saved Projects ({projects.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('downloads')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'downloads' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            Download History ({downloads.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('fonts')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              activeTab === 'fonts' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            <TypeIcon className="w-3.5 h-3.5" />
            Font History ({fontSearches.length})
          </button>
        </div>

        {activeTab === 'projects' && folders.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {folders.map((folder) => (
              <button
                key={folder}
                type="button"
                onClick={() => setSelectedFolder(folder)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border cursor-pointer ${
                  selectedFolder === folder
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-medium'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                <Folder className="w-3 h-3" />
                {folder}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeTab === 'projects' ? (
        loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-56 rounded-xl border border-slate-200 bg-slate-50 animate-pulse" />
            ))}
          </div>
        ) : visibleProjects.length === 0 ? (
          <div className="border border-slate-200 rounded-xl bg-slate-50/70 p-12 text-center space-y-3">
            <p className="text-sm font-semibold text-slate-900">No saved projects yet</p>
            <p className="text-xs text-slate-500">
              Vectorize an image and click &ldquo;Save Project&rdquo; in the studio to organize and reopen it here anytime.
            </p>
            <button
              type="button"
              onClick={() => onNavigate('/vectorizer')}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
            >
              Vectorize Your First Image
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {visibleProjects.map((proj) => (
              <div
                key={proj.projectId}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col"
              >
                <div className="aspect-4/3 bg-checkerboard border-b border-slate-100 flex items-center justify-center p-4">
                  {proj.thumbnailDataUrl ? (
                    <img
                      src={proj.thumbnailDataUrl}
                      alt={proj.name}
                      referrerPolicy="no-referrer"
                      className="max-w-full max-h-full object-contain"
                    />
                  ) : (
                    <FolderOpen className="w-10 h-10 text-slate-300" />
                  )}
                </div>

                <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                  {editingId === proj.projectId ? (
                    <div className="space-y-2 text-xs">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-indigo-300 rounded-md"
                        placeholder="Project name"
                      />
                      <input
                        type="text"
                        value={editFolder}
                        onChange={(e) => setEditFolder(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md"
                        placeholder="Folder name"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            await renameUserProject(
                              proj.projectId,
                              editName || proj.name,
                              editFolder || 'Studio'
                            );
                            setEditingId(null);
                          }}
                          className="px-3 py-1 bg-indigo-600 text-white rounded font-medium cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 text-slate-600 cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-sm font-bold text-slate-900 truncate">{proj.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5 font-mono tabular-nums">
                        <span>{proj.folder || 'Studio'}</span>
                        <span>·</span>
                        <span>{proj.kind}</span>
                        {proj.width && proj.height ? (
                          <>
                            <span>·</span>
                            <span>
                              {proj.width}×{proj.height}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
                    <div className="flex items-center gap-1.5">
                      {proj.kind === 'vector' && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleReopen(proj)}
                            className="px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-md font-semibold hover:bg-indigo-100 cursor-pointer"
                          >
                            Open in Editor
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDownloadSavedSvg(proj)}
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                            title="Download SVG"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(proj.projectId);
                          setEditName(proj.name);
                          setEditFolder(proj.folder || 'Studio');
                        }}
                        className="p-1.5 text-slate-400 hover:text-slate-800 rounded cursor-pointer"
                        title="Rename / Move Folder"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteUserProject(proj.projectId)}
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                        title="Delete Project"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : activeTab === 'downloads' ? (
        downloads.length === 0 ? (
          <div className="border border-slate-200 rounded-xl bg-slate-50/70 p-12 text-center text-xs text-slate-500">
            Your exported SVG, PDF, EPS, DXF, and PNG downloads will appear here.
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="py-3 px-4 font-semibold">Project</th>
                  <th className="py-3 px-4 font-semibold">Format</th>
                  <th className="py-3 px-4 font-semibold text-right">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {downloads.map((dl) => (
                  <tr key={dl.downloadId} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 font-medium text-slate-900">{dl.projectName}</td>
                    <td className="py-3 px-4 uppercase font-mono text-indigo-700">{dl.format}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                      {(dl.byteSize / 1024).toFixed(1)} KB
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : fontSearches.length === 0 ? (
        <div className="border border-slate-200 rounded-xl bg-slate-50/70 p-12 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-900">No font identification searches yet</p>
          <p className="text-xs text-slate-500">
            Use AI Font Finder to detect typography in any image—your verified matches and licenses will appear here.
          </p>
          <button
            type="button"
            onClick={() => onNavigate('/font-finder')}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
          >
            Open AI Font Finder
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {fontSearches.map((fs) => (
            <div
              key={fs.searchId}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col"
            >
              <div className="aspect-4/3 bg-checkerboard border-b border-slate-100 flex items-center justify-center p-4">
                {fs.thumbnailDataUrl ? (
                  <img
                    src={fs.thumbnailDataUrl}
                    alt={fs.filename}
                    referrerPolicy="no-referrer"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <TypeIcon className="w-10 h-10 text-slate-300" />
                )}
              </div>
              <div className="p-4 flex-1 flex flex-col justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-slate-900 truncate">
                      {fs.matchedFontFamily}
                    </span>
                    <span className="font-mono font-semibold text-indigo-700">
                      {fs.confidencePercent}%
                    </span>
                  </div>
                  <div className="text-slate-600 truncate">
                    Text: &ldquo;{fs.extractedText}&rdquo;
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {fs.isExactMatch ? 'Verified exact match' : 'Exact font not found'} · {fs.licenseClass}
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => onNavigate('/font-finder')}
                    className="px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-md font-semibold hover:bg-indigo-100 cursor-pointer"
                  >
                    Open AI Font Finder
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteFontSearchHistory(fs.searchId)}
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                    title="Delete Font Search History"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
