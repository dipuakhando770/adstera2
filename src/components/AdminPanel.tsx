import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  ExternalLink,
  PauseCircle,
  Pencil,
  PlayCircle,
  PlaySquare,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  Video,
} from 'lucide-react';
import type {
  AbuseReport,
  AdminStats,
  LinkRecord,
  PublicUser,
  SocialMetadataPreview,
  SystemSettings,
  VideoStreamAudit,
} from '../shared/types';
import { useApp } from '../context/AppContext';
import { useToast } from './Toast';
import { StatCard } from './StatCard';
import { BarChart, ChartCard } from './ChartCard';
import { Search } from './Search';
import { Modal } from './Modal';

function formatSourcePreview(url: string | null | undefined, fallbackDomain: string): string {
  const raw = (url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) {
    return fallbackDomain.replace(/^https?:\/\//i, '').split('/')[0] || 'nasirlink.com';
  }
  try {
    const parsed = new URL(raw);
    return parsed.hostname;
  } catch {
    return '';
  }
}

export function AdminPanel() {
  const { user, navigate, refreshPublicSettings } = useApp();
  const { notify } = useToast();

  const [tab, setTab] = useState<'overview' | 'video-previews' | 'users' | 'links' | 'reports' | 'settings'>('overview');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [allLinks, setAllLinks] = useState<LinkRecord[]>([]);
  const [linkSearch, setLinkSearch] = useState('');
  const [videoFilter, setVideoFilter] = useState<'all' | 'enabled' | 'disabled' | 'warnings'>('all');
  const [reports, setReports] = useState<AbuseReport[]>([]);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [probingGlobalVideo, setProbingGlobalVideo] = useState(false);
  const [globalProbeSummary, setGlobalProbeSummary] = useState<string>('');

  // Admin Video Preview Edit & Metadata Inspection Modals
  const [editingVideoLink, setEditingVideoLink] = useState<LinkRecord | null>(null);
  const [editVideoUrl, setEditVideoUrl] = useState('');
  const [editThumbUrl, setEditThumbUrl] = useState('');
  const [editCardType, setEditCardType] = useState<'player' | 'summary_large_image'>('player');
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editWidth, setEditWidth] = useState(0);
  const [editHeight, setEditHeight] = useState(0);
  const [editCountdown, setEditCountdown] = useState(0);
  const [editPreviewEnabled, setEditPreviewEnabled] = useState(true);
  const [savingVideoEdit, setSavingVideoEdit] = useState(false);

  const [inspectedSlug, setInspectedSlug] = useState<string | null>(null);
  const [inspectedMeta, setInspectedMeta] = useState<SocialMetadataPreview | null>(null);
  const [inspectedAudit, setInspectedAudit] = useState<VideoStreamAudit | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    const [stRes, rpRes] = await Promise.all([
      fetch('/api/admin/stats', { credentials: 'include' }),
      fetch('/api/admin/reports', { credentials: 'include' }),
    ]);
    if (stRes.ok) setStats(await stRes.json());
    if (rpRes.ok) {
      const data = await rpRes.json();
      setReports(data.reports || []);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    const res = await fetch(`/api/admin/users?q=${encodeURIComponent(userSearch)}`, {
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users || []);
    }
  }, [userSearch]);

  const loadAllLinks = useCallback(async () => {
    const res = await fetch(`/api/admin/links?q=${encodeURIComponent(linkSearch)}`, {
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      setAllLinks(data.links || []);
    }
  }, [linkSearch]);

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/admin/settings', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      setSettings(data.settings);
    }
  }, []);

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    loadOverview();
    loadUsers();
    loadAllLinks();
    loadSettings();
  }, [user, loadOverview, loadUsers, loadAllLinks, loadSettings]);

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    const refreshAdmin = () => {
      loadOverview();
      loadUsers();
      loadAllLinks();
    };
    window.addEventListener('nasirlink:data-changed', refreshAdmin);
    window.addEventListener('focus', refreshAdmin);
    return () => {
      window.removeEventListener('nasirlink:data-changed', refreshAdmin);
      window.removeEventListener('focus', refreshAdmin);
    };
  }, [user, loadOverview, loadUsers, loadAllLinks]);

  if (!user || user.role !== 'admin') {
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center max-w-lg mx-auto my-8 space-y-4">
        <ShieldAlert className="w-10 h-10 text-amber-500 mx-auto" />
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
          Administrator Access Required
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Sign in with an administrator account (such as <code className="font-mono">admin@nasirlink.com</code>) to manage platform users, link moderation, abuse reports, and system settings.
        </p>
        <button
          type="button"
          onClick={() => navigate('/login')}
          className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
        >
          Go to Sign In
        </button>
      </div>
    );
  }

  const updateUser = async (id: string, patch: { role?: 'user' | 'admin'; status?: 'active' | 'suspended' }) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) notify(data.error || 'Failed to update user', 'error');
    else {
      notify('User updated', 'success');
      loadUsers();
      loadOverview();
    }
  };

  const deleteUser = async (id: string) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) notify(data.error || 'Failed to delete user', 'error');
    else {
      notify('User deleted', 'success');
      loadUsers();
      loadOverview();
    }
  };

  const toggleAdminLink = async (link: LinkRecord) => {
    const res = await fetch(`/api/admin/links/${link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isActive: !link.isActive }),
    });
    if (res.ok) {
      notify(link.isActive ? 'Link disabled by moderator' : 'Link re-enabled', 'success');
      window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
      loadAllLinks();
    }
  };

  const deleteAdminLink = async (id: string) => {
    const res = await fetch(`/api/admin/links/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (res.ok) {
      notify('Link permanently deleted', 'success');
      window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
      loadAllLinks();
      loadOverview();
    }
  };

  const handleReportStatus = async (id: string, status: AbuseReport['status']) => {
    const res = await fetch(`/api/admin/reports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      notify(
        status === 'actioned' ? 'Report actioned and target link disabled' : `Report marked ${status}`,
        'success'
      );
      window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
      loadOverview();
      loadAllLinks();
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSavingSettings(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings(data.settings);
        refreshPublicSettings();
        window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
        notify('System settings & Global X Player configuration saved', 'success');
      } else {
        notify(data.error || 'Failed to update system settings', 'error');
      }
    } finally {
      setSavingSettings(false);
    }
  };

  const handleProbeGlobalVideo = async () => {
    if (!settings?.globalVideoUrl?.trim()) return;
    setProbingGlobalVideo(true);
    setGlobalProbeSummary('');
    try {
      const res = await fetch('/api/links/validate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: settings.globalVideoUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGlobalProbeSummary(data.error || 'Validation failed.');
        notify(data.error || 'Global video validation failed', 'error');
        return;
      }
      const audit: VideoStreamAudit | undefined = data.audit;
      const nextWidth = audit?.detectedWidth || settings.globalVideoWidth || null;
      const nextHeight = audit?.detectedHeight || settings.globalVideoHeight || null;
      const nextMime = data.mimeType || settings.globalVideoMimeType || 'video/mp4';

      setSettings((prev) =>
        prev
          ? {
              ...prev,
              globalVideoUrl: data.normalizedUrl || prev.globalVideoUrl,
              globalVideoWidth: nextWidth,
              globalVideoHeight: nextHeight,
              globalVideoMimeType: nextMime,
            }
          : prev
      );

      const parts = [
        nextMime,
        audit?.codec ? `codec: ${audit.codec}` : '',
        nextWidth && nextHeight ? `${nextWidth}×${nextHeight}` : 'dimensions pending',
        audit?.rangeSupported ? 'Range 206 OK' : 'Range N/A',
      ].filter(Boolean);
      setGlobalProbeSummary(parts.join(' · '));
      notify(
        nextWidth && nextHeight
          ? `Detected ${nextWidth}×${nextHeight} (${nextMime})`
          : 'Global video URL validated',
        'success'
      );
    } catch {
      notify('Network error while probing global video', 'error');
    } finally {
      setProbingGlobalVideo(false);
    }
  };

  const getVideoWarnings = (l: LinkRecord): string[] => {
    const warnings: string[] = [];
    if (!l.videoUrl) warnings.push('Missing video URL');
    else if (!l.videoUrl.startsWith('https://') && !l.videoUrl.startsWith('/')) {
      warnings.push('Video URL is not HTTPS');
    }
    if (!l.videoWidth || !l.videoHeight) warnings.push('Missing container dimensions');
    if (!l.isActive) warnings.push('Link disabled');
    return warnings;
  };

  const toggleVideoPreviewEnabled = async (link: LinkRecord) => {
    const res = await fetch(`/api/admin/links/${link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ previewEnabled: !link.previewEnabled }),
    });
    if (res.ok) {
      notify(!link.previewEnabled ? 'Video preview enabled' : 'Video preview disabled (reverted to direct redirect)', 'success');
      window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
      loadAllLinks();
    } else {
      const err = await res.json();
      notify(err.error || 'Could not toggle video preview', 'error');
    }
  };

  const openVideoEditor = (link: LinkRecord) => {
    setEditingVideoLink(link);
    setEditVideoUrl(link.videoUrl || '');
    setEditThumbUrl(link.thumbnailUrl || '');
    setEditCardType(link.twitterCardType || 'player');
    setEditTitle(link.videoTitle || '');
    setEditDesc(link.videoDescription || '');
    setEditWidth(link.videoWidth || 0);
    setEditHeight(link.videoHeight || 0);
    setEditCountdown(link.autoRedirectSeconds || 0);
    setEditPreviewEnabled(link.previewEnabled);
  };

  const handleSaveVideoEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVideoLink) return;
    setSavingVideoEdit(true);
    try {
      const res = await fetch(`/api/admin/links/${editingVideoLink.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          previewEnabled: editPreviewEnabled,
          autoRedirectSeconds: Number(editCountdown) || 0,
          videoUrl: editVideoUrl.trim() || null,
          thumbnailUrl: editThumbUrl.trim() || null,
          videoTitle: editTitle.trim() || null,
          videoDescription: editDesc.trim() || null,
          videoWidth: editWidth > 0 ? Number(editWidth) : null,
          videoHeight: editHeight > 0 ? Number(editHeight) : null,
          twitterCardType: editCardType,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || 'Could not update video preview settings', 'error');
      } else {
        notify('Video preview updated', 'success');
        setEditingVideoLink(null);
        window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
        loadAllLinks();
      }
    } finally {
      setSavingVideoEdit(false);
    }
  };

  const openInspectMetadata = async (slug: string) => {
    setInspectedSlug(slug);
    setInspectedMeta(null);
    setInspectedAudit(null);
    setInspectLoading(true);
    try {
      const res = await fetch(`/api/preview/${encodeURIComponent(slug)}?audit=1`);
      if (res.ok) {
        const data = await res.json();
        setInspectedMeta(data.metadata);
        setInspectedAudit(data.audit || null);
      }
    } finally {
      setInspectLoading(false);
    }
  };

  const videoLinks = allLinks.filter((l) => l.linkType === 'video' || Boolean(l.videoUrl));
  const filteredVideoLinks = videoLinks.filter((l) => {
    if (videoFilter === 'enabled' && !l.previewEnabled) return false;
    if (videoFilter === 'disabled' && l.previewEnabled) return false;
    if (videoFilter === 'warnings' && getVideoWarnings(l).length === 0) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            Platform Administration
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            User governance, video preview diagnostics, link moderation, abuse review, and runtime configuration.
          </p>
        </div>

        <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          {(
            [
              { id: 'overview', label: 'Stats' },
              { id: 'video-previews', label: `Video Previews (${videoLinks.length})` },
              { id: 'users', label: `Users (${users.length})` },
              { id: 'links', label: `Moderation (${allLinks.length})` },
              { id: 'reports', label: `Reports (${reports.filter((r) => r.status === 'pending').length})` },
              { id: 'settings', label: 'System Settings' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                tab === item.id
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Video Previews Management Tab */}
      {tab === 'video-previews' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <Search
              value={linkSearch}
              onChange={setLinkSearch}
              placeholder="Search video links by slug or destination..."
            />

            <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'enabled', label: 'Enabled' },
                  { id: 'disabled', label: 'Disabled' },
                  { id: 'warnings', label: 'Warnings' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setVideoFilter(f.id)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                    videoFilter === f.id
                      ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 pr-4">Short URL</th>
                  <th className="py-3 px-4">Video & Card</th>
                  <th className="py-3 px-4">Diagnostics</th>
                  <th className="py-3 px-4">Preview</th>
                  <th className="py-3 pl-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredVideoLinks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                      No video preview links match this filter.
                    </td>
                  </tr>
                ) : (
                  filteredVideoLinks.map((l) => {
                    const warnings = getVideoWarnings(l);
                    return (
                      <tr key={l.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                        <td className="py-3.5 pr-4 whitespace-nowrap">
                          <div className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                            /{l.slug}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 max-w-[180px] truncate mt-0.5">
                            {l.destinationUrl}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 max-w-[240px]">
                          <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                            {l.videoTitle || `Video Preview: ${l.slug}`}
                          </div>
                          <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                            {l.twitterCardType} · {l.videoWidth > 0 && l.videoHeight > 0 ? `${l.videoWidth}×${l.videoHeight}` : 'Auto aspect'}
                            {l.autoRedirectSeconds > 0 ? ` · ${l.autoRedirectSeconds}s timer` : ''}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-xs">
                          {warnings.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              {warnings.join(' · ')}
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap text-xs">
                          <span className={l.previewEnabled ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-500 font-medium'}>
                            {l.previewEnabled ? 'Preview ON' : 'Preview OFF'}
                          </span>
                          {' · '}
                          <span className={l.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                            {l.isActive ? 'Active' : 'Disabled'}
                          </span>
                        </td>
                        <td className="py-3.5 pl-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openInspectMetadata(l.slug)}
                              title="Inspect Metadata & Live Audit"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Code2 className="w-4 h-4" />
                            </button>
                            <a
                              href={`/s/${encodeURIComponent(l.slug)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open Social Share Page (/s/:slug)"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                            <a
                              href={`/embed/${encodeURIComponent(l.slug)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Test /embed Page"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <PlaySquare className="w-4 h-4" />
                            </a>
                            <button
                              type="button"
                              onClick={() => openVideoEditor(l)}
                              title="Edit Video Preview Fields"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleVideoPreviewEnabled(l)}
                              title={l.previewEnabled ? 'Disable video preview (direct redirect)' : 'Enable video preview'}
                              className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                            >
                              {l.previewEnabled ? 'Disable Preview' : 'Enable Preview'}
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleAdminLink(l)}
                              title={l.isActive ? 'Disable invalid/unsafe link' : 'Re-enable link'}
                              className="p-1.5 rounded-lg text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              {l.isActive ? <PauseCircle className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Overview Tab */}
      {tab === 'overview' && stats && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard label="Total Users" value={stats.totalUsers} accent="indigo" />
            <StatCard label="Active Users" value={stats.activeUsers} accent="emerald" />
            <StatCard label="Total Links" value={stats.totalLinks} accent="indigo" />
            <StatCard label="Video Links" value={stats.totalVideoLinks} accent="violet" />
            <StatCard label="Total Clicks" value={stats.totalClicks} accent="cyan" />
            <StatCard label="Pending Reports" value={stats.pendingReports} accent="violet" />
          </div>

          <ChartCard title="Daily User Registrations" subtitle="Account signups by UTC date">
            <BarChart
              color="#4F46E5"
              data={stats.dailyRegistrations.map((d) => ({ label: d.date, value: d.count }))}
            />
          </ChartCard>
        </div>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <Search
            value={userSearch}
            onChange={setUserSearch}
            placeholder="Search users by name or email..."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 pr-4">User</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Joined</th>
                  <th className="py-3 pl-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="py-3 pr-4">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{u.name}</div>
                      <div className="text-xs text-slate-500 font-mono">{u.email}</div>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={u.role}
                        onChange={(e) =>
                          updateUser(u.id, { role: e.target.value === 'admin' ? 'admin' : 'user' })
                        }
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1 text-xs"
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {u.status === 'active' ? (
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Active
                        </span>
                      ) : (
                        <span className="text-rose-600 dark:text-rose-400 font-medium">Suspended</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-500">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-3 pl-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            updateUser(u.id, {
                              status: u.status === 'active' ? 'suspended' : 'active',
                            })
                          }
                          title={u.status === 'active' ? 'Suspend user' : 'Activate user'}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-amber-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {u.status === 'active' ? (
                            <UserX className="w-4 h-4" />
                          ) : (
                            <UserCheck className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteUser(u.id)}
                          title="Delete user"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Link Moderation Tab */}
      {tab === 'links' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <Search
            value={linkSearch}
            onChange={setLinkSearch}
            placeholder="Filter all platform links by slug or destination..."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 pr-4">Short Slug</th>
                  <th className="py-3 px-4">Destination</th>
                  <th className="py-3 px-4 text-right">Clicks</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 pl-4 text-right">Moderate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {allLinks.map((l) => (
                  <tr key={l.id}>
                    <td className="py-3 pr-4 font-mono text-xs text-indigo-600 dark:text-indigo-400">
                      /{l.slug}
                    </td>
                    <td className="py-3 px-4 max-w-xs truncate font-mono text-xs text-slate-600 dark:text-slate-300">
                      {l.destinationUrl}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {l.clicksCount.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {l.isActive ? (
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">Active</span>
                      ) : (
                        <span className="text-rose-600 dark:text-rose-400 font-medium">Disabled</span>
                      )}
                    </td>
                    <td className="py-3 pl-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <a
                          href={`/${l.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => toggleAdminLink(l)}
                          title={l.isActive ? 'Disable suspicious link' : 'Re-enable link'}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-amber-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {l.isActive ? (
                            <PauseCircle className="w-4 h-4" />
                          ) : (
                            <PlayCircle className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteAdminLink(l.id)}
                          title="Delete malicious link"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Reports Tab */}
      {tab === 'reports' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          {reports.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">No abuse reports submitted.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {reports.map((r) => (
                <div
                  key={r.id}
                  className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="text-xs font-mono text-indigo-600 dark:text-indigo-400">
                      /{r.slug} · {r.reason} · {r.status}
                    </div>
                    {r.details && (
                      <p className="text-sm text-slate-700 dark:text-slate-300">{r.details}</p>
                    )}
                    <div className="text-xs text-slate-400 font-mono">
                      {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleReportStatus(r.id, 'dismissed')}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReportStatus(r.id, 'actioned')}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-xs font-semibold text-white"
                    >
                      Disable Target Link
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* System Settings Tab */}
      {tab === 'settings' && settings && (
        <form
          onSubmit={handleSaveSettings}
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5 max-w-3xl"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Site Name
              </label>
              <input
                type="text"
                value={settings.siteName}
                onChange={(e) => setSettings({ ...settings, siteName: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Configurable Custom Domain
              </label>
              <input
                type="text"
                value={settings.domain}
                onChange={(e) => setSettings({ ...settings, domain: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Default Redirect Type
              </label>
              <select
                value={settings.defaultRedirectType}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    defaultRedirectType: Number(e.target.value) === 301 ? 301 : 302,
                  })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value={302}>302 Temporary</option>
                <option value={301}>301 Permanent</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Max Links Per User
              </label>
              <input
                type="number"
                min={1}
                value={settings.maxLinksPerUser}
                onChange={(e) =>
                  setSettings({ ...settings, maxLinksPerUser: Number(e.target.value) || 100 })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                API Rate Limit (requests / minute)
              </label>
              <input
                type="number"
                min={10}
                value={settings.rateLimitPerMin}
                onChange={(e) =>
                  setSettings({ ...settings, rateLimitPerMin: Number(e.target.value) || 60 })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-6 pt-2 border-t border-slate-100 dark:border-slate-800">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.registrationEnabled}
                onChange={(e) =>
                  setSettings({ ...settings, registrationEnabled: e.target.checked })
                }
              />
              <span>Public User Registration Enabled</span>
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.maintenanceMode}
                onChange={(e) =>
                  setSettings({ ...settings, maintenanceMode: e.target.checked })
                }
              />
              <span>Maintenance Mode (block new link creation)</span>
            </label>
          </div>

          {/* Global X Player Video Configuration */}
          <div className="pt-5 border-t border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Video className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  Global X Player Video Configuration
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Configure a global video stream and source attribution for <code className="font-mono">/s/:slug</code> &amp; <code className="font-mono">/embed/:slug</code>. Original aspect ratio is read from the container headers.
                </p>
              </div>
              {settings.globalVideoWidth && settings.globalVideoHeight ? (
                <span className="text-xs font-mono px-2.5 py-1 rounded-md bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-900">
                  {settings.globalVideoWidth}×{settings.globalVideoHeight}{' '}
                  {settings.globalVideoHeight > settings.globalVideoWidth
                    ? 'Portrait'
                    : settings.globalVideoWidth === settings.globalVideoHeight
                      ? 'Square'
                      : 'Landscape'}
                </span>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Global HTTPS Video URL (MP4 / WebM)
              </label>
              <div className="flex flex-wrap sm:flex-nowrap gap-2">
                <input
                  type="text"
                  value={settings.globalVideoUrl || ''}
                  onChange={(e) =>
                    setSettings({ ...settings, globalVideoUrl: e.target.value || null })
                  }
                  placeholder="https://cdn.example.com/clip.mp4 or /api/sample-video/showcase.mp4"
                  className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={handleProbeGlobalVideo}
                  disabled={probingGlobalVideo || !settings.globalVideoUrl?.trim()}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {probingGlobalVideo ? 'Probing...' : 'Validate & Read Dimensions'}
                </button>
              </div>
              {globalProbeSummary && (
                <p className="mt-1 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                  {globalProbeSummary}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Video Width (px)
                </label>
                <input
                  type="number"
                  min={160}
                  max={3840}
                  value={settings.globalVideoWidth ?? ''}
                  placeholder="Auto-detect"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      globalVideoWidth: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Video Height (px)
                </label>
                <input
                  type="number"
                  min={90}
                  max={3840}
                  value={settings.globalVideoHeight ?? ''}
                  placeholder="Auto-detect"
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      globalVideoHeight: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Stream MIME Type
                </label>
                <select
                  value={settings.globalVideoMimeType || 'video/mp4'}
                  onChange={(e) =>
                    setSettings({ ...settings, globalVideoMimeType: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                >
                  <option value="video/mp4">video/mp4</option>
                  <option value="video/webm">video/webm</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Source Attribution URL (HTTPS link shown underneath embed as &ldquo;From domain&rdquo;)
              </label>
              <input
                type="url"
                value={settings.globalVideoSourceUrl || ''}
                onChange={(e) =>
                  setSettings({ ...settings, globalVideoSourceUrl: e.target.value || null })
                }
                placeholder="https://imgbb.space/example (defaults to sanitized video stream host)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
              {(() => {
                const domain = formatSourcePreview(
                  settings.globalVideoSourceUrl || settings.globalVideoUrl,
                  settings.domain
                );
                return domain ? (
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    Rendered attribution label: <code className="font-mono text-indigo-600 dark:text-indigo-400">From {domain}</code> (credentials &amp; signed query tokens automatically stripped).
                  </p>
                ) : null;
              })()}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Global Video Title (optional)
                </label>
                <input
                  type="text"
                  value={settings.globalVideoTitle || ''}
                  onChange={(e) =>
                    setSettings({ ...settings, globalVideoTitle: e.target.value || null })
                  }
                  placeholder="Overrides link title when Global Override is enabled"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Global Video Description (optional)
                </label>
                <input
                  type="text"
                  value={settings.globalVideoDescription || ''}
                  onChange={(e) =>
                    setSettings({ ...settings, globalVideoDescription: e.target.value || null })
                  }
                  placeholder="Concise description for twitter:description"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings.globalVideoOverride)}
                onChange={(e) =>
                  setSettings({ ...settings, globalVideoOverride: e.target.checked })
                }
              />
              <span>Override all shared video previews with Global Video</span>
            </label>

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3.5 py-2.5 text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
              Platform note: X (Twitter) inline Player Card rendering requires the sharing domain to be allowlisted with X Player Card support, reachable over public HTTPS by X crawlers, and paired with a valid <code className="font-mono">video/mp4</code> stream supporting HTTP <code className="font-mono">206</code> Byte-Range requests.
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingSettings}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 px-5 py-2.5 text-xs font-semibold text-white"
            >
              {savingSettings ? 'Saving...' : 'Save System Settings'}
            </button>
          </div>
        </form>
      )}

      {/* Admin Edit Video Preview Modal */}
      <Modal
        open={Boolean(editingVideoLink)}
        onClose={() => setEditingVideoLink(null)}
        title={editingVideoLink ? `Edit Video Preview — /${editingVideoLink.slug}` : 'Edit Video Preview'}
        subtitle={editingVideoLink?.destinationUrl}
        maxWidth="xl"
      >
        {editingVideoLink && (
          <form onSubmit={handleSaveVideoEdit} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3.5 py-2.5">
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editPreviewEnabled}
                  onChange={(e) => setEditPreviewEnabled(e.target.checked)}
                />
                Enable Social Video Preview Landing Page
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Auto-Redirect:</span>
                <select
                  value={editCountdown}
                  onChange={(e) => setEditCountdown(Number(e.target.value))}
                  className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
                >
                  <option value={0}>Off</option>
                  <option value={5}>5s</option>
                  <option value={10}>10s</option>
                  <option value={15}>15s</option>
                  <option value={30}>30s</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                HTTPS Video URL (MP4 / WebM)
              </label>
              <input
                type="text"
                value={editVideoUrl}
                onChange={(e) => setEditVideoUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Poster / Thumbnail URL (optional)
                </label>
                <input
                  type="text"
                  value={editThumbUrl}
                  onChange={(e) => setEditThumbUrl(e.target.value)}
                  placeholder="/poster/:slug.jpg (auto fallback)"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  X Card Type
                </label>
                <select
                  value={editCardType}
                  onChange={(e) =>
                    setEditCardType(
                      e.target.value === 'summary_large_image' ? 'summary_large_image' : 'player'
                    )
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                >
                  <option value="player">Player Card (Inline Video)</option>
                  <option value="summary_large_image">Summary Large Image Card</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Width (px)
                </label>
                <input
                  type="number"
                  min={160}
                  max={3840}
                  value={editWidth > 0 ? editWidth : ''}
                  placeholder="Auto-detect"
                  onChange={(e) => setEditWidth(e.target.value ? Number(e.target.value) : 0)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Height (px)
                </label>
                <input
                  type="number"
                  min={90}
                  max={3840}
                  value={editHeight > 0 ? editHeight : ''}
                  placeholder="Auto-detect"
                  onChange={(e) => setEditHeight(e.target.value ? Number(e.target.value) : 0)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Video Title
              </label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Video Description
              </label>
              <textarea
                rows={2}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingVideoLink(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingVideoEdit}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold"
              >
                {savingVideoEdit ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Admin Metadata & Live Audit Modal */}
      <Modal
        open={Boolean(inspectedSlug)}
        onClose={() => setInspectedSlug(null)}
        title={inspectedSlug ? `Generated HTML Metadata — /${inspectedSlug}` : 'Metadata Audit'}
        maxWidth="xl"
      >
        {inspectLoading ? (
          <div className="py-8 text-center text-xs text-slate-500">Running live endpoint audit...</div>
        ) : inspectedMeta ? (
          <div className="space-y-4">
            {inspectedAudit && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs font-mono">
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                    <div className="text-slate-500">Video Stream</div>
                    <div className={inspectedAudit.videoReachable ? 'text-emerald-600 font-semibold' : 'text-amber-600'}>
                      HTTP {String(inspectedAudit.videoStatus ?? 'ERR')} · {inspectedAudit.videoMimeType || 'N/A'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                    <div className="text-slate-500">Byte-Range (206)</div>
                    <div className={inspectedAudit.rangeSupported ? 'text-emerald-600 font-semibold' : 'text-amber-600'}>
                      {inspectedAudit.rangeSupported
                        ? '206 Supported'
                        : `HTTP ${String(inspectedAudit.rangeStatus ?? 'N/A')}`}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                    <div className="text-slate-500">Embed Player</div>
                    <div className={inspectedAudit.playerReachable ? 'text-emerald-600 font-semibold' : 'text-amber-600'}>
                      HTTP {String(inspectedAudit.playerStatus ?? 'ERR')} ·{' '}
                      {inspectedAudit.detectedWidth && inspectedAudit.detectedHeight
                        ? `${inspectedAudit.detectedWidth}×${inspectedAudit.detectedHeight}`
                        : inspectedAudit.xCrawlerReady
                          ? 'Crawler Ready'
                          : 'Needs Review'}
                    </div>
                  </div>
                </div>
                {inspectedAudit.warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    {inspectedAudit.warnings.join(' · ')}
                  </div>
                )}
              </div>
            )}

            <pre className="rounded-lg bg-slate-950 text-slate-200 p-3.5 text-[11px] font-mono overflow-x-auto leading-relaxed max-h-72">
              {inspectedMeta.renderedMetaHtml}
            </pre>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`/embed/${encodeURIComponent(inspectedSlug || '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Video className="w-3.5 h-3.5" />
                  Test /embed/{inspectedSlug}
                </a>
                <a
                  href={`/s/${encodeURIComponent(inspectedSlug || '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open /s/{inspectedSlug}
                </a>
              </div>
              <button
                type="button"
                onClick={() => setInspectedSlug(null)}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-rose-500">Could not inspect metadata.</div>
        )}
      </Modal>
    </div>
  );
}
