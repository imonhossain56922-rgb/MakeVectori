import 'dotenv/config';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import sharp from 'sharp';
import JSZip from 'jszip';
import rateLimit from 'express-rate-limit';

import {
  detectImageSignature,
  generateSecureId,
  getFirebaseStorageBucket,
  isValidSafeId,
  resolveSafeSubpath,
  sanitizeFilename,
  verifyOptionalFirebaseAuth,
} from './engines/security.ts';
import { vectorizeRasterImage } from './engines/vectorizer.ts';
import { upscaleImage } from './engines/upscaler.ts';
import { removeBackground } from './engines/backgroundRemover.ts';
import { exportVectorDocument } from './engines/exporters.ts';
import { analyzeImageWithGemini } from './engines/geminiAnalyzer.ts';
import {
  buildVerifiedFontDownload,
  convertFontTextToVectorShapes,
  runExactFontResearch,
  runFontRegionDetection,
} from './engines/fontFinder.ts';
import {
  DEFAULT_BG_REMOVE_OPTIONS,
  DEFAULT_UPSCALE_OPTIONS,
  DEFAULT_VECTORIZE_OPTIONS,
  type BackgroundRemoveOptions,
  type DetectedTextRegion,
  type ExportOptions,
  type FontCropRect,
  type ProcessingJobState,
  type UpscaleOptions,
  type VectorDocument,
  type VectorizeOptions,
} from '../src/types/vector.ts';

export const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION
);
const MAX_UPLOAD_MB = Math.max(5, Math.min(50, Number(process.env.MAX_UPLOAD_MB || 25)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const TMP_DIR = IS_SERVERLESS
  ? path.join(os.tmpdir(), 'makevectorizer_uploads')
  : path.resolve(process.cwd(), '.tmp_uploads');
const TTL_MS = 1000 * 60 * 60 * 4;

function ensureTmpDir(): void {
  try {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    } else if (!IS_SERVERLESS) {
      for (const entry of fs.readdirSync(TMP_DIR)) {
        const target = path.join(TMP_DIR, entry);
        try {
          if (fs.statSync(target).isFile()) fs.unlinkSync(target);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore read-only edge cases until write
  }
}

ensureTmpDir();

interface StoredUpload {
  uploadId: string;
  ownerUid: string | null;
  filename: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  hasAlpha: boolean;
  filePath: string;
  createdAt: number;
}

interface StoredJob extends ProcessingJobState {
  ownerUid: string | null;
  uploadId: string;
  cancelled: boolean;
  createdAt: number;
  downloadBuffer?: Buffer;
  downloadFilename?: string;
}

const uploadsStore = new Map<string, StoredUpload>();
const jobsStore = new Map<string, StoredJob>();

if (!IS_SERVERLESS) {
  setInterval(() => {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, up] of uploadsStore.entries()) {
      if (up.createdAt < cutoff) {
        try {
          if (fs.existsSync(up.filePath)) fs.unlinkSync(up.filePath);
        } catch {
          // ignore
        }
        uploadsStore.delete(id);
      }
    }
    for (const [id, job] of jobsStore.entries()) {
      if (job.createdAt < cutoff) {
        jobsStore.delete(id);
      }
    }
  }, 1000 * 60 * 15).unref();
}

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

const ALLOWED_SAMPLES: Record<string, string> = {
  emblem: 'sample_brand_emblem_1795651607372.jpg',
  illustration: 'sample_botanical_illustration_1795651607300.jpg',
  watch: 'sample_product_watch_1795651607350.jpg',
};

function readSampleAssetBuffer(sampleName: string): { buffer: Buffer; filename: string } {
  const filename = ALLOWED_SAMPLES[sampleName];
  if (!filename) {
    throw new Error('Unknown sample identifier.');
  }
  const assetsDir = path.resolve(process.cwd(), 'src/assets/images');
  const fullPath = resolveSafeSubpath(assetsDir, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error('Sample asset file missing on server.');
  }
  return { buffer: fs.readFileSync(fullPath), filename };
}

async function normalizeAndValidateRasterBuffer(
  buffer: Buffer,
  originalName: string
): Promise<{
  normalizedPng: Buffer;
  previewBuf: Buffer;
  width: number;
  height: number;
  hasAlpha: boolean;
  mimeType: string;
  safeName: string;
  dominantHex: string;
}> {
  if (!buffer || buffer.length === 0) {
    throw new Error('The uploaded image file is empty (0 bytes).');
  }
  const sig = detectImageSignature(buffer);
  if (sig.isHeic) {
    throw new Error(
      'HEIC/HEIF photos are not supported directly on the server. Please convert or upload a PNG, JPG, JPEG, WebP, BMP, or GIF image.'
    );
  }
  if (!sig.valid || !sig.mimeType || !sig.extension) {
    throw new Error(
      'Unsupported or invalid file signature. Please upload a valid PNG, JPG, WebP, BMP, or GIF image.'
    );
  }

  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let normalizedPng: Buffer;
  let normWidth = 0;
  let normHeight = 0;
  let previewBuf: Buffer;

  try {
    const sharpImg = sharp(buffer, { limitInputPixels: 40_000_000, failOn: 'error' });
    const meta = await sharpImg.metadata();
    width = meta.width || 0;
    height = meta.height || 0;
    hasAlpha = meta.hasAlpha ?? false;
    if (width < 4 || height < 4 || width > 10000 || height > 10000) {
      throw new Error('Image dimensions must be between 4x4 and 10000x10000 pixels.');
    }

    normalizedPng = await sharpImg.rotate().ensureAlpha().png().toBuffer();
    const normMeta = await sharp(normalizedPng).metadata();
    normWidth = normMeta.width || width;
    normHeight = normMeta.height || height;

    previewBuf = await sharp(normalizedPng)
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err) {
    if (err instanceof Error && err.message.includes('Image dimensions')) {
      throw err;
    }
    throw new Error(
      'Corrupted image data or invalid image metadata. Please re-save the image as PNG or JPG and upload again.'
    );
  }

  const stats = await sharp(normalizedPng).stats();
  const dominantHex =
    '#' +
    [stats.dominant.r, stats.dominant.g, stats.dominant.b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('');

  return {
    normalizedPng,
    previewBuf,
    width: normWidth,
    height: normHeight,
    hasAlpha,
    mimeType: sig.mimeType,
    safeName: sanitizeFilename(originalName, sig.extension),
    dominantHex,
  };
}

async function registerBufferAsUpload(
  buffer: Buffer,
  originalName: string,
  ownerUid: string | null
) {
  const norm = await normalizeAndValidateRasterBuffer(buffer, originalName);
  const uploadId = generateSecureId('up');
  ensureTmpDir();
  const filePath = resolveSafeSubpath(TMP_DIR, `${uploadId}.png`);
  try {
    fs.writeFileSync(filePath, norm.normalizedPng);
  } catch {
    // In constrained serverless instances where temp write fails, metadata still returns
  }

  const record: StoredUpload = {
    uploadId,
    ownerUid,
    filename: norm.safeName,
    mimeType: norm.mimeType,
    byteSize: buffer.length,
    width: norm.width,
    height: norm.height,
    hasAlpha: norm.hasAlpha,
    filePath,
    createdAt: Date.now(),
  };

  uploadsStore.set(uploadId, record);

  return {
    uploadId,
    filename: norm.safeName,
    mimeType: norm.mimeType,
    byteSize: buffer.length,
    width: record.width,
    height: record.height,
    hasAlpha: record.hasAlpha,
    previewDataUrl: `data:image/png;base64,${norm.previewBuf.toString('base64')}`,
    dominantColors: [norm.dominantHex],
    serverless: IS_SERVERLESS,
  };
}

function decodeBase64Raster(raw: string): Buffer {
  const trimmed = String(raw || '').trim();
  const commaIdx = trimmed.indexOf(',');
  const payload =
    trimmed.startsWith('data:') && commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed;
  const cleanB64 = payload.replace(/\s+/g, '');
  if (!cleanB64) {
    throw new Error('Empty inline image payload.');
  }
  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Image file is too large. Maximum allowed size is ${MAX_UPLOAD_MB} MB.`);
  }
  return buf;
}

async function resolveUploadBuffer(
  body: Record<string, unknown> | undefined,
  callerUid: string | null
): Promise<{
  uploadId: string;
  filename: string;
  width: number;
  height: number;
  buffer: Buffer;
}> {
  const uploadId = String(body?.uploadId || '').trim();
  if (uploadId) {
    if (!isValidSafeId(uploadId)) {
      throw new Error('Invalid upload identifier.');
    }
    const up = uploadsStore.get(uploadId);
    if (up) {
      if (up.ownerUid && up.ownerUid !== callerUid) {
        throw new Error('Unauthorized access to uploaded asset.');
      }
      if (fs.existsSync(up.filePath)) {
        return {
          uploadId: up.uploadId,
          filename: up.filename,
          width: up.width,
          height: up.height,
          buffer: fs.readFileSync(up.filePath),
        };
      }
    }
  }

  // Stateless fallback for Vercel Serverless Functions across invocations
  const inlineImage =
    typeof body?.imageBase64 === 'string' && body.imageBase64.trim()
      ? body.imageBase64
      : typeof body?.imageDataUrl === 'string' && body.imageDataUrl.trim()
      ? body.imageDataUrl
      : '';

  if (inlineImage) {
    const rawBuf = decodeBase64Raster(inlineImage);
    const norm = await normalizeAndValidateRasterBuffer(
      rawBuf,
      typeof body?.filename === 'string' ? body.filename : 'uploaded_image'
    );
    return {
      uploadId: uploadId && isValidSafeId(uploadId) ? uploadId : generateSecureId('up'),
      filename: norm.safeName,
      width: norm.width,
      height: norm.height,
      buffer: norm.normalizedPng,
    };
  }

  if (typeof body?.sampleName === 'string' && body.sampleName.trim()) {
    const sample = readSampleAssetBuffer(body.sampleName.trim());
    const norm = await normalizeAndValidateRasterBuffer(sample.buffer, sample.filename);
    return {
      uploadId: uploadId && isValidSafeId(uploadId) ? uploadId : generateSecureId('up'),
      filename: norm.safeName,
      width: norm.width,
      height: norm.height,
      buffer: norm.normalizedPng,
    };
  }

  throw new Error('Uploaded image expired or not found. Please re-upload your image.');
}

export function createApiApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);

  const allowedCorsOrigins = new Set<string>();
  const rawCorsEntries = [
    ...(process.env.ALLOWED_CORS_ORIGINS || '').split(','),
    process.env.APP_URL || '',
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL.replace(/^https?:\/\//i, '')}` : '',
  ];
  for (const entry of rawCorsEntries) {
    const clean = entry.trim();
    if (!clean || clean === 'MY_APP_URL') continue;
    try {
      const parsed = new URL(clean.startsWith('http') ? clean : `https://${clean}`);
      allowedCorsOrigins.add(parsed.origin.toLowerCase());
    } catch {
      // ignore invalid env entry
    }
  }

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        const originHost = parsedOrigin.host.toLowerCase();
        const normalizedOrigin = parsedOrigin.origin.toLowerCase();
        const hostMatch = typeof host === 'string' && originHost === host.toLowerCase();
        const isLocal = originHost.startsWith('localhost:') || originHost.startsWith('127.0.0.1:');
        if (hostMatch || isLocal || allowedCorsOrigins.has(normalizedOrigin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
      } catch {
        // ignore invalid origin
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '25mb' }));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Please wait a moment and try again.' },
  });

  app.use('/api', apiLimiter);

  app.get('/api/health', (_req, res) => {
    const workerUrl = (process.env.PROCESSING_WORKER_URL || '').trim();
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    const hasGemini = Boolean(geminiKey) && geminiKey !== 'MY_GEMINI_API_KEY';

    res.json({
      status: 'ok',
      service: 'MakeVectorizer Processing API',
      serverless: IS_SERVERLESS,
      maxUploadMb: MAX_UPLOAD_MB,
      engines: {
        vectorizer: {
          available: true,
          name: workerUrl
            ? 'Cloud Run VTracer Worker + Local Potrace/VTracer Engine'
            : 'MakeVectorizer Potrace WASM + VTracer Rust Engine',
          isExternalWorker: Boolean(workerUrl),
        },
        upscaler: {
          available: true,
          name: workerUrl
            ? 'Real-ESRGAN Cloud Run Worker'
            : 'Edge-Directed Lanczos3 + Detail Recovery (Built-in Server Engine)',
          isExternalWorker: Boolean(workerUrl),
        },
        backgroundRemover: {
          available: true,
          name: workerUrl
            ? 'RMBG Cloud Run Worker'
            : 'Edge-Aware Lab Saliency + Alpha Matting (Built-in Server Engine)',
          isExternalWorker: Boolean(workerUrl),
        },
        aiAnalyzer: {
          available: hasGemini,
        },
        fontFinder: {
          available: hasGemini,
          sources: [
            'Google Fonts Catalog',
            'Fontsource Registry',
            'Official Foundries & Specimen Databases',
          ],
        },
      },
    });
  });

  app.delete('/api/upload/:uploadId', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const uploadId = String(req.params.uploadId || '').trim();
      if (!isValidSafeId(uploadId)) {
        res.status(400).json({ error: 'Invalid upload identifier.' });
        return;
      }
      const up = uploadsStore.get(uploadId);
      if (up) {
        if (up.ownerUid && up.ownerUid !== caller?.uid) {
          res.status(403).json({ error: 'Unauthorized removal of uploaded asset.' });
          return;
        }
        try {
          if (fs.existsSync(up.filePath)) fs.unlinkSync(up.filePath);
        } catch {
          // ignore
        }
        uploadsStore.delete(uploadId);
      }
      res.json({ deleted: true, uploadId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to remove upload.' });
    }
  });

  app.post('/api/upload', uploadMiddleware.single('file'), async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      if (!req.file || !req.file.buffer) {
        res.status(400).json({ error: 'No image file provided.' });
        return;
      }
      const meta = await registerBufferAsUpload(
        req.file.buffer,
        req.file.originalname,
        caller?.uid || null
      );
      res.json(meta);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed.' });
    }
  });

  app.post('/api/upload/from-storage', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      if (!caller || !caller.emailVerified) {
        res.status(401).json({ error: 'Verified Firebase sign-in is required for storage upload.' });
        return;
      }
      const bucket = getFirebaseStorageBucket();
      if (!bucket) {
        res.status(503).json({ error: 'Firebase Storage bucket is not configured on the server.' });
        return;
      }
      const downloadUrlRaw = String(req.body?.downloadUrl || '').trim();
      const rawFilename = String(req.body?.filename || 'uploaded_image').trim();
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(downloadUrlRaw);
      } catch {
        res.status(400).json({ error: 'Invalid storage download URL.' });
        return;
      }
      if (
        parsedUrl.protocol !== 'https:' ||
        parsedUrl.hostname.toLowerCase() !== 'firebasestorage.googleapis.com'
      ) {
        res.status(400).json({ error: 'Disallowed storage host.' });
        return;
      }
      const prefix = `/v0/b/${bucket}/o/`;
      if (!parsedUrl.pathname.startsWith(prefix)) {
        res.status(403).json({ error: 'Storage bucket mismatch.' });
        return;
      }
      const objectPath = decodeURIComponent(parsedUrl.pathname.slice(prefix.length));
      if (
        !objectPath.startsWith(`users/${caller.uid}/uploads/`) ||
        objectPath.includes('..') ||
        objectPath.includes('\\')
      ) {
        res.status(403).json({ error: 'Unauthorized storage object path.' });
        return;
      }

      const fetchRes = await fetch(parsedUrl.toString(), {
        signal: AbortSignal.timeout(20_000),
      });
      if (!fetchRes.ok) {
        res.status(400).json({ error: `Unable to fetch uploaded storage image (HTTP ${fetchRes.status}).` });
        return;
      }
      const contentLen = Number(fetchRes.headers.get('content-length') || 0);
      if (contentLen > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `Image file exceeds maximum allowed size (${MAX_UPLOAD_MB} MB).` });
        return;
      }
      const arrBuf = await fetchRes.arrayBuffer();
      const buf = Buffer.from(arrBuf);
      if (buf.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `Image file exceeds maximum allowed size (${MAX_UPLOAD_MB} MB).` });
        return;
      }

      const meta = await registerBufferAsUpload(buf, rawFilename, caller.uid);
      res.json(meta);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Storage upload processing failed.',
      });
    }
  });

  app.post('/api/sample', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const sampleName = String(req.body?.sample || '');
      const { buffer, filename } = readSampleAssetBuffer(sampleName);
      const meta = await registerBufferAsUpload(buffer, filename, caller?.uid || null);
      res.json(meta);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load sample.';
      const status = msg.includes('Unknown sample') ? 400 : msg.includes('missing') ? 404 : 500;
      res.status(status).json({ error: msg });
    }
  });

  app.post('/api/analyze', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const resolved = await resolveUploadBuffer(req.body, caller?.uid || null);
      const thumb = await sharp(resolved.buffer)
        .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      const recommendation = await analyzeImageWithGemini(thumb.toString('base64'), 'image/jpeg');
      res.json(recommendation);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'AI analysis unavailable.',
      });
    }
  });

  app.post('/api/vectorize', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const resolved = await resolveUploadBuffer(req.body, caller?.uid || null);
      const options: VectorizeOptions = {
        ...DEFAULT_VECTORIZE_OPTIONS,
        ...(req.body?.options || {}),
      };
      const syncMode = IS_SERVERLESS || req.body?.sync === true;

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId: resolved.uploadId,
        jobType: 'vectorize',
        status: 'processing',
        stage: 'Uploading Image',
        stageIndex: 1,
        totalStages: 8,
        progress: 8,
        isEstimate: false,
        engine: 'MakeVectorizer Potrace WASM + VTracer Rust Engine',
        cancelled: false,
        createdAt: Date.now(),
      };

      const executeVectorize = async () => {
        if (job.cancelled) return;
        const { document, svgContent } = await vectorizeRasterImage(
          resolved.buffer,
          options,
          (stage, stageIndex, progress) => {
            if (!job.cancelled) {
              job.stage = stage;
              job.stageIndex = stageIndex;
              job.progress = progress;
            }
          }
        );

        if (job.cancelled) return;

        const svgBuf = Buffer.from(svgContent, 'utf8');
        job.engine = document.metadata.engine;
        job.downloadBuffer = svgBuf;
        job.downloadFilename = `${path.parse(resolved.filename).name}.svg`;
        job.status = 'completed';
        job.stage = 'Completed';
        job.stageIndex = 8;
        job.progress = 100;
        job.result = {
          vectorDocument: document,
          svgContent,
          originalWidth: resolved.width,
          originalHeight: resolved.height,
          outputWidth: document.width,
          outputHeight: document.height,
          byteSize: svgBuf.length,
          mimeType: 'image/svg+xml',
          processingMs: document.metadata.processingMs,
        };
      };

      if (syncMode) {
        await executeVectorize();
        const { downloadBuffer: _buf, downloadFilename: _fn, ownerUid: _uid, ...publicState } = job;
        res.status(200).json(publicState);
        return;
      }

      jobsStore.set(jobId, job);
      setImmediate(async () => {
        try {
          await executeVectorize();
        } catch (err) {
          job.status = 'failed';
          job.stage = 'Failed';
          job.error = err instanceof Error ? err.message : 'Vectorization failed.';
        }
      });

      res.status(202).json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to start job.' });
    }
  });

  app.post('/api/upscale', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const resolved = await resolveUploadBuffer(req.body, caller?.uid || null);
      const options: UpscaleOptions = {
        ...DEFAULT_UPSCALE_OPTIONS,
        ...(req.body?.options || {}),
      };
      const syncMode = IS_SERVERLESS || req.body?.sync === true;

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId: resolved.uploadId,
        jobType: 'upscale',
        status: 'processing',
        stage: 'Loading AI Model',
        stageIndex: 1,
        totalStages: 6,
        progress: 10,
        isEstimate: false,
        engine: process.env.PROCESSING_WORKER_URL
          ? 'Real-ESRGAN Cloud Run Worker'
          : 'Edge-Directed Lanczos3 + Detail Recovery (Built-in Server Engine)',
        cancelled: false,
        createdAt: Date.now(),
      };

      const executeUpscale = async () => {
        if (job.cancelled) return;
        const result = await upscaleImage(resolved.buffer, options, (stage, stageIndex, progress) => {
          if (!job.cancelled) {
            job.stage = stage;
            job.stageIndex = stageIndex;
            job.progress = progress;
          }
        });
        if (job.cancelled) return;

        const chainedMeta = await registerBufferAsUpload(
          result.buffer,
          `${path.parse(resolved.filename).name}_${options.scaleFactor}x.${options.outputFormat}`,
          caller?.uid || null
        );

        job.engine = result.engine;
        job.downloadBuffer = result.buffer;
        job.downloadFilename = `${path.parse(resolved.filename).name}_${options.scaleFactor}x.${
          options.outputFormat
        }`;
        job.status = 'completed';
        job.stage = 'Completed';
        job.stageIndex = 6;
        job.progress = 100;
        job.result = {
          imageDataUrl: `data:${result.mimeType};base64,${result.buffer.toString('base64')}`,
          uploadId: chainedMeta.uploadId,
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight,
          outputWidth: result.outputWidth,
          outputHeight: result.outputHeight,
          byteSize: result.buffer.length,
          mimeType: result.mimeType,
          processingMs: result.processingMs,
        };
      };

      if (syncMode) {
        await executeUpscale();
        const { downloadBuffer: _buf, downloadFilename: _fn, ownerUid: _uid, ...publicState } = job;
        res.status(200).json(publicState);
        return;
      }

      jobsStore.set(jobId, job);
      setImmediate(async () => {
        try {
          await executeUpscale();
        } catch (err) {
          job.status = 'failed';
          job.stage = 'Failed';
          job.error = err instanceof Error ? err.message : 'Upscaling failed.';
        }
      });

      res.status(202).json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to start upscale.' });
    }
  });

  app.post('/api/remove-background', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const resolved = await resolveUploadBuffer(req.body, caller?.uid || null);
      const options: BackgroundRemoveOptions = {
        ...DEFAULT_BG_REMOVE_OPTIONS,
        ...(req.body?.options || {}),
      };
      const syncMode = IS_SERVERLESS || req.body?.sync === true;

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId: resolved.uploadId,
        jobType: 'remove-background',
        status: 'processing',
        stage: 'Analyzing Image',
        stageIndex: 1,
        totalStages: 6,
        progress: 15,
        isEstimate: false,
        engine: process.env.PROCESSING_WORKER_URL
          ? 'RMBG Cloud Run Worker'
          : 'Edge-Aware Lab Saliency + Alpha Matting (Built-in Server Engine)',
        cancelled: false,
        createdAt: Date.now(),
      };

      const executeBgRemove = async () => {
        if (job.cancelled) return;
        const result = await removeBackground(resolved.buffer, options, (stage, stageIndex, progress) => {
          if (!job.cancelled) {
            job.stage = stage;
            job.stageIndex = stageIndex;
            job.progress = progress;
          }
        });
        if (job.cancelled) return;

        const chainedMeta = await registerBufferAsUpload(
          result.buffer,
          `${path.parse(resolved.filename).name}_nobg.png`,
          caller?.uid || null
        );

        job.engine = result.engine;
        job.downloadBuffer = result.buffer;
        job.downloadFilename = `${path.parse(resolved.filename).name}_nobg.png`;
        job.status = 'completed';
        job.stage = 'Completed';
        job.stageIndex = 6;
        job.progress = 100;
        job.result = {
          imageDataUrl: `data:${result.mimeType};base64,${result.buffer.toString('base64')}`,
          uploadId: chainedMeta.uploadId,
          originalWidth: resolved.width,
          originalHeight: resolved.height,
          outputWidth: result.width,
          outputHeight: result.height,
          byteSize: result.buffer.length,
          mimeType: result.mimeType,
          processingMs: result.processingMs,
        };
      };

      if (syncMode) {
        await executeBgRemove();
        const { downloadBuffer: _buf, downloadFilename: _fn, ownerUid: _uid, ...publicState } = job;
        res.status(200).json(publicState);
        return;
      }

      jobsStore.set(jobId, job);
      setImmediate(async () => {
        try {
          await executeBgRemove();
        } catch (err) {
          job.status = 'failed';
          job.stage = 'Failed';
          job.error = err instanceof Error ? err.message : 'Background removal failed.';
        }
      });

      res.status(202).json({ jobId });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'Unable to start background removal.' });
    }
  });

  app.post('/api/font-finder/detect', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const resolved = await resolveUploadBuffer(req.body, caller?.uid || null);
      const crop = (req.body?.crop || null) as FontCropRect | null;
      const customHint = typeof req.body?.customHint === 'string' ? req.body.customHint.slice(0, 300) : '';
      const syncMode = IS_SERVERLESS || req.body?.sync === true;

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId: resolved.uploadId,
        jobType: 'font-detect',
        status: 'processing',
        stage: 'Analyzing uploaded image...',
        stageIndex: 1,
        totalStages: 3,
        progress: 12,
        isEstimate: false,
        engine: 'Typography Detection & Segmentation Pipeline',
        cancelled: false,
        createdAt: Date.now(),
      };

      const executeDetect = async () => {
        if (job.cancelled) return;
        const result = await runFontRegionDetection({
          imageBuffer: resolved.buffer,
          uploadId: resolved.uploadId,
          crop,
          customHint,
          onProgress: (stage, stageIndex, progress) => {
            if (!job.cancelled) {
              job.stage = stage;
              job.stageIndex = stageIndex;
              job.progress = progress;
            }
          },
        });
        if (job.cancelled) return;

        job.status = 'completed';
        job.stage = 'Completed';
        job.stageIndex = 3;
        job.progress = 100;
        job.result = {
          processingMs: result.processingMs,
          fontDetectionResult: result,
        };
      };

      if (syncMode) {
        await executeDetect();
        const { downloadBuffer: _buf, downloadFilename: _fn, ownerUid: _uid, ...publicState } = job;
        res.status(200).json(publicState);
        return;
      }

      jobsStore.set(jobId, job);
      setImmediate(async () => {
        try {
          await executeDetect();
        } catch (err) {
          job.status = 'failed';
          job.stage = 'Failed';
          job.error = err instanceof Error ? err.message : 'Typography detection failed.';
        }
      });

      res.status(202).json({ jobId });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'Unable to start typography detection.' });
    }
  });

  app.post('/api/font-finder/research', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const resolved = await resolveUploadBuffer(req.body, caller?.uid || null);
      const region = req.body?.region as DetectedTextRegion | undefined;
      const crop = (req.body?.crop || null) as FontCropRect | null;
      const extractedTextOverride =
        typeof req.body?.extractedTextOverride === 'string'
          ? req.body.extractedTextOverride.slice(0, 400)
          : undefined;
      const syncMode = IS_SERVERLESS || req.body?.sync === true;

      if (!region || !region.regionId || !region.bbox || !region.extractedText) {
        res.status(400).json({ error: 'A valid selected text region is required.' });
        return;
      }

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId: resolved.uploadId,
        jobType: 'font-research',
        status: 'processing',
        stage: 'Analyzing selected letterforms...',
        stageIndex: 1,
        totalStages: 6,
        progress: 12,
        isEstimate: false,
        engine: 'Exact Font Research & Specimen Verification Pipeline',
        cancelled: false,
        createdAt: Date.now(),
      };

      const executeResearch = async () => {
        if (job.cancelled) return;
        const result = await runExactFontResearch({
          imageBuffer: resolved.buffer,
          uploadId: resolved.uploadId,
          region,
          crop,
          extractedTextOverride,
          onProgress: (stage, stageIndex, progress) => {
            if (!job.cancelled) {
              job.stage = stage;
              job.stageIndex = stageIndex;
              job.progress = progress;
            }
          },
        });
        if (job.cancelled) return;

        job.status = 'completed';
        job.stage = 'Preparing verified result...';
        job.stageIndex = 6;
        job.progress = 100;
        job.result = {
          processingMs: result.processingMs,
          fontResearchResult: result,
        };
      };

      if (syncMode) {
        await executeResearch();
        const { downloadBuffer: _buf, downloadFilename: _fn, ownerUid: _uid, ...publicState } = job;
        res.status(200).json(publicState);
        return;
      }

      jobsStore.set(jobId, job);
      setImmediate(async () => {
        try {
          await executeResearch();
        } catch (err) {
          job.status = 'failed';
          job.stage = 'Failed';
          job.error = err instanceof Error ? err.message : 'Exact font research failed.';
        }
      });

      res.status(202).json({ jobId });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'Unable to start exact font search.' });
    }
  });

  app.get('/api/font-finder/download', async (req, res) => {
    try {
      const fontId = String(req.query.id || '').trim().toLowerCase();
      const family = typeof req.query.family === 'string' ? req.query.family.trim().slice(0, 120) : undefined;
      const format = String(req.query.format || 'zip').trim().toLowerCase();
      const weight = Number(req.query.weight || 400);
      const style = String(req.query.style || 'normal').trim().toLowerCase();

      if (!/^[a-z0-9_-]{1,100}$/.test(fontId)) {
        res.status(400).json({ error: 'Invalid font identifier.' });
        return;
      }
      if (!['zip', 'otf', 'ttf', 'woff2', 'woff'].includes(format)) {
        res.status(400).json({ error: 'Unsupported font download format.' });
        return;
      }

      const fileData = await buildVerifiedFontDownload({
        fontId,
        family,
        format: format as 'zip' | 'otf' | 'ttf' | 'woff2' | 'woff',
        weight: Number.isFinite(weight) ? weight : 400,
        style,
      });
      const safeName = sanitizeFilename(fileData.filename);
      res.setHeader('Content-Type', fileData.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(fileData.buffer);
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : 'Verified font file could not be downloaded.',
      });
    }
  });

  app.post('/api/font-finder/outline', async (req, res) => {
    try {
      const fontId = String(req.body?.fontId || '').trim().toLowerCase();
      const family = typeof req.body?.family === 'string' ? req.body.family.trim().slice(0, 120) : undefined;
      const text = String(req.body?.text || '').trim();
      if (!/^[a-z0-9_-]{1,100}$/.test(fontId) || !text) {
        res.status(400).json({ error: 'Valid fontId and text are required.' });
        return;
      }
      const shape = await convertFontTextToVectorShapes({
        fontId,
        family,
        text,
        fontSize: Number(req.body?.fontSize || 64),
        weight: Number(req.body?.weight || 400),
        isItalic: Boolean(req.body?.isItalic),
        x: Number(req.body?.x ?? 80),
        y: Number(req.body?.y ?? 140),
        fill: typeof req.body?.fill === 'string' ? req.body.fill : '#0f172a',
      });
      res.json({ shape });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to convert font text to vector outlines.',
      });
    }
  });

  app.get('/api/jobs/:jobId', async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!isValidSafeId(jobId)) {
      res.status(400).json({ error: 'Invalid job ID.' });
      return;
    }
    const job = jobsStore.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found or expired.' });
      return;
    }
    const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
    if (job.ownerUid && job.ownerUid !== caller?.uid) {
      res.status(403).json({ error: 'Unauthorized job access.' });
      return;
    }
    const { downloadBuffer: _buf, downloadFilename: _fn, ownerUid: _uid, ...publicState } = job;
    res.json(publicState);
  });

  app.post('/api/jobs/:jobId/cancel', async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!isValidSafeId(jobId)) {
      res.status(400).json({ error: 'Invalid job ID.' });
      return;
    }
    const job = jobsStore.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
    if (job.ownerUid && job.ownerUid !== caller?.uid) {
      res.status(403).json({ error: 'Unauthorized job cancellation.' });
      return;
    }
    job.cancelled = true;
    job.status = 'cancelled';
    job.stage = 'Cancelled';
    res.json({ jobId, status: 'cancelled' });
  });

  app.get('/api/download/:jobId', async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!isValidSafeId(jobId)) {
      res.status(400).json({ error: 'Invalid job ID.' });
      return;
    }
    const job = jobsStore.get(jobId);
    if (!job || job.status !== 'completed' || !job.downloadBuffer) {
      res.status(404).json({ error: 'Download artifact not ready.' });
      return;
    }
    const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
    if (job.ownerUid && job.ownerUid !== caller?.uid) {
      res.status(403).json({ error: 'Unauthorized download.' });
      return;
    }
    const filename = sanitizeFilename(job.downloadFilename || 'makevectorizer_output');
    res.setHeader('Content-Type', job.result?.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(job.downloadBuffer);
  });

  app.post('/api/export', async (req, res) => {
    try {
      const doc = req.body?.document as VectorDocument | undefined;
      const options = req.body?.options as ExportOptions | undefined;
      const baseName = sanitizeFilename(String(req.body?.filename || 'makevectorizer_artwork'));

      if (!doc || !Array.isArray(doc.shapes) || !options?.format) {
        res.status(400).json({ error: 'Invalid vector document or export format.' });
        return;
      }

      const result = await exportVectorDocument(doc, options);
      const outName = `${path.parse(baseName).name}.${result.filenameExt}`;
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(result.buffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed.' });
    }
  });

  app.post('/api/batch/zip', async (req, res) => {
    try {
      const items = req.body?.items as Array<{
        filename: string;
        svg?: string;
        imageDataUrl?: string;
      }>;
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'No completed batch items provided.' });
        return;
      }

      const zip = new JSZip();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const safeBase = path.parse(sanitizeFilename(item.filename || `item_${i + 1}`)).name;
        if (item.svg) {
          zip.file(`${safeBase}.svg`, item.svg);
        } else if (item.imageDataUrl) {
          const match = item.imageDataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
          if (match) {
            const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
            zip.file(`${safeBase}.${ext}`, Buffer.from(match[2], 'base64'));
          }
        }
      }

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="makevectorizer_batch.zip"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'ZIP packaging failed.' });
    }
  });

  // Catch-all for unknown /api routes so HTML is NEVER returned for API requests
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Global JSON error handler for Multer & Express body parsing errors
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (!err) {
        next();
        return;
      }
      if (res.headersSent) {
        next(err);
        return;
      }

      const multerErr = err as { code?: string; type?: string; status?: number; message?: string };
      if (multerErr instanceof multer.MulterError) {
        if (multerErr.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `Image file is too large. Maximum allowed size is ${MAX_UPLOAD_MB} MB.`,
          });
          return;
        }
        res.status(400).json({
          error: `Upload validation error: ${multerErr.message || 'Invalid multipart form upload.'}`,
        });
        return;
      }

      if (multerErr?.type === 'entity.too.large' || multerErr?.status === 413) {
        res.status(413).json({
          error: `Request payload is too large. Maximum allowed size is ${MAX_UPLOAD_MB} MB.`,
        });
        return;
      }

      if (err instanceof SyntaxError && multerErr?.status === 400) {
        res.status(400).json({ error: 'Invalid JSON request payload.' });
        return;
      }

      if (req.path.startsWith('/api')) {
        res.status(multerErr?.status || 500).json({
          error: err instanceof Error ? err.message : 'Unexpected server error.',
        });
        return;
      }

      next(err);
    }
  );

  return app;
}
