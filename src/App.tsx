import { useEffect, useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { ToastProvider } from './components/Toast';
import { HomePage } from './pages/HomePage';
import { VideoPreviewPage } from './pages/VideoPreviewPage';
import { AuthPages } from './pages/AuthPages';
import { DashboardShell } from './pages/DashboardShell';
import { DocsPage, StatusPage, UnlockPage } from './pages/UtilityPages';

function ShortSlugResolver({ slug }: { slug: string }) {
  const [status, setStatus] = useState<'loading' | 'preview' | 'not-found'>(() => {
    if (typeof window !== 'undefined') {
      const boot = window.__NASIRLINK_PREVIEW__;
      if (boot?.link && boot.link.slug.toLowerCase() === slug.toLowerCase()) {
        return boot.link.linkType === 'video' && boot.link.previewEnabled ? 'preview' : 'not-found';
      }
    }
    return 'loading';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const boot = window.__NASIRLINK_PREVIEW__;
      if (boot?.link && boot.link.slug.toLowerCase() === slug.toLowerCase()) {
        setStatus(boot.link.linkType === 'video' && boot.link.previewEnabled ? 'preview' : 'not-found');
        return;
      }
    }
    let active = true;
    setStatus('loading');
    fetch(`/api/preview/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (!active) return;
        if (!res.ok) {
          setStatus('not-found');
          return;
        }
        const data = await res.json();
        if (!active) return;
        if (data?.link?.linkType === 'video' && data.link.previewEnabled) {
          setStatus('preview');
        } else {
          setStatus('not-found');
        }
      })
      .catch(() => {
        if (active) setStatus('not-found');
      });
    return () => {
      active = false;
    };
  }, [slug]);

  if (status === 'loading') {
    return <div className="fixed inset-0 w-screen h-[100dvh] bg-black" />;
  }
  if (status === 'preview') {
    return <VideoPreviewPage slug={slug} />;
  }
  return <StatusPage state="not-found" />;
}

function RouterView() {
  const { pathname } = useApp();
  const clean = pathname.replace(/\/+$/, '') || '/';

  if (clean === '/') return <HomePage />;
  if (clean === '/dashboard') return <DashboardShell initialTab="overview" />;
  if (clean === '/links') return <DashboardShell initialTab="links" />;
  if (clean === '/video-links') return <DashboardShell initialTab="video-links" />;
  if (clean === '/analytics') return <DashboardShell initialTab="analytics" />;
  if (clean === '/metadata-debug') return <DashboardShell initialTab="metadata-debug" />;
  if (clean === '/qr-codes') return <DashboardShell initialTab="qr-codes" />;
  if (clean === '/settings') return <DashboardShell initialTab="settings" />;
  if (clean === '/admin') return <DashboardShell initialTab="admin" />;

  if (clean === '/login') return <AuthPages mode="login" />;
  if (clean === '/register') return <AuthPages mode="register" />;
  if (clean === '/forgot-password') return <AuthPages mode="forgot-password" />;
  if (clean === '/docs') return <DocsPage />;

  if (clean.startsWith('/v/')) {
    return <VideoPreviewPage slug={decodeURIComponent(clean.slice(3))} />;
  }
  if (clean.startsWith('/video/')) {
    return <VideoPreviewPage slug={decodeURIComponent(clean.slice(7))} />;
  }
  if (clean.startsWith('/s/')) {
    return <VideoPreviewPage slug={decodeURIComponent(clean.slice(3))} />;
  }
  if (clean.startsWith('/embed/')) {
    return <VideoPreviewPage slug={decodeURIComponent(clean.slice(7))} />;
  }
  if (clean.startsWith('/player/')) {
    return <VideoPreviewPage slug={decodeURIComponent(clean.slice(8))} />;
  }
  if (clean.startsWith('/unlock/')) {
    return <UnlockPage slug={decodeURIComponent(clean.slice(8))} />;
  }
  if (clean === '/status/disabled') return <StatusPage state="disabled" />;
  if (clean === '/status/expired') return <StatusPage state="expired" />;

  // Single-segment short slug fallback (/:slug)
  const singleSegmentMatch = clean.match(/^\/([^/]+)$/);
  if (singleSegmentMatch) {
    return <ShortSlugResolver slug={decodeURIComponent(singleSegmentMatch[1])} />;
  }

  return <StatusPage state="not-found" />;
}

export default function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <RouterView />
      </ToastProvider>
    </AppProvider>
  );
}
