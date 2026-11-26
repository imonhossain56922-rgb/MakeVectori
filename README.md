# MakeVectorizer — AI Image to Vector Converter & 4X Image Upscaler

**Turn Pixels Into Perfect Vectors.**

MakeVectorizer is a production full-stack vectorization, 4X image upscaling, smart background removal, and interactive SVG editing platform built with React, TypeScript, Tailwind CSS, Express, Sharp, SVGO, PDFKit, Firebase Auth/Firestore/Storage, and an optional Google Cloud Run AI worker.

## Architecture

- **Frontend (`src/`)**: React 19 + TypeScript + Tailwind CSS v4 studio interface with 3-panel vector editor, interactive before/after comparison slider, crop/preprocessing workstation, batch queue processor, and Firebase project dashboard.
- **API & Built-in Processing Server (`server.ts`, `server/engines/`)**:
  - **Raster-to-Vector (`vectorizer.ts`)**: Perceptual K-Means++ color quantization, despeckling, crack-boundary topological contour extraction (with true `evenodd` cutout holes and zero gaps), Ramer-Douglas-Peucker simplification, Catmull-Rom cubic Bezier curve fitting, and SVGO optimization.
  - **Exporters (`exporters.ts`)**: Genuine SVG 1.0/1.1, vector PDF (`pdfkit` + `svg-to-pdfkit`), PostScript Level 3 EPS, AutoCAD ASCII DXF (`Lines Only`, `Lines & Arcs`, `Lines, Arcs & Splines`), and 1X–4X DPI-tagged PNG.
  - **4X Image Upscaler (`upscaler.ts`)**: Connects to `PROCESSING_WORKER_URL` (Real-ESRGAN) when configured, or executes built-in multi-pass Edge-Directed Lanczos3 + Detail Recovery on the server.
  - **Smart Background Remover (`backgroundRemover.ts`)**: Connects to `PROCESSING_WORKER_URL` (RMBG) when configured, or executes built-in Lab color saliency + Sobel edge-aware alpha matting with interactive foreground/background brush seeds.
  - **AI Vision Preset Advisor (`geminiAnalyzer.ts`)**: Uses `@google/genai` (`gemini-4-hydrogen`) server-side to inspect artwork and recommend optimal presets and palette sizes.
- **Dedicated Cloud Run Worker (`worker/`)**: FastAPI container (`worker/Dockerfile`) running VTracer, Real-ESRGAN, Potrace, OpenCV, and RMBG independently from the frontend.

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
   Set `GEMINI_API_KEY` (optional for AI Preset Advisor) and optional `PROCESSING_WORKER_URL`.
3. Run development server on port 3000:
   ```bash
   npm run dev
   ```

## Deploying to Vercel & Google Cloud Run

1. **Cloud Run Worker**:
   ```bash
   cd worker
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/makevectorizer-worker
   gcloud run deploy makevectorizer-worker \
     --image gcr.io/YOUR_PROJECT_ID/makevectorizer-worker \
     --platform managed \
     --memory 4Gi \
     --cpu 2 \
     --set-env-vars PROCESSING_WORKER_SECRET=your_shared_secret
   ```
2. **Vercel Frontend**:
   - Deploy the Node/Express processing server (`server.ts`, e.g., to Cloud Run, Render, or Railway) with `ALLOWED_CORS_ORIGINS=https://your-vercel-app.vercel.app`.
   - In Vercel Project Settings > Environment Variables, set `VITE_API_BASE_URL` to your deployed HTTPS backend URL (e.g., `https://your-backend-service.run.app`). Calling the backend directly via `VITE_API_BASE_URL` also avoids Vercel's 4.5 MB serverless proxy payload limit and supports full 25 MB uploads.
   - Push to GitHub and import the repository in Vercel (`npm run build`, output `dist`).
3. **Firebase**:
   - Deploy `firestore.rules` and `storage.rules` via Firebase CLI:
     ```bash
     firebase deploy --only firestore:rules,storage
     ```
   - Enable **Google** and **Email/Password** providers in Firebase Console > Authentication > Sign-in method.
