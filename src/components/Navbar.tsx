import React, { useState } from 'react';
import { Menu, X } from 'lucide-react';
import type { User } from 'firebase/auth';

export type AppRoute =
  | '/'
  | '/vectorizer'
  | '/upscaler'
  | '/background-remover'
  | '/font-finder'
  | '/editor'
  | '/batch'
  | '/dashboard'
  | '/signin'
  | '/signup'
  | '/settings'
  | '/about'
  | '/contact'
  | '/privacy'
  | '/terms';

interface NavbarProps {
  currentRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  user: User | null;
}

export const Navbar: React.FC<NavbarProps> = ({ currentRoute, onNavigate, user }) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks: Array<{ route: AppRoute; label: string }> = [
    { route: '/', label: 'Home' },
    { route: '/vectorizer', label: 'Vectorizer' },
    { route: '/upscaler', label: 'Upscaler' },
    { route: '/background-remover', label: 'BG Remover' },
    { route: '/font-finder', label: 'AI Font Finder' },
    { route: '/batch', label: 'Batch' },
  ];

  const go = (route: AppRoute) => {
    setMobileOpen(false);
    onNavigate(route);
  };

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Brand Wordmark */}
        <button
          type="button"
          onClick={() => go('/')}
          className="inline-flex items-center gap-2.5 text-lg font-extrabold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <svg
            width="26"
            height="26"
            viewBox="0 0 28 28"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <rect width="28" height="28" rx="7" fill="#4F46E5" />
            <path
              d="M7 20L12.5 8L17.5 16L21 10"
              stroke="#FFFFFF"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="12.5" cy="8" r="2" fill="#FFFFFF" />
            <circle cx="21" cy="10" r="2" fill="#FFFFFF" />
          </svg>
          <span>MakeVectorizer</span>
        </button>

        {/* Zone 2: Single-line Nav Links */}
        <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600">
          {navLinks.map((item) => {
            const active = currentRoute === item.route;
            return (
              <button
                key={item.route}
                type="button"
                onClick={() => go(item.route)}
                className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer py-1 border-b-2 ${
                  active
                    ? 'text-indigo-600 border-indigo-600 font-semibold'
                    : 'border-transparent hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Primary Action */}
        <div className="hidden lg:flex items-center gap-4 shrink-0">
          {user ? (
            <button
              type="button"
              onClick={() => go('/dashboard')}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Dashboard
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => go('/signin')}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => go('/vectorizer')}
                className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Get Started
              </button>
            </>
          )}
        </div>

        {/* Mobile Menu Toggle */}
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="lg:hidden p-2.5 rounded-lg text-slate-700 hover:bg-slate-100 cursor-pointer"
          aria-label="Toggle navigation menu"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="lg:hidden border-t border-slate-200 bg-white px-4 py-4 space-y-1">
          {navLinks.map((item) => (
            <button
              key={item.route}
              type="button"
              onClick={() => go(item.route)}
              className={`w-full text-left px-3 py-3 rounded-lg text-sm font-medium ${
                currentRoute === item.route
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => go('/editor')}
            className="w-full text-left px-3 py-3 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Vector Editor
          </button>
          <div className="pt-3 border-t border-slate-200 flex flex-col gap-2">
            {user ? (
              <button
                type="button"
                onClick={() => go('/dashboard')}
                className="w-full py-3 rounded-lg text-sm font-semibold text-white bg-indigo-600"
              >
                Dashboard
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => go('/signin')}
                  className="w-full py-3 rounded-lg text-sm font-medium text-slate-700 border border-slate-200"
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => go('/vectorizer')}
                  className="w-full py-3 rounded-lg text-sm font-semibold text-white bg-indigo-600"
                >
                  Get Started
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
