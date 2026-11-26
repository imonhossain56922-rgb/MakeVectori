import React from 'react';
import type { AppRoute } from './Navbar.tsx';

interface FooterProps {
  onNavigate: (route: AppRoute) => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigate }) => {
  return (
    <footer className="border-t border-slate-200 bg-slate-50/70">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-1">
            <div className="text-base font-extrabold text-slate-900">MakeVectorizer</div>
            <p className="text-xs text-slate-500 mt-2 leading-relaxed">
              Turn Pixels Into Perfect Vectors. Precision raster-to-vector conversion, 4X image upscaling, and background removal.
            </p>
          </div>

          <div>
            <div className="text-xs font-semibold text-slate-900 mb-3">Studio Tools</div>
            <ul className="space-y-2 text-xs text-slate-600">
              <li>
                <button type="button" onClick={() => onNavigate('/vectorizer')} className="hover:text-indigo-600 cursor-pointer">
                  Image to Vector
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/upscaler')} className="hover:text-indigo-600 cursor-pointer">
                  AI 4X Image Upscaler
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/background-remover')} className="hover:text-indigo-600 cursor-pointer">
                  Background Remover
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/font-finder')} className="hover:text-indigo-600 cursor-pointer">
                  AI Font Finder
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/editor')} className="hover:text-indigo-600 cursor-pointer">
                  Vector Editor
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/batch')} className="hover:text-indigo-600 cursor-pointer">
                  Batch Processing
                </button>
              </li>
            </ul>
          </div>

          <div>
            <div className="text-xs font-semibold text-slate-900 mb-3">Account</div>
            <ul className="space-y-2 text-xs text-slate-600">
              <li>
                <button type="button" onClick={() => onNavigate('/dashboard')} className="hover:text-indigo-600 cursor-pointer">
                  Dashboard
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/settings')} className="hover:text-indigo-600 cursor-pointer">
                  User Settings
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/signin')} className="hover:text-indigo-600 cursor-pointer">
                  Sign In
                </button>
              </li>
            </ul>
          </div>

          <div>
            <div className="text-xs font-semibold text-slate-900 mb-3">Company & Legal</div>
            <ul className="space-y-2 text-xs text-slate-600">
              <li>
                <button type="button" onClick={() => onNavigate('/about')} className="hover:text-indigo-600 cursor-pointer">
                  About
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/contact')} className="hover:text-indigo-600 cursor-pointer">
                  Contact
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/privacy')} className="hover:text-indigo-600 cursor-pointer">
                  Privacy Policy
                </button>
              </li>
              <li>
                <button type="button" onClick={() => onNavigate('/terms')} className="hover:text-indigo-600 cursor-pointer">
                  Terms of Service
                </button>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <span>© {new Date().getFullYear()} MakeVectorizer. All rights reserved.</span>
          <span>From Pixels to Perfect Vectors.</span>
        </div>
      </div>
    </footer>
  );
};
