import React from 'react';
import { Crop, FlipHorizontal, FlipVertical, RotateCw, RotateCcw } from 'lucide-react';
import { DEFAULT_PREPROCESSING, type PreprocessingOptions } from '../types/vector.ts';

interface PreprocessPanelProps {
  imageWidth: number;
  imageHeight: number;
  value: PreprocessingOptions;
  onChange: (next: PreprocessingOptions) => void;
}

export const PreprocessPanel: React.FC<PreprocessPanelProps> = ({
  imageWidth,
  imageHeight,
  value,
  onChange,
}) => {
  const applyAspectCrop = (aspect: string) => {
    if (aspect === 'none') {
      onChange({ ...value, crop: null });
      return;
    }
    if (aspect === 'free') {
      onChange({
        ...value,
        crop: {
          x: Math.round(imageWidth * 0.05),
          y: Math.round(imageHeight * 0.05),
          width: Math.round(imageWidth * 0.9),
          height: Math.round(imageHeight * 0.9),
          aspect: 'free',
        },
      });
      return;
    }
    const ratios: Record<string, number> = {
      '1:1': 1,
      '4:3': 4 / 3,
      '3:2': 3 / 2,
      '16:9': 16 / 9,
    };
    const r = ratios[aspect] || 1;
    let cw = imageWidth;
    let ch = Math.round(cw / r);
    if (ch > imageHeight) {
      ch = imageHeight;
      cw = Math.round(ch * r);
    }
    const cx = Math.round((imageWidth - cw) / 2);
    const cy = Math.round((imageHeight - ch) / 2);
    onChange({
      ...value,
      crop: { x: cx, y: cy, width: cw, height: ch, aspect },
    });
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-slate-900 flex items-center gap-1.5">
          <Crop className="w-3.5 h-3.5 text-indigo-600" />
          Crop & Preprocessing
        </span>
        <button
          type="button"
          onClick={() => onChange(DEFAULT_PREPROCESSING)}
          className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      {/* Crop Aspect Ratio Presets */}
      <div>
        <div className="text-[11px] font-medium text-slate-600 mb-1.5">Crop Area</div>
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { id: 'none', label: 'Full' },
            { id: 'free', label: 'Free' },
            { id: '1:1', label: '1:1' },
            { id: '4:3', label: '4:3' },
            { id: '3:2', label: '3:2' },
            { id: '16:9', label: '16:9' },
          ].map((preset) => {
            const active =
              preset.id === 'none'
                ? !value.crop
                : value.crop?.aspect === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyAspectCrop(preset.id)}
                className={`py-1.5 px-2 rounded-md border text-[11px] font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        {value.crop && (
          <div className="grid grid-cols-2 gap-2 mt-2">
            <label className="block">
              <span className="text-[10px] text-slate-500">X / Width (px)</span>
              <div className="flex gap-1 mt-0.5">
                <input
                  type="number"
                  min={0}
                  max={imageWidth - 4}
                  value={value.crop.x}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      crop: { ...value.crop!, x: Number(e.target.value) || 0 },
                    })
                  }
                  className="w-1/2 px-2 py-1 border border-slate-200 rounded font-mono tabular-nums"
                />
                <input
                  type="number"
                  min={4}
                  max={imageWidth}
                  value={value.crop.width}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      crop: { ...value.crop!, width: Number(e.target.value) || 16 },
                    })
                  }
                  className="w-1/2 px-2 py-1 border border-slate-200 rounded font-mono tabular-nums"
                />
              </div>
            </label>
            <label className="block">
              <span className="text-[10px] text-slate-500">Y / Height (px)</span>
              <div className="flex gap-1 mt-0.5">
                <input
                  type="number"
                  min={0}
                  max={imageHeight - 4}
                  value={value.crop.y}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      crop: { ...value.crop!, y: Number(e.target.value) || 0 },
                    })
                  }
                  className="w-1/2 px-2 py-1 border border-slate-200 rounded font-mono tabular-nums"
                />
                <input
                  type="number"
                  min={4}
                  max={imageHeight}
                  value={value.crop.height}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      crop: { ...value.crop!, height: Number(e.target.value) || 16 },
                    })
                  }
                  className="w-1/2 px-2 py-1 border border-slate-200 rounded font-mono tabular-nums"
                />
              </div>
            </label>
          </div>
        )}
      </div>

      {/* Rotate & Flip */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              rotate: ((value.rotate + 90) % 360) as 0 | 90 | 180 | 270,
            })
          }
          className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
        >
          <RotateCw className="w-3.5 h-3.5" />
          Rotate ({value.rotate}°)
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...value, flipH: !value.flipH })}
          className={`p-1.5 rounded-md border cursor-pointer ${
            value.flipH
              ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
          title="Flip Horizontal"
        >
          <FlipHorizontal className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...value, flipV: !value.flipV })}
          className={`p-1.5 rounded-md border cursor-pointer ${
            value.flipV
              ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
          title="Flip Vertical"
        >
          <FlipVertical className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tone & Filter Sliders */}
      <div className="space-y-2.5">
        {[
          { key: 'brightness', label: 'Brightness', min: 0.5, max: 1.5, step: 0.05 },
          { key: 'contrast', label: 'Contrast', min: 0.5, max: 1.5, step: 0.05 },
          { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.05 },
          { key: 'exposure', label: 'Exposure', min: -1, max: 1, step: 0.05 },
          { key: 'blur', label: 'Blur', min: 0, max: 5, step: 0.2 },
          { key: 'sharpen', label: 'Sharpen', min: 0, max: 5, step: 0.2 },
          { key: 'noiseRemoval', label: 'Noise Removal', min: 0, max: 5, step: 1 },
        ].map((ctrl) => {
          const val = value[ctrl.key as keyof PreprocessingOptions] as number;
          return (
            <label key={ctrl.key} className="block">
              <div className="flex justify-between text-[11px] text-slate-600 mb-0.5">
                <span>{ctrl.label}</span>
                <span className="font-mono tabular-nums text-slate-800">{val}</span>
              </div>
              <input
                type="range"
                min={ctrl.min}
                max={ctrl.max}
                step={ctrl.step}
                value={val}
                onChange={(e) =>
                  onChange({ ...value, [ctrl.key]: parseFloat(e.target.value) })
                }
                className="w-full accent-indigo-600"
              />
            </label>
          );
        })}
      </div>

      {/* Grayscale & Threshold */}
      <div className="pt-1 space-y-2">
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-slate-700">Grayscale</span>
          <input
            type="checkbox"
            checked={value.grayscale}
            onChange={(e) => onChange({ ...value, grayscale: e.target.checked })}
            className="rounded accent-indigo-600"
          />
        </label>
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-slate-700">Binary Threshold</span>
          <input
            type="checkbox"
            checked={value.threshold !== null}
            onChange={(e) =>
              onChange({ ...value, threshold: e.target.checked ? 128 : null })
            }
            className="rounded accent-indigo-600"
          />
        </label>
        {value.threshold !== null && (
          <input
            type="range"
            min={10}
            max={245}
            step={1}
            value={value.threshold}
            onChange={(e) =>
              onChange({ ...value, threshold: parseInt(e.target.value, 10) })
            }
            className="w-full accent-indigo-600"
          />
        )}
      </div>
    </div>
  );
};
