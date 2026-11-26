import React, { useRef } from 'react';
import {
  ArrowRight,
  Eraser,
  Layers,
  Maximize,
  PenTool,
  Scissors,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { UploadDropzone } from '../components/UploadDropzone.tsx';
import type { UploadMetadata } from '../types/vector.ts';
import type { AppRoute } from '../components/Navbar.tsx';

interface HomePageProps {
  onNavigate: (route: AppRoute) => void;
  onStartWithUpload: (meta: UploadMetadata, targetRoute: AppRoute) => void;
}

export const HomePage: React.FC<HomePageProps> = ({ onNavigate, onStartWithUpload }) => {
  const featuresRef = useRef<HTMLDivElement>(null);

  return (
    <div className="bg-white">
      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-10 pb-16 lg:pt-14 lg:pb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center">
            <p className="text-xs font-semibold text-indigo-600 tracking-wide mb-3">
              Turn Pixels Into Perfect Vectors
            </p>
            <h1
              className="font-extrabold tracking-tight text-slate-900 mb-5"
              style={{ fontSize: 'clamp(2.25rem, 4vw, 3.5rem)', lineHeight: 1.08, textWrap: 'balance' }}
            >
              Transform Any Image Into a Perfect Vector.
            </h1>
            <p className="text-base sm:text-lg text-slate-600 leading-relaxed mb-7 max-w-xl">
              Convert images into clean, scalable vector graphics. Enhance resolution up to 4X, remove backgrounds, and create professional-quality artwork in seconds.
            </p>

            <div className="flex flex-wrap items-center gap-3 mb-8">
              <button
                type="button"
                onClick={() => onNavigate('/vectorizer')}
                className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Start Vectorizing
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => featuresRef.current?.scrollIntoView({ behavior: 'smooth' })}
                className="inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Explore Features
              </button>
            </div>

            <UploadDropzone
              onUploaded={(meta) => onStartWithUpload(meta, '/vectorizer')}
              title="Drop an image to vectorize right now"
              subtitle="PNG, JPG, JPEG, WebP, BMP, GIF · Drag & drop or paste (Ctrl+V)"
            />
          </div>

          <div className="lg:col-span-6 flex flex-col">
            <div className="flex-1 rounded-xl border border-slate-200 bg-slate-50 overflow-hidden shadow-sm flex flex-col">
              <div className="relative flex-1 min-h-[320px] bg-slate-100">
                <img
                  src="/src/assets/images/hero_studio_showcase_1795651606887.jpg"
                  alt="MakeVectorizer precision Bezier vector workstation"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="p-5 bg-white border-t border-slate-200 grid grid-cols-3 gap-4 text-left">
                <div>
                  <div className="text-lg font-bold font-mono tabular-nums text-slate-900">SVG · PDF</div>
                  <div className="text-xs text-slate-500">EPS & CAD DXF exports</div>
                </div>
                <div>
                  <div className="text-lg font-bold font-mono tabular-nums text-slate-900">Up to 4X</div>
                  <div className="text-xs text-slate-500">Detail-preserving upscale</div>
                </div>
                <div>
                  <div className="text-lg font-bold font-mono tabular-nums text-slate-900">7 Presets</div>
                  <div className="text-xs text-slate-500">Logos to laser CNC</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Core Capabilities Bento Grid */}
      <section ref={featuresRef} className="border-t border-slate-200 bg-slate-50/60 py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="max-w-2xl mb-12">
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 mb-3">
              Complete raster-to-vector & enhancement studio
            </h2>
            <p className="text-sm sm:text-base text-slate-600">
              Every tool writes real editable geometry, genuine multi-format vector files, and full-resolution raster outputs without shortcuts.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            {/* 01. AI Image to Vector */}
            <div className="md:col-span-7 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-4 mb-4">
                  <h3 className="text-xl font-bold text-slate-900">
                    01. Full-Color Bezier Vectorizer
                  </h3>
                  <button
                    type="button"
                    onClick={() => onNavigate('/vectorizer')}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap cursor-pointer"
                  >
                    Open Vectorizer →
                  </button>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed mb-6">
                  Topological contour tracing extracts closed outer paths and cutout holes with smooth Catmull-Rom cubic Bezier curves—zero overlapping blobs, zero gaps between adjacent colors, and zero embedded raster fakes.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center pt-4 border-t border-slate-100">
                <div className="aspect-square max-h-48 rounded-lg border border-slate-200 overflow-hidden bg-white">
                  <img
                    src="/src/assets/images/sample_brand_emblem_1795651607372.jpg"
                    alt="Geometric origami brand emblem ready for vectorization"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="space-y-2 text-xs text-slate-600">
                  <div className="font-semibold text-slate-900">7 Specialized Presets</div>
                  <div>Logo & Branding · Illustration</div>
                  <div>Photography · Sketch & Line Art</div>
                  <div>Screen Printing · Laser & CNC</div>
                  <div>Text & Typography</div>
                </div>
              </div>
            </div>

            {/* 02. 4X Upscaler */}
            <div className="md:col-span-5 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-4 mb-4">
                  <h3 className="text-xl font-bold text-slate-900">
                    02. 4X Image Upscaler
                  </h3>
                  <button
                    type="button"
                    onClick={() => onNavigate('/upscaler')}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap cursor-pointer"
                  >
                    Open Upscaler →
                  </button>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed mb-5">
                  Upscale 2X, 3X, or 4X with edge enhancement, noise reduction, and transparency preservation—then vectorize the crisp upscaled result in one click.
                </p>
              </div>
              <div className="aspect-4/3 rounded-lg border border-slate-200 overflow-hidden bg-slate-100">
                <img
                  src="/src/assets/images/sample_product_watch_1795651607350.jpg"
                  alt="Studio chronograph wristwatch sample for 4X upscaling"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>

            {/* 03. Background Remover */}
            <div className="md:col-span-5 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-4 mb-4">
                  <h3 className="text-xl font-bold text-slate-900">
                    03. Smart Background Remover
                  </h3>
                  <button
                    type="button"
                    onClick={() => onNavigate('/background-remover')}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap cursor-pointer"
                  >
                    Remove BG →
                  </button>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed mb-5">
                  Automatic border saliency detection plus manual foreground/background brush hints, edge refinement, feathering, and transparent PNG or solid backdrop export.
                </p>
              </div>
              <div className="aspect-4/3 rounded-lg border border-slate-200 overflow-hidden bg-white">
                <img
                  src="/src/assets/images/sample_botanical_illustration_1795651607300.jpg"
                  alt="Botanical toucan illustration sample for background removal and multi-color vectorization"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>

            {/* 04. 3-Panel Vector Editor & Batch */}
            <div className="md:col-span-7 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-4 mb-4">
                  <h3 className="text-xl font-bold text-slate-900">
                    04. Three-Panel Vector Studio & Multi-Format Export
                  </h3>
                  <button
                    type="button"
                    onClick={() => onNavigate('/editor')}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap cursor-pointer"
                  >
                    Open Editor →
                  </button>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed mb-6">
                  Inspect, recolor, merge, separate, group, and edit individual Bezier path nodes on an infinite canvas with rulers, grid, checkerboard alpha, and before/after slider.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                {[
                  { icon: <PenTool className="w-4 h-4 text-indigo-600" />, label: 'Pen & Node Editor' },
                  { icon: <Layers className="w-4 h-4 text-indigo-600" />, label: 'Color Separation' },
                  { icon: <Scissors className="w-4 h-4 text-indigo-600" />, label: 'Merge & Separate' },
                  { icon: <Sliders className="w-4 h-4 text-indigo-600" />, label: 'Before/After Slider' },
                  { icon: <Maximize className="w-4 h-4 text-indigo-600" />, label: 'SVG, PDF, EPS, DXF' },
                  { icon: <Sparkles className="w-4 h-4 text-indigo-600" />, label: 'Batch ZIP Queue' },
                ].map((feat) => (
                  <div
                    key={feat.label}
                    className="flex items-center gap-2 p-3 rounded-lg border border-slate-200 bg-slate-50/70 font-medium text-slate-800"
                  >
                    {feat.icon}
                    <span>{feat.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 05. AI Font Finder & Live Typography Comparison */}
            <div className="md:col-span-12 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div className="max-w-3xl">
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <h3 className="text-xl font-bold text-slate-900">
                    05. AI Font Finder &amp; Live Font Discovery
                  </h3>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Upload any image containing text to detect typography regions, identify exact or visually similar free fonts across Google Fonts and Fontsource, preview your exact image text in real loaded webfonts side-by-side, verify licenses, and download TTF/WOFF2/ZIP packages.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('/font-finder')}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer self-start lg:self-center"
              >
                Open AI Font Finder
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Workflow Chain Banner */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
        <div className="rounded-xl border border-slate-200 bg-slate-900 text-white p-8 sm:p-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold mb-2">
              End-to-End Pipeline: Enhance → 4X Upscale → Vectorize → Export
            </h2>
            <p className="text-sm text-slate-300 max-w-2xl">
              Start with low-resolution raster artwork, upscale up to 4X to reconstruct crisp edges, strip the background, trace into editable Bezier paths, and export print-ready PDF, EPS, or CNC DXF.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('/upscaler')}
              className="px-5 py-2.5 text-sm font-semibold text-slate-900 bg-white rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            >
              Start With 4X Upscaler
            </button>
            <button
              type="button"
              onClick={() => onNavigate('/batch')}
              className="px-5 py-2.5 text-sm font-semibold text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Batch Queue
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
