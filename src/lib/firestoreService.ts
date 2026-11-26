import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { ref, uploadString } from 'firebase/storage';
import { type User } from 'firebase/auth';
import { db, handleFirestoreError, OperationType, storage } from './firebase.ts';
import type { VectorPreset } from '../types/vector.ts';

export interface UserProfileRecord {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  plan: 'free' | 'pro' | 'business';
  dailyConversionsUsed: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserSettingsRecord {
  userId: string;
  defaultPreset: VectorPreset;
  defaultExportFormat: 'svg' | 'pdf' | 'eps' | 'dxf' | 'png';
  defaultUpscaleFactor: 1 | 2 | 3 | 4;
  showGrid: boolean;
  showRulers: boolean;
  checkerboardBg: boolean;
  updatedAt?: unknown;
}

export interface ProjectRecord {
  projectId: string;
  userId: string;
  name: string;
  folder: string;
  kind: 'vector' | 'upscale' | 'background-removal';
  status: 'draft' | 'processing' | 'completed' | 'failed';
  sourceUploadId?: string;
  latestResultId?: string;
  width?: number;
  height?: number;
  shapeCount?: number;
  colorCount?: number;
  thumbnailDataUrl?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DownloadHistoryRecord {
  downloadId: string;
  userId: string;
  projectId: string;
  projectName: string;
  format: 'svg' | 'pdf' | 'eps' | 'dxf' | 'png' | 'jpg' | 'webp' | 'zip';
  byteSize: number;
  createdAt?: unknown;
}

export interface FontSearchHistoryRecord {
  searchId: string;
  userId: string;
  filename: string;
  extractedText: string;
  matchedFontFamily: string;
  matchedFontId?: string;
  isExactMatch: boolean;
  confidencePercent: number;
  licenseClass: string;
  regionCount: number;
  thumbnailDataUrl?: string;
  createdAt?: unknown;
}

function makeValidId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.replace(
    /[^a-zA-Z0-9_-]/g,
    '_'
  );
}

export async function ensureUserProfile(user: User): Promise<UserProfileRecord | null> {
  if (!user.uid || !user.emailVerified) return null;
  const userPath = `users/${user.uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists()) {
      return snap.data() as UserProfileRecord;
    }
    const profile: UserProfileRecord = {
      uid: user.uid,
      email: (user.email || 'user@makevectorizer.app').slice(0, 254),
      displayName: (user.displayName || user.email?.split('@')[0] || 'Designer').slice(0, 100),
      ...(user.photoURL ? { photoURL: user.photoURL.slice(0, 512) } : {}),
      plan: 'free',
      dailyConversionsUsed: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'users', user.uid), profile);

    const settings: UserSettingsRecord = {
      userId: user.uid,
      defaultPreset: 'logo',
      defaultExportFormat: 'svg',
      defaultUpscaleFactor: 4,
      showGrid: false,
      showRulers: true,
      checkerboardBg: true,
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'userSettings', user.uid), settings);
    return profile;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

export async function getUserSettings(userId: string): Promise<UserSettingsRecord | null> {
  const path = `userSettings/${userId}`;
  try {
    const snap = await getDoc(doc(db, 'userSettings', userId));
    return snap.exists() ? (snap.data() as UserSettingsRecord) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function saveUserSettings(
  userId: string,
  settings: Omit<UserSettingsRecord, 'userId' | 'updatedAt'>
): Promise<void> {
  const path = `userSettings/${userId}`;
  try {
    await setDoc(doc(db, 'userSettings', userId), {
      userId,
      defaultPreset: settings.defaultPreset,
      defaultExportFormat: settings.defaultExportFormat,
      defaultUpscaleFactor: settings.defaultUpscaleFactor,
      showGrid: settings.showGrid,
      showRulers: settings.showRulers,
      checkerboardBg: settings.checkerboardBg,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export function subscribeUserProjects(
  userId: string,
  onData: (projects: ProjectRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, 'projects'),
    where('userId', '==', userId),
    orderBy('updatedAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as ProjectRecord));
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, 'projects');
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export function subscribeDownloadHistory(
  userId: string,
  onData: (items: DownloadHistoryRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, 'downloadHistory'),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as DownloadHistoryRecord));
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, 'downloadHistory');
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function saveVectorProjectToFirebase(params: {
  user: User;
  existingProjectId?: string;
  name: string;
  folder?: string;
  width: number;
  height: number;
  shapeCount: number;
  colorCount: number;
  preset: string;
  paletteColors: string[];
  svgContent: string;
  thumbnailDataUrl?: string;
}): Promise<string> {
  const { user } = params;
  const projectId = params.existingProjectId || makeValidId('proj');
  const resultId = makeValidId('vec');
  const storagePath = `users/${user.uid}/vectors/${resultId}.svg`;

  // Upload SVG asset to Firebase Storage (best effort if Storage bucket rules are live)
  try {
    const svgRef = ref(storage, storagePath);
    await uploadString(svgRef, params.svgContent, 'raw', { contentType: 'image/svg+xml' });
  } catch {
    // Storage bucket might not be initialized yet in Spark tier; Firestore persists SVG up to 700KB
  }

  const safeThumb =
    params.thumbnailDataUrl && params.thumbnailDataUrl.length <= 190000
      ? params.thumbnailDataUrl
      : undefined;

  const projectPath = `projects/${projectId}`;
  try {
    const existingSnap = await getDoc(doc(db, 'projects', projectId));
    if (existingSnap.exists()) {
      await updateDoc(doc(db, 'projects', projectId), {
        name: params.name.slice(0, 120),
        folder: (params.folder || 'Studio').slice(0, 80),
        status: 'completed',
        latestResultId: resultId,
        width: params.width,
        height: params.height,
        shapeCount: params.shapeCount,
        colorCount: params.colorCount,
        ...(safeThumb ? { thumbnailDataUrl: safeThumb } : {}),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(doc(db, 'projects', projectId), {
        projectId,
        userId: user.uid,
        name: params.name.slice(0, 120),
        folder: (params.folder || 'Studio').slice(0, 80),
        kind: 'vector',
        status: 'completed',
        latestResultId: resultId,
        width: params.width,
        height: params.height,
        shapeCount: params.shapeCount,
        colorCount: params.colorCount,
        ...(safeThumb ? { thumbnailDataUrl: safeThumb } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, projectPath);
  }

  const vecPath = `vectorResults/${resultId}`;
  try {
    const safeSvg = params.svgContent.length <= 680000 ? params.svgContent : undefined;
    await setDoc(doc(db, 'vectorResults', resultId), {
      resultId,
      userId: user.uid,
      projectId,
      preset: params.preset.slice(0, 40),
      width: params.width,
      height: params.height,
      shapeCount: params.shapeCount,
      nodeCount: params.shapeCount * 4,
      paletteColors: JSON.stringify(params.paletteColors).slice(0, 1900),
      ...(safeSvg ? { svgContent: safeSvg } : {}),
      storagePath,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, vecPath);
  }

  return projectId;
}

export async function saveUpscaleOrBgProjectToFirebase(params: {
  user: User;
  kind: 'upscale' | 'background-removal';
  name: string;
  scaleFactor: 1 | 2 | 3 | 4;
  preset: string;
  engine: string;
  originalWidth: number;
  originalHeight: number;
  outputWidth: number;
  outputHeight: number;
  thumbnailDataUrl?: string;
}): Promise<string> {
  const { user } = params;
  const projectId = makeValidId('proj');
  const resultId = makeValidId('ups');
  const storagePath = `users/${user.uid}/upscaled/${resultId}.png`;
  const safeThumb =
    params.thumbnailDataUrl && params.thumbnailDataUrl.length <= 190000
      ? params.thumbnailDataUrl
      : undefined;

  try {
    await setDoc(doc(db, 'projects', projectId), {
      projectId,
      userId: user.uid,
      name: params.name.slice(0, 120),
      folder: params.kind === 'upscale' ? 'Upscaled' : 'Cutouts',
      kind: params.kind,
      status: 'completed',
      latestResultId: resultId,
      width: params.outputWidth,
      height: params.outputHeight,
      ...(safeThumb ? { thumbnailDataUrl: safeThumb } : {}),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `projects/${projectId}`);
  }

  try {
    await setDoc(doc(db, 'upscaleResults', resultId), {
      resultId,
      userId: user.uid,
      projectId,
      scaleFactor: params.scaleFactor,
      preset: params.preset.slice(0, 40),
      engine: params.engine.slice(0, 120),
      originalWidth: params.originalWidth,
      originalHeight: params.originalHeight,
      outputWidth: params.outputWidth,
      outputHeight: params.outputHeight,
      storagePath,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `upscaleResults/${resultId}`);
  }

  return projectId;
}

export async function loadVectorResultSvg(resultId: string): Promise<string | null> {
  const path = `vectorResults/${resultId}`;
  try {
    const snap = await getDoc(doc(db, 'vectorResults', resultId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return typeof data.svgContent === 'string' ? data.svgContent : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function renameUserProject(
  projectId: string,
  name: string,
  folder: string
): Promise<void> {
  const path = `projects/${projectId}`;
  try {
    await updateDoc(doc(db, 'projects', projectId), {
      name: name.slice(0, 120),
      folder: folder.slice(0, 80),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteUserProject(projectId: string): Promise<void> {
  const path = `projects/${projectId}`;
  try {
    await deleteDoc(doc(db, 'projects', projectId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function logDownloadRecord(params: {
  userId: string;
  projectId: string;
  projectName: string;
  format: DownloadHistoryRecord['format'];
  byteSize: number;
}): Promise<void> {
  const downloadId = makeValidId('dl');
  const path = `downloadHistory/${downloadId}`;
  try {
    await setDoc(doc(db, 'downloadHistory', downloadId), {
      downloadId,
      userId: params.userId,
      projectId: params.projectId,
      projectName: params.projectName.slice(0, 120),
      format: params.format,
      byteSize: Math.max(0, Math.round(params.byteSize)),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function saveFontSearchToFirebase(params: {
  userId: string;
  filename: string;
  extractedText: string;
  matchedFontFamily: string;
  matchedFontId?: string;
  isExactMatch: boolean;
  confidencePercent: number;
  licenseClass: string;
  regionCount: number;
  thumbnailDataUrl?: string;
}): Promise<string> {
  const searchId = makeValidId('fnt');
  const path = `fontSearches/${searchId}`;
  const safeThumb =
    params.thumbnailDataUrl && params.thumbnailDataUrl.length <= 190000
      ? params.thumbnailDataUrl
      : undefined;

  try {
    await setDoc(doc(db, 'fontSearches', searchId), {
      searchId,
      userId: params.userId,
      filename: (params.filename || 'image.png').slice(0, 180),
      extractedText: (params.extractedText || 'Text').slice(0, 500),
      matchedFontFamily: (params.matchedFontFamily || 'Unknown').slice(0, 120),
      ...(params.matchedFontId ? { matchedFontId: params.matchedFontId.slice(0, 120) } : {}),
      isExactMatch: Boolean(params.isExactMatch),
      confidencePercent: Math.max(0, Math.min(100, Math.round(params.confidencePercent))),
      licenseClass: (params.licenseClass || 'Unknown or Unverified License').slice(0, 80),
      regionCount: Math.max(1, Math.min(20, Math.round(params.regionCount))),
      ...(safeThumb ? { thumbnailDataUrl: safeThumb } : {}),
      createdAt: serverTimestamp(),
    });
    return searchId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export function subscribeFontSearchHistory(
  userId: string,
  onData: (items: FontSearchHistoryRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, 'fontSearches'),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as FontSearchHistoryRecord));
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, 'fontSearches');
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function deleteFontSearchHistory(searchId: string): Promise<void> {
  const path = `fontSearches/${searchId}`;
  try {
    await deleteDoc(doc(db, 'fontSearches', searchId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
