import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  Pencil,
  PlaySquare,
  QrCode,
  Share2,
  SlidersHorizontal,
  Video,
} from 'lucide-react';
import type { LinkRecord, LinkType, RedirectStatusCode, VideoStreamAudit } from '../shared/types';
import { convertGitHubVideoUrl, convertMediaUrl, convertImgurMediaUrl, validateVideoUrl } from '../shared/validation';
import { captureVideoFrameAndDims } from '../shared/videoFrameCapture';
import { useApp } from '../context/AppContext';
import { useToast } from './Toast';
import { VideoPlayer } from './VideoPlayer';
import { Modal } from './Modal';
import { QRCodeGenerator } from './QRCodeGenerator';

interface LinkFormProps {
  defaultLinkType?: LinkType;
  editingLink?: LinkRecord | null;
  onSuccess?: (link: LinkRecord) => void;
  onCancelEdit?: () => void;
  compact?: boolean;
}

function getPreviewSourceDomain(url: string, fallbackHost: string): { sourceUrl: string; sourceDomain: string } {
  const trimmed = url.trim();
  if (!trimmed) return { sourceUrl: '', sourceDomain: '' };
  if (trimmed.startsWith('/')) {
    const cleanHost = fallbackHost.replace(/^https?:\/\//i, '').split('/')[0] || 'nasirlink.com';
    return { sourceUrl: `https://${cleanHost}`, sourceDomain: cleanHost };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') {
      return {
        sourceUrl: `https://${parsed.hostname}${parsed.pathname}`,
        sourceDomain: parsed.hostname,
      };
    }
  } catch {
    // ignore invalid URL while typing
  }
  return { sourceUrl: '', sourceDomain: '' };
}

export function LinkForm({
  defaultLinkType = 'normal',
  editingLink = null,
  onSuccess,
  onCancelEdit,
}: LinkFormProps) {
  const { publicSettings, navigate } = useApp();
  const { notify } = useToast();

  const [destinationUrl, setDestinationUrl] = useState(editingLink?.destinationUrl || '');
  const [customAlias, setCustomAlias] = useState(editingLink?.slug || '');
  const [linkType, setLinkType] = useState<LinkType>(editingLink?.linkType || defaultLinkType);
  const [previewEnabled, setPreviewEnabled] = useState<boolean>(
    editingLink ? editingLink.previewEnabled : defaultLinkType === 'video'
  );
  const [autoRedirectSeconds, setAutoRedirectSeconds] = useState<number>(
    editingLink?.autoRedirectSeconds ?? 0
  );
  const [videoUrl, setVideoUrl] = useState(editingLink?.videoUrl || '');
  const [videoTitle, setVideoTitle] = useState(editingLink?.videoTitle || '');
  const [videoDescription, setVideoDescription] = useState(editingLink?.videoDescription || '');
  const [previewTab, setPreviewTab] = useState<'landing' | 'card'>('landing');

  // Advanced Settings
  const [showAdvanced, setShowAdvanced] = useState(Boolean(editingLink));
  const [redirectType, setRedirectType] = useState<RedirectStatusCode>(
    editingLink?.redirectType || publicSettings.defaultRedirectType || 302
  );
  const [expiresAt, setExpiresAt] = useState(
    editingLink?.expiresAt ? editingLink.expiresAt.slice(0, 16) : ''
  );
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [isActive, setIsActive] = useState(editingLink ? editingLink.isActive : true);
  const [utmSource, setUtmSource] = useState(editingLink?.utmSource || '');
  const [utmMedium, setUtmMedium] = useState(editingLink?.utmMedium || '');
  const [utmCampaign, setUtmCampaign] = useState(editingLink?.utmCampaign || '');
  const [campaignName, setCampaignName] = useState(editingLink?.campaignName || '');
  const [tagsInput, setTagsInput] = useState(editingLink?.tags.join(', ') || '');
  const [playerUrl, setPlayerUrl] = useState(editingLink?.playerUrl || '');
  const [thumbnailUrl, setThumbnailUrl] = useState(editingLink?.thumbnailUrl || '');
  const [twitterCardType, setTwitterCardType] = useState<'player' | 'summary_large_image'>(
    editingLink?.twitterCardType || 'player'
  );
  const [videoWidth, setVideoWidth] = useState(editingLink?.videoWidth || 0);
  const [videoHeight, setVideoHeight] = useState(editingLink?.videoHeight || 0);

  // Real-time alias status
  const [aliasStatus, setAliasStatus] = useState<{
    checking: boolean;
    available?: boolean;
    reason?: string;
  }>({ checking: false });

  // Video validation status
  const [videoCheck, setVideoCheck] = useState<{
    checking: boolean;
    valid?: boolean;
    convertedFromGithub?: boolean;
    normalizedUrl?: string;
    mimeType?: string;
    reachable?: boolean | null;
    audit?: VideoStreamAudit;
    error?: string;
  }>({ checking: false });

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [createdLink, setCreatedLink] = useState<LinkRecord | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  // Sync editingLink when prop changes
  useEffect(() => {
    if (editingLink) {
      setDestinationUrl(editingLink.destinationUrl);
      setCustomAlias(editingLink.slug);
      setLinkType(editingLink.linkType);
      setPreviewEnabled(editingLink.previewEnabled);
      setAutoRedirectSeconds(editingLink.autoRedirectSeconds ?? 0);
      setVideoUrl(editingLink.videoUrl || '');
      setVideoTitle(editingLink.videoTitle || '');
      setVideoDescription(editingLink.videoDescription || '');
      setRedirectType(editingLink.redirectType);
      setExpiresAt(editingLink.expiresAt ? editingLink.expiresAt.slice(0, 16) : '');
      setIsActive(editingLink.isActive);
      setUtmSource(editingLink.utmSource || '');
      setUtmMedium(editingLink.utmMedium || '');
      setUtmCampaign(editingLink.utmCampaign || '');
      setCampaignName(editingLink.campaignName || '');
      setTagsInput(editingLink.tags.join(', '));
      setPlayerUrl(editingLink.playerUrl || '');
      setThumbnailUrl(editingLink.thumbnailUrl || '');
      setTwitterCardType(editingLink.twitterCardType || 'player');
      setVideoWidth(editingLink.videoWidth || 0);
      setVideoHeight(editingLink.videoHeight || 0);
      setShowAdvanced(true);
    }
  }, [editingLink]);

  // Debounced real-time alias availability check
  useEffect(() => {
    const trimmed = customAlias.trim();
    if (!trimmed) {
      setAliasStatus({ checking: false });
      return;
    }
    setAliasStatus({ checking: true });
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ slug: trimmed });
        if (editingLink?.id) params.set('excludeId', editingLink.id);
        const res = await fetch(`/api/links/check-alias?${params.toString()}`);
        const data = await res.json();
        setAliasStatus({
          checking: false,
          available: Boolean(data.available),
          reason: data.reason,
        });
      } catch {
        setAliasStatus({ checking: false });
      }
    }, 260);
    return () => clearTimeout(timer);
  }, [customAlias, editingLink?.id]);

  // Auto-detect real original video dimensions & capture real first frame of selected video
  useEffect(() => {
    const trimmed = videoUrl.trim();
    if (!trimmed || linkType !== 'video') return;
    const check = validateVideoUrl(trimmed);
    if (!check.valid || !check.normalizedUrl) return;

    let cancelled = false;
    const currentVideoNormalized = check.normalizedUrl;

    // Never keep an old auto-captured frame when switching to a different video URL
    const isUnchangedEditingVideo =
      Boolean(editingLink?.videoUrl) && editingLink?.videoUrl === currentVideoNormalized;
    if (!isUnchangedEditingVideo) {
      setThumbnailUrl((prev) => (prev.trim().startsWith('data:image/') ? '' : prev));
    }

    const shouldCapture = !isUnchangedEditingVideo || !editingLink?.thumbnailUrl?.trim();
    captureVideoFrameAndDims(currentVideoNormalized, { captureFrame: shouldCapture }).then((res) => {
      if (cancelled) return;
      if (res.width > 0 && res.height > 0) {
        setVideoWidth(res.width);
        setVideoHeight(res.height);
      }
      if (res.thumbnailDataUrl) {
        setThumbnailUrl((prev) => {
          const p = prev.trim();
          if (!p || p.startsWith('data:image/')) {
            return res.thumbnailDataUrl || '';
          }
          return prev;
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [videoUrl, linkType, editingLink?.id, editingLink?.videoUrl, editingLink?.thumbnailUrl]);

  // Auto-convert GitHub, Imgur, & X/Twitter video URLs locally + read container hints
  const handleVideoUrlChange = (raw: string) => {
    const converted = convertMediaUrl(raw, 'video');
    if (converted.convertedFromGithub) {
      setVideoUrl(converted.normalizedUrl);
      notify('Converted GitHub repository link to raw video stream URL', 'info');
    } else if (converted.convertedFromImgur) {
      setVideoUrl(converted.normalizedUrl);
      notify('Converted Imgur link to direct video stream URL', 'info');
    } else if (converted.isTwitter) {
      setVideoUrl(converted.normalizedUrl);
      notify('X (Twitter) video link recognized', 'info');
    } else {
      setVideoUrl(raw);
    }

    const dimMatch = converted.normalizedUrl.match(/[/_](\d{3,4})x(\d{3,4})[./_?]/i);
    if (dimMatch) {
      setVideoWidth(parseInt(dimMatch[1], 10));
      setVideoHeight(parseInt(dimMatch[2], 10));
    } else if (converted.normalizedUrl.includes('showcase1.mp4')) {
      setVideoWidth(1290);
      setVideoHeight(720);
    } else if (converted.normalizedUrl.includes('showcase.mp4')) {
      setVideoWidth(720);
      setVideoHeight(1278);
    } else if (!raw.trim()) {
      setVideoWidth(0);
      setVideoHeight(0);
    }

    const localCheck = validateVideoUrl(converted.normalizedUrl);
    if (!raw.trim()) {
      setVideoCheck({ checking: false });
    } else if (!localCheck.valid) {
      setVideoCheck({
        checking: false,
        valid: false,
        convertedFromGithub: converted.convertedFromGithub,
        error: localCheck.error,
      });
    } else {
      setVideoCheck({
        checking: false,
        valid: true,
        convertedFromGithub: converted.convertedFromGithub,
        normalizedUrl: localCheck.normalizedUrl,
        mimeType: localCheck.mimeType,
      });
    }
  };

  const runServerVideoCheck = async () => {
    if (!videoUrl.trim()) return;
    setVideoCheck((prev) => ({ ...prev, checking: true }));
    try {
      const res = await fetch('/api/links/validate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVideoCheck({
          checking: false,
          valid: false,
          audit: data.audit,
          error: data.error || 'Video validation failed.',
        });
      } else {
        setVideoUrl(data.normalizedUrl);
        const audit: VideoStreamAudit | undefined = data.audit;
        if (audit?.detectedWidth && audit?.detectedHeight) {
          setVideoWidth(audit.detectedWidth);
          setVideoHeight(audit.detectedHeight);
        }
        setVideoCheck({
          checking: false,
          valid: true,
          convertedFromGithub: data.convertedFromGithub,
          normalizedUrl: data.normalizedUrl,
          mimeType: data.mimeType,
          reachable: data.reachable,
          audit,
          error: data.fetchError || undefined,
        });
        notify(
          audit?.detectedWidth && audit?.detectedHeight
            ? `Verified ${data.mimeType} (${audit.detectedWidth}×${audit.detectedHeight})`
            : data.reachable
              ? 'Video stream verified and reachable'
              : 'Video URL syntax valid (remote host blocked probe)',
          'success'
        );
      }
    } catch {
      setVideoCheck((prev) => ({ ...prev, checking: false, error: 'Validation check failed.' }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSubmitting(true);

    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const effectiveLinkType: LinkType = videoUrl.trim() || (linkType === 'video' && previewEnabled) ? 'video' : 'normal';
      const effectivePreview = effectiveLinkType === 'video' && previewEnabled;

      const payload = {
        destinationUrl: destinationUrl.trim(),
        customAlias: customAlias.trim() || null,
        linkType: effectiveLinkType,
        previewEnabled: effectivePreview,
        autoRedirectSeconds: effectivePreview ? Number(autoRedirectSeconds) || 0 : 0,
        videoUrl: effectiveLinkType === 'video' ? videoUrl.trim() || null : null,
        videoTitle: effectiveLinkType === 'video' ? videoTitle.trim() || null : null,
        videoDescription: effectiveLinkType === 'video' ? videoDescription.trim() || null : null,
        thumbnailUrl: effectiveLinkType === 'video' && thumbnailUrl.trim() ? thumbnailUrl.trim() : null,
        videoWidth: videoWidth > 0 ? Number(videoWidth) : null,
        videoHeight: videoHeight > 0 ? Number(videoHeight) : null,
        twitterCardType,
        playerUrl: effectiveLinkType === 'video' && playerUrl.trim() ? playerUrl.trim() : null,
        redirectType,
        password: password.trim() || null,
        clearPassword,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        isActive,
        utmSource: utmSource.trim() || null,
        utmMedium: utmMedium.trim() || null,
        utmCampaign: utmCampaign.trim() || null,
        campaignName: campaignName.trim() || null,
        tags,
      };

      const url = editingLink ? `/api/links/${editingLink.id}` : '/api/links';
      const method = editingLink ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || 'Could not save link.');
        notify(data.error || 'Could not save link.', 'error');
        return;
      }

      const saved: LinkRecord = data.link;
      setCreatedLink(saved);
      notify(editingLink ? 'Link updated successfully' : 'Short link created', 'success');

      if (!editingLink) {
        setDestinationUrl('');
        setCustomAlias('');
        setPassword('');
        setVideoUrl('');
        setVideoTitle('');
        setVideoDescription('');
        setThumbnailUrl('');
        setTwitterCardType('player');
        setVideoWidth(0);
        setVideoHeight(0);
      }
      window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
      onSuccess?.(saved);
    } catch {
      setFormError('Network error while saving link.');
    } finally {
      setSubmitting(false);
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : `https://${publicSettings.domain}`;
  const getShortHref = (link: LinkRecord) => `${origin}/${link.slug}`;

  const copyShortUrl = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      notify('Short URL copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify('Could not copy automatically', 'error');
    }
  };

  const activeResult = createdLink;
  const activeShortUrl = activeResult ? getShortHref(activeResult) : '';

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-sm space-y-6"
      >
        {/* Link Type Segmented Selector */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800">
          <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setLinkType('normal')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                linkType === 'normal'
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" />
              Normal Short URL
            </button>
            <button
              type="button"
              onClick={() => {
                setLinkType('video');
                setPreviewEnabled(true);
              }}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                linkType === 'video'
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Video className="w-3.5 h-3.5" />
              Video Preview Link
            </button>
          </div>

          <span className="text-xs text-slate-500 dark:text-slate-400">
            {linkType === 'normal' || !previewEnabled
              ? `Direct HTTP ${redirectType} redirect with click analytics`
              : 'Uncloaked landing page + X/OpenGraph video preview card'}
          </span>
        </div>

        {/* Core Fields */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
          <div className="md:col-span-7">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Destination URL
            </label>
            <input
              type="url"
              required
              value={destinationUrl}
              onChange={(e) => setDestinationUrl(e.target.value)}
              placeholder="https://example.com/your-long-destination-page"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-4 py-3 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-2 focus:outline-indigo-600"
            />
          </div>

          <div className="md:col-span-5">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Custom Alias (optional)
            </label>
            <div className="flex items-center rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 focus-within:outline-2 focus-within:outline-indigo-600 overflow-hidden">
              <span className="px-3 py-3 text-xs font-mono text-slate-400 bg-slate-50 dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 shrink-0">
                /
              </span>
              <input
                type="text"
                value={customAlias}
                onChange={(e) => setCustomAlias(e.target.value)}
                placeholder="my-smart-link"
                className="w-full px-3 py-3 text-sm font-mono bg-transparent text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
              />
            </div>
            {customAlias.trim() && (
              <div className="mt-1.5 text-xs flex items-center gap-1.5">
                {aliasStatus.checking ? (
                  <span className="text-slate-400">Checking availability...</span>
                ) : aliasStatus.available ? (
                  <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Alias is available
                  </span>
                ) : aliasStatus.available === false ? (
                  <span className="text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5" /> {aliasStatus.reason || 'Unavailable'}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* Inline CTA to attach a video when in Normal mode */}
        {linkType === 'normal' && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Video className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Embed Video on Social Media
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Attach an MP4/WebM video so sharing your short link embeds a playable video on X, Facebook, Discord, Telegram & WhatsApp.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setLinkType('video');
                setPreviewEnabled(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-white dark:bg-slate-900 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 transition-colors whitespace-nowrap"
            >
              <Video className="w-3.5 h-3.5" />
              Attach Video
            </button>
          </div>
        )}

        {/* Video Preview Link Fields */}
        {linkType === 'video' && (
          <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200/70 dark:border-indigo-900/60 bg-indigo-50/40 dark:bg-indigo-950/20 px-4 py-3">
              <label className="inline-flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={previewEnabled}
                  onChange={(e) => setPreviewEnabled(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                />
                <span className="text-xs font-semibold text-indigo-950 dark:text-indigo-100">
                  Enable Social Video Preview & Public Landing Page
                </span>
              </label>

              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  {previewEnabled
                    ? 'Same page served to browsers & X/OpenGraph crawlers'
                    : `Preview off — performs HTTP ${redirectType} redirect`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setLinkType('normal');
                    setPreviewEnabled(false);
                  }}
                  className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 underline whitespace-nowrap"
                >
                  Remove video
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-7 space-y-4">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      HTTPS Video URL (MP4, WebM, or GitHub Repo Video URL)
                    </label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleVideoUrlChange('/api/sample-video/showcase.mp4')}
                        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        Portrait Sample (720×1278)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleVideoUrlChange('/api/sample-video/showcase1.mp4')}
                        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        Landscape Sample (1290×720)
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required={linkType === 'video' && previewEnabled}
                      value={videoUrl}
                      onChange={(e) => handleVideoUrlChange(e.target.value)}
                      placeholder="https://cdn.example.com/video.mp4 or https://video.twimg.com/.../clip.mp4"
                      className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-2 focus:outline-indigo-600"
                    />
                    <button
                      type="button"
                      onClick={runServerVideoCheck}
                      disabled={videoCheck.checking || !videoUrl.trim()}
                      className="px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      {videoCheck.checking ? 'Probing...' : 'Verify Stream'}
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    Direct HTTPS MP4/WebM stream. Original container width &amp; height are preserved automatically (never cropped or forced to 1280×720).
                  </p>
                  {videoCheck.error && (
                    <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                      {videoCheck.error}
                    </p>
                  )}
                  {videoCheck.valid && !videoCheck.error && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                      <span>
                        Verified {videoCheck.mimeType}
                        {videoCheck.audit?.codec ? ` (${videoCheck.audit.codec})` : ''}
                        {videoCheck.audit?.detectedWidth && videoCheck.audit?.detectedHeight
                          ? ` · ${videoCheck.audit.detectedWidth}×${videoCheck.audit.detectedHeight}`
                          : ''}
                        {videoCheck.audit?.rangeSupported ? ' · HTTP Range 206 Ready' : ''}
                      </span>
                      {videoCheck.convertedFromGithub && (
                        <span className="text-slate-500 dark:text-slate-400">
                          · Converted from GitHub blob URL
                        </span>
                      )}
                    </div>
                  )}
                  {videoCheck.audit?.isGithubRaw && (
                    <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                      GitHub Raw URL detected: social stream tags are routed via /media/:slug with video/mp4 MIME &amp; HTTP Range 206 support.
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Video Title
                    </label>
                    <button
                      type="button"
                      onClick={() => setVideoTitle('46:44 | 59:52')}
                      className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      Random: 46:44 | 59:52
                    </button>
                  </div>
                  <input
                    type="text"
                    value={videoTitle}
                    onChange={(e) => setVideoTitle(e.target.value)}
                    placeholder="Video title shown in X Player Card & OpenGraph metadata"
                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-2 focus:outline-indigo-600"
                  />
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    Supports rotating titles via pipe syntax like <code className="font-mono text-indigo-600 dark:text-indigo-400">46:44 | 59:52</code>.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Description
                  </label>
                  <textarea
                    rows={2}
                    value={videoDescription}
                    onChange={(e) => setVideoDescription(e.target.value)}
                    placeholder="Concise description used for the public preview page, OpenGraph, and X Player Card metadata."
                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-2 focus:outline-indigo-600"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Poster / Thumbnail URL (optional)
                    </label>
                    <input
                      type="text"
                      value={thumbnailUrl}
                      onChange={(e) => {
                        const val = e.target.value;
                        const converted = convertImgurMediaUrl(val, 'image');
                        setThumbnailUrl(converted.normalizedUrl);
                      }}
                      onBlur={(e) => {
                        const converted = convertImgurMediaUrl(e.target.value, 'image');
                        if (converted.convertedFromImgur) {
                          setThumbnailUrl(converted.normalizedUrl);
                          notify('Converted Imgur link to direct poster image URL', 'info');
                        }
                      }}
                      placeholder="https://i.imgur.com/RZj7NBWh.jpg or auto /poster/:slug.jpg"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-2 focus:outline-indigo-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      X (Twitter) Card Type
                    </label>
                    <select
                      value={twitterCardType}
                      onChange={(e) =>
                        setTwitterCardType(
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

                {/* Dimensions & Auto-Redirect Countdown */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Video Width (px)
                    </label>
                    <input
                      type="number"
                      min={160}
                      max={3840}
                      value={videoWidth > 0 ? videoWidth : ''}
                      placeholder="Auto-detect"
                      onChange={(e) => setVideoWidth(e.target.value ? Number(e.target.value) : 0)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100"
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
                      value={videoHeight > 0 ? videoHeight : ''}
                      placeholder="Auto-detect"
                      onChange={(e) => setVideoHeight(e.target.value ? Number(e.target.value) : 0)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Auto-Redirect Timer
                    </label>
                    <select
                      value={autoRedirectSeconds}
                      onChange={(e) => setAutoRedirectSeconds(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                    >
                      <option value={0}>Off (Manual Click Only)</option>
                      <option value={5}>5 seconds (Cancellable)</option>
                      <option value={10}>10 seconds (Cancellable)</option>
                      <option value={15}>15 seconds (Cancellable)</option>
                      <option value={30}>30 seconds (Cancellable)</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Aspect Presets:</span>
                  {[
                    { label: '9:16 Portrait (720×1278)', w: 720, h: 1278 },
                    { label: '16:9 Landscape (1290×720)', w: 1290, h: 720 },
                    { label: '1:1 Square (1080×1080)', w: 1080, h: 1080 },
                    { label: '4:3 (640×480)', w: 640, h: 480 },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        setVideoWidth(preset.w);
                        setVideoHeight(preset.h);
                      }}
                      className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 whitespace-nowrap"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Landing Page & X Player Card Preview */}
              <div className="lg:col-span-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Live Preview
                  </span>
                  <div className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => setPreviewTab('landing')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                        previewTab === 'landing'
                          ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      Embed Player
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewTab('card')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                        previewTab === 'card'
                          ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      X Player Card
                    </button>
                  </div>
                </div>

                {(() => {
                  const previewAttr = getPreviewSourceDomain(videoUrl, publicSettings.domain);
                  const previewPoster = thumbnailUrl.trim() || undefined;
                  return previewTab === 'landing' ? (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-2.5">
                      <VideoPlayer
                        src={videoCheck.valid !== false ? videoUrl : ''}
                        poster={previewPoster}
                        mimeType={videoCheck.mimeType}
                        title={videoTitle}
                        width={videoWidth}
                        height={videoHeight}
                        sourceUrl={previewAttr.sourceUrl}
                        sourceDomain={previewAttr.sourceDomain}
                      />
                      <div className="space-y-1 pt-1">
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 line-clamp-1">
                          {videoTitle.trim() || customAlias.trim() || 'video'}
                        </div>
                        {videoDescription.trim() && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                            {videoDescription}
                          </p>
                        )}
                        {autoRedirectSeconds > 0 && (
                          <div className="text-[11px] font-mono tabular-nums text-indigo-600 dark:text-indigo-400">
                            Countdown timer: {autoRedirectSeconds}s (with Cancel button)
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-2.5">
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 flex items-center justify-between">
                        <span>twitter:card={twitterCardType}</span>
                        <span>{videoWidth > 0 && videoHeight > 0 ? `${videoWidth}×${videoHeight}` : 'Auto aspect'}</span>
                      </div>
                      <VideoPlayer
                        src={videoCheck.valid !== false ? videoUrl : ''}
                        poster={previewPoster}
                        mimeType={videoCheck.mimeType}
                        title={videoTitle}
                        width={videoWidth}
                        height={videoHeight}
                        sourceUrl={previewAttr.sourceUrl}
                        sourceDomain={previewAttr.sourceDomain}
                      />
                    </div>
                  );
                })()}

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Clean aspect-ratio HTML5 embed (<code className="font-mono">/embed/:slug</code>) with real <code className="font-mono">From domain</code> attribution. Inline playback inside X requires X Player Card domain allowlisting and crawler access.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Advanced Settings Drawer */}
        {showAdvanced && (
          <div className="pt-5 border-t border-slate-200 dark:border-slate-800 space-y-4">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Advanced Link & Metadata Settings
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Redirect Status
                </label>
                <select
                  value={redirectType}
                  onChange={(e) => setRedirectType(Number(e.target.value) === 301 ? 301 : 302)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                >
                  <option value={302}>302 Temporary (Default)</option>
                  <option value={301}>301 Permanent</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Expiration Date
                </label>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Password Protection
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editingLink?.hasPassword ? 'Set new password...' : 'Optional passcode'}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
                {editingLink?.hasPassword && (
                  <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={clearPassword}
                      onChange={(e) => setClearPassword(e.target.checked)}
                    />
                    Remove existing password
                  </label>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Link Status
                </label>
                <select
                  value={isActive ? 'active' : 'disabled'}
                  onChange={(e) => setIsActive(e.target.value === 'active')}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                >
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  UTM Source
                </label>
                <input
                  type="text"
                  value={utmSource}
                  onChange={(e) => setUtmSource(e.target.value)}
                  placeholder="twitter"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  UTM Medium
                </label>
                <input
                  type="text"
                  value={utmMedium}
                  onChange={(e) => setUtmMedium(e.target.value)}
                  placeholder="social"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  UTM Campaign
                </label>
                <input
                  type="text"
                  value={utmCampaign}
                  onChange={(e) => setUtmCampaign(e.target.value)}
                  placeholder="q4_launch"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Campaign Name
                </label>
                <input
                  type="text"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="Product Release"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Tags (comma separated)
                </label>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="launch, social"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            {linkType === 'video' && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Custom Player URL (optional HTTPS)
                </label>
                <input
                  type="url"
                  value={playerUrl}
                  onChange={(e) => setPlayerUrl(e.target.value)}
                  placeholder="Defaults to /embed/:slug"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
            )}
          </div>
        )}

        {formError && (
          <div className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-xs text-rose-700 dark:text-rose-300">
            {formError}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap"
          >
            <SlidersHorizontal className="w-4 h-4" />
            {showAdvanced ? 'Hide Advanced Settings' : 'Advanced Settings'}
          </button>

          <div className="flex items-center gap-3">
            {editingLink && onCancelEdit && (
              <button
                type="button"
                onClick={onCancelEdit}
                className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={submitting || aliasStatus.available === false}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 px-6 py-3 text-sm font-semibold text-white transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-indigo-600"
            >
              {submitting
                ? 'Saving...'
                : editingLink
                  ? 'Save Link Changes'
                  : 'Create Short Link'}
            </button>
          </div>
        </div>
      </form>

      {/* Created Link Result Panel */}
      {activeResult && !editingLink && (
        <div className="rounded-2xl border border-indigo-200 dark:border-indigo-900/70 bg-indigo-50/50 dark:bg-indigo-950/20 p-6 flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="min-w-0 space-y-1.5">
            <div className="text-xs font-medium text-indigo-700 dark:text-indigo-300">
              {activeResult.linkType === 'video' && activeResult.previewEnabled
                ? 'Video Preview Short Link Ready'
                : 'Short Link Ready'}
              {' · '}
              HTTP {activeResult.redirectType}
            </div>
            <div className="font-mono text-lg font-semibold text-slate-900 dark:text-white truncate">
              {activeShortUrl}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
              Destination: {activeResult.destinationUrl}
            </div>
            {activeResult.linkType === 'video' && activeResult.previewEnabled && (
              <div className="space-y-1">
                <div className="text-xs text-slate-600 dark:text-slate-300 font-mono truncate">
                  Social Share URL:{' '}
                  <a
                    href={`${origin}/s/${encodeURIComponent(activeResult.slug)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {origin}/s/{activeResult.slug}
                  </a>
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-300 font-mono truncate">
                  Embed Player URL:{' '}
                  <a
                    href={`${origin}/embed/${encodeURIComponent(activeResult.slug)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {origin}/embed/{activeResult.slug}
                  </a>
                </div>
                <div className="text-xs text-indigo-700 dark:text-indigo-300">
                  Short URL redirects browsers directly; social crawlers and <code className="font-mono">/s/{activeResult.slug}</code> serve X Player Card metadata
                  {activeResult.autoRedirectSeconds > 0
                    ? ` · ${activeResult.autoRedirectSeconds}s cancellable timer`
                    : ''}
                  .
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => copyShortUrl(activeShortUrl)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-3.5 py-2 text-xs font-semibold text-white transition-colors whitespace-nowrap"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>

            <button
              type="button"
              onClick={() => setQrModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap"
            >
              <QrCode className="w-3.5 h-3.5" />
              QR Code
            </button>

            <button
              type="button"
              onClick={() => setShareModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap"
            >
              <Share2 className="w-3.5 h-3.5" />
              Share
            </button>

            <a
              href={`/${activeResult.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open Link
            </a>

            {activeResult.linkType === 'video' && activeResult.previewEnabled && (
              <a
                href={`/embed/${encodeURIComponent(activeResult.slug)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap"
              >
                <PlaySquare className="w-3.5 h-3.5" />
                Test /embed
              </a>
            )}

            <button
              type="button"
              onClick={() => navigate('/links')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit Link
            </button>
          </div>
        </div>
      )}

      <Modal
        open={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        title="QR Code Preview"
        subtitle={activeShortUrl}
        maxWidth="xl"
      >
        <QRCodeGenerator initialUrl={activeShortUrl} />
      </Modal>

      <Modal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        title="Share Social Video Link"
        subtitle={activeResult?.linkType === 'video' || activeResult?.previewEnabled ? `${origin}/s/${activeResult?.slug}` : activeShortUrl}
        maxWidth="md"
      >
        {activeResult && (() => {
          const shareUrl = activeResult.linkType === 'video' || activeResult.previewEnabled
            ? `${origin}/s/${encodeURIComponent(activeResult.slug)}`
            : activeShortUrl;
          const shareTitle = activeResult.videoTitle || 'Check out this video';
          return (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs">
                <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Social Sharing URL (serves X Player Card &amp; OpenGraph Video):
                </div>
                <div className="font-mono text-indigo-600 dark:text-indigo-400 break-all select-all">
                  {shareUrl}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <a
                  key="twitter"
                  href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareTitle)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                >
                  X (Twitter)
                </a>
                <a
                  key="facebook"
                  href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                >
                  Facebook
                </a>
                <a
                  key="telegram"
                  href={`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareTitle)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                >
                  Telegram
                </a>
                <a
                  key="whatsapp"
                  href={`https://wa.me/?text=${encodeURIComponent(shareUrl)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                >
                  WhatsApp
                </a>
                <a
                  key="reddit"
                  href={`https://www.reddit.com/submit?url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(shareTitle)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                >
                  Reddit
                </a>
                {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                  <button
                    key="native"
                    type="button"
                    onClick={() => {
                      navigator.share({
                        title: shareTitle,
                        url: shareUrl,
                      }).catch(() => {});
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 px-3 py-2.5 text-xs font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    Native Share
                  </button>
                )}
                <button
                  key="copy"
                  type="button"
                  onClick={() => copyShortUrl(shareUrl)}
                  className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 text-white px-3 py-2.5 text-xs font-semibold hover:bg-indigo-700 col-span-2 sm:col-span-1"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy Share Link
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
