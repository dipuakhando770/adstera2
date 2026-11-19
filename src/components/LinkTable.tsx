import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  Code2,
  Copy,
  ExternalLink,
  Link2,
  Lock,
  PauseCircle,
  Pencil,
  PlayCircle,
  PlaySquare,
  QrCode,
  Trash2,
  Video,
} from 'lucide-react';
import type { LinkRecord } from '../shared/types';
import { useApp } from '../context/AppContext';
import { useToast } from './Toast';
import { Search } from './Search';
import { Pagination } from './Pagination';
import { Modal } from './Modal';
import { LinkForm } from './LinkForm';
import { QRCodeGenerator } from './QRCodeGenerator';
import { AnalyticsDashboard } from './AnalyticsDashboard';

interface LinkTableProps {
  fixedType?: 'all' | 'normal' | 'video';
  onOpenMetadataDebug?: (slug: string) => void;
  refreshTrigger?: number;
}

export function LinkTable({
  fixedType = 'all',
  onOpenMetadataDebug,
  refreshTrigger = 0,
}: LinkTableProps) {
  const { notify } = useToast();
  const { navigate } = useApp();

  const [links, setLinks] = useState<LinkRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'normal' | 'video'>(fixedType);

  const [editingLink, setEditingLink] = useState<LinkRecord | null>(null);
  const [qrLink, setQrLink] = useState<LinkRecord | null>(null);
  const [analyticsLink, setAnalyticsLink] = useState<LinkRecord | null>(null);

  useEffect(() => {
    setTypeFilter(fixedType);
    setPage(1);
  }, [fixedType]);

  const fetchLinks = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: '8',
          status: statusFilter,
          type: typeFilter,
        });
        if (searchQuery.trim()) params.set('q', searchQuery.trim());
        const res = await fetch(`/api/links?${params.toString()}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setLinks(data.links || []);
          setTotal(data.total || 0);
          setTotalPages(data.totalPages || 1);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [page, statusFilter, typeFilter, searchQuery]
  );

  useEffect(() => {
    const t = setTimeout(() => fetchLinks(false), 120);
    return () => clearTimeout(t);
  }, [fetchLinks, refreshTrigger]);

  useEffect(() => {
    const onRefresh = () => {
      fetchLinks(true);
    };
    window.addEventListener('nasirlink:data-changed', onRefresh);
    window.addEventListener('focus', onRefresh);
    const interval = setInterval(onRefresh, 15000);
    return () => {
      window.removeEventListener('nasirlink:data-changed', onRefresh);
      window.removeEventListener('focus', onRefresh);
      clearInterval(interval);
    };
  }, [fetchLinks]);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://nasirlink.com';
  const shortUrlFor = (l: LinkRecord) => `${origin}/${l.slug}`;

  const handleToggleActive = async (link: LinkRecord) => {
    const res = await fetch(`/api/links/${link.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isActive: !link.isActive }),
    });
    if (res.ok) {
      notify(link.isActive ? 'Link disabled' : 'Link enabled', 'success');
      window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
      fetchLinks(true);
    } else {
      const err = await res.json();
      notify(err.error || 'Could not update link status', 'error');
    }
  };

  const handleDelete = async (link: LinkRecord) => {
    const res = await fetch(`/api/links/${link.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (res.ok) {
      notify(`Deleted /${link.slug}`, 'success');
      window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
      fetchLinks(true);
    } else {
      const err = await res.json();
      notify(err.error || 'Could not delete link', 'error');
    }
  };

  const handleCopy = async (link: LinkRecord) => {
    try {
      await navigator.clipboard.writeText(shortUrlFor(link));
      notify('Short URL copied to clipboard', 'success');
    } catch {
      notify('Copy failed', 'error');
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
      {/* Toolbar: Search + Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <Search
          value={searchQuery}
          onChange={(v) => {
            setSearchQuery(v);
            setPage(1);
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            {(['all', 'active', 'disabled'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => {
                  setStatusFilter(st);
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors whitespace-nowrap ${
                  statusFilter === st
                    ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          {fixedType === 'all' && (
            <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              {(
                [
                  { id: 'all', label: 'All Types' },
                  { id: 'normal', label: 'Normal Links' },
                  { id: 'video', label: 'Video Links' },
                ] as const
              ).map((tp) => (
                <button
                  key={tp.id}
                  type="button"
                  onClick={() => {
                    setTypeFilter(tp.id);
                    setPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    typeFilter === tp.id
                      ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {tp.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
              <th className="py-3 pr-4">Short URL</th>
              <th className="py-3 px-4">Destination</th>
              <th className="py-3 px-4">Type</th>
              <th className="py-3 px-4">Created</th>
              <th className="py-3 px-4 text-right">Clicks</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 pl-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-sm">
            {loading ? (
              Array.from({ length: 4 }).map((_, idx) => (
                <tr key={idx}>
                  <td colSpan={7} className="py-4">
                    <div className="h-5 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
                  </td>
                </tr>
              ))
            ) : links.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                  No links match your current filters. Create a short link above to get started.
                </td>
              </tr>
            ) : (
              links.map((link) => {
                const isExpired = link.expiresAt
                  ? new Date(link.expiresAt).getTime() < Date.now()
                  : false;

                return (
                  <tr
                    key={link.id}
                    className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3.5 pr-4 whitespace-nowrap">
                      <div className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5">
                        <span>/{link.slug}</span>
                        {link.hasPassword && (
                          <Lock className="w-3 h-3 text-amber-500" aria-label="Password protected" />
                        )}
                      </div>
                      {link.videoTitle && (
                        <div className="text-xs text-slate-500 dark:text-slate-400 max-w-[200px] truncate mt-0.5">
                          {link.videoTitle}
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-4 max-w-[240px]">
                      <div className="text-xs text-slate-700 dark:text-slate-300 truncate font-mono">
                        {link.destinationUrl}
                      </div>
                      {link.campaignName && (
                        <div className="text-xs text-slate-400 truncate mt-0.5">
                          {link.campaignName}
                        </div>
                      )}
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-600 dark:text-slate-300">
                      <span className="inline-flex items-center gap-1.5">
                        {link.linkType === 'video' ? (
                          <Video className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                        ) : (
                          <Link2 className="w-3.5 h-3.5 text-slate-400" />
                        )}
                        {link.linkType === 'video'
                          ? `Video · ${link.previewEnabled ? 'Preview ON' : 'Preview OFF'}`
                          : `HTTP ${link.redirectType}`}
                      </span>
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {new Date(link.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {link.clicksCount.toLocaleString()}
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap text-xs">
                      {!link.isActive ? (
                        <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 font-medium">
                          <PauseCircle className="w-3.5 h-3.5 text-amber-600" /> Disabled
                        </span>
                      ) : isExpired ? (
                        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-medium">
                          Expired
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Active
                        </span>
                      )}
                    </td>

                    <td className="py-3.5 pl-4 whitespace-nowrap text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleCopy(link)}
                          title="Copy short URL"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setQrLink(link)}
                          title="QR Code"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <QrCode className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setAnalyticsLink(link)}
                          title="Analytics"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <BarChart3 className="w-4 h-4" />
                        </button>
                        {link.linkType === 'video' && (
                          <>
                            <a
                              href={`/s/${encodeURIComponent(link.slug)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open Social Share Page (/s/:slug)"
                              className="px-1.5 py-1 rounded-lg text-[11px] font-mono font-semibold text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              /s
                            </a>
                            <a
                              href={`/embed/${encodeURIComponent(link.slug)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Test /embed Page"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <PlaySquare className="w-4 h-4" />
                            </a>
                            <button
                              type="button"
                              onClick={() => {
                                if (onOpenMetadataDebug) onOpenMetadataDebug(link.slug);
                                else navigate(`/metadata-debug?slug=${encodeURIComponent(link.slug)}`);
                              }}
                              title="Metadata Preview & X Card Debugger"
                              className="p-1.5 rounded-lg text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Code2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        <a
                          href={`/${link.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open Short Link"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => setEditingLink(link)}
                          title="Edit"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(link)}
                          title={link.isActive ? 'Disable link' : 'Enable link'}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {link.isActive ? (
                            <PauseCircle className="w-4 h-4" />
                          ) : (
                            <PlayCircle className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(link)}
                          title="Delete"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Trash2 className="w-4 h-4" />
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

      <Pagination
        page={page}
        totalPages={totalPages}
        totalItems={total}
        onPageChange={setPage}
      />

      {/* Edit Link Modal */}
      <Modal
        open={Boolean(editingLink)}
        onClose={() => setEditingLink(null)}
        title={editingLink ? `Edit /${editingLink.slug}` : 'Edit Link'}
        subtitle={editingLink?.destinationUrl}
        maxWidth="2xl"
      >
        {editingLink && (
          <LinkForm
            editingLink={editingLink}
            onSuccess={() => {
              setEditingLink(null);
              fetchLinks();
            }}
            onCancelEdit={() => setEditingLink(null)}
          />
        )}
      </Modal>

      {/* QR Code Modal */}
      <Modal
        open={Boolean(qrLink)}
        onClose={() => setQrLink(null)}
        title={qrLink ? `QR Code — /${qrLink.slug}` : 'QR Code'}
        subtitle={qrLink ? shortUrlFor(qrLink) : ''}
        maxWidth="xl"
      >
        {qrLink && <QRCodeGenerator initialUrl={shortUrlFor(qrLink)} />}
      </Modal>

      {/* Per-Link Analytics Modal */}
      <Modal
        open={Boolean(analyticsLink)}
        onClose={() => setAnalyticsLink(null)}
        title={analyticsLink ? `Analytics — /${analyticsLink.slug}` : 'Link Analytics'}
        subtitle={analyticsLink?.destinationUrl}
        maxWidth="2xl"
      >
        {analyticsLink && <AnalyticsDashboard initialLinkId={analyticsLink.id} />}
      </Modal>
    </div>
  );
}
