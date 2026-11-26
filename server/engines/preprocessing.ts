import sharp from 'sharp';
import type { PreprocessingOptions } from '../../src/types/vector.ts';

export async function applyPreprocessing(
  inputBuffer: Buffer,
  options?: PreprocessingOptions
): Promise<{ buffer: Buffer; width: number; height: number; hasAlpha: boolean }> {
  let pipeline = sharp(inputBuffer, { animated: false }).ensureAlpha();
  const meta = await pipeline.metadata();
  let srcW = meta.width || 512;
  let srcH = meta.height || 512;

  if (options?.crop && options.crop.width > 4 && options.crop.height > 4) {
    const left = Math.max(0, Math.min(srcW - 4, Math.round(options.crop.x)));
    const top = Math.max(0, Math.min(srcH - 4, Math.round(options.crop.y)));
    const width = Math.max(4, Math.min(srcW - left, Math.round(options.crop.width)));
    const height = Math.max(4, Math.min(srcH - top, Math.round(options.crop.height)));
    pipeline = pipeline.extract({ left, top, width, height });
    srcW = width;
    srcH = height;
  }

  if (options?.rotate) {
    pipeline = pipeline.rotate(options.rotate);
  }
  if (options?.flipH) {
    pipeline = pipeline.flop();
  }
  if (options?.flipV) {
    pipeline = pipeline.flip();
  }

  const brightness = options?.brightness ?? 1;
  const saturation = options?.saturation ?? 1;
  const exposure = options?.exposure ?? 0;
  const contrast = options?.contrast ?? 1;

  if (brightness !== 1 || saturation !== 1 || exposure !== 0) {
    const effectiveBrightness = Math.max(0.25, Math.min(2.5, brightness * Math.pow(2, exposure)));
    pipeline = pipeline.modulate({
      brightness: effectiveBrightness,
      saturation: Math.max(0, Math.min(3, saturation)),
    });
  }

  if (contrast !== 1) {
    const offset = -(0.5 * contrast) + 0.5;
    pipeline = pipeline.linear(contrast, offset * 255);
  }

  if (options?.grayscale) {
    pipeline = pipeline.grayscale();
  }

  if (options?.noiseRemoval && options.noiseRemoval > 0) {
    const medianSize = Math.min(7, Math.max(3, Math.round(options.noiseRemoval) * 2 + 1));
    pipeline = pipeline.median(medianSize);
  }

  if (options?.blur && options.blur > 0) {
    pipeline = pipeline.blur(Math.max(0.3, Math.min(5, options.blur)));
  }

  if (options?.sharpen && options.sharpen > 0) {
    pipeline = pipeline.sharpen({
      sigma: 0.6 + options.sharpen * 0.45,
      m1: 1 + options.sharpen * 0.5,
      m2: 2 + options.sharpen * 0.8,
    });
  }

  if (options?.threshold !== null && options?.threshold !== undefined) {
    pipeline = pipeline.threshold(Math.max(0, Math.min(255, Math.round(options.threshold))));
  }

  const outBuf = await pipeline.png().toBuffer({ resolveWithObject: true });
  return {
    buffer: outBuf.data,
    width: outBuf.info.width,
    height: outBuf.info.height,
    hasAlpha: meta.hasAlpha ?? true,
  };
}
