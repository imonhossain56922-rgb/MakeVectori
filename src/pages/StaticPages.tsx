import React, { useState } from 'react';
import { Mail, Send } from 'lucide-react';

export const AboutPage: React.FC = () => (
  <div className="max-w-4xl mx-auto px-4 sm:px-6 py-14 space-y-6">
    <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">
      About MakeVectorizer
    </h1>
    <p className="text-base text-slate-600 leading-relaxed">
      MakeVectorizer was engineered for graphic designers, screen printers, CAD fabricators, and product teams who need true geometric vector paths—never wrapped raster images masquerading as SVG files.
    </p>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
      <div className="p-6 rounded-xl border border-slate-200 bg-white space-y-2">
        <h2 className="text-base font-bold text-slate-900">Genuine Vector Geometry</h2>
        <p className="text-xs text-slate-600 leading-relaxed">
          Our tracing pipeline computes perceptual color clusters, topological crack-boundary contours with cutout hole preservation, and smooth cubic Bezier splines exported directly to SVG, Vector PDF, PostScript EPS, and AutoCAD DXF.
        </p>
      </div>
      <div className="p-6 rounded-xl border border-slate-200 bg-white space-y-2">
        <h2 className="text-base font-bold text-slate-900">Modular Cloud Run Worker Ready</h2>
        <p className="text-xs text-slate-600 leading-relaxed">
          Heavy workloads cleanly decouple from the Vercel/Vite frontend via our dedicated FastAPI Cloud Run worker specification for Real-ESRGAN, VTracer, Potrace, and RMBG.
        </p>
      </div>
    </div>
  </div>
);

export const ContactPage: React.FC = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@') || !message.trim()) return;
    setSent(true);
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-14 space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Contact Us</h1>
        <p className="text-sm text-slate-600 mt-1">
          Questions about Cloud Run worker deployment, custom DXF/CNC workflows, or studio features? Send us a note.
        </p>
      </div>

      {sent ? (
        <div className="p-6 rounded-xl border border-emerald-200 bg-emerald-50 text-xs text-emerald-800 space-y-2">
          <div className="font-bold text-sm">Message received</div>
          <p>
            Thank you, {name || 'there'}. Our team will follow up at {email} shortly.
          </p>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-xs"
        >
          <label className="block">
            <span className="font-medium text-slate-700">Name</span>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg"
              placeholder="Your name"
            />
          </label>
          <label className="block">
            <span className="font-medium text-slate-700">Work Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg"
              placeholder="you@company.com"
            />
          </label>
          <label className="block">
            <span className="font-medium text-slate-700">Message</span>
            <textarea
              required
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg"
              placeholder="Tell us about your vectorization or upscaling requirements..."
            />
          </label>
          <button
            type="submit"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            Send Message
          </button>
        </form>
      )}

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Mail className="w-4 h-4" />
        <span>support@makevectorizer.app</span>
      </div>
    </div>
  );
};

export const PrivacyPage: React.FC = () => (
  <div className="max-w-4xl mx-auto px-4 sm:px-6 py-14 space-y-5 text-sm text-slate-700 leading-relaxed">
    <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Privacy Policy</h1>
    <p>
      MakeVectorizer processes uploaded images solely to perform requested vectorization, upscaling, background removal, and format export operations.
    </p>
    <h2 className="text-lg font-bold text-slate-900 pt-2">1. File Retention & Temporary Storage</h2>
    <p>
      Temporary processing buffers on the API server are automatically purged after expiration. Saved projects and assets stored under your authenticated account in Firebase Firestore and Firebase Storage are strictly isolated by per-user security rules.
    </p>
    <h2 className="text-lg font-bold text-slate-900 pt-2">2. Security & Access Control</h2>
    <p>
      All uploads undergo binary signature verification, filename sanitization, and SVG script sanitization. No user can access or list another user&apos;s private files or projects.
    </p>
  </div>
);

export const TermsPage: React.FC = () => (
  <div className="max-w-4xl mx-auto px-4 sm:px-6 py-14 space-y-5 text-sm text-slate-700 leading-relaxed">
    <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Terms of Service</h1>
    <p>
      By using MakeVectorizer, you confirm that you own or hold valid rights to process and export the images you upload.
    </p>
    <h2 className="text-lg font-bold text-slate-900 pt-2">1. Ownership of Output</h2>
    <p>
      You retain 100% ownership and commercial rights to all SVG, PDF, EPS, DXF, and upscaled raster artwork generated from your inputs.
    </p>
    <h2 className="text-lg font-bold text-slate-900 pt-2">2. Acceptable Use</h2>
    <p>
      Automated abuse, malformed payload injection, or attempts to circumvent upload size limits and rate limits are prohibited.
    </p>
  </div>
);
