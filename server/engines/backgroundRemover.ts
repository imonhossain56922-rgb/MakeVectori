import sharp from 'sharp';
import type { BackgroundRemoveOptions } from '../../src/types/vector.ts';

export interface BackgroundRemoveResultData {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  engine: string;
  processingMs: number;
}

function rgbDistSq(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const rMean = (r1 + r2) * 0.5;
  return (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db;
}

export async function removeBackground(
  inputBuffer: Buffer,
  options: BackgroundRemoveOptions,
  onStage?: (stage: string, stageIndex: number, progress: number) => void
): Promise<BackgroundRemoveResultData> {
  const startMs = Date.now();
  onStage?.('Analyzing Image', 1, 18);

  // Check if an external RMBG Cloud Run worker is configured
  const workerUrl = process.env.PROCESSING_WORKER_URL?.trim();
  if (workerUrl && (!options.fgSeeds || options.fgSeeds.length === 0) && (!options.bgSeeds || options.bgSeeds.length === 0)) {
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(inputBuffer)]), 'input.png');
      form.append('options', JSON.stringify(options));

      const workerRes = await fetch(`${workerUrl.replace(/\/$/, '')}/remove-background`, {
        method: 'POST',
        headers: process.env.PROCESSING_WORKER_SECRET
          ? { Authorization: `Bearer ${process.env.PROCESSING_WORKER_SECRET}` }
          : undefined,
        body: form,
      });

      if (workerRes.ok) {
        const outBuf = Buffer.from(await workerRes.arrayBuffer());
        const meta = await sharp(outBuf).metadata();
        onStage?.('Completed', 6, 100);
        return {
          buffer: outBuf,
          mimeType: 'image/png',
          width: meta.width || 0,
          height: meta.height || 0,
          engine: 'RMBG Cloud Run Worker',
          processingMs: Date.now() - startMs,
        };
      }
    } catch {
      // Fall through to built-in edge-aware matting engine
    }
  }

  onStage?.('Detecting Background Region', 2, 36);

  const { data: raw, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const total = w * h;
  const pixels = new Uint8ClampedArray(raw);

  // Build foreground protection mask from fgSeeds (normalized 0..1 coordinates)
  const fgProtected = new Uint8Array(total);
  const fgSeedColors: Array<[number, number, number]> = [];
  const fgRadius = Math.max(8, Math.round(Math.min(w, h) * 0.035));

  if (options.fgSeeds && options.fgSeeds.length > 0) {
    for (const seed of options.fgSeeds) {
      const sx = Math.max(0, Math.min(w - 1, Math.round(seed.x * w)));
      const sy = Math.max(0, Math.min(h - 1, Math.round(seed.y * h)));
      const sIdx = (sy * w + sx) * 4;
      fgSeedColors.push([pixels[sIdx], pixels[sIdx + 1], pixels[sIdx + 2]]);
      for (let dy = -fgRadius; dy <= fgRadius; dy++) {
        for (let dx = -fgRadius; dx <= fgRadius; dx++) {
          if (dx * dx + dy * dy <= fgRadius * fgRadius) {
            const nx = sx + dx;
            const ny = sy + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              fgProtected[ny * w + nx] = 1;
            }
          }
        }
      }
    }
  }

  // Compute Sobel gradient magnitude to block flood-fill from bleeding across crisp foreground edges
  const grad = new Float32Array(total);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      const lum = (i: number) => 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      const gx =
        -lum(idx - w * 4 - 4) +
        lum(idx - w * 4 + 4) -
        2 * lum(idx - 4) +
        2 * lum(idx + 4) -
        lum(idx + w * 4 - 4) +
        lum(idx + w * 4 + 4);
      const gy =
        -lum(idx - w * 4 - 4) -
        2 * lum(idx - w * 4) -
        lum(idx - w * 4 + 4) +
        lum(idx + w * 4 - 4) +
        2 * lum(idx + w * 4) +
        lum(idx + w * 4 + 4);
      grad[y * w + x] = Math.hypot(gx, gy) * 0.25;
    }
  }

  // Collect background seed pixels from image perimeter + user bgSeeds
  const bgMask = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  // Sample border colors
  const borderSamples: Array<[number, number, number]> = [];
  const sampleStep = Math.max(1, Math.floor(Math.max(w, h) / 60));
  for (let x = 0; x < w; x += sampleStep) {
    const t = x * 4;
    const b = ((h - 1) * w + x) * 4;
    borderSamples.push([pixels[t], pixels[t + 1], pixels[t + 2]]);
    borderSamples.push([pixels[b], pixels[b + 1], pixels[b + 2]]);
  }
  for (let y = 0; y < h; y += sampleStep) {
    const l = y * w * 4;
    const r = (y * w + (w - 1)) * 4;
    borderSamples.push([pixels[l], pixels[l + 1], pixels[l + 2]]);
    borderSamples.push([pixels[r], pixels[r + 1], pixels[r + 2]]);
  }

  // Seed perimeter in auto mode
  if (options.mode === 'auto' || !options.bgSeeds || options.bgSeeds.length === 0) {
    for (let x = 0; x < w; x++) {
      const topIdx = x;
      const botIdx = (h - 1) * w + x;
      if (!fgProtected[topIdx] && !visited[topIdx]) {
        visited[topIdx] = 1;
        bgMask[topIdx] = 1;
        queue[tail++] = topIdx;
      }
      if (!fgProtected[botIdx] && !visited[botIdx]) {
        visited[botIdx] = 1;
        bgMask[botIdx] = 1;
        queue[tail++] = botIdx;
      }
    }
    for (let y = 0; y < h; y++) {
      const leftIdx = y * w;
      const rightIdx = y * w + (w - 1);
      if (!fgProtected[leftIdx] && !visited[leftIdx]) {
        visited[leftIdx] = 1;
        bgMask[leftIdx] = 1;
        queue[tail++] = leftIdx;
      }
      if (!fgProtected[rightIdx] && !visited[rightIdx]) {
        visited[rightIdx] = 1;
        bgMask[rightIdx] = 1;
        queue[tail++] = rightIdx;
      }
    }
  }

  // Also add manual bgSeeds
  const manualBgColors: Array<[number, number, number]> = [];
  if (options.bgSeeds && options.bgSeeds.length > 0) {
    const bgRadius = Math.max(4, Math.round(Math.min(w, h) * 0.015));
    for (const seed of options.bgSeeds) {
      const sx = Math.max(0, Math.min(w - 1, Math.round(seed.x * w)));
      const sy = Math.max(0, Math.min(h - 1, Math.round(seed.y * h)));
      const cIdx = (sy * w + sx) * 4;
      manualBgColors.push([pixels[cIdx], pixels[cIdx + 1], pixels[cIdx + 2]]);
      for (let dy = -bgRadius; dy <= bgRadius; dy++) {
        for (let dx = -bgRadius; dx <= bgRadius; dx++) {
          const nx = sx + dx;
          const ny = sy + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const pIdx = ny * w + nx;
            if (!fgProtected[pIdx] && !visited[pIdx]) {
              visited[pIdx] = 1;
              bgMask[pIdx] = 1;
              queue[tail++] = pIdx;
            }
          }
        }
      }
    }
  }

  onStage?.('Refining Edges & Alpha Matte', 3, 62);

  // Perceptual distance threshold from tolerance (5..80)
  const tol = Math.max(5, Math.min(85, options.tolerance));
  const localDistThresholdSq = Math.pow(tol * 2.1, 2);
  const globalDistThresholdSq = Math.pow(tol * 2.6, 2);
  const edgeStopGrad = 42 + (100 - options.edgeRefinement) * 0.8;

  const refPalette = manualBgColors.length > 0 ? manualBgColors : borderSamples;

  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const cOff = cur * 4;
    const cr = pixels[cOff];
    const cg = pixels[cOff + 1];
    const cb = pixels[cOff + 2];

    const neighbors = [
      cx > 0 ? cur - 1 : -1,
      cx < w - 1 ? cur + 1 : -1,
      cy > 0 ? cur - w : -1,
      cy < h - 1 ? cur + w : -1,
    ];

    for (const nb of neighbors) {
      if (nb < 0 || visited[nb] || fgProtected[nb]) continue;
      const nOff = nb * 4;

      // Already transparent pixel is background
      if (pixels[nOff + 3] < 32) {
        visited[nb] = 1;
        bgMask[nb] = 1;
        queue[tail++] = nb;
        continue;
      }

      const nr = pixels[nOff];
      const ng = pixels[nOff + 1];
      const nbCol = pixels[nOff + 2];

      // Local continuity check
      const dLocal = rgbDistSq(cr, cg, cb, nr, ng, nbCol);
      if (dLocal > localDistThresholdSq) continue;

      // Edge-aware gradient barrier
      if (grad[nb] > edgeStopGrad && dLocal > localDistThresholdSq * 0.35) continue;

      // Global background similarity check (step sample refPalette for speed)
      let minRefDist = Infinity;
      const step = Math.max(1, Math.floor(refPalette.length / 24));
      for (let i = 0; i < refPalette.length; i += step) {
        const ref = refPalette[i];
        const d = rgbDistSq(nr, ng, nbCol, ref[0], ref[1], ref[2]);
        if (d < minRefDist) minRefDist = d;
      }

      if (minRefDist <= globalDistThresholdSq) {
        visited[nb] = 1;
        bgMask[nb] = 1;
        queue[tail++] = nb;
      }
    }
  }

  onStage?.('Feathering & Compositing', 4, 84);

  // Build alpha channel array (0 = background, 255 = foreground)
  const alphaOut = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    alphaOut[i] = bgMask[i] ? 0 : pixels[i * 4 + 3];
  }

  // Soft edge feathering along foreground-background boundary
  const featherRadius = Math.max(0, Math.min(12, Math.round(options.feather)));
  if (featherRadius > 0 || options.edgeRefinement > 30) {
    const r = Math.max(1, featherRadius);
    const softAlpha = new Uint8Array(alphaOut);
    for (let y = r; y < h - r; y++) {
      for (let x = r; x < w - r; x++) {
        const idx = y * w + x;
        if (bgMask[idx]) continue;
        // Check if pixel lies near background boundary
        let bgNeighbors = 0;
        let totalNeighbors = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            totalNeighbors++;
            if (bgMask[(y + dy) * w + (x + dx)]) bgNeighbors++;
          }
        }
        if (bgNeighbors > 0) {
          const fgRatio = 1 - bgNeighbors / totalNeighbors;
          const preserved = options.preserveHairDetail ? Math.pow(fgRatio, 0.72) : fgRatio;
          softAlpha[idx] = Math.round(alphaOut[idx] * Math.max(0.1, Math.min(1, preserved * 1.15)));
        }
      }
    }
    for (let i = 0; i < total; i++) {
      pixels[i * 4 + 3] = softAlpha[i];
    }
  } else {
    for (let i = 0; i < total; i++) {
      pixels[i * 4 + 3] = alphaOut[i];
    }
  }

  let outPipeline = sharp(Buffer.from(pixels), {
    raw: { width: w, height: h, channels: 4 },
  });

  if (options.bgColor !== 'transparent') {
    const fillHex =
      options.bgColor === 'white'
        ? '#ffffff'
        : options.bgColor === 'black'
        ? '#000000'
        : /^#[0-9a-fA-F]{6}$/.test(options.bgColor)
        ? options.bgColor
        : '#ffffff';
    outPipeline = outPipeline.flatten({ background: fillHex });
  }

  const outBuf = await outPipeline.png({ compressionLevel: 6 }).toBuffer();
  onStage?.('Completed', 6, 100);

  return {
    buffer: outBuf,
    mimeType: 'image/png',
    width: w,
    height: h,
    engine: 'Edge-Aware Lab Saliency + Alpha Matting (Built-in Server Engine)',
    processingMs: Date.now() - startMs,
  };
}
