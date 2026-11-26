import { auth } from './firebase.ts';
import type {
  BackgroundRemoveOptions,
  ExportOptions,
  FontCropRect,
  FontSearchFilters,
  ProcessingJobState,
  UploadMetadata,
  UpscaleOptions,
  VectorDocument,
  VectorPreset,
  VectorShape,
  VectorizeOptions,
} from '../types/vector.ts';

async function getAuthHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  try {
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

export async function fetchEngineHealth(): Promise<{
  status: string;
  maxUploadMb: number;
  engines: {
    vectorizer: { available: boolean; name: string; isExternalWorker: boolean };
    upscaler: { available: boolean; name: string; isExternalWorker: boolean };
    backgroundRemover: { available: boolean; name: string; isExternalWorker: boolean };
    aiAnalyzer: { available: boolean; model: string };
  };
}> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error('Unable to reach processing server.');
  return res.json();
}

export async function uploadImageFile(file: File): Promise<UploadMetadata> {
  const headers = await getAuthHeaders();
  const form = new FormData();
  form.append('file', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    headers,
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Image upload failed.');
  return data;
}

export async function loadSampleImage(sample: 'emblem' | 'illustration' | 'watch'): Promise<UploadMetadata> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ sample }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load sample image.');
  return data;
}

export async function analyzeImageAi(uploadId: string): Promise<{
  recommendedPreset: VectorPreset;
  recommendedColorCount: 'auto' | 2 | 4 | 8 | 16 | 32 | 64;
  curveSmoothing: number;
  cornerPrecision: number;
  noiseReduction: number;
  subjectSummary: string;
  aiPowered: boolean;
}> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ uploadId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'AI analysis failed.');
  return data;
}

export async function startVectorizeJob(
  uploadId: string,
  options: VectorizeOptions
): Promise<string> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/vectorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ uploadId, options }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to start vectorization.');
  return data.jobId;
}

export async function startUpscaleJob(
  uploadId: string,
  options: UpscaleOptions
): Promise<string> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/upscale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ uploadId, options }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to start upscaling.');
  return data.jobId;
}

export async function startBgRemoveJob(
  uploadId: string,
  options: BackgroundRemoveOptions
): Promise<string> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/remove-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ uploadId, options }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to start background removal.');
  return data.jobId;
}

export async function startFontFinderJob(
  uploadId: string,
  crop?: FontCropRect | null,
  filters?: FontSearchFilters
): Promise<string> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/font-finder/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ uploadId, crop, filters }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to start AI Font Finder.');
  return data.jobId;
}

export async function downloadVerifiedFontFile(
  proxyUrl: string,
  fallbackFilename: string
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(proxyUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Font download failed.' }));
    throw new Error(err.error || 'Font download failed.');
  }
  const cd = res.headers.get('content-disposition') || '';
  const match = cd.match(/filename="([^"]+)"/i);
  const blob = await res.blob();
  return {
    blob,
    filename: match?.[1] || fallbackFilename,
  };
}

export async function convertFontTextToVectorShape(params: {
  fontId: string;
  text: string;
  fontSize?: number;
  weight?: number;
  isItalic?: boolean;
  x?: number;
  y?: number;
  fill?: string;
}): Promise<VectorShape> {
  const headers = await getAuthHeaders();
  const res = await fetch('/api/font-finder/outline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Font outline conversion failed.');
  return data.shape as VectorShape;
}

export async function pollJobUntilDone(
  jobId: string,
  onProgress: (state: ProcessingJobState) => void,
  signal?: AbortSignal
): Promise<ProcessingJobState> {
  const headers = await getAuthHeaders();
  while (true) {
    if (signal?.aborted) {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST', headers });
      throw new Error('Processing cancelled by user.');
    }
    const res = await fetch(`/api/jobs/${jobId}`, { headers });
    const data = (await res.json()) as ProcessingJobState & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to read job progress.');
    }
    onProgress(data);
    if (data.status === 'completed') {
      return data;
    }
    if (data.status === 'failed') {
      throw new Error(data.error || 'Processing job failed.');
    }
    if (data.status === 'cancelled') {
      throw new Error('Processing cancelled.');
    }
    await new Promise((r) => setTimeout(r, 220));
  }
}

export async function cancelProcessingJob(jobId: string): Promise<void> {
  const headers = await getAuthHeaders();
  await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST', headers });
}

export async function exportVectorFile(
  document: VectorDocument,
  options: ExportOptions,
  filename: string
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, options, filename }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed.' }));
    throw new Error(err.error || 'Export failed.');
  }
  const blob = await res.blob();
  const base = filename.replace(/\.[^/.]+$/, '');
  return { blob, filename: `${base}.${options.format}` };
}

export async function downloadBatchZip(
  items: Array<{ filename: string; svg?: string; imageDataUrl?: string }>
): Promise<Blob> {
  const res = await fetch('/api/batch/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'ZIP export failed.' }));
    throw new Error(err.error || 'ZIP export failed.');
  }
  return res.blob();
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
