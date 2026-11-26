import sharp from 'sharp';
import { optimize } from 'svgo';
import { createRequire } from 'module';
import path from 'path';
import {
  vectorizeRaw,
  ColorMode,
  Hierarchical,
  PathSimplifyMode,
} from '@neplex/vectorizer';
import type {
  VectorizeOptions,
  VectorDocument,
  VectorShape,
  PaletteSwatch,
} from '../../src/types/vector.ts';
import { applyPreprocessing } from './preprocessing.ts';
import { sanitizeSvgXml } from './security.ts';

type PotraceFn = (
  imageBitmapSource: ImageBitmapSource,
  options?: {
    turdsize?: number;
    turnpolicy?: number;
    alphamax?: number;
    opticurve?: number;
    opttolerance?: number;
    pathonly?: boolean;
    extractcolors?: boolean;
    posterizelevel?: number;
    posterizationalgorithm?: number;
  }
) => Promise<string[]>;

let potraceReadyPromise: Promise<PotraceFn> | null = null;
function ensurePotraceReady(): Promise<PotraceFn> {
  if (!potraceReadyPromise) {
    potraceReadyPromise = (async () => {
      const req = createRequire(import.meta.url);
      const g = globalThis as Record<string, unknown>;
      if (typeof g.require !== 'function') {
        g.require = req;
      }
      if (typeof g.__dirname !== 'string') {
        try {
          const pkgDir = path.dirname(req.resolve('esm-potrace-wasm/package.json'));
          g.__dirname = path.join(pkgDir, 'dist');
        } catch {
          g.__dirname = path.resolve(process.cwd(), 'node_modules/esm-potrace-wasm/dist');
        }
      }
      const mod = await import('esm-potrace-wasm');
      await mod.init();
      return mod.potrace as unknown as PotraceFn;
    })().catch((err) => {
      potraceReadyPromise = null;
      throw err;
    });
  }
  return potraceReadyPromise;
}

interface ColorEntry {
  r: number;
  g: number;
  b: number;
  hex: string;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

function normalizeHex(hex: string): string {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    return (
      '#' +
      (clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]).toUpperCase()
    );
  }
  if (clean.length >= 6) {
    return '#' + clean.slice(0, 6).toUpperCase();
  }
  return '#000000';
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const norm = normalizeHex(hex).slice(1);
  return [
    parseInt(norm.slice(0, 2), 16) || 0,
    parseInt(norm.slice(2, 4), 16) || 0,
    parseInt(norm.slice(4, 6), 16) || 0,
  ];
}

function perceptualDistSq(
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

function euclideanDistSq(
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
  return dr * dr + dg * dg + db * db;
}

function pointToSegmentDistSq(
  pr: number,
  pg: number,
  pb: number,
  ar: number,
  ag: number,
  ab: number,
  br: number,
  bg: number,
  bb: number
): number {
  const vx = br - ar;
  const vy = bg - ag;
  const vz = bb - ab;
  const wx = pr - ar;
  const wy = pg - ag;
  const wz = pb - ab;
  const lenSq = vx * vx + vy * vy + vz * vz;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / lenSq));
  const dx = pr - (ar + t * vx);
  const dy = pg - (ag + t * vy);
  const dz = pb - (ab + t * vz);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Inspects interior pixel color diversity so `'auto'` color count & engine selection
 * can distinguish clean flat logos/icons from shaded/photographic imagery.
 */
function analyzeInteriorColorComplexity(
  pixels: Uint8Array,
  width: number,
  height: number
): {
  isInterior: Uint8Array;
  interiorCount: number;
  significantPeakCount: number;
  topCoverageRatio: number;
} {
  const total = width * height;
  const isInterior = new Uint8Array(total);
  const bins = new Map<number, number>();
  let interiorCount = 0;

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const idx = i * 4;
      if (pixels[idx + 3] < 230) continue;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];

      const nbs = [i - 1, i + 1, i - width, i + width];
      let maxDiff = 0;
      for (const nb of nbs) {
        const ni = nb * 4;
        if (pixels[ni + 3] < 230) {
          maxDiff = 999;
          break;
        }
        const d =
          Math.abs(r - pixels[ni]) +
          Math.abs(g - pixels[ni + 1]) +
          Math.abs(b - pixels[ni + 2]);
        if (d > maxDiff) maxDiff = d;
      }

      if (maxDiff <= 28) {
        isInterior[i] = 1;
        interiorCount++;
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        bins.set(key, (bins.get(key) || 0) + 1);
      }
    }
  }

  if (interiorCount === 0) {
    return {
      isInterior,
      interiorCount: 0,
      significantPeakCount: 2,
      topCoverageRatio: 1,
    };
  }

  const sorted = Array.from(bins.values()).sort((a, b) => b - a);
  const minSignificant = Math.max(4, interiorCount * 0.002);
  const significantPeakCount = sorted.filter((c) => c >= minSignificant).length;
  const top12Sum = sorted.slice(0, 12).reduce((acc, v) => acc + v, 0);
  const topCoverageRatio = top12Sum / interiorCount;

  return {
    isInterior,
    interiorCount,
    significantPeakCount,
    topCoverageRatio,
  };
}

/**
 * Extracts exact flat design colors from interior solid cores (avoiding averaged K-Means drift),
 * rescues crisp thin foreground strokes/typography, and snaps anti-aliased transition fringes
 * strictly to locally adjacent interior colors to eliminate halo ribbons.
 */
function quantizeWithExactColors(
  pixels: Uint8Array,
  width: number,
  height: number,
  targetK: number,
  isInterior: Uint8Array,
  options: VectorizeOptions
): {
  labelMap: Int32Array;
  palette: ColorEntry[];
  bgIndices: Set<number>;
} {
  const total = width * height;
  const alphaCutoff = options.preserveTransparency ? 128 : 80;

  // 1. Collect interior solid pixels (fallback to all opaque pixels if graphic is all thin strokes)
  const bins = new Map<number, { count: number; sumR: number; sumG: number; sumB: number }>();
  let poolCount = 0;

  for (let i = 0; i < total; i++) {
    if (!isInterior[i]) continue;
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let entry = bins.get(key);
    if (!entry) {
      entry = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
      bins.set(key, entry);
    }
    entry.count++;
    entry.sumR += r;
    entry.sumG += g;
    entry.sumB += b;
    poolCount++;
  }

  if (poolCount < 64) {
    bins.clear();
    poolCount = 0;
    for (let i = 0; i < total; i++) {
      const idx = i * 4;
      if (pixels[idx + 3] < 210) continue;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let entry = bins.get(key);
      if (!entry) {
        entry = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
        bins.set(key, entry);
      }
      entry.count++;
      entry.sumR += r;
      entry.sumG += g;
      entry.sumB += b;
      poolCount++;
    }
  }

  if (poolCount === 0) {
    return {
      labelMap: new Int32Array(total).fill(-1),
      palette: [],
      bgIndices: new Set(),
    };
  }

  const sortedBins = Array.from(bins.values())
    .map((v) => ({
      count: v.count,
      r: Math.round(v.sumR / v.count),
      g: Math.round(v.sumG / v.count),
      b: Math.round(v.sumB / v.count),
    }))
    .sort((a, b) => b.count - a.count);

  const dedupThresholdSq = targetK <= 6 ? 1050 : targetK <= 16 ? 750 : 420;
  const palette: ColorEntry[] = [];

  for (const bin of sortedBins) {
    if (bin.count < Math.max(4, poolCount * 0.0008) && palette.length >= 2) break;
    const tooClose = palette.some(
      (p) => euclideanDistSq(p.r, p.g, p.b, bin.r, bin.g, bin.b) < dedupThresholdSq
    );
    if (!tooClose) {
      palette.push({
        r: bin.r,
        g: bin.g,
        b: bin.b,
        hex: rgbToHex(bin.r, bin.g, bin.b),
      });
      if (palette.length >= targetK) break;
    }
  }

  // Assign initial interior pixels so spatial AA neighborhood checks know true adjacent colors
  const labelMap = new Int32Array(total).fill(-1);
  for (let i = 0; i < total; i++) {
    if (!isInterior[i]) continue;
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const d = perceptualDistSq(r, g, b, palette[c].r, palette[c].g, palette[c].b);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    labelMap[i] = best;
  }

  // 2. Thin-stroke rescue pass: pick up crisp text/lines whose strokes are < 3px wide
  // while rejecting anti-aliased edge transition pixels blended between two adjacent interior colors.
  if (palette.length < targetK) {
    const extraBins = new Map<number, { count: number; sumR: number; sumG: number; sumB: number }>();
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        if (isInterior[i]) continue;
        const idx = i * 4;
        if (pixels[idx + 3] < 215) continue;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];

        // Gather locally present interior labels inside 5x5 window
        const localLabels: number[] = [];
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const lbl = labelMap[ny * width + nx];
            if (lbl >= 0 && !localLabels.includes(lbl)) localLabels.push(lbl);
          }
        }

        const closeToExisting = palette.some(
          (p) => euclideanDistSq(r, g, b, p.r, p.g, p.b) < 1100
        );
        if (closeToExisting) continue;

        // Check if it sits on a linear RGB blend between two locally adjacent interior colors
        let isLocalBlend = false;
        for (let a = 0; a < localLabels.length && !isLocalBlend; a++) {
          for (let bIdx = a + 1; bIdx < localLabels.length && !isLocalBlend; bIdx++) {
            const ca = palette[localLabels[a]];
            const cb = palette[localLabels[bIdx]];
            if (pointToSegmentDistSq(r, g, b, ca.r, ca.g, ca.b, cb.r, cb.g, cb.b) < 380) {
              isLocalBlend = true;
            }
          }
        }

        if (!isLocalBlend) {
          const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          let entry = extraBins.get(key);
          if (!entry) {
            entry = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
            extraBins.set(key, entry);
          }
          entry.count++;
          entry.sumR += r;
          entry.sumG += g;
          entry.sumB += b;
        }
      }
    }

    const minRescueCount = Math.max(10, Math.round(total * 0.00035));
    // Prioritize edge clusters that are farthest from existing palette (endpoints before mid-tone AA blends)
    const extraSorted = Array.from(extraBins.values())
      .filter((eb) => eb.count >= minRescueCount)
      .map((eb) => {
        const r = Math.round(eb.sumR / eb.count);
        const g = Math.round(eb.sumG / eb.count);
        const b = Math.round(eb.sumB / eb.count);
        let minD = Infinity;
        for (const p of palette) {
          const d = euclideanDistSq(p.r, p.g, p.b, r, g, b);
          if (d < minD) minD = d;
        }
        return { count: eb.count, r, g, b, minD };
      })
      .sort((a, b) => b.minD * Math.log2(b.count + 2) - a.minD * Math.log2(a.count + 2));

    for (const eb of extraSorted) {
      const { r, g, b } = eb;
      const tooClose = palette.some(
        (p) => euclideanDistSq(p.r, p.g, p.b, r, g, b) < dedupThresholdSq
      );
      if (tooClose) continue;

      // Reject mid-tone AA blend shades lying along RGB segment between two already accepted colors
      let liesOnAnyPaletteSegment = false;
      for (let a = 0; a < palette.length && !liesOnAnyPaletteSegment; a++) {
        for (let bIdx = a + 1; bIdx < palette.length && !liesOnAnyPaletteSegment; bIdx++) {
          const ca = palette[a];
          const cb = palette[bIdx];
          if (pointToSegmentDistSq(r, g, b, ca.r, ca.g, ca.b, cb.r, cb.g, cb.b) < 520) {
            liesOnAnyPaletteSegment = true;
          }
        }
      }
      if (liesOnAnyPaletteSegment) continue;

      palette.push({ r, g, b, hex: rgbToHex(r, g, b) });
      if (palette.length >= targetK) break;
    }
  }

  // Re-assign all interior pixels against finalized palette
  for (let i = 0; i < total; i++) {
    if (!isInterior[i]) continue;
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const d = perceptualDistSq(r, g, b, palette[c].r, palette[c].g, palette[c].b);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    labelMap[i] = best;
  }

  // 3. Snap remaining non-interior / AA edge pixels strictly using local interior candidates
  // so transition pixels NEVER create stray halo specks of unrelated palette colors.
  const finalLabels = new Int32Array(labelMap);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (pixels[i * 4 + 3] < alphaCutoff || labelMap[i] >= 0) continue;

      const localCands = new Set<number>();
      for (let dy = -3; dy <= 3; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const lbl = labelMap[ny * width + nx];
          if (lbl >= 0) localCands.add(lbl);
        }
      }

      const idx = i * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];

      // Compare against ALL palette colors ONLY if pixel itself is crisp opaque (> 235)
      // AND sits far from every local interior color (thin stroke edge protection);
      // otherwise restrict purely to local interior candidates!
      let best = 0;
      let bestD = Infinity;

      if (localCands.size > 0) {
        for (const c of localCands) {
          const d = perceptualDistSq(r, g, b, palette[c].r, palette[c].g, palette[c].b);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (pixels[idx + 3] >= 225 && bestD > 3500) {
          for (let c = 0; c < palette.length; c++) {
            const d = perceptualDistSq(r, g, b, palette[c].r, palette[c].g, palette[c].b);
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
        }
      } else {
        for (let c = 0; c < palette.length; c++) {
          const d = perceptualDistSq(r, g, b, palette[c].r, palette[c].g, palette[c].b);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }

      finalLabels[i] = best;
    }
  }

  // 4. Refine each palette swatch's final RGB from its pure interior / dense core pixels
  // (for crisp pure white/black/brand fills without centroid washout)
  const coreSumR = new Float64Array(palette.length);
  const coreSumG = new Float64Array(palette.length);
  const coreSumB = new Float64Array(palette.length);
  const coreCount = new Int32Array(palette.length);
  const allSumR = new Float64Array(palette.length);
  const allSumG = new Float64Array(palette.length);
  const allSumB = new Float64Array(palette.length);
  const allCount = new Int32Array(palette.length);

  for (let i = 0; i < total; i++) {
    const lbl = finalLabels[i];
    if (lbl < 0) continue;
    const idx = i * 4;
    if (isInterior[i]) {
      coreSumR[lbl] += pixels[idx];
      coreSumG[lbl] += pixels[idx + 1];
      coreSumB[lbl] += pixels[idx + 2];
      coreCount[lbl]++;
    }
    if (pixels[idx + 3] >= 220) {
      allSumR[lbl] += pixels[idx];
      allSumG[lbl] += pixels[idx + 1];
      allSumB[lbl] += pixels[idx + 2];
      allCount[lbl]++;
    }
  }

  for (let c = 0; c < palette.length; c++) {
    if (coreCount[c] >= 12) {
      const r = Math.round(coreSumR[c] / coreCount[c]);
      const g = Math.round(coreSumG[c] / coreCount[c]);
      const b = Math.round(coreSumB[c] / coreCount[c]);
      // Snap ultra-near white/black extremes cleanly
      const snapR = r >= 252 && g >= 252 && b >= 252 ? 255 : r <= 3 && g <= 3 && b <= 3 ? 0 : r;
      const snapG = r >= 252 && g >= 252 && b >= 252 ? 255 : r <= 3 && g <= 3 && b <= 3 ? 0 : g;
      const snapB = r >= 252 && g >= 252 && b >= 252 ? 255 : r <= 3 && g <= 3 && b <= 3 ? 0 : b;
      palette[c] = { r: snapR, g: snapG, b: snapB, hex: rgbToHex(snapR, snapG, snapB) };
    } else if (allCount[c] > 0) {
      const r = Math.round(allSumR[c] / allCount[c]);
      const g = Math.round(allSumG[c] / allCount[c]);
      const b = Math.round(allSumB[c] / allCount[c]);
      palette[c] = { r, g, b, hex: rgbToHex(r, g, b) };
    }
  }

  const bgIndices = detectBorderBackgroundIndices(
    finalLabels,
    width,
    height,
    options.preserveTransparency,
    options.backgroundHandling
  );

  return { labelMap: finalLabels, palette, bgIndices };
}

function detectBorderBackgroundIndices(
  labelMap: Int32Array,
  width: number,
  height: number,
  preserveTransparency: boolean,
  bgHandling: VectorizeOptions['backgroundHandling']
): Set<number> {
  const bgIndices = new Set<number>();
  if (!preserveTransparency || bgHandling === 'remove' || bgHandling === 'transparent' || bgHandling === 'white') {
    const borderCounts = new Map<number, number>();
    let borderTotal = 0;
    for (let x = 0; x < width; x++) {
      const top = labelMap[x];
      const bot = labelMap[(height - 1) * width + x];
      if (top >= 0) borderCounts.set(top, (borderCounts.get(top) || 0) + 1);
      if (bot >= 0) borderCounts.set(bot, (borderCounts.get(bot) || 0) + 1);
      borderTotal += 2;
    }
    for (let y = 0; y < height; y++) {
      const left = labelMap[y * width];
      const right = labelMap[y * width + (width - 1)];
      if (left >= 0) borderCounts.set(left, (borderCounts.get(left) || 0) + 1);
      if (right >= 0) borderCounts.set(right, (borderCounts.get(right) || 0) + 1);
      borderTotal += 2;
    }
    let dominantBg = -1;
    let maxBorder = 0;
    for (const [colIdx, cnt] of borderCounts.entries()) {
      if (cnt > maxBorder) {
        maxBorder = cnt;
        dominantBg = colIdx;
      }
    }
    if (dominantBg >= 0 && maxBorder >= borderTotal * 0.35) {
      bgIndices.add(dominantBg);
    }
  }
  return bgIndices;
}

function despeckleLabelMap(
  labelMap: Int32Array,
  width: number,
  height: number,
  passes: number
): void {
  if (passes <= 0) return;
  const temp = new Int32Array(labelMap.length);
  for (let p = 0; p < passes; p++) {
    temp.set(labelMap);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = row + x;
        const cur = temp[idx];
        const n0 = temp[idx - width];
        const n1 = temp[idx + width];
        const n2 = temp[idx - 1];
        const n3 = temp[idx + 1];
        if (n0 === n1 && n0 === n2 && n0 !== cur) {
          labelMap[idx] = n0;
        } else if (n0 === n1 && n0 === n3 && n0 !== cur) {
          labelMap[idx] = n0;
        } else if (n2 === n3 && n2 === n0 && n2 !== cur) {
          labelMap[idx] = n2;
        } else if (n2 === n3 && n2 === n1 && n2 !== cur) {
          labelMap[idx] = n2;
        }
      }
    }
  }
}

/**
 * Absorbs tiny noise islands strictly smaller than `minComponentPixels` into their dominant
 * neighboring foreground label so speckles don't turn into orphan paths or pinholes.
 */
function absorbTinyIslands(
  labelMap: Int32Array,
  width: number,
  height: number,
  minComponentPixels: number
): void {
  if (minComponentPixels <= 1) return;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);

  for (let i = 0; i < total; i++) {
    const lbl = labelMap[i];
    if (visited[i] || lbl < 0) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    const neighborCounts = new Map<number, number>();

    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % width;
      const cy = (cur - cx) / width;

      const checkNb = (nb: number) => {
        const nl = labelMap[nb];
        if (nl === lbl) {
          if (!visited[nb]) {
            visited[nb] = 1;
            queue[tail++] = nb;
          }
        } else if (nl >= 0) {
          neighborCounts.set(nl, (neighborCounts.get(nl) || 0) + 1);
        }
      };

      if (cx > 0) checkNb(cur - 1);
      if (cx < width - 1) checkNb(cur + 1);
      if (cy > 0) checkNb(cur - width);
      if (cy < height - 1) checkNb(cur + width);
    }

    if (tail < minComponentPixels && neighborCounts.size > 0) {
      let bestNb = lbl;
      let bestCnt = 0;
      for (const [nbLbl, cnt] of neighborCounts.entries()) {
        if (cnt > bestCnt) {
          bestCnt = cnt;
          bestNb = nbLbl;
        }
      }
      for (let k = 0; k < tail; k++) {
        labelMap[queue[k]] = bestNb;
      }
    }
  }
}

/**
 * Normalizes any SVG path (Potrace or VTracer, relative or absolute commands, arbitrary transform)
 * into clean uppercase absolute M / L / C / Z document coordinates along with exact bounds & node count.
 */
function normalizePathToDocumentCoords(
  rawD: string,
  mapX: (x: number) => number,
  mapY: (y: number) => number
): {
  d: string;
  bounds: { x: number; y: number; width: number; height: number };
  nodeCount: number;
  detectedType: 'path' | 'rect';
} {
  const tokens = rawD.match(/[MLHVCSQTZmlhvcsqtz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens || tokens.length === 0) {
    return { d: '', bounds: { x: 0, y: 0, width: 0, height: 0 }, nodeCount: 0, detectedType: 'path' };
  }

  let i = 0;
  let cmd = 'M';
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let lastCmd = '';

  const out: string[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let nodeCount = 0;
  let subpathCount = 0;
  const rectPts: Array<{ x: number; y: number }> = [];
  let hasCurves = false;

  const fmt = (v: number) => Number(v.toFixed(2));
  const recordPt = (dx: number, dy: number) => {
    if (dx < minX) minX = dx;
    if (dy < minY) minY = dy;
    if (dx > maxX) maxX = dx;
    if (dy > maxY) maxY = dy;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MLHVCSQTZmlhvcsqtz]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        out.push('Z');
        curX = startX;
        curY = startY;
        lastCmd = cmd;
      }
      continue;
    }

    const nextNum = () => parseFloat(tokens[i++] || '0');
    const isRel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === 'M') {
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      curX = x;
      curY = y;
      startX = x;
      startY = y;
      const sx = fmt(mapX(x));
      const sy = fmt(mapY(y));
      out.push(`M ${sx} ${sy}`);
      recordPt(sx, sy);
      rectPts.push({ x: sx, y: sy });
      nodeCount++;
      subpathCount++;
      lastCmd = cmd;
      cmd = isRel ? 'l' : 'L';
    } else if (upper === 'L') {
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      curX = x;
      curY = y;
      const sx = fmt(mapX(x));
      const sy = fmt(mapY(y));
      out.push(`L ${sx} ${sy}`);
      recordPt(sx, sy);
      rectPts.push({ x: sx, y: sy });
      nodeCount++;
      lastCmd = cmd;
    } else if (upper === 'H') {
      const x = nextNum() + (isRel ? curX : 0);
      curX = x;
      const sx = fmt(mapX(curX));
      const sy = fmt(mapY(curY));
      out.push(`L ${sx} ${sy}`);
      recordPt(sx, sy);
      rectPts.push({ x: sx, y: sy });
      nodeCount++;
      lastCmd = cmd;
    } else if (upper === 'V') {
      const y = nextNum() + (isRel ? curY : 0);
      curY = y;
      const sx = fmt(mapX(curX));
      const sy = fmt(mapY(curY));
      out.push(`L ${sx} ${sy}`);
      recordPt(sx, sy);
      rectPts.push({ x: sx, y: sy });
      nodeCount++;
      lastCmd = cmd;
    } else if (upper === 'C') {
      hasCurves = true;
      const x1 = nextNum() + (isRel ? curX : 0);
      const y1 = nextNum() + (isRel ? curY : 0);
      const x2 = nextNum() + (isRel ? curX : 0);
      const y2 = nextNum() + (isRel ? curY : 0);
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      lastCtrlX = x2;
      lastCtrlY = y2;
      curX = x;
      curY = y;
      const sx1 = fmt(mapX(x1));
      const sy1 = fmt(mapY(y1));
      const sx2 = fmt(mapX(x2));
      const sy2 = fmt(mapY(y2));
      const sx = fmt(mapX(x));
      const sy = fmt(mapY(y));
      out.push(`C ${sx1} ${sy1}, ${sx2} ${sy2}, ${sx} ${sy}`);
      recordPt(sx, sy);
      recordPt(sx1, sy1);
      recordPt(sx2, sy2);
      nodeCount++;
      lastCmd = cmd;
    } else if (upper === 'S') {
      hasCurves = true;
      const prevUpper = lastCmd.toUpperCase();
      const x1 = prevUpper === 'C' || prevUpper === 'S' ? 2 * curX - lastCtrlX : curX;
      const y1 = prevUpper === 'C' || prevUpper === 'S' ? 2 * curY - lastCtrlY : curY;
      const x2 = nextNum() + (isRel ? curX : 0);
      const y2 = nextNum() + (isRel ? curY : 0);
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      lastCtrlX = x2;
      lastCtrlY = y2;
      curX = x;
      curY = y;
      const sx1 = fmt(mapX(x1));
      const sy1 = fmt(mapY(y1));
      const sx2 = fmt(mapX(x2));
      const sy2 = fmt(mapY(y2));
      const sx = fmt(mapX(x));
      const sy = fmt(mapY(y));
      out.push(`C ${sx1} ${sy1}, ${sx2} ${sy2}, ${sx} ${sy}`);
      recordPt(sx, sy);
      recordPt(sx1, sy1);
      recordPt(sx2, sy2);
      nodeCount++;
      lastCmd = cmd;
    } else if (upper === 'Q') {
      hasCurves = true;
      const qx = nextNum() + (isRel ? curX : 0);
      const qy = nextNum() + (isRel ? curY : 0);
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      const c1x = curX + (2 / 3) * (qx - curX);
      const c1y = curY + (2 / 3) * (qy - curY);
      const c2x = x + (2 / 3) * (qx - x);
      const c2y = y + (2 / 3) * (qy - y);
      lastCtrlX = qx;
      lastCtrlY = qy;
      curX = x;
      curY = y;
      const sx1 = fmt(mapX(c1x));
      const sy1 = fmt(mapY(c1y));
      const sx2 = fmt(mapX(c2x));
      const sy2 = fmt(mapY(c2y));
      const sx = fmt(mapX(x));
      const sy = fmt(mapY(y));
      out.push(`C ${sx1} ${sy1}, ${sx2} ${sy2}, ${sx} ${sy}`);
      recordPt(sx, sy);
      nodeCount++;
      lastCmd = cmd;
    } else if (upper === 'T') {
      hasCurves = true;
      const prevUpper = lastCmd.toUpperCase();
      const qx = prevUpper === 'Q' || prevUpper === 'T' ? 2 * curX - lastCtrlX : curX;
      const qy = prevUpper === 'Q' || prevUpper === 'T' ? 2 * curY - lastCtrlY : curY;
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      const c1x = curX + (2 / 3) * (qx - curX);
      const c1y = curY + (2 / 3) * (qy - curY);
      const c2x = x + (2 / 3) * (qx - x);
      const c2y = y + (2 / 3) * (qy - y);
      lastCtrlX = qx;
      lastCtrlY = qy;
      curX = x;
      curY = y;
      const sx1 = fmt(mapX(c1x));
      const sy1 = fmt(mapY(c1y));
      const sx2 = fmt(mapX(c2x));
      const sy2 = fmt(mapY(c2y));
      const sx = fmt(mapX(x));
      const sy = fmt(mapY(y));
      out.push(`C ${sx1} ${sy1}, ${sx2} ${sy2}, ${sx} ${sy}`);
      recordPt(sx, sy);
      nodeCount++;
      lastCmd = cmd;
    } else {
      i++;
    }
  }

  if (!Number.isFinite(minX)) {
    return { d: '', bounds: { x: 0, y: 0, width: 0, height: 0 }, nodeCount: 0, detectedType: 'path' };
  }

  let detectedType: 'path' | 'rect' = 'path';
  if (!hasCurves && subpathCount === 1 && (rectPts.length === 4 || rectPts.length === 5)) {
    const [p0, p1, p2, p3] = rectPts;
    const isOrtho =
      (Math.abs(p0.x - p1.x) < 1 && Math.abs(p1.y - p2.y) < 1 && Math.abs(p2.x - p3.x) < 1 && Math.abs(p3.y - p0.y) < 1) ||
      (Math.abs(p0.y - p1.y) < 1 && Math.abs(p1.x - p2.x) < 1 && Math.abs(p2.y - p3.y) < 1 && Math.abs(p3.x - p0.x) < 1);
    if (isOrtho) detectedType = 'rect';
  }

  return {
    d: out.join(' '),
    bounds: {
      x: Number(minX.toFixed(2)),
      y: Number(minY.toFixed(2)),
      width: Number(Math.max(0.5, maxX - minX).toFixed(2)),
      height: Number(Math.max(0.5, maxY - minY).toFixed(2)),
    },
    nodeCount,
    detectedType,
  };
}

/**
 * Multi-Layer Potrace engine: produces razor-sharp corners, smooth optimal Bezier splines,
 * exact flat design palette colors, and 1px under-layer seam tucking to eliminate subpixel gaps.
 */
async function traceWithPotraceMultiLayer(
  rawBuf: Uint8Array,
  workW: number,
  workH: number,
  origW: number,
  origH: number,
  targetK: number,
  isInterior: Uint8Array,
  options: VectorizeOptions
): Promise<{
  shapes: VectorShape[];
  palette: PaletteSwatch[];
  totalNodes: number;
  engineLabel: string;
}> {
  const potrace = await ensurePotraceReady();

  const scaleX = origW / workW;
  const scaleY = origH / workH;
  const minPixelsBase =
    options.detailLevel === 'maximum'
      ? 2
      : options.detailLevel === 'high'
      ? 4
      : options.detailLevel === 'medium'
      ? 8
      : 16;
  const minComponentPixels = Math.max(
    2,
    Math.round(minPixelsBase * (0.4 + options.noiseReduction / 55))
  );

  let labelMap: Int32Array;
  let palette: ColorEntry[];
  let bgIndices: Set<number>;

  if (options.preset === 'sketch' || options.preset === 'cnc') {
    const monoK = options.colorCount === 'auto' ? 2 : targetK;
    if (monoK <= 2) {
      // High-precision luminance binarization for sketch & CNC laser cutting
      const total = workW * workH;
      labelMap = new Int32Array(total).fill(-1);
      const alphaCutoff = options.preserveTransparency ? 128 : 80;
      const threshold = options.preprocessing?.threshold ?? 165;
      for (let i = 0; i < total; i++) {
        const idx = i * 4;
        if (rawBuf[idx + 3] < alphaCutoff) continue;
        const lum = 0.299 * rawBuf[idx] + 0.587 * rawBuf[idx + 1] + 0.114 * rawBuf[idx + 2];
        labelMap[i] = lum < threshold ? 0 : 1;
      }
      palette = [
        { r: 17, g: 24, b: 39, hex: '#111827' },
        { r: 255, g: 255, b: 255, hex: '#FFFFFF' },
      ];
      bgIndices =
        options.backgroundHandling === 'keep'
          ? new Set<number>()
          : new Set<number>([1]);
    } else {
      ({ labelMap, palette, bgIndices } = quantizeWithExactColors(
        rawBuf,
        workW,
        workH,
        monoK,
        isInterior,
        options
      ));
    }
  } else {
    ({ labelMap, palette, bgIndices } = quantizeWithExactColors(
      rawBuf,
      workW,
      workH,
      targetK,
      isInterior,
      options
    ));
  }

  const despecklePasses = options.noiseReduction >= 60 ? 2 : options.noiseReduction >= 20 ? 1 : 0;
  despeckleLabelMap(labelMap, workW, workH, despecklePasses);
  absorbTinyIslands(labelMap, workW, workH, Math.min(8, minComponentPixels));

  const totalPixels = workW * workH;
  const colorPixelCounts = new Int32Array(palette.length);
  let totalVisiblePixels = 0;

  for (let i = 0; i < totalPixels; i++) {
    const c = labelMap[i];
    if (c >= 0 && !bgIndices.has(c)) {
      colorPixelCounts[c]++;
      totalVisiblePixels++;
    }
  }

  // Painter's order: largest layers (background / base silhouettes) bottom -> smallest accents top
  const colorOrder = palette
    .map((_, idx) => idx)
    .filter((idx) => !bgIndices.has(idx) && colorPixelCounts[idx] >= minComponentPixels)
    .sort((a, b) => colorPixelCounts[b] - colorPixelCounts[a]);

  // Rank map lets bottom layers tuck cleanly 1px beneath higher-z foreground layers
  const colorRank = new Int32Array(palette.length).fill(-1);
  colorOrder.forEach((cIdx, rank) => {
    colorRank[cIdx] = rank;
  });
  const rankMap = new Int32Array(totalPixels).fill(-1);
  for (let i = 0; i < totalPixels; i++) {
    const c = labelMap[i];
    if (c >= 0) rankMap[i] = colorRank[c];
  }

  // Map user cornerPrecision (0..100) and curveSmoothing (0..100) to Potrace alphamax & opttolerance:
  // Higher cornerPrecision -> lower alphamax (crisper geometric corners, e.g. 95 -> 0.45, 85 -> 0.72)
  // Lower curveSmoothing / polygon preference reduces alphamax cleanly too
  const cornerAlpha = Math.max(0.25, Math.min(1.28, 1.32 - (options.cornerPrecision / 100) * 0.85));
  const smoothScale = options.curveSmoothing < 15 ? 0 : 0.65 + (options.curveSmoothing / 100) * 0.45;
  const alphamax = Number(Math.max(0, Math.min(1.33, cornerAlpha * smoothScale)).toFixed(3));
  const opttolerance = Number(
    (0.08 + (options.pathSimplification / 100) * (options.detailLevel === 'maximum' ? 0.35 : 0.7)).toFixed(3)
  );
  const turdsize = Math.max(1, minComponentPixels);
  const opticurve = options.curveSmoothing > 12 ? 1 : 0;

  const isCnc = options.preset === 'cnc';
  const shapes: VectorShape[] = [];
  const paletteSwatches: PaletteSwatch[] = [];
  let totalNodes = 0;
  let shapeCounter = 1;

  for (let rank = 0; rank < colorOrder.length; rank++) {
    const cIdx = colorOrder[rank];
    const color = palette[cIdx];

    // Build binary RGBA mask for Potrace (0 = ink / traced shape, 255 = paper)
    const mask = new Uint8ClampedArray(totalPixels * 4);
    const isBottomKeptBg = rank === 0 && options.backgroundHandling === 'keep' && colorOrder.length > 1;
    const allowTuck = !isCnc;

    for (let y = 0; y < workH; y++) {
      const row = y * workW;
      for (let x = 0; x < workW; x++) {
        const i = row + x;
        const rHere = rankMap[i];
        let on = rHere === rank;

        if (!on && allowTuck && rHere > rank) {
          if (isBottomKeptBg) {
            // Kept background underlays all foreground elements cleanly without holes
            on = true;
          } else {
            // Tuck 1px behind adjacent higher-z foreground layers to avoid subpixel seams,
            // while never bleeding 1px outward into transparent/removed background!
            if (
              (x > 0 && rankMap[i - 1] === rank) ||
              (x < workW - 1 && rankMap[i + 1] === rank) ||
              (y > 0 && rankMap[i - workW] === rank) ||
              (y < workH - 1 && rankMap[i + workW] === rank) ||
              (x > 0 && y > 0 && rankMap[i - workW - 1] === rank) ||
              (x < workW - 1 && y > 0 && rankMap[i - workW + 1] === rank) ||
              (x > 0 && y < workH - 1 && rankMap[i + workW - 1] === rank) ||
              (x < workW - 1 && y < workH - 1 && rankMap[i + workW + 1] === rank)
            ) {
              on = true;
            }
          }
        }

        const v = on ? 0 : 255;
        const o = i * 4;
        mask[o] = v;
        mask[o + 1] = v;
        mask[o + 2] = v;
        mask[o + 3] = 255;
      }
    }

    const potracePaths = await potrace(
      { data: mask, width: workW, height: workH } as unknown as ImageBitmapSource,
      {
        turdsize,
        turnpolicy: 4, // minority (standard Potrace)
        alphamax,
        opticurve,
        opttolerance,
        pathonly: true,
        extractcolors: false,
      }
    );

    let colorShapeCount = 0;
    for (const rawPotraceD of potracePaths) {
      const converted = normalizePathToDocumentCoords(
        rawPotraceD,
        (px) => px * 0.1 * scaleX,
        (py) => (workH - py * 0.1) * scaleY
      );
      if (!converted.d || converted.nodeCount < 2) continue;

      const id = `shape_${shapeCounter++}`;
      shapes.push({
        id,
        groupId: `layer_${color.hex.slice(1)}`,
        layerName: `Layer ${color.hex}`,
        type: options.detectPrimitives ? converted.detectedType : 'path',
        pathData: converted.d,
        fill: isCnc ? 'none' : color.hex,
        stroke: isCnc ? color.hex : 'none',
        strokeWidth: isCnc ? 1.25 : 0,
        opacity: 1,
        visible: true,
        locked: false,
        bounds: converted.bounds,
        nodeCount: converted.nodeCount,
      });

      totalNodes += converted.nodeCount;
      colorShapeCount++;
    }

    if (colorShapeCount > 0) {
      paletteSwatches.push({
        hex: color.hex,
        rgb: [color.r, color.g, color.b],
        areaPercent:
          totalVisiblePixels > 0
            ? Number(((colorPixelCounts[cIdx] / totalVisiblePixels) * 100).toFixed(1))
            : 0,
        shapeCount: colorShapeCount,
      });
    }
  }

  return {
    shapes,
    palette: paletteSwatches,
    totalNodes,
    engineLabel: 'MakeVectorizer Potrace WASM + AA-Defringe Precision Engine',
  };
}

/**
 * Native Rust VTracer (@neplex/vectorizer visioncortex) engine:
 * ideal for multi-color gradients, botanical/illustrative shading, photography,
 * or sharp polygonal geometric simplification.
 */
async function traceWithVTracer(
  rawBuf: Uint8Array,
  workW: number,
  workH: number,
  origW: number,
  origH: number,
  targetK: number,
  isInterior: Uint8Array,
  shouldPreQuantize: boolean,
  polygonMode: boolean,
  options: VectorizeOptions
): Promise<{
  shapes: VectorShape[];
  palette: PaletteSwatch[];
  totalNodes: number;
  engineLabel: string;
}> {
  let tracePixels = Buffer.from(rawBuf);
  let detectedBgHexes = new Set<string>();

  if (shouldPreQuantize) {
    const { labelMap, palette, bgIndices } = quantizeWithExactColors(
      rawBuf,
      workW,
      workH,
      targetK,
      isInterior,
      options
    );
    const passes = options.noiseReduction >= 60 ? 2 : options.noiseReduction >= 25 ? 1 : 0;
    despeckleLabelMap(labelMap, workW, workH, passes);

    tracePixels = Buffer.alloc(workW * workH * 4);
    for (let i = 0; i < workW * workH; i++) {
      const c = labelMap[i];
      const o = i * 4;
      if (c < 0 || bgIndices.has(c)) {
        tracePixels[o] = 0;
        tracePixels[o + 1] = 0;
        tracePixels[o + 2] = 0;
        tracePixels[o + 3] = 0;
      } else {
        tracePixels[o] = palette[c].r;
        tracePixels[o + 1] = palette[c].g;
        tracePixels[o + 2] = palette[c].b;
        tracePixels[o + 3] = 255;
      }
    }
    for (const bgIdx of bgIndices) {
      if (palette[bgIdx]) detectedBgHexes.add(palette[bgIdx].hex);
    }
  } else if (options.backgroundHandling === 'remove' || options.backgroundHandling === 'transparent' || options.backgroundHandling === 'white') {
    // Detect border dominant color in unquantized mode
    const borderBins = new Map<string, number>();
    let borderSamples = 0;
    const sampleBorder = (x: number, y: number) => {
      const idx = (y * workW + x) * 4;
      if (tracePixels[idx + 3] < 128) return;
      const hx = rgbToHex(
        tracePixels[idx] & 0xf0,
        tracePixels[idx + 1] & 0xf0,
        tracePixels[idx + 2] & 0xf0
      );
      borderBins.set(hx, (borderBins.get(hx) || 0) + 1);
      borderSamples++;
    };
    for (let x = 0; x < workW; x++) {
      sampleBorder(x, 0);
      sampleBorder(x, workH - 1);
    }
    for (let y = 0; y < workH; y++) {
      sampleBorder(0, y);
      sampleBorder(workW - 1, y);
    }
    for (const [hx, cnt] of borderBins.entries()) {
      if (cnt >= borderSamples * 0.45) {
        detectedBgHexes.add(hx);
      }
    }
  }

  const filterSpeckle = Math.max(
    1,
    Math.round((options.noiseReduction / 12) + (options.detailLevel === 'low' ? 8 : options.detailLevel === 'medium' ? 4 : 2))
  );
  const colorPrecision = shouldPreQuantize
    ? 8
    : targetK >= 64
    ? 8
    : targetK >= 32
    ? 7
    : targetK >= 16
    ? 6
    : 5;
  const layerDifference = shouldPreQuantize
    ? 4
    : Math.max(8, Math.min(48, Math.round(44 - (options.shapeComplexity / 100) * 32)));
  const cornerThreshold = Math.max(
    15,
    Math.min(110, Math.round(105 - (options.cornerPrecision / 100) * 75))
  );
  const lengthThreshold = Number(
    (2.5 + (options.pathSimplification / 100) * 5.0).toFixed(2)
  );
  const spliceThreshold = Math.max(
    15,
    Math.min(90, Math.round(25 + (options.curveSmoothing / 100) * 45))
  );

  const simplifyMode =
    polygonMode || options.curveSmoothing < 12
      ? PathSimplifyMode.Polygon
      : PathSimplifyMode.Spline;

  const isCnc = options.preset === 'cnc';
  const hierarchical =
    isCnc || shouldPreQuantize ? Hierarchical.Cutout : Hierarchical.Stacked;

  const rawSvg = await vectorizeRaw(
    tracePixels,
    { width: workW, height: workH },
    {
      colorMode: options.colorCount === 2 ? ColorMode.Binary : ColorMode.Color,
      hierarchical,
      filterSpeckle,
      colorPrecision,
      layerDifference,
      mode: simplifyMode,
      cornerThreshold,
      lengthThreshold,
      maxIterations: 12,
      spliceThreshold,
      pathPrecision: 2,
    }
  );

  const scaleX = origW / workW;
  const scaleY = origH / workH;

  const shapes: VectorShape[] = [];
  const paletteStats = new Map<string, { rgb: [number, number, number]; areaScore: number; shapeCount: number }>();
  let totalAreaScore = 0;
  let totalNodes = 0;
  let shapeCounter = 1;

  // Consolidate ultra-close VTracer color shades so the Palette Panel stays clean & editable
  const canonicalPalette: Array<{ r: number; g: number; b: number; hex: string }> = [];
  const hexRemap = new Map<string, string>();
  const mergeDistSq = shouldPreQuantize ? 60 : options.preset === 'photography' ? 85 : 120;

  const mapToCanonical = (hex: string): string => {
    const cached = hexRemap.get(hex);
    if (cached) return cached;
    const [r, g, b] = hexToRgbTuple(hex);
    for (const c of canonicalPalette) {
      if (euclideanDistSq(r, g, b, c.r, c.g, c.b) <= mergeDistSq) {
        hexRemap.set(hex, c.hex);
        return c.hex;
      }
    }
    canonicalPalette.push({ r, g, b, hex });
    hexRemap.set(hex, hex);
    return hex;
  };

  // Parse all <path .../> tags emitted by @neplex/vectorizer
  const pathTagMatches = rawSvg.matchAll(/<path\b([^>]*)\/?>/gi);
  for (const match of pathTagMatches) {
    const attrs = match[1];
    const dMatch = attrs.match(/\bd="([^"]+)"/i);
    if (!dMatch) continue;
    const fillMatch = attrs.match(/\bfill="([^"]+)"/i);
    const rawFillHex = normalizeHex(fillMatch ? fillMatch[1] : '#000000');

    if (fillMatch?.[1]?.toLowerCase() === 'none') continue;
    const fillHex = mapToCanonical(rawFillHex);

    // Parse optional transform="translate(tx, ty)"
    let tx = 0;
    let ty = 0;
    const transMatch = attrs.match(/translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)/i);
    if (transMatch) {
      tx = parseFloat(transMatch[1]) || 0;
      ty = parseFloat(transMatch[2] || '0') || 0;
    }

    const normalized = normalizePathToDocumentCoords(
      dMatch[1],
      (x) => (x + tx) * scaleX,
      (y) => (y + ty) * scaleY
    );
    if (!normalized.d || normalized.nodeCount < 2) continue;

    // Skip full-canvas perimeter background shape when background removal/transparent/white is selected
    if (
      (options.backgroundHandling === 'remove' ||
        options.backgroundHandling === 'transparent' ||
        options.backgroundHandling === 'white') &&
      normalized.bounds.width >= origW * 0.94 &&
      normalized.bounds.height >= origH * 0.94
    ) {
      const top4 = rgbToHex(
        hexToRgbTuple(fillHex)[0] & 0xf0,
        hexToRgbTuple(fillHex)[1] & 0xf0,
        hexToRgbTuple(fillHex)[2] & 0xf0
      );
      if (detectedBgHexes.size === 0 || detectedBgHexes.has(top4) || detectedBgHexes.has(fillHex)) {
        continue;
      }
    }

    const id = `shape_${shapeCounter++}`;
    shapes.push({
      id,
      groupId: `layer_${fillHex.slice(1)}`,
      layerName: `Layer ${fillHex}`,
      type: options.detectPrimitives ? normalized.detectedType : 'path',
      pathData: normalized.d,
      fill: isCnc ? 'none' : fillHex,
      stroke: isCnc ? fillHex : 'none',
      strokeWidth: isCnc ? 1.25 : 0,
      opacity: 1,
      visible: true,
      locked: false,
      bounds: normalized.bounds,
      nodeCount: normalized.nodeCount,
    });

    totalNodes += normalized.nodeCount;
    const areaEstimate = Math.max(1, normalized.bounds.width * normalized.bounds.height);
    totalAreaScore += areaEstimate;

    const existing = paletteStats.get(fillHex);
    if (existing) {
      existing.areaScore += areaEstimate;
      existing.shapeCount++;
    } else {
      paletteStats.set(fillHex, {
        rgb: hexToRgbTuple(fillHex),
        areaScore: areaEstimate,
        shapeCount: 1,
      });
    }
  }

  const palette: PaletteSwatch[] = Array.from(paletteStats.entries())
    .sort((a, b) => b[1].areaScore - a[1].areaScore)
    .map(([hex, info]) => ({
      hex,
      rgb: info.rgb,
      areaPercent:
        totalAreaScore > 0 ? Number(((info.areaScore / totalAreaScore) * 100).toFixed(1)) : 0,
      shapeCount: info.shapeCount,
    }));

  return {
    shapes,
    palette,
    totalNodes,
    engineLabel:
      simplifyMode === PathSimplifyMode.Polygon
        ? 'VTracer Native Rust Polygon Engine (@neplex/vectorizer)'
        : 'VTracer Native Rust Spline Engine (@neplex/vectorizer)',
  };
}

export async function vectorizeRasterImage(
  inputBuffer: Buffer,
  options: VectorizeOptions,
  onStage?: (stage: string, stageIndex: number, progress: number) => void
): Promise<{ document: VectorDocument; svgContent: string }> {
  const startMs = Date.now();
  onStage?.('Analyzing Image', 2, 15);

  const preprocessed = await applyPreprocessing(inputBuffer, options.preprocessing);
  const origW = preprocessed.width;
  const origH = preprocessed.height;

  onStage?.('Preprocessing', 3, 28);

  const maxDimByDetail: Record<VectorizeOptions['detailLevel'], number> = {
    low: 560,
    medium: 900,
    high: 1280,
    maximum: 1680,
  };
  const maxWorkDim = maxDimByDetail[options.detailLevel] || 1280;
  const longest = Math.max(origW, origH);

  // Upscale small logos/text up to 2x (capped at 1280px) for sharper sub-pixel edge geometry
  const isFlatStylePreset =
    options.preset === 'logo' ||
    options.preset === 'typography' ||
    options.preset === 'screenprint' ||
    options.preset === 'sketch' ||
    options.preset === 'cnc';

  let workScale = 1;
  if (longest > maxWorkDim) {
    workScale = maxWorkDim / longest;
  } else if (longest < 850 && options.detailLevel !== 'low' && isFlatStylePreset) {
    workScale = Math.min(2, 1280 / longest);
  }

  const workW = Math.max(16, Math.round(origW * workScale));
  const workH = Math.max(16, Math.round(origH * workScale));

  let workPipeline = sharp(preprocessed.buffer);
  if (workW !== origW || workH !== origH) {
    // Mitchell resampling minimizes Lanczos overshoot ringing along high-contrast edges
    workPipeline = workPipeline.resize(workW, workH, {
      kernel: sharp.kernel.mitchell,
    });
  }

  const rawBuf = await workPipeline.ensureAlpha().raw().toBuffer();

  onStage?.('Detecting Shapes and Colors', 4, 48);

  const complexity = analyzeInteriorColorComplexity(rawBuf, workW, workH);

  let targetK = 8;
  if (options.colorCount === 'auto') {
    const p = complexity.significantPeakCount;
    if (p <= 3) targetK = 3;
    else if (p <= 6) targetK = 6;
    else if (p <= 12) targetK = 12;
    else if (p <= 24) targetK = 24;
    else if (p <= 48) targetK = 36;
    else targetK = 64;
    const complexityFactor = 0.75 + (options.shapeComplexity / 100) * 0.5;
    targetK = Math.max(2, Math.min(64, Math.round(targetK * complexityFactor)));
  } else if (options.colorCount === 'unlimited') {
    targetK = 96;
  } else {
    targetK = Number(options.colorCount);
  }

  const requestedEngine = options.engine || 'auto';
  const isRichMultiColor =
    options.preset === 'photography' ||
    options.preset === 'illustration' ||
    options.colorCount === 'unlimited' ||
    (typeof options.colorCount === 'number' && options.colorCount >= 32) ||
    (options.colorCount === 'auto' &&
      complexity.significantPeakCount > 20 &&
      complexity.topCoverageRatio < 0.86);

  let chosenEngine: 'potrace' | 'vtracer' | 'vtracer-polygon';
  if (requestedEngine === 'potrace') {
    chosenEngine = 'potrace';
  } else if (requestedEngine === 'vtracer') {
    chosenEngine = 'vtracer';
  } else if (requestedEngine === 'vtracer-polygon') {
    chosenEngine = 'vtracer-polygon';
  } else {
    chosenEngine = isRichMultiColor ? 'vtracer' : 'potrace';
  }

  onStage?.('Generating Vector Paths', 5, 68);

  let traced: {
    shapes: VectorShape[];
    palette: PaletteSwatch[];
    totalNodes: number;
    engineLabel: string;
  };

  if (chosenEngine === 'potrace') {
    traced = await traceWithPotraceMultiLayer(
      rawBuf,
      workW,
      workH,
      origW,
      origH,
      Math.min(32, targetK),
      complexity.isInterior,
      options
    );
  } else {
    const preQuantize =
      chosenEngine === 'vtracer-polygon' ||
      (typeof options.colorCount === 'number' && options.colorCount <= 24) ||
      (!isRichMultiColor && options.preset !== 'photography');

    traced = await traceWithVTracer(
      rawBuf,
      workW,
      workH,
      origW,
      origH,
      targetK,
      complexity.isInterior,
      preQuantize,
      chosenEngine === 'vtracer-polygon',
      options
    );
  }

  onStage?.('Optimizing Geometry', 6, 86);

  const backgroundColor =
    options.backgroundHandling === 'white' ? '#FFFFFF' : null;

  const document: VectorDocument = {
    width: origW,
    height: origH,
    viewBox: `0 0 ${origW} ${origH}`,
    backgroundColor,
    shapes: traced.shapes,
    palette: traced.palette,
    metadata: {
      preset: options.preset,
      engine: traced.engineLabel,
      processingMs: Date.now() - startMs,
      totalShapes: traced.shapes.length,
      totalNodes: traced.totalNodes,
    },
  };

  onStage?.('Preparing Output', 7, 95);
  const svgContent = buildSvgFromDocument(document, {
    svgVersion: '1.1',
    svgSizeMode: 'scalable',
    preserveLayers: true,
    illustratorCompat: false,
  });

  return { document, svgContent };
}

export function buildSvgFromDocument(
  doc: VectorDocument,
  opts: {
    svgVersion?: '1.0' | '1.1';
    svgSizeMode?: 'scalable' | 'fixed';
    preserveLayers?: boolean;
    illustratorCompat?: boolean;
  }
): string {
  const version = opts.svgVersion === '1.0' ? '1.0' : '1.1';
  const sizeAttrs =
    opts.svgSizeMode === 'fixed'
      ? `width="${doc.width}" height="${doc.height}"`
      : `width="100%" height="100%"`;
  const illustratorAttrs = opts.illustratorCompat ? ` xml:space="preserve"` : '';

  const bgRect = doc.backgroundColor
    ? `<rect x="0" y="0" width="${doc.width}" height="${doc.height}" fill="${doc.backgroundColor}" />`
    : '';

  const visibleShapes = doc.shapes.filter((s) => s.visible);
  let bodyContent = '';

  const serializeShape = (s: VectorShape) => {
    const transform = s.tx || s.ty ? ` transform="translate(${s.tx || 0} ${s.ty || 0})"` : '';
    const strokeAttr =
      s.stroke && s.stroke !== 'none' && s.strokeWidth > 0
        ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"`
        : '';
    const opAttr = s.opacity < 1 ? ` opacity="${s.opacity}"` : '';

    if (s.type === 'text' && s.textContent) {
      const escaped = s.textContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const fam = (s.fontFamily || 'sans-serif').replace(/["<>]/g, '');
      const fSize = s.fontSize || 48;
      const fWeight = s.fontWeight || 600;
      const lSpace = s.letterSpacing ? ` letter-spacing="${s.letterSpacing}"` : '';
      return `<text id="${s.id}" x="${s.bounds.x}" y="${s.bounds.y + fSize * 0.85}" font-family="${fam}, sans-serif" font-size="${fSize}" font-weight="${fWeight}"${lSpace} fill="${s.fill}"${strokeAttr}${opAttr}${transform}>${escaped}</text>`;
    }

    return `<path id="${s.id}" d="${s.pathData}" fill="${s.fill}" fill-rule="evenodd"${strokeAttr}${opAttr}${transform}/>`;
  };

  if (opts.preserveLayers !== false) {
    const grouped = new Map<string, VectorShape[]>();
    for (const shape of visibleShapes) {
      const gKey = shape.groupId || 'default';
      let arr = grouped.get(gKey);
      if (!arr) {
        arr = [];
        grouped.set(gKey, arr);
      }
      arr.push(shape);
    }
    const groupStrings: string[] = [];
    for (const [gKey, items] of grouped.entries()) {
      const paths = items.map(serializeShape).join('\n    ');
      groupStrings.push(`  <g id="${gKey}">\n    ${paths}\n  </g>`);
    }
    bodyContent = groupStrings.join('\n');
  } else {
    bodyContent = visibleShapes.map((s) => `  ${serializeShape(s)}`).join('\n');
  }

  const rawSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="${version}" ${sizeAttrs} viewBox="${doc.viewBox}"${illustratorAttrs}>
${bgRect ? `  ${bgRect}\n` : ''}${bodyContent}
</svg>`;

  try {
    const optimized = optimize(rawSvg, {
      multipass: false,
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              cleanupIds: false,
              collapseGroups: false,
              mergePaths: false,
            },
          },
        },
      ],
    });
    return sanitizeSvgXml(optimized.data);
  } catch {
    return sanitizeSvgXml(rawSvg);
  }
}
