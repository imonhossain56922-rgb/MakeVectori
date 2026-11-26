import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, verifyActiveAuthSession } from './lib/firebase.ts';
import { ensureUserProfile } from './lib/firestoreService.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Navbar, type AppRoute } from './components/Navbar.tsx';
import { Footer } from './components/Footer.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { VectorizerPage } from './pages/VectorizerPage.tsx';
import { UpscalerPage } from './pages/UpscalerPage.tsx';
import { BgRemoverPage } from './pages/BgRemoverPage.tsx';
import { FontFinderPage } from './pages/FontFinderPage.tsx';
import { EditorPage } from './pages/EditorPage.tsx';
import { BatchPage } from './pages/BatchPage.tsx';
import { AuthPage } from './pages/AuthPages.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import {
  AboutPage,
  ContactPage,
  PrivacyPage,
  TermsPage,
} from './pages/StaticPages.tsx';
import type { PendingFontDesign, UploadMetadata, VectorDocument } from './types/vector.ts';

const VALID_ROUTES: AppRoute[] = [
  '/',
  '/vectorizer',
  '/upscaler',
  '/background-remover',
  '/font-finder',
  '/editor',
  '/batch',
  '/dashboard',
  '/signin',
  '/signup',
  '/settings',
  '/about',
  '/contact',
  '/privacy',
  '/terms',
];

function parseRoute(pathname: string): AppRoute {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return VALID_ROUTES.includes(clean as AppRoute) ? (clean as AppRoute) : '/';
}

const ROUTE_TITLES: Record<AppRoute, string> = {
  '/': 'MakeVectorizer — AI Image to Vector Converter & 4X Image Upscaler',
  '/vectorizer': 'Image to Vector Converter — MakeVectorizer',
  '/upscaler': 'AI 4X Image Upscaler — MakeVectorizer',
  '/background-remover': 'Smart Background Remover — MakeVectorizer',
  '/font-finder': 'AI Font Finder & Live Comparison — MakeVectorizer',
  '/editor': 'Vector Editor — MakeVectorizer',
  '/batch': 'Batch Processing — MakeVectorizer',
  '/dashboard': 'Dashboard — MakeVectorizer',
  '/signin': 'Sign In — MakeVectorizer',
  '/signup': 'Sign Up — MakeVectorizer',
  '/settings': 'User Settings — MakeVectorizer',
  '/about': 'About — MakeVectorizer',
  '/contact': 'Contact — MakeVectorizer',
  '/privacy': 'Privacy Policy — MakeVectorizer',
  '/terms': 'Terms of Service — MakeVectorizer',
};

export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [user, setUser] = useState<User | null>(null);
  const [activeUpload, setActiveUpload] = useState<UploadMetadata | null>(null);
  const [activeVectorDoc, setActiveVectorDoc] = useState<VectorDocument | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [pendingFontDesign, setPendingFontDesign] = useState<PendingFontDesign | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    document.title = ROUTE_TITLES[route] || ROUTE_TITLES['/'];
  }, [route]);

  useEffect(() => {
    const checkSession = async (targetUser: User | null) => {
      if (!targetUser) return;
      const { revoked } = await verifyActiveAuthSession(targetUser);
      if (revoked) {
        setSessionNotice(
          'Your session ended because your Google or account password changed. Please sign in again.'
        );
      }
    };

    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        setSessionNotice(null);
        if (u.emailVerified) {
          ensureUserProfile(u).catch(() => {});
        }
        checkSession(u);
      }
    });

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible' && auth.currentUser) {
        checkSession(auth.currentUser);
      }
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    const interval = window.setInterval(() => {
      if (auth.currentUser) {
        checkSession(auth.currentUser);
      }
    }, 120_000);

    return () => {
      unsub();
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      window.clearInterval(interval);
    };
  }, []);

  const navigate = (nextRoute: AppRoute) => {
    if (window.location.pathname !== nextRoute) {
      window.history.pushState({}, '', nextRoute);
    }
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderPage = () => {
    switch (route) {
      case '/':
        return (
          <HomePage
            onNavigate={navigate}
            onStartWithUpload={(meta, target) => {
              setActiveUpload(meta);
              setActiveVectorDoc(null);
              setActiveProjectId(undefined);
              navigate(target);
            }}
          />
        );
      case '/vectorizer':
        return (
          <VectorizerPage
            activeUpload={activeUpload}
            onSetUpload={setActiveUpload}
            activeVectorDoc={activeVectorDoc}
            onSetVectorDoc={(doc, pid) => {
              setActiveVectorDoc(doc);
              setActiveProjectId(pid);
            }}
            activeProjectId={activeProjectId}
            onNavigate={navigate}
          />
        );
      case '/upscaler':
        return (
          <UpscalerPage
            activeUpload={activeUpload}
            onSetUpload={setActiveUpload}
            onSendToVectorizer={(meta) => {
              setActiveUpload(meta);
              setActiveVectorDoc(null);
              navigate('/vectorizer');
            }}
            onNavigate={navigate}
          />
        );
      case '/background-remover':
        return (
          <BgRemoverPage
            activeUpload={activeUpload}
            onSetUpload={setActiveUpload}
            onSendToVectorizer={(meta) => {
              setActiveUpload(meta);
              setActiveVectorDoc(null);
              navigate('/vectorizer');
            }}
            onNavigate={navigate}
          />
        );
      case '/font-finder':
        return (
          <FontFinderPage
            activeUpload={activeUpload}
            onSetUpload={setActiveUpload}
            onUseFontInDesign={(design) => {
              setPendingFontDesign(design);
              navigate('/editor');
            }}
          />
        );
      case '/editor':
        return (
          <EditorPage
            activeVectorDoc={activeVectorDoc}
            activeUpload={activeUpload}
            activeProjectId={activeProjectId}
            pendingFontDesign={pendingFontDesign}
            onSetVectorDoc={(doc, pid) => {
              setActiveVectorDoc(doc);
              setActiveProjectId(pid);
            }}
            onNavigate={navigate}
          />
        );
      case '/batch':
        return <BatchPage />;
      case '/dashboard':
        return (
          <DashboardPage
            user={user}
            onNavigate={navigate}
            onOpenVectorProject={(doc, pid) => {
              setActiveVectorDoc(doc);
              setActiveProjectId(pid);
            }}
          />
        );
      case '/signin':
        return <AuthPage mode="signin" onNavigate={navigate} />;
      case '/signup':
        return <AuthPage mode="signup" onNavigate={navigate} />;
      case '/settings':
        return <SettingsPage user={user} onNavigate={navigate} />;
      case '/about':
        return <AboutPage />;
      case '/contact':
        return <ContactPage />;
      case '/privacy':
        return <PrivacyPage />;
      case '/terms':
        return <TermsPage />;
    }
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-white text-slate-900">
        <Navbar currentRoute={route} onNavigate={navigate} user={user} />
        {sessionNotice && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 text-xs text-amber-900 flex items-center justify-center gap-3">
            <span>{sessionNotice}</span>
            <button
              type="button"
              onClick={() => {
                setSessionNotice(null);
                navigate('/signin');
              }}
              className="font-semibold text-indigo-700 hover:text-indigo-900 underline cursor-pointer"
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setSessionNotice(null)}
              className="text-amber-700 hover:text-amber-950 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}
        <main className="flex-1">{renderPage()}</main>
        <Footer onNavigate={navigate} />
      </div>
    </ErrorBoundary>
  );
}
