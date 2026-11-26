import React, { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, ImagePlus, Loader2, Upload } from 'lucide-react';
import { loadSampleImage, uploadImageFile } from '../lib/apiClient.ts';
import type { UploadMetadata } from '../types/vector.ts';

interface UploadDropzoneProps {
  onUploaded: (meta: UploadMetadata) => void;
  compact?: boolean;
  title?: string;
  subtitle?: string;
}

export const UploadDropzone: React.FC<UploadDropzoneProps> = ({
  onUploaded,
  compact = false,
  title = 'Drop an image here, paste from clipboard, or browse',
  subtitle = 'Supports PNG, JPG, JPEG, WebP, BMP, and GIF up to 25 MB',
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const meta = await uploadImageFile(file);
      onUploaded(meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleSample = async (sample: 'emblem' | 'illustration' | 'watch') => {
    setError(null);
    setUploading(true);
    try {
      const meta = await loadSampleImage(sample);
      onUploaded(meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sample.');
    } finally {
      setUploading(false);
    }
  };

  const handlePasteFromClipboard = async () => {
    setError(null);
    try {
      if (!navigator.clipboard?.read) {
        setError('Press Ctrl+V / Cmd+V anywhere on this page to paste an image.');
        return;
      }
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith('image/'));
        if (imgType) {
          const blob = await item.getType(imgType);
          const ext = imgType.split('/')[1] || 'png';
          const file = new File([blob], `pasted_image.${ext}`, { type: imgType });
          await handleFile(file);
          return;
        }
      }
      setError('No image found on your clipboard.');
    } catch {
      setError('Press Ctrl+V / Cmd+V anywhere on this page to paste an image.');
    }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            handleFile(file);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  return (
    <div className="w-full">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        className={`relative rounded-xl border-2 border-dashed transition-colors ${
          dragging
            ? 'border-indigo-600 bg-indigo-50/60'
            : 'border-slate-300 bg-slate-50/70 hover:border-indigo-400 hover:bg-slate-50'
        } ${compact ? 'p-5' : 'p-8 sm:p-10'}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />

        <div className="flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-center text-indigo-600 mb-4">
            {uploading ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : (
              <ImagePlus className="w-6 h-6" />
            )}
          </div>

          <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-1.5">
            {uploading ? 'Validating & Analyzing Image...' : title}
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 mb-5">{subtitle}</p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              Upload Image
            </button>
            <button
              type="button"
              disabled={uploading}
              onClick={handlePasteFromClipboard}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ClipboardPaste className="w-4 h-4" />
              Paste Image
            </button>
          </div>

          {!compact && (
            <div className="mt-6 pt-5 border-t border-slate-200/80 w-full flex flex-wrap items-center justify-center gap-2 text-xs text-slate-500">
              <span>Try a sample:</span>
              <button
                type="button"
                disabled={uploading}
                onClick={() => handleSample('emblem')}
                className="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-700 hover:border-indigo-300 hover:text-indigo-700 transition-colors cursor-pointer"
              >
                Origami Emblem
              </button>
              <button
                type="button"
                disabled={uploading}
                onClick={() => handleSample('illustration')}
                className="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-700 hover:border-indigo-300 hover:text-indigo-700 transition-colors cursor-pointer"
              >
                Botanical Illustration
              </button>
              <button
                type="button"
                disabled={uploading}
                onClick={() => handleSample('watch')}
                className="px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-700 hover:border-indigo-300 hover:text-indigo-700 transition-colors cursor-pointer"
              >
                Studio Chronograph
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-xs text-red-700 text-center">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
