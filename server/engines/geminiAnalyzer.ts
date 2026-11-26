import { GoogleGenAI, Type } from '@google/genai';
import type { VectorPreset } from '../../src/types/vector.ts';

export interface AiAnalysisRecommendation {
  recommendedPreset: VectorPreset;
  recommendedColorCount: 'auto' | 2 | 4 | 8 | 16 | 32 | 64;
  curveSmoothing: number;
  cornerPrecision: number;
  noiseReduction: number;
  subjectSummary: string;
  aiPowered: boolean;
}

export async function analyzeImageWithGemini(
  imageBase64: string,
  mimeType: string
): Promise<AiAnalysisRecommendation> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured in server secrets.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType,
            data: imageBase64,
          },
        },
        {
          text: 'Analyze this raster image for vectorization. Classify its visual style and recommend the optimal vectorization preset, color palette count, curve smoothing (0-100), corner precision (0-100), noise reduction (0-100), and a concise 1-sentence visual description.',
        },
      ],
    },
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          recommendedPreset: {
            type: Type.STRING,
            enum: ['logo', 'illustration', 'photography', 'sketch', 'screenprint', 'cnc', 'typography'],
          },
          recommendedColorCount: {
            type: Type.INTEGER,
            description: 'One of 2, 4, 8, 16, 32, 64',
          },
          curveSmoothing: { type: Type.INTEGER },
          cornerPrecision: { type: Type.INTEGER },
          noiseReduction: { type: Type.INTEGER },
          subjectSummary: { type: Type.STRING },
        },
        required: [
          'recommendedPreset',
          'recommendedColorCount',
          'curveSmoothing',
          'cornerPrecision',
          'noiseReduction',
          'subjectSummary',
        ],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim());
  const validCounts = [2, 4, 8, 16, 32, 64] as const;
  const closestCount = validCounts.reduce((prev, curr) =>
    Math.abs(curr - (parsed.recommendedColorCount || 16)) < Math.abs(prev - (parsed.recommendedColorCount || 16))
      ? curr
      : prev
  );

  return {
    recommendedPreset: parsed.recommendedPreset || 'logo',
    recommendedColorCount: closestCount,
    curveSmoothing: Math.max(0, Math.min(100, Number(parsed.curveSmoothing ?? 70))),
    cornerPrecision: Math.max(0, Math.min(100, Number(parsed.cornerPrecision ?? 80))),
    noiseReduction: Math.max(0, Math.min(100, Number(parsed.noiseReduction ?? 35))),
    subjectSummary: parsed.subjectSummary || 'Raster artwork ready for vectorization.',
    aiPowered: true,
  };
}
