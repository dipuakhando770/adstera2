import React, { useEffect, useState } from 'react';
import { CheckCircle2, Menu, ShieldCheck } from 'lucide-react';
import type { LinkRecord } from '../shared/types';
import { useApp } from '../context/AppContext';
import { useToast } from '../components/Toast';
import { Sidebar, type DashboardTab } from '../components/Sidebar';
import { LinkForm } from '../components/LinkForm';
import { VideoLinkForm } from '../components/VideoLinkForm';
import { LinkTable } from '../components/LinkTable';
import { AnalyticsDashboard } from '../components/AnalyticsDashboard';
import { MetadataDebugger } from '../components/MetadataDebugger';
import { QRCodeGenerator } from '../components/QRCodeGenerator';
import { AdminPanel } from '../components/AdminPanel';

export function DashboardShell({ initialTab }: { initialTab: DashboardTab }) {
  const { user, navigate, publicSettings, refreshAuth } = useApp();
  const { notify } = useToast();

  const [activeTab, setActiveTab] = useState<DashboardTab>(initialTab);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [allLinks, setAllLinks] = useState<LinkRecord[]>([]);
  const [debugSlug, setDebugSlug] = useState('');
  const [verifyToken, setVerifyToken] = useState('');

  useEffect(() => {
    setActiveTab(initialTab);
    if (typeof window !== 'undefined') {
      const slugParam = new URLSearchParams(window.location.search).get('slug');
      if (slugParam) setDebugSlug(slugParam);
    }
  }, [initialTab]);

  useEffect(() => {
    fetch('/api/links?pageSize=50', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setAllLinks(d.links || []))
      .catch(() => {});
  }, [refreshCounter]);

  useEffect(() => {
    const bump = () => setRefreshCounter((c) => c + 1);
    window.addEventListener('nasirlink:data-changed', bump);
    window.addEventListener('focus', bump);
    const interval = setInterval(bump, 15000);
    return () => {
      window.removeEventListener('nasirlink:data-changed', bump);
      window.removeEventListener('focus', bump);
      clearInterval(interval);
    };
  }, []);

  const handleSelectTab = (tab: DashboardTab) => {
    setActiveTab(tab);
    const routeMap: Record<DashboardTab, string> = {
      overview: '/dashboard',
      links: '/links',
      'video-links': '/video-links',
      analytics: '/analytics',
      'metadata-debug': '/metadata-debug',
      'qr-codes': '/qr-codes',
      settings: '/settings',
      admin: '/admin',
    };
    navigate(routeMap[tab]);
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    });
    const data = await res.json();
    if (res.ok) {
      await refreshAuth();
      notify('Email address verified', 'success');
      setVerifyToken('');
    } else {
      notify(data.error || 'Verification failed', 'error');
    }
  };

  const tabTitles: Record<DashboardTab, string> = {
    overview: 'Workspace Overview',
    links: 'Link Management',
    'video-links': 'Video Preview Links',
    analytics: 'Analytics & Telemetry',
    'metadata-debug': 'Metadata Preview & X Card Debugger',
    'qr-codes': 'QR Code Studio',
    settings: 'Account & Domain Settings',
    admin: 'Admin Control Center',
  };

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar inside Dashboard */}
        <header className="h-16 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              aria-label="Open sidebar menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="text-xs text-slate-400 truncate">
                {publicSettings.siteName} / {tabTitles[activeTab]}
              </div>
              <h1 className="font-display text-base sm:text-lg font-bold text-slate-900 dark:text-white truncate">
                {tabTitles[activeTab]}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {!user && (
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold whitespace-nowrap"
              >
                Sign In
              </button>
            )}
            {user && (
              <button
                type="button"
                onClick={() => handleSelectTab('links')}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold whitespace-nowrap"
              >
                Manage Links
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-7xl w-full mx-auto space-y-8">
          {activeTab === 'overview' && (
            <div className="space-y-8">
              <AnalyticsDashboard links={allLinks} />
              <div className="space-y-3">
                <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                  Quick Create Short Link
                </h2>
                <LinkForm onSuccess={() => setRefreshCounter((c) => c + 1)} />
              </div>
            </div>
          )}

          {activeTab === 'links' && (
            <div className="space-y-6">
              <LinkForm onSuccess={() => setRefreshCounter((c) => c + 1)} />
              <LinkTable
                refreshTrigger={refreshCounter}
                onOpenMetadataDebug={(slug) => {
                  setDebugSlug(slug);
                  handleSelectTab('metadata-debug');
                }}
              />
            </div>
          )}

          {activeTab === 'video-links' && (
            <div className="space-y-6">
              <VideoLinkForm onSuccess={() => setRefreshCounter((c) => c + 1)} />
              <LinkTable
                fixedType="video"
                refreshTrigger={refreshCounter}
                onOpenMetadataDebug={(slug) => {
                  setDebugSlug(slug);
                  handleSelectTab('metadata-debug');
                }}
              />
            </div>
          )}

          {activeTab === 'analytics' && <AnalyticsDashboard links={allLinks} />}

          {activeTab === 'metadata-debug' && (
            <MetadataDebugger
              initialSlug={debugSlug}
              videoLinks={allLinks.filter((l) => l.linkType === 'video')}
            />
          )}

          {activeTab === 'qr-codes' && <QRCodeGenerator links={allLinks} />}

          {activeTab === 'settings' && (
            <div className="max-w-2xl space-y-6">
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                  Account & Verification
                </h2>
                {user ? (
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-slate-500">Name</span>
                      <span className="font-medium">{user.name}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-slate-500">Email</span>
                      <span className="font-mono">{user.email}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-slate-500">Role</span>
                      <span className="inline-flex items-center gap-1 font-medium capitalize">
                        <ShieldCheck className="w-4 h-4 text-indigo-600" />
                        {user.role}
                      </span>
                    </div>
                    <div className="flex justify-between py-2">
                      <span className="text-slate-500">Email Verification</span>
                      {user.emailVerified ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                          <CheckCircle2 className="w-4 h-4" /> Verified
                        </span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          Pending Verification
                        </span>
                      )}
                    </div>

                    {!user.emailVerified && (
                      <form onSubmit={handleVerifyEmail} className="pt-3 flex gap-2">
                        <input
                          type="text"
                          required
                          value={verifyToken}
                          onChange={(e) => setVerifyToken(e.target.value)}
                          placeholder="Paste verification token..."
                          className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono"
                        />
                        <button
                          type="submit"
                          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold"
                        >
                          Verify
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      You are browsing as a guest. Sign in to bind created links to your personal account and verify your email.
                    </p>
                    <button
                      type="button"
                      onClick={() => navigate('/login')}
                      className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold"
                    >
                      Sign In
                    </button>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-2">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Active Platform Domain Configuration
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Configured domain: <span className="font-mono text-slate-800 dark:text-slate-200">{publicSettings.domain}</span> · Default redirect: <span className="font-mono">HTTP {publicSettings.defaultRedirectType}</span>
                </p>
              </div>
            </div>
          )}

          {activeTab === 'admin' && <AdminPanel />}
        </main>
      </div>
    </div>
  );
}
