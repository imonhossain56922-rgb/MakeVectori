import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import sharp from 'sharp';
import JSZip from 'jszip';
import rateLimit from 'express-rate-limit';
import { createServer as createViteServer } from 'vite';

import {
  detectImageSignature,
  generateSecureId,
  isValidSafeId,
  resolveSafeSubpath,
  sanitizeFilename,
  verifyOptionalFirebaseAuth,
} from './server/engines/security.ts';
import { vectorizeRasterImage, buildSvgFromDocument } from './server/engines/vectorizer.ts';
import { upscaleImage } from './server/engines/upscaler.ts';
import { removeBackground } from './server/engines/backgroundRemover.ts';
import { exportVectorDocument } from './server/engines/exporters.ts';
import { analyzeImageWithGemini } from './server/engines/geminiAnalyzer.ts';
import {
  buildVerifiedFontDownload,
  convertFontTextToVectorShapes,
  runExactFontResearch,
  runFontRegionDetection,
} from './server/engines/fontFinder.ts';
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
} from './src/types/vector.ts';

const PORT = 3000;
const MAX_UPLOAD_MB = Math.max(5, Math.min(50, Number(process.env.MAX_UPLOAD_MB || 25)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const TMP_DIR = path.resolve(process.cwd(), '.tmp_uploads');
const TTL_MS = 1000 * 60 * 60 * 4; // 4 hours temp file lifetime

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
} else {
  // Clean up orphaned temporary uploads left over from previous server runs
  try {
    for (const entry of fs.readdirSync(TMP_DIR)) {
      const target = path.join(TMP_DIR, entry);
      try {
        if (fs.statSync(target).isFile()) fs.unlinkSync(target);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

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

// Periodic temp file & job expiration cleanup
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

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

async function registerBufferAsUpload(
  buffer: Buffer,
  originalName: string,
  ownerUid: string | null
) {
  const sig = detectImageSignature(buffer);
  if (!sig.valid || !sig.mimeType || !sig.extension) {
    throw new Error(
      'Unsupported or invalid file signature. Please upload a valid PNG, JPG, WebP, BMP, or GIF image.'
    );
  }

  const sharpImg = sharp(buffer, { limitInputPixels: 40_000_000 });
  const meta = await sharpImg.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 4 || height < 4 || width > 10000 || height > 10000) {
    throw new Error('Image dimensions must be between 4x4 and 10000x10000 pixels.');
  }

  // Normalize BMP/GIF/EXIF orientation into a clean PNG working buffer for uniform processing
  const normalizedPng = await sharpImg.rotate().ensureAlpha().png().toBuffer();
  const normMeta = await sharp(normalizedPng).metadata();

  const uploadId = generateSecureId('up');
  const safeName = sanitizeFilename(originalName);
  const filePath = resolveSafeSubpath(TMP_DIR, `${uploadId}.png`);
  fs.writeFileSync(filePath, normalizedPng);

  const previewBuf = await sharp(normalizedPng)
    .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const stats = await sharp(normalizedPng).stats();
  const dominantHex =
    '#' +
    [stats.dominant.r, stats.dominant.g, stats.dominant.b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('');

  const record: StoredUpload = {
    uploadId,
    ownerUid,
    filename: safeName,
    mimeType: sig.mimeType,
    byteSize: buffer.length,
    width: normMeta.width || width,
    height: normMeta.height || height,
    hasAlpha: meta.hasAlpha ?? false,
    filePath,
    createdAt: Date.now(),
  };

  uploadsStore.set(uploadId, record);

  return {
    uploadId,
    filename: safeName,
    mimeType: sig.mimeType,
    byteSize: buffer.length,
    width: record.width,
    height: record.height,
    hasAlpha: record.hasAlpha,
    previewDataUrl: `data:image/png;base64,${previewBuf.toString('base64')}`,
    dominantColors: [dominantHex],
  };
}

function assertUploadAccess(uploadId: string, callerUid: string | null): StoredUpload {
  if (!isValidSafeId(uploadId)) {
    throw new Error('Invalid upload identifier.');
  }
  const up = uploadsStore.get(uploadId);
  if (!up || !fs.existsSync(up.filePath)) {
    throw new Error('Uploaded image expired or not found. Please re-upload your image.');
  }
  if (up.ownerUid && up.ownerUid !== callerUid) {
    throw new Error('Unauthorized access to uploaded asset.');
  }
  return up;
}

async function createServer() {
  const app = express();
  app.set('trust proxy', 1);

  // Strict CORS without wildcard on authenticated routes
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost === host || originHost.startsWith('localhost:')) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
      } catch {
        // ignore invalid origin
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

  // Health & Engine Status Endpoint
  app.get('/api/health', (_req, res) => {
    const workerUrl = (process.env.PROCESSING_WORKER_URL || '').trim();
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    const hasGemini = Boolean(geminiKey) && geminiKey !== 'MY_GEMINI_API_KEY';

    res.json({
      status: 'ok',
      service: 'MakeVectorizer Processing API',
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

  // Delete Temporary Upload cleanly
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

  // Upload Raster Image
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

  // Load Built-in Sample Artwork securely from /src/assets/images
  app.post('/api/sample', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const sampleName = String(req.body?.sample || '');
      const allowedSamples: Record<string, string> = {
        emblem: 'sample_brand_emblem_1795651607372.jpg',
        illustration: 'sample_botanical_illustration_1795651607300.jpg',
        watch: 'sample_product_watch_1795651607350.jpg',
      };
      const filename = allowedSamples[sampleName];
      if (!filename) {
        res.status(400).json({ error: 'Unknown sample identifier.' });
        return;
      }
      const assetsDir = path.resolve(process.cwd(), 'src/assets/images');
      const fullPath = resolveSafeSubpath(assetsDir, filename);
      if (!fs.existsSync(fullPath)) {
        res.status(404).json({ error: 'Sample asset file missing on server.' });
        return;
      }
      const buf = fs.readFileSync(fullPath);
      const meta = await registerBufferAsUpload(buf, filename, caller?.uid || null);
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load sample.' });
    }
  });

  // Gemini AI Preset & Palette Recommendation
  app.post('/api/analyze', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const uploadId = String(req.body?.uploadId || '');
      const up = assertUploadAccess(uploadId, caller?.uid || null);
      const imgBuf = fs.readFileSync(up.filePath);
      const thumb = await sharp(imgBuf)
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

  // Start Vectorization Job
  app.post('/api/vectorize', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const uploadId = String(req.body?.uploadId || '');
      const up = assertUploadAccess(uploadId, caller?.uid || null);
      const options: VectorizeOptions = {
        ...DEFAULT_VECTORIZE_OPTIONS,
        ...(req.body?.options || {}),
      };

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId,
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
      jobsStore.set(jobId, job);

      // Run vectorization asynchronously so frontend polls real stage progress & can cancel
      setImmediate(async () => {
        try {
          if (job.cancelled) return;
          const imgBuf = fs.readFileSync(up.filePath);
          const { document, svgContent } = await vectorizeRasterImage(
            imgBuf,
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
          job.downloadFilename = `${path.parse(up.filename).name}.svg`;
          job.status = 'completed';
          job.stage = 'Completed';
          job.stageIndex = 8;
          job.progress = 100;
          job.result = {
            vectorDocument: document,
            svgContent,
            originalWidth: up.width,
            originalHeight: up.height,
            outputWidth: document.width,
            outputHeight: document.height,
            byteSize: svgBuf.length,
            mimeType: 'image/svg+xml',
            processingMs: document.metadata.processingMs,
          };
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

  // Start 1X-4X Image Upscale Job
  app.post('/api/upscale', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const uploadId = String(req.body?.uploadId || '');
      const up = assertUploadAccess(uploadId, caller?.uid || null);
      const options: UpscaleOptions = {
        ...DEFAULT_UPSCALE_OPTIONS,
        ...(req.body?.options || {}),
      };

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId,
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
      jobsStore.set(jobId, job);

      setImmediate(async () => {
        try {
          if (job.cancelled) return;
          const imgBuf = fs.readFileSync(up.filePath);
          const result = await upscaleImage(imgBuf, options, (stage, stageIndex, progress) => {
            if (!job.cancelled) {
              job.stage = stage;
              job.stageIndex = stageIndex;
              job.progress = progress;
            }
          });
          if (job.cancelled) return;

          // Register upscaled output as a new uploadId so user can chain straight into Vectorizer
          const chainedMeta = await registerBufferAsUpload(
            result.buffer,
            `${path.parse(up.filename).name}_${options.scaleFactor}x.${options.outputFormat}`,
            caller?.uid || null
          );

          job.engine = result.engine;
          job.downloadBuffer = result.buffer;
          job.downloadFilename = `${path.parse(up.filename).name}_${options.scaleFactor}x.${
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

  // Start Smart Background Removal Job
  app.post('/api/remove-background', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const uploadId = String(req.body?.uploadId || '');
      const up = assertUploadAccess(uploadId, caller?.uid || null);
      const options: BackgroundRemoveOptions = {
        ...DEFAULT_BG_REMOVE_OPTIONS,
        ...(req.body?.options || {}),
      };

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId,
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
      jobsStore.set(jobId, job);

      setImmediate(async () => {
        try {
          if (job.cancelled) return;
          const imgBuf = fs.readFileSync(up.filePath);
          const result = await removeBackground(imgBuf, options, (stage, stageIndex, progress) => {
            if (!job.cancelled) {
              job.stage = stage;
              job.stageIndex = stageIndex;
              job.progress = progress;
            }
          });
          if (job.cancelled) return;

          const chainedMeta = await registerBufferAsUpload(
            result.buffer,
            `${path.parse(up.filename).name}_nobg.png`,
            caller?.uid || null
          );

          job.engine = result.engine;
          job.downloadBuffer = result.buffer;
          job.downloadFilename = `${path.parse(up.filename).name}_nobg.png`;
          job.status = 'completed';
          job.stage = 'Completed';
          job.stageIndex = 6;
          job.progress = 100;
          job.result = {
            imageDataUrl: `data:${result.mimeType};base64,${result.buffer.toString('base64')}`,
            uploadId: chainedMeta.uploadId,
            originalWidth: up.width,
            originalHeight: up.height,
            outputWidth: result.width,
            outputHeight: result.height,
            byteSize: result.buffer.length,
            mimeType: result.mimeType,
            processingMs: result.processingMs,
          };
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

  // Phase A: Automatic Multi-Region Image Typography Detection
  app.post('/api/font-finder/detect', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const uploadId = String(req.body?.uploadId || '').trim();
      const up = assertUploadAccess(uploadId, caller?.uid || null);
      const crop = (req.body?.crop || null) as FontCropRect | null;
      const customHint = typeof req.body?.customHint === 'string' ? req.body.customHint.slice(0, 300) : '';

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId,
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
      jobsStore.set(jobId, job);

      setImmediate(async () => {
        try {
          if (job.cancelled) return;
          const imgBuf = fs.readFileSync(up.filePath);
          const result = await runFontRegionDetection({
            imageBuffer: imgBuf,
            uploadId,
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

  // Phase B: Deep Single-Region Exact Original Font Research & Verification
  app.post('/api/font-finder/research', async (req, res) => {
    try {
      const caller = await verifyOptionalFirebaseAuth(req.headers.authorization);
      const uploadId = String(req.body?.uploadId || '').trim();
      const up = assertUploadAccess(uploadId, caller?.uid || null);
      const region = req.body?.region as DetectedTextRegion | undefined;
      const crop = (req.body?.crop || null) as FontCropRect | null;
      const extractedTextOverride =
        typeof req.body?.extractedTextOverride === 'string'
          ? req.body.extractedTextOverride.slice(0, 400)
          : undefined;

      if (!region || !region.regionId || !region.bbox || !region.extractedText) {
        res.status(400).json({ error: 'A valid selected text region is required.' });
        return;
      }

      const jobId = generateSecureId('job');
      const job: StoredJob = {
        jobId,
        ownerUid: caller?.uid || null,
        uploadId,
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
      jobsStore.set(jobId, job);

      setImmediate(async () => {
        try {
          if (job.cancelled) return;
          const imgBuf = fs.readFileSync(up.filePath);
          const result = await runExactFontResearch({
            imageBuffer: imgBuf,
            uploadId,
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

  // Download Verified Font File or ZIP Bundle (Allowlisted Official Sources Only)
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

  // Convert Text Using Verified Font Into True Vector Bezier Outlines
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

  // Poll Job Status
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

  // Cancel Job
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

  // Download Completed Job Artifact
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

  // Export Edited VectorDocument to Genuine SVG, PDF, EPS, DXF, or Scaled PNG
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

  // Batch ZIP Export
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

  const httpServer = http.createServer(app);

  // Attach Vite middleware in dev, or serve static dist/ in production
  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : true,
        ws: hmrDisabled ? false : { server: httpServer },
        watch: hmrDisabled ? null : undefined,
      },
      appType: 'spa',
      plugins: hmrDisabled
        ? [
            {
              name: 'disable-vite-client-ws-when-hmr-off',
              enforce: 'post',
              transform(code, id) {
                if (id.endsWith('/dist/client/client.mjs') || id.includes('@vite/client')) {
                  return {
                    code: code.replace(
                      'transport.connect(createHMRHandler(handleMessage));',
                      '/* HMR disabled via DISABLE_HMR=true */'
                    ),
                    map: null,
                  };
                }
              },
            },
          ]
        : [],
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`MakeVectorizer server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
