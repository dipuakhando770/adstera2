import React, { useEffect, useState } from 'react';
import {
  Check,
  Clock,
  Code2,
  Copy,
  ExternalLink,
  Flag,
  Globe,
  PauseCircle,
  PlaySquare,
  Share2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type { LinkRecord, SocialMetadataPreview } from '../shared/types';
import { useApp } from '../context/AppContext';
import { useToast } from '../components/Toast';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { VideoPlayer } from '../components/VideoPlayer';
import { Modal } from '../components/Modal';

interface SsrPreviewBootstrap {
  link?: LinkRecord;
  isExpired?: boolean;
  metadata?: SocialMetadataPreview;
}

declare global {
  interface Window {
    __NASIRLINK_PREVIEW__?: SsrPreviewBootstrap;
  }
}

function getBootstrappedPreview(slug: string): SsrPreviewBootstrap | null {
  if (typeof window === 'undefined') return null;
  const boot = window.__NASIRLINK_PREVIEW__;
  if (boot?.link && boot.link.slug.toLowerCase() === slug.toLowerCase()) {
    return boot;
  }
  return null;
}

export function VideoPreviewPage({ slug }: { slug: string }) {
  const { navigate } = useApp();
  const { notify } = useToast();

  const initialBoot = getBootstrappedPreview(slug);
  const [link, setLink] = useState<LinkRecord | null>(initialBoot?.link || null);
  const [metadata, setMetadata] = useState<SocialMetadataPreview | null>(initialBoot?.metadata || null);
  const [isExpired, setIsExpired] = useState(Boolean(initialBoot?.isExpired));
  const [loading, setLoading] = useState(!initialBoot?.link);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);

  // Optional visible countdown redirect state
  const [countdown, setCountdown] = useState<number | null>(() => {
    const secs = initialBoot?.link?.autoRedirectSeconds ?? 0;
    return secs > 0 && initialBoot?.link?.isActive && !initialBoot?.isExpired ? secs : null;
  });
  const [redirectCancelled, setRedirectCancelled] = useState(false);

  // Report modal
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState<'phishing' | 'malware' | 'spam' | 'deceptive_video' | 'copyright' | 'other'>('spam');
  const [details, setDetails] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);

  useEffect(() => {
    const boot = getBootstrappedPreview(slug);
    if (boot?.link) {
      setLink(boot.link);
      setMetadata(boot.metadata || null);
      setIsExpired(Boolean(boot.isExpired));
      setLoading(false);
      setNotFound(false);
      const secs = boot.link.autoRedirectSeconds || 0;
      setCountdown(secs > 0 && boot.link.isActive && !boot.isExpired ? secs : null);
      setRedirectCancelled(false);
      return;
    }

    setLoading(true);
    setNotFound(false);
    setRedirectCancelled(false);
    fetch(`/api/preview/${encodeURIComponent(slug)}?track=1`)
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = await res.json();
        const loaded: LinkRecord = data.link;
        const expired = Boolean(data.isExpired);
        setLink(loaded);
        setMetadata(data.metadata);
        setIsExpired(expired);
        const secs = loaded?.autoRedirectSeconds || 0;
        setCountdown(secs > 0 && loaded.isActive && !expired ? secs : null);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    if (redirectCancelled || countdown === null || !link || !link.isActive || isExpired) return;
    if (countdown <= 0) {
      window.location.assign(link.destinationUrl);
      return;
    }
    const timer = setTimeout(() => {
      setCountdown((prev) => (prev !== null ? Math.max(0, prev - 1) : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown, redirectCancelled, link, isExpired]);

  const originUrl =
    typeof window !== 'undefined' ? window.location.origin : 'https://nasirlink.com';
  const shortUrl = `${originUrl}/${encodeURIComponent(slug)}`;
  const shareUrl = `${originUrl}/s/${encodeURIComponent(slug)}`;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      notify('Short link copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify('Copy failed', 'error');
    }
  };

  const submitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingReport(true);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, reason, details }),
      });
      if (res.ok) {
        notify('Thank you. Your report has been queued for moderator review.', 'success');
        setReportOpen(false);
        setDetails('');
      } else {
        notify('Could not submit report.', 'error');
      }
    } finally {
      setSubmittingReport(false);
    }
  };

  const getDomain = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950">
      <Header />

      <main className="flex-1 mx-auto max-w-5xl w-full px-4 sm:px-6 lg:px-8 py-10">
        {loading ? (
          <div className="space-y-4">
            <div className="aspect-video rounded-2xl bg-slate-200 dark:bg-slate-900 animate-pulse" />
            <div className="h-8 w-2/3 rounded bg-slate-200 dark:bg-slate-900 animate-pulse" />
          </div>
        ) : notFound || !link ? (
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-4">
            <ShieldAlert className="w-10 h-10 text-slate-400 mx-auto" />
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Video Preview Not Found
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No active link matches <span className="font-mono">/{slug}</span>.
            </p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700"
            >
              Return Home
            </button>
          </div>
        ) : !link.isActive || isExpired ? (
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-4">
            <PauseCircle className="w-10 h-10 text-amber-500 mx-auto" />
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              {isExpired ? 'This Video Link Has Expired' : 'This Video Link Is Disabled'}
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              The owner or an administrator has paused access to <span className="font-mono">/{slug}</span>.
            </p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700"
            >
              Return Home
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Optional Visible Countdown Auto-Redirect Banner */}
            {link.autoRedirectSeconds > 0 && (
              <div className="rounded-xl border border-indigo-200 dark:border-indigo-900/70 bg-indigo-50/70 dark:bg-indigo-950/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 text-xs font-medium text-indigo-900 dark:text-indigo-200">
                  <Clock className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  {redirectCancelled ? (
                    <span>
                      Auto-redirect cancelled. Stay on this page to finish watching or use the button below.
                    </span>
                  ) : (
                    <span className="tabular-nums">
                      Redirecting to <strong>{getDomain(link.destinationUrl)}</strong> in{' '}
                      <strong>{countdown ?? link.autoRedirectSeconds}</strong>{' '}
                      {(countdown ?? link.autoRedirectSeconds) === 1 ? 'second' : 'seconds'}...
                    </span>
                  )}
                </div>
                {!redirectCancelled && (
                  <button
                    type="button"
                    onClick={() => {
                      setRedirectCancelled(true);
                      setCountdown(null);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Cancel Redirect
                  </button>
                )}
              </div>
            )}

            {/* HTML5 Video Player */}
            <VideoPlayer
              src={metadata?.ogVideo || link.videoUrl || ''}
              poster={link.thumbnailUrl?.trim() ? metadata?.ogImage || undefined : undefined}
              mimeType={metadata?.ogVideoType || link.videoMimeType}
              title={metadata?.title || link.videoTitle || link.slug}
              width={metadata?.ogVideoWidth || link.videoWidth}
              height={metadata?.ogVideoHeight || link.videoHeight}
              sourceUrl={metadata?.sourceUrl}
              sourceDomain={metadata?.sourceDomain}
            />

            {/* Title, Description & Disclosed Destination */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                <div className="space-y-2">
                  <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    /{link.slug} · /s/{link.slug} · {link.clicksCount.toLocaleString()} views
                    {(metadata?.ogVideoWidth || link.videoWidth) > 0 &&
                    (metadata?.ogVideoHeight || link.videoHeight) > 0
                      ? ` · ${metadata?.ogVideoWidth || link.videoWidth}×${metadata?.ogVideoHeight || link.videoHeight}`
                      : ''}
                  </div>
                  <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                    {metadata?.title || link.videoTitle || `Video Preview: ${link.slug}`}
                  </h1>
                  {(metadata?.description || link.videoDescription) && (
                    <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                      {metadata?.description || link.videoDescription}
                    </p>
                  )}
                  <div className="text-xs font-mono text-slate-500 dark:text-slate-400 pt-1">
                    Short Redirect: <span className="text-indigo-600 dark:text-indigo-400">{shortUrl}</span>
                  </div>
                </div>

                {/* Social Sharing Bar */}
                <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Share This Video Preview
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        if (navigator.share) {
                          try {
                            await navigator.share({
                              title: link.videoTitle || link.slug,
                              text: link.videoDescription || '',
                              url: shareUrl,
                            });
                            return;
                          } catch {
                            // fall through to clipboard copy
                          }
                        }
                        copyUrl();
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold whitespace-nowrap"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      Share
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {[
                      {
                        label: 'X',
                        href: `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(link.videoTitle || '')}`,
                      },
                      {
                        label: 'Facebook',
                        href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
                      },
                      {
                        label: 'Telegram',
                        href: `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(link.videoTitle || '')}`,
                      },
                      {
                        label: 'WhatsApp',
                        href: `https://wa.me/?text=${encodeURIComponent(shareUrl)}`,
                      },
                      {
                        label: 'Reddit',
                        href: `https://www.reddit.com/submit?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(link.videoTitle || link.slug)}`,
                      },
                    ].map((net) => (
                      <a
                        key={net.label}
                        href={net.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors whitespace-nowrap"
                      >
                        {net.label}
                      </a>
                    ))}

                    <button
                      type="button"
                      onClick={copyUrl}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-800 text-white text-xs font-semibold hover:bg-slate-800 dark:hover:bg-slate-700 whitespace-nowrap"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied' : 'Copy Link'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Transparent Destination Disclosure Card */}
              <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <Globe className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  Disclosed Destination Website
                </div>

                <div className="rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3.5 space-y-1">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {getDomain(link.destinationUrl)}
                  </div>
                  <div className="text-xs font-mono text-slate-500 dark:text-slate-400 break-all">
                    {link.destinationUrl}
                  </div>
                </div>

                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Visitors and social crawlers see the same public preview page. Click below when you are ready to visit the disclosed external website.
                </p>

                <a
                  href={link.destinationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-4 py-3 text-sm font-semibold text-white transition-colors whitespace-nowrap"
                >
                  Open Destination Website
                  <ExternalLink className="w-4 h-4" />
                </a>

                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-3">
                    <a
                      href={`/embed/${encodeURIComponent(link.slug)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 whitespace-nowrap"
                    >
                      <PlaySquare className="w-3.5 h-3.5" />
                      Test /embed Page
                    </a>
                    <button
                      type="button"
                      onClick={() => navigate(`/metadata-debug?slug=${encodeURIComponent(slug)}`)}
                      className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 whitespace-nowrap"
                    >
                      <Code2 className="w-3.5 h-3.5" />
                      Inspect Metadata ({metadata?.twitterCard || 'player'})
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 whitespace-nowrap"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    Report Link
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report Suspicious Link"
        subtitle={`/${slug}`}
        maxWidth="md"
      >
        <form onSubmit={submitReport} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Reason
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as typeof reason)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
            >
              <option value="phishing">Phishing or credential harvesting</option>
              <option value="malware">Malware or unsafe download</option>
              <option value="deceptive_video">Deceptive video or misleading destination</option>
              <option value="spam">Spam</option>
              <option value="copyright">Copyright concern</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Details (optional)
            </label>
            <textarea
              rows={3}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Provide context for our moderation team..."
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setReportOpen(false)}
              className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submittingReport}
              className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
            >
              {submittingReport ? 'Submitting...' : 'Submit Report'}
            </button>
          </div>
        </form>
      </Modal>

      <Footer />
    </div>
  );
}
