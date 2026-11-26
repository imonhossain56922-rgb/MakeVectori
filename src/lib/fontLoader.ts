import { useEffect, useState } from 'react';
import type { FontCandidateMatch } from '../types/vector.ts';

export type FontLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

const loadedFontsCache = new Map<string, FontLoadStatus>();
const pendingLoads = new Map<string, Promise<FontLoadStatus>>();
const injectedStylesheets = new Set<string>();

export function buildLoadedFamilyAlias(fontId: string, weight: number, isItalic: boolean): string {
  const safe = fontId.replace(/[^a-z0-9_-]/gi, '_');
  return `MVF_${safe}_${weight}_${isItalic ? 'i' : 'n'}`;
}

export async function loadCandidateWebfont(
  candidate: Pick<
    FontCandidateMatch,
    'id' | 'family' | 'recommendedWeight' | 'previewFontUrls' | 'cssUrl' | 'matchType'
  >,
  weightOverride?: number,
  isItalic = false
): Promise<{ cssFamily: string; status: FontLoadStatus }> {
  if (candidate.matchType === 'exact-paid') {
    return { cssFamily: `"${candidate.family}", sans-serif`, status: 'error' };
  }

  const w = weightOverride || candidate.recommendedWeight || 400;
  const alias = buildLoadedFamilyAlias(candidate.id, w, isItalic);

  const existing = loadedFontsCache.get(alias);
  if (existing === 'loaded') {
    return { cssFamily: `"${alias}", "${candidate.family}", sans-serif`, status: 'loaded' };
  }

  if (pendingLoads.has(alias)) {
    const st = await pendingLoads.get(alias)!;
    return {
      cssFamily: st === 'loaded' ? `"${alias}", "${candidate.family}", sans-serif` : `"${candidate.family}", sans-serif`,
      status: st,
    };
  }

  const task = (async (): Promise<FontLoadStatus> => {
    try {
      // 1. Prefer verified binary WOFF2 / TTF / WOFF via FontFace API so browser renders authentic font glyphs
      const binaryUrl =
        candidate.previewFontUrls?.woff2 ||
        candidate.previewFontUrls?.ttf ||
        candidate.previewFontUrls?.woff;

      if (binaryUrl && typeof FontFace !== 'undefined') {
        const face = new FontFace(alias, `url("${binaryUrl}")`, {
          weight: String(w),
          style: isItalic ? 'italic' : 'normal',
          display: 'swap',
        });
        const loaded = await face.load();
        document.fonts.add(loaded);
        loadedFontsCache.set(alias, 'loaded');
        return 'loaded';
      }

      // 2. Fallback to Google Fonts official CSS2 stylesheet if direct binary URL wasn't present
      if (candidate.cssUrl && !injectedStylesheets.has(candidate.cssUrl)) {
        await new Promise<void>((resolve, reject) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = candidate.cssUrl;
          link.onload = () => resolve();
          link.onerror = () => reject(new Error('Stylesheet load failed'));
          document.head.appendChild(link);
          injectedStylesheets.add(candidate.cssUrl);
        });
        await document.fonts.load(`${isItalic ? 'italic' : 'normal'} ${w} 24px "${candidate.family}"`);
        loadedFontsCache.set(alias, 'loaded');
        return 'loaded';
      }

      loadedFontsCache.set(alias, 'error');
      return 'error';
    } catch {
      loadedFontsCache.set(alias, 'error');
      return 'error';
    } finally {
      pendingLoads.delete(alias);
    }
  })();

  pendingLoads.set(alias, task);
  const st = await task;
  return {
    cssFamily: st === 'loaded' ? `"${alias}", "${candidate.family}", sans-serif` : `"${candidate.family}", sans-serif`,
    status: st,
  };
}

export function useCandidateWebfont(
  candidate: FontCandidateMatch | null,
  weight?: number,
  isItalic = false
): { cssFamily: string; status: FontLoadStatus } {
  const [state, setState] = useState<{ cssFamily: string; status: FontLoadStatus }>(() => ({
    cssFamily: candidate ? `"${candidate.family}", sans-serif` : 'sans-serif',
    status: candidate?.matchType === 'exact-paid' ? 'error' : 'loading',
  }));

  useEffect(() => {
    if (!candidate) return;
    if (candidate.matchType === 'exact-paid') {
      setState({ cssFamily: `"${candidate.family}", sans-serif`, status: 'error' });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading' }));

    loadCandidateWebfont(candidate, weight, isItalic).then((res) => {
      if (!cancelled) setState(res);
    });

    return () => {
      cancelled = true;
    };
  }, [candidate?.id, candidate?.recommendedWeight, candidate?.previewFontUrls?.woff2, candidate?.cssUrl, weight, isItalic]);

  return state;
}
