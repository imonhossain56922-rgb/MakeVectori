import { useEffect, useState } from 'react';
import type { FontCandidateMatch, VerifiedExactFontMatch } from '../types/vector.ts';

export type FontLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

const loadedFontsCache = new Map<string, FontLoadStatus>();
const pendingLoads = new Map<string, Promise<FontLoadStatus>>();
const injectedStylesheets = new Set<string>();

export function buildLoadedFamilyAlias(fontId: string, weight: number, isItalic: boolean): string {
  const safe = fontId.replace(/[^a-z0-9_-]/gi, '_');
  return `MVF_${safe}_${weight}_${isItalic ? 'i' : 'n'}`;
}

export interface LoadableWebfontTarget {
  id: string;
  family: string;
  weight: number;
  cssUrl: string;
  previewFontUrls: {
    woff2?: string;
    woff?: string;
    ttf?: string;
    otf?: string;
  };
  unavailable: boolean;
}

function normalizeLoadableTarget(
  input: FontCandidateMatch | VerifiedExactFontMatch
): LoadableWebfontTarget {
  if ('specimenPreview' in input) {
    return {
      id: input.id,
      family: input.family,
      weight: input.weight || 400,
      cssUrl: input.specimenPreview.cssUrl,
      previewFontUrls: input.specimenPreview.previewFontUrls || {},
      unavailable: !input.specimenPreview.available,
    };
  }
  return {
    id: input.id,
    family: input.family,
    weight: input.recommendedWeight || 400,
    cssUrl: input.cssUrl,
    previewFontUrls: input.previewFontUrls || {},
    unavailable: input.matchType === 'exact-paid',
  };
}

export async function loadWebfontTarget(
  target: LoadableWebfontTarget,
  weightOverride?: number,
  isItalic = false
): Promise<{ cssFamily: string; status: FontLoadStatus }> {
  if (target.unavailable) {
    return { cssFamily: 'inherit', status: 'error' };
  }

  const w = weightOverride || target.weight || 400;
  const alias = buildLoadedFamilyAlias(target.id, w, isItalic);

  const existing = loadedFontsCache.get(alias);
  if (existing === 'loaded') {
    return { cssFamily: `"${alias}"`, status: 'loaded' };
  }

  if (pendingLoads.has(alias)) {
    const st = await pendingLoads.get(alias)!;
    return {
      cssFamily: st === 'loaded' ? `"${alias}"` : 'inherit',
      status: st,
    };
  }

  const task = (async (): Promise<FontLoadStatus> => {
    try {
      const binaryUrl = (
        target.previewFontUrls?.woff2 ||
        target.previewFontUrls?.ttf ||
        target.previewFontUrls?.woff ||
        target.previewFontUrls?.otf ||
        ''
      ).trim();

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

      const cssUrl = (target.cssUrl || '').trim();
      if (cssUrl && !injectedStylesheets.has(cssUrl)) {
        await new Promise<void>((resolve, reject) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = cssUrl;
          link.onload = () => resolve();
          link.onerror = () => reject(new Error('Stylesheet load failed'));
          document.head.appendChild(link);
          injectedStylesheets.add(cssUrl);
        });
        await document.fonts.load(`${isItalic ? 'italic' : 'normal'} ${w} 24px "${target.family}"`);
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
    cssFamily: st === 'loaded' ? `"${alias}"` : 'inherit',
    status: st,
  };
}

export async function loadCandidateWebfont(
  candidate: FontCandidateMatch | VerifiedExactFontMatch,
  weightOverride?: number,
  isItalic = false
): Promise<{ cssFamily: string; status: FontLoadStatus }> {
  return loadWebfontTarget(normalizeLoadableTarget(candidate), weightOverride, isItalic);
}

export function useCandidateWebfont(
  candidate: FontCandidateMatch | VerifiedExactFontMatch | null,
  weight?: number,
  isItalic = false
): { cssFamily: string; status: FontLoadStatus } {
  const target = candidate ? normalizeLoadableTarget(candidate) : null;

  const [state, setState] = useState<{ cssFamily: string; status: FontLoadStatus }>(() => ({
    cssFamily: 'inherit',
    status: !target ? 'idle' : target.unavailable ? 'error' : 'loading',
  }));

  useEffect(() => {
    if (!target) {
      setState({ cssFamily: 'inherit', status: 'idle' });
      return;
    }
    if (target.unavailable) {
      setState({ cssFamily: 'inherit', status: 'error' });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading' }));

    loadWebfontTarget(target, weight, isItalic).then((res) => {
      if (!cancelled) setState(res);
    });

    return () => {
      cancelled = true;
    };
  }, [
    target?.id,
    target?.weight,
    target?.previewFontUrls?.woff2,
    target?.previewFontUrls?.ttf,
    target?.cssUrl,
    target?.unavailable,
    weight,
    isItalic,
  ]);

  return state;
}
