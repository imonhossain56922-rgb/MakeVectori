import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { auth, storage } from './firebase.ts';
import {
  blobToDataUrl,
  compressImageForProxyLimit,
  createSafePreviewUrl,
  dataUrlToBlob,
  prepareUploadImageFile,
  trimToken,
  trimUrl,
} from './imageUtils.ts';
import type {
  BackgroundRemoveOptions,
  DetectedTextRegion,
  ExportOptions,
  FontCropRect,
  ProcessingJobState,
  UploadMetadata,
  UpscaleOptions,
  VectorDocument,
  VectorPreset,
  VectorShape,
  VectorizeOptions,
} from '../types/vector.ts';

const PLACEHOLDER_HOST_PATTERN = /YOUR_CLOUD_RUN_WORKER_URL|MY_APP_URL|EXAMPLE_BACKEND_URL/i;

// Client-side caches for seamless stateless Vercel Serverless compatibility
interface CachedUploadSource {
  file?: File;
  sampleName?: 'emblem' | 'illustration' | 'watch';
  filename?: string;
  imageDataUrl?: string;
  serverless?: boolean;
}

const clientUploadCache = new Map<string, CachedUploadSource>();
const clientCompletedJobs = new Map<string, ProcessingJobState>();
let detectedServerlessRuntime = false;

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]';
}

export function getApiBaseUrl(): string {
  const raw = trimUrl(import.meta.env?.VITE_API_BASE_URL);
  if (!raw || raw === 'undefined' || raw === 'null') {
    return '';
  }
  if (PLACEHOLDER_HOST_PATTERN.test(raw)) {
    throw new Error(
      'API base URL is still set to a placeholder value. Update VITE_API_BASE_URL to your live HTTPS backend URL.'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid VITE_API_BASE_URL configuration. Expected a full https:// URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid API protocol. Only HTTPS or HTTP URLs are supported.');
  }
  if (
    typeof window !== 'undefined' &&
    window.location?.protocol === 'https:' &&
    parsed.protocol !== 'https:' &&
    !isLocalHostname(parsed.hostname)
  ) {
    throw new Error('Production API URL must use HTTPS when running on an HTTPS site.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function buildApiUrl(pathOrUrl: string): string {
  const clean = trimUrl(pathOrUrl);
  if (!clean || clean === 'undefined' || clean === 'null' || PLACEHOLDER_HOST_PATTERN.test(clean)) {
    throw new Error('Invalid API endpoint URL.');
  }

  if (clean.startsWith('/')) {
    const base = getApiBaseUrl();
    const combined = `${base}${clean}`;
    if (base) {
      try {
        return new URL(combined).toString();
      } catch {
        throw new Error('Malformed API endpoint URL.');
      }
    }
    return combined;
  }

  if (/^https?:\/\//i.test(clean)) {
    try {
      const parsed = new URL(clean);
      if (
        typeof window !== 'undefined' &&
        window.location?.protocol === 'https:' &&
        parsed.protocol !== 'https:' &&
        !isLocalHostname(parsed.hostname)
      ) {
        throw new Error('API request blocked: production URL must use HTTPS.');
      }
      return parsed.toString();
    } catch (err) {
      if (err instanceof Error && err.message.includes('HTTPS')) throw err;
      throw new Error('Malformed API endpoint URL.');
    }
  }

  throw new Error('Invalid API endpoint URL format.');
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  try {
    const token = trimToken(await user.getIdToken());
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

interface SafeFetchOptions {
  timeoutMs?: number;
  context?: string;
}

class HttpResponseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpResponseError';
    this.status = status;
  }
}

async function safeFetch(
  pathOrUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {}
): Promise<Response> {
  const targetUrl = buildApiUrl(pathOrUrl);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const context = opts.context ?? 'request';

  const headers = new Headers(init.headers || undefined);
  if (init.body instanceof FormData) {
    headers.delete('Content-Type');
    headers.delete('content-type');
  }

  const controller = new AbortController();
  let timedOut = false;
  const externalSignal = init.signal;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new Error('Processing cancelled by user.');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(targetUrl, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[MakeVectorizer API:${context}] Network/fetch error:`, err);
    if (timedOut) {
      throw new Error(
        'The request timed out while communicating with the image server. Please try again with a smaller image or check your connection.'
      );
    }
    if (externalSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new Error('Processing cancelled by user.');
    }
    const rawMsg = err instanceof Error ? err.message : String(err || '');
    if (/pattern/i.test(rawMsg)) {
      throw new Error(
        'Could not contact the processing endpoint due to an invalid URL or browser response format.'
      );
    }
    throw new Error(
      'Network error: Unable to reach the image processing server. Please check your internet connection and try again.'
    );
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function isLikelyHtml(text: string, contentType: string): boolean {
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    return true;
  }
  const head = text.trimStart().slice(0, 64).toLowerCase();
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body')
  );
}

function mapProxyOrHtmlError(status: number, context: string, bodySnippet: string): HttpResponseError {
  console.error(`[MakeVectorizer API:${context}] Non-JSON response (HTTP ${status}):`, bodySnippet.slice(0, 240));

  if (status === 413) {
    return new HttpResponseError(
      'Image file is too large for the current upload endpoint (limit exceeded).',
      413
    );
  }
  if (status === 404 || status === 405 || status === 502 || status === 503 || status === 504 || status === 200) {
    return new HttpResponseError(
      `Processing API is unavailable or misconfigured on this deployment (HTTP ${status}).`,
      status
    );
  }
  return new HttpResponseError(
    `Server returned an unexpected response (HTTP ${status}). Please try again.`,
    status
  );
}

async function parseJsonResponseSafely<T>(res: Response, context: string): Promise<T> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  let rawText = '';
  try {
    rawText = await res.text();
  } catch (err) {
    console.error(`[MakeVectorizer API:${context}] Failed to read response body:`, err);
    throw new HttpResponseError(
      `Unable to read server response (HTTP ${res.status}). Please try again.`,
      res.status
    );
  }

  if (!rawText || !rawText.trim()) {
    if (res.status === 413) {
      throw mapProxyOrHtmlError(413, context, '');
    }
    throw new HttpResponseError(
      res.ok
        ? 'The processing server returned an empty response. Please try again.'
        : `Server error (HTTP ${res.status}). Please try again.`,
      res.status
    );
  }

  if (isLikelyHtml(rawText, contentType)) {
    throw mapProxyOrHtmlError(res.status, context, rawText);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error(`[MakeVectorizer API:${context}] Invalid JSON (HTTP ${res.status}):`, rawText.slice(0, 240), err);
    if (res.status === 413) {
      throw mapProxyOrHtmlError(413, context, rawText);
    }
    throw new HttpResponseError(
      res.ok
        ? 'Received an unexpected non-JSON response from the server.'
        : `Server returned an error (HTTP ${res.status}): ${rawText.trim().slice(0, 140)}`,
      res.status
    );
  }

  if (!res.ok) {
    const errObj = parsed as { error?: unknown; message?: unknown } | null;
    const msg =
      (errObj && typeof errObj.error === 'string' && errObj.error) ||
      (errObj && typeof errObj.message === 'string' && errObj.message) ||
      `Request failed (HTTP ${res.status}).`;
    throw new HttpResponseError(msg, res.status);
  }

  return parsed as T;
}

async function parseErrorFromFailedResponse(res: Response, context: string, fallback: string): Promise<never> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const rawText = await res.text().catch(() => '');
  if (!rawText.trim()) {
    throw new HttpResponseError(`${fallback} (HTTP ${res.status})`, res.status);
  }
  if (isLikelyHtml(rawText, contentType)) {
    throw mapProxyOrHtmlError(res.status, context, rawText);
  }
  try {
    const parsed = JSON.parse(rawText) as { error?: unknown; message?: unknown };
    const msg =
      (typeof parsed.error === 'string' && parsed.error) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      fallback;
    throw new HttpResponseError(msg, res.status);
  } catch (err) {
    if (err instanceof HttpResponseError) throw err;
    throw new HttpResponseError(`${fallback} (HTTP ${res.status})`, res.status);
  }
}

async function buildStatelessPayloadExtras(uploadId: string): Promise<Record<string, unknown>> {
  const cached = clientUploadCache.get(uploadId);
  if (!cached) return {};
  if (cached.sampleName) {
    return { sampleName: cached.sampleName, filename: cached.filename };
  }
  if (cached.imageDataUrl) {
    return { imageDataUrl: cached.imageDataUrl, filename: cached.filename };
  }
  if (cached.file) {
    const compact = await compressImageForProxyLimit(cached.file, 2_800_000).catch(() => cached.file!);
    const dataUrl = await blobToDataUrl(compact);
    cached.imageDataUrl = dataUrl;
    return { imageDataUrl: dataUrl, filename: compact.name };
  }
  return {};
}

async function postJsonWithServerlessFallback<T>(
  endpoint: string,
  uploadId: string,
  basePayload: Record<string, unknown>,
  context: string,
  timeoutMs = 55_000
): Promise<T> {
  const cleanId = trimToken(uploadId);
  const headers = await getAuthHeaders();
  const cached = clientUploadCache.get(cleanId);
  const preferSync = detectedServerlessRuntime || Boolean(cached?.serverless);

  const sendRequest = async (includeStatelessImage: boolean): Promise<T> => {
    const extras = includeStatelessImage ? await buildStatelessPayloadExtras(cleanId) : {};
    const res = await safeFetch(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          ...basePayload,
          uploadId: cleanId,
          ...(preferSync || includeStatelessImage ? { sync: true } : {}),
          ...extras,
        }),
      },
      { timeoutMs, context }
    );
    return parseJsonResponseSafely<T>(res, context);
  };

  if (preferSync) {
    return sendRequest(true);
  }

  try {
    return await sendRequest(false);
  } catch (err) {
    if (
      err instanceof Error &&
      /expired or not found/i.test(err.message) &&
      clientUploadCache.has(cleanId)
    ) {
      detectedServerlessRuntime = true;
      return sendRequest(true);
    }
    throw err;
  }
}

function handleImmediateJobResult(
  raw: { jobId: string } & Partial<ProcessingJobState>,
  sourceUploadId: string
): string {
  if (raw && raw.status === 'completed' && raw.jobId) {
    clientCompletedJobs.set(raw.jobId, raw as ProcessingJobState);
    // Also cache chained output uploadId (e.g. from Upscaler or BgRemover) for Vercel follow-ups
    if (raw.result?.uploadId && raw.result?.imageDataUrl) {
      const parent = clientUploadCache.get(sourceUploadId);
      clientUploadCache.set(raw.result.uploadId, {
        imageDataUrl: raw.result.imageDataUrl,
        filename: parent?.filename || 'processed.png',
        serverless: true,
      });
    }
  }
  return raw.jobId;
}

export async function fetchEngineHealth(): Promise<{
  status: string;
  serverless?: boolean;
  maxUploadMb: number;
  engines: {
    vectorizer: { available: boolean; name: string; isExternalWorker: boolean };
    upscaler: { available: boolean; name: string; isExternalWorker: boolean };
    backgroundRemover: { available: boolean; name: string; isExternalWorker: boolean };
    aiAnalyzer: { available: boolean };
    fontFinder?: { available: boolean; sources: string[] };
  };
}> {
  const res = await safeFetch('/api/health', { method: 'GET' }, { timeoutMs: 12_000, context: 'health' });
  const data = await parseJsonResponseSafely<{
    status: string;
    serverless?: boolean;
    maxUploadMb: number;
    engines: {
      vectorizer: { available: boolean; name: string; isExternalWorker: boolean };
      upscaler: { available: boolean; name: string; isExternalWorker: boolean };
      backgroundRemover: { available: boolean; name: string; isExternalWorker: boolean };
      aiAnalyzer: { available: boolean };
      fontFinder?: { available: boolean; sources: string[] };
    };
  }>(res, 'health');
  if (data.serverless) detectedServerlessRuntime = true;
  return data;
}

async function uploadViaFirebaseStorageFallback(safeFile: File): Promise<UploadMetadata> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) {
    throw new Error('Verified sign-in required for direct cloud storage upload.');
  }
  const storagePath = `users/${user.uid}/uploads/${safeFile.name}`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, safeFile, { contentType: safeFile.type });
  const downloadUrl = await getDownloadURL(storageRef);

  const headers = await getAuthHeaders();
  const res = await safeFetch(
    '/api/upload/from-storage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        storagePath,
        downloadUrl,
        filename: safeFile.name,
      }),
    },
    { timeoutMs: 45_000, context: 'upload-from-storage' }
  );
  return parseJsonResponseSafely<UploadMetadata>(res, 'upload-from-storage');
}

async function postMultipartUpload(targetFile: File, headers: Record<string, string>): Promise<UploadMetadata> {
  const form = new FormData();
  form.append('file', targetFile, targetFile.name);
  const res = await safeFetch(
    '/api/upload',
    {
      method: 'POST',
      headers,
      body: form,
    },
    { timeoutMs: 60_000, context: 'upload' }
  );
  return parseJsonResponseSafely<UploadMetadata>(res, 'upload');
}

export async function uploadImageFile(file: File | Blob): Promise<UploadMetadata> {
  let workingFile = await prepareUploadImageFile(
    file,
    file instanceof File ? file.name : 'uploaded_image',
    file.type
  );

  const headers = await getAuthHeaders();
  let data: UploadMetadata;

  try {
    data = await postMultipartUpload(workingFile, headers);
  } catch (err) {
    if (err instanceof HttpResponseError && err.status === 413) {
      if (auth.currentUser?.emailVerified) {
        try {
          data = await uploadViaFirebaseStorageFallback(workingFile);
        } catch {
          workingFile = await compressImageForProxyLimit(workingFile, 3_400_000);
          data = await postMultipartUpload(workingFile, headers);
        }
      } else {
        workingFile = await compressImageForProxyLimit(workingFile, 3_400_000);
        data = await postMultipartUpload(workingFile, headers);
      }
    } else {
      throw err;
    }
  }

  if (data.serverless) {
    detectedServerlessRuntime = true;
  }

  clientUploadCache.set(data.uploadId, {
    file: workingFile,
    filename: data.filename,
    serverless: Boolean(data.serverless),
  });

  const localPreviewUrl = createSafePreviewUrl(workingFile);
  return {
    ...data,
    ...(localPreviewUrl ? { localPreviewUrl } : {}),
  };
}

export async function removeUploadedImage(uploadId: string): Promise<void> {
  const cleanId = trimToken(uploadId);
  if (!cleanId) return;
  clientUploadCache.delete(cleanId);
  const headers = await getAuthHeaders();
  await safeFetch(
    `/api/upload/${encodeURIComponent(cleanId)}`,
    {
      method: 'DELETE',
      headers,
    },
    { timeoutMs: 10_000, context: 'remove-upload' }
  ).catch(() => {});
}

export async function loadSampleImage(sample: 'emblem' | 'illustration' | 'watch'): Promise<UploadMetadata> {
  const headers = await getAuthHeaders();
  const res = await safeFetch(
    '/api/sample',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ sample }),
    },
    { timeoutMs: 25_000, context: 'sample' }
  );
  const data = await parseJsonResponseSafely<UploadMetadata>(res, 'sample');
  if (data.serverless) {
    detectedServerlessRuntime = true;
  }
  clientUploadCache.set(data.uploadId, {
    sampleName: sample,
    filename: data.filename,
    serverless: Boolean(data.serverless),
  });
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
  return postJsonWithServerlessFallback('/api/analyze', uploadId, {}, 'analyze', 35_000);
}

export async function startVectorizeJob(
  uploadId: string,
  options: VectorizeOptions
): Promise<string> {
  const cleanId = trimToken(uploadId);
  const data = await postJsonWithServerlessFallback<{ jobId: string } & Partial<ProcessingJobState>>(
    '/api/vectorize',
    cleanId,
    { options },
    'vectorize',
    58_000
  );
  return handleImmediateJobResult(data, cleanId);
}

export async function startUpscaleJob(
  uploadId: string,
  options: UpscaleOptions
): Promise<string> {
  const cleanId = trimToken(uploadId);
  const data = await postJsonWithServerlessFallback<{ jobId: string } & Partial<ProcessingJobState>>(
    '/api/upscale',
    cleanId,
    { options },
    'upscale',
    58_000
  );
  return handleImmediateJobResult(data, cleanId);
}

export async function startBgRemoveJob(
  uploadId: string,
  options: BackgroundRemoveOptions
): Promise<string> {
  const cleanId = trimToken(uploadId);
  const data = await postJsonWithServerlessFallback<{ jobId: string } & Partial<ProcessingJobState>>(
    '/api/remove-background',
    cleanId,
    { options },
    'remove-background',
    58_000
  );
  return handleImmediateJobResult(data, cleanId);
}

export async function startFontDetectJob(
  uploadId: string,
  crop?: FontCropRect | null,
  customHint?: string
): Promise<string> {
  const cleanId = trimToken(uploadId);
  const data = await postJsonWithServerlessFallback<{ jobId: string } & Partial<ProcessingJobState>>(
    '/api/font-finder/detect',
    cleanId,
    { crop, customHint },
    'font-detect',
    58_000
  );
  return handleImmediateJobResult(data, cleanId);
}

export async function startFontResearchJob(
  uploadId: string,
  region: DetectedTextRegion,
  extractedTextOverride?: string,
  crop?: FontCropRect | null
): Promise<string> {
  const cleanId = trimToken(uploadId);
  const data = await postJsonWithServerlessFallback<{ jobId: string } & Partial<ProcessingJobState>>(
    '/api/font-finder/research',
    cleanId,
    { region, extractedTextOverride, crop },
    'font-research',
    58_000
  );
  return handleImmediateJobResult(data, cleanId);
}

export async function downloadVerifiedFontFile(
  proxyUrl: string,
  fallbackFilename: string
): Promise<{ blob: Blob; filename: string }> {
  const res = await safeFetch(proxyUrl, { method: 'GET' }, { timeoutMs: 45_000, context: 'font-download' });
  if (!res.ok) {
    await parseErrorFromFailedResponse(res, 'font-download', 'Font download failed.');
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
  family?: string;
  text: string;
  fontSize?: number;
  weight?: number;
  isItalic?: boolean;
  x?: number;
  y?: number;
  fill?: string;
}): Promise<VectorShape> {
  const headers = await getAuthHeaders();
  const res = await safeFetch(
    '/api/font-finder/outline',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(params),
    },
    { timeoutMs: 25_000, context: 'font-outline' }
  );
  const data = await parseJsonResponseSafely<{ shape: VectorShape }>(res, 'font-outline');
  return data.shape;
}

export async function pollJobUntilDone(
  jobId: string,
  onProgress: (state: ProcessingJobState) => void,
  signal?: AbortSignal
): Promise<ProcessingJobState> {
  const cleanJobId = trimToken(jobId);
  if (!cleanJobId) throw new Error('Invalid job identifier.');

  // Immediate return for serverless synchronous completions
  const cachedDone = clientCompletedJobs.get(cleanJobId);
  if (cachedDone) {
    clientCompletedJobs.delete(cleanJobId);
    onProgress(cachedDone);
    return cachedDone;
  }

  const headers = await getAuthHeaders();

  while (true) {
    if (signal?.aborted) {
      await safeFetch(
        `/api/jobs/${encodeURIComponent(cleanJobId)}/cancel`,
        { method: 'POST', headers },
        { timeoutMs: 8_000, context: 'job-cancel' }
      ).catch(() => {});
      throw new Error('Processing cancelled by user.');
    }

    const res = await safeFetch(
      `/api/jobs/${encodeURIComponent(cleanJobId)}`,
      { method: 'GET', headers, signal },
      { timeoutMs: 20_000, context: 'job-poll' }
    );
    const data = await parseJsonResponseSafely<ProcessingJobState & { error?: string }>(
      res,
      'job-poll'
    );

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
  const cleanJobId = trimToken(jobId);
  if (!cleanJobId) return;
  clientCompletedJobs.delete(cleanJobId);
  const headers = await getAuthHeaders();
  await safeFetch(
    `/api/jobs/${encodeURIComponent(cleanJobId)}/cancel`,
    { method: 'POST', headers },
    { timeoutMs: 8_000, context: 'job-cancel' }
  ).catch(() => {});
}

export async function exportVectorFile(
  document: VectorDocument,
  options: ExportOptions,
  filename: string
): Promise<{ blob: Blob; filename: string }> {
  const res = await safeFetch(
    '/api/export',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document, options, filename }),
    },
    { timeoutMs: 45_000, context: 'export' }
  );
  if (!res.ok) {
    await parseErrorFromFailedResponse(res, 'export', 'Export failed.');
  }
  const blob = await res.blob();
  const base = filename.replace(/\.[^/.]+$/, '');
  return { blob, filename: `${base}.${options.format}` };
}

export async function downloadBatchZip(
  items: Array<{ filename: string; svg?: string; imageDataUrl?: string }>
): Promise<Blob> {
  const res = await safeFetch(
    '/api/batch/zip',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    },
    { timeoutMs: 60_000, context: 'batch-zip' }
  );
  if (!res.ok) {
    await parseErrorFromFailedResponse(res, 'batch-zip', 'ZIP export failed.');
  }
  return res.blob();
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  // Keep dataUrlToBlob referenced if tree-shaker checks exports cleanly
  void dataUrlToBlob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
