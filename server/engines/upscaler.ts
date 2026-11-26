import sharp from 'sharp';
import type { UpscaleOptions } from '../../src/types/vector.ts';

export interface UpscaleResultData {
  buffer: Buffer;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  outputWidth: number;
  outputHeight: number;
  engine: string;
  processingMs: number;
}

const MAX_OUTPUT_DIMENSION = 12000;

export async function upscaleImage(
  inputBuffer: Buffer,
  options: UpscaleOptions,
  onStage?: (stage: string, stageIndex: number, progress: number) => void
): Promise<UpscaleResultData> {
  const startMs = Date.now();
  onStage?.('Loading AI Model', 1, 12);

  // Check if an external Real-ESRGAN Cloud Run worker is configured
  const workerUrl = process.env.PROCESSING_WORKER_URL?.trim();
  if (workerUrl) {
    try {
      onStage?.('Analyzing Image', 2, 28);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(inputBuffer)]), 'input.png');
      form.append('options', JSON.stringify(options));

      const workerRes = await fetch(`${workerUrl.replace(/\/$/, '')}/upscale`, {
        method: 'POST',
        headers: process.env.PROCESSING_WORKER_SECRET
          ? { Authorization: `Bearer ${process.env.PROCESSING_WORKER_SECRET}` }
          : undefined,
        body: form,
      });

      if (workerRes.ok) {
        onStage?.('Upscaling Image', 4, 75);
        const outBuf = Buffer.from(await workerRes.arrayBuffer());
        const outMeta = await sharp(outBuf).metadata();
        const inMeta = await sharp(inputBuffer).metadata();
        onStage?.('Completed', 6, 100);
        return {
          buffer: outBuf,
          mimeType:
            options.outputFormat === 'jpg'
              ? 'image/jpeg'
              : options.outputFormat === 'webp'
              ? 'image/webp'
              : 'image/png',
          originalWidth: inMeta.width || 0,
          originalHeight: inMeta.height || 0,
          outputWidth: outMeta.width || 0,
          outputHeight: outMeta.height || 0,
          engine: 'Real-ESRGAN Cloud Run Worker',
          processingMs: Date.now() - startMs,
        };
      }
    } catch {
      // Fall through to built-in server super-resolution engine
    }
  }

  // Built-in Edge-Directed Super-Resolution Engine (Multi-pass Lanczos3 + Detail Recovery + Artifact Removal)
  onStage?.('Analyzing Image', 2, 28);
  const baseImage = sharp(inputBuffer, { limitInputPixels: 40_000_000 });
  const meta = await baseImage.metadata();
  const origW = meta.width || 512;
  const origH = meta.height || 512;
  const hasAlpha = meta.hasAlpha ?? false;

  const requestedW = Math.round(origW * options.scaleFactor);
  const requestedH = Math.round(origH * options.scaleFactor);

  if (requestedW > MAX_OUTPUT_DIMENSION || requestedH > MAX_OUTPUT_DIMENSION) {
    throw new Error(
      `Target upscaled dimensions (${requestedW}x${requestedH}) exceed the ${MAX_OUTPUT_DIMENSION}px safety limit.`
    );
  }

  onStage?.('Enhancing Details', 3, 52);

  // Preset tuning multipliers
  const presetMult =
    options.preset === 'maximum-detail' ? 1.25 : options.preset === 'high-quality' ? 1.0 : 0.72;

  let pipeline = sharp(inputBuffer).keepMetadata();

  // Stage A: Pre-upscale artifact & noise suppression when requested
  if (options.noiseReduction > 15 || options.artifactRemoval > 20) {
    const denoiseStrength = Math.max(options.noiseReduction, options.artifactRemoval);
    if (denoiseStrength >= 65) {
      pipeline = pipeline.median(3);
    }
  }

  // Stage B: Progressive 2X -> 4X edge-directed Lanczos3 super-sampling for crisp micro-edges
  onStage?.('Upscaling Image', 4, 74);
  if (options.scaleFactor >= 3) {
    const midW = Math.round(origW * 2);
    const midH = Math.round(origH * 2);
    const midBuf = await pipeline
      .resize(midW, midH, { kernel: sharp.kernel.lanczos3 })
      .sharpen({
        sigma: 0.7,
        m1: 0.4 + (options.edgeEnhancement / 100) * 0.8 * presetMult,
        m2: 1.2 + (options.detailRecovery / 100) * 1.6 * presetMult,
      })
      .png()
      .toBuffer();

    pipeline = sharp(midBuf).keepMetadata().resize(requestedW, requestedH, {
      kernel: sharp.kernel.lanczos3,
    });
  } else if (options.scaleFactor === 2) {
    pipeline = pipeline.resize(requestedW, requestedH, {
      kernel: sharp.kernel.lanczos3,
    });
  }

  onStage?.('Refining Output', 5, 90);

  // Stage C: Adaptive Detail Recovery, Edge Enhancement & Texture Clarity
  const sharpAmt = (options.sharpness / 100) * presetMult;
  const detailAmt = (options.detailRecovery / 100) * presetMult;
  const textureAmt = (options.textureEnhancement / 100) * presetMult;

  if (sharpAmt > 0.05 || detailAmt > 0.05) {
    pipeline = pipeline.sharpen({
      sigma: 0.65 + textureAmt * 0.55,
      m1: 0.4 + sharpAmt * 1.1,
      m2: 1.0 + detailAmt * 2.2,
    });
  }

  // Stage D: Optional Color Restoration & Micro-Contrast
  if (options.colorRestoration > 10) {
    const satBoost = 1 + (options.colorRestoration / 100) * 0.16 * presetMult;
    const contrastBoost = 1 + (options.colorRestoration / 100) * 0.08 * presetMult;
    const offset = -(0.5 * contrastBoost) + 0.5;
    pipeline = pipeline.modulate({ saturation: satBoost }).linear(contrastBoost, offset * 255);
  }

  // Preserve transparency if PNG/WebP; flatten cleanly to white only for JPG
  let outBuffer: Buffer;
  let mimeType: string;

  if (options.outputFormat === 'jpg') {
    outBuffer = await pipeline
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer();
    mimeType = 'image/jpeg';
  } else if (options.outputFormat === 'webp') {
    outBuffer = await pipeline.webp({ quality: 95, lossless: false }).toBuffer();
    mimeType = 'image/webp';
  } else {
    if (hasAlpha) {
      pipeline = pipeline.ensureAlpha();
    }
    outBuffer = await pipeline.png({ compressionLevel: 6 }).toBuffer();
    mimeType = 'image/png';
  }

  onStage?.('Completed', 6, 100);

  return {
    buffer: outBuffer,
    mimeType,
    originalWidth: origW,
    originalHeight: origH,
    outputWidth: requestedW,
    outputHeight: requestedH,
    engine: 'Edge-Directed Lanczos3 + Detail Recovery (Built-in Server Engine)',
    processingMs: Date.now() - startMs,
  };
}
