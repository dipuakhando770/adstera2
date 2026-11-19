import React, { useEffect, useState } from 'react';
import { CheckCircle2, Code2, ExternalLink, PlaySquare, RefreshCw, ShieldAlert } from 'lucide-react';
import type { LinkRecord, SocialMetadataPreview, VideoStreamAudit } from '../shared/types';
import { useToast } from './Toast';
import { VideoPlayer } from './VideoPlayer';

interface MetadataDebuggerProps {
  initialSlug?: string;
  videoLinks?: LinkRecord[];
}

export function MetadataDebugger({ initialSlug = '', videoLinks = [] }: MetadataDebuggerProps) {
  const { notify } = useToast();
  const [links, setLinks] = useState<LinkRecord[]>(videoLinks);
  const [selectedSlug, setSelectedSlug] = useState(initialSlug);
  const [previewLink, setPreviewLink] = useState<LinkRecord | null>(null);
  const [metadata, setMetadata] = useState<SocialMetadataPreview | null>(null);
  const [audit, setAudit] = useState<VideoStreamAudit | null>(null);
  const [rawServerTags, setRawServerTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Admin / Owner Inline Metadata Editor State
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [autoRedirectSeconds, setAutoRedirectSeconds] = useState(0);
  const [playerUrl, setPlayerUrl] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [twitterCardType, setTwitterCardType] = useState<'player' | 'summary_large_image'>('player');
  const [playerWidth, setPlayerWidth] = useState(0);
  const [playerHeight, setPlayerHeight] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (videoLinks.length > 0) {
      setLinks(videoLinks);
      if (!selectedSlug) setSelectedSlug(videoLinks[0].slug);
    } else {
      fetch('/api/links?type=video&pageSize=30', { credentials: 'include' })
        .then((r) => r.json())
        .then((d) => {
          const list: LinkRecord[] = d.links || [];
          setLinks(list);
          if (!selectedSlug && list.length > 0) setSelectedSlug(list[0].slug);
        })
        .catch(() => {});
    }
  }, [videoLinks, selectedSlug]);

  useEffect(() => {
    if (initialSlug) setSelectedSlug(initialSlug);
  }, [initialSlug]);

  const inspectSlug = async (slugToInspect: string) => {
    if (!slugToInspect) return;
    setLoading(true);
    try {
      const [apiRes, htmlRes] = await Promise.all([
        fetch(`/api/preview/${encodeURIComponent(slugToInspect)}?audit=1`),
        fetch(`/s/${encodeURIComponent(slugToInspect)}`),
      ]);

      if (apiRes.ok) {
        const json = await apiRes.json();
        const l: LinkRecord = json.link;
        const meta: SocialMetadataPreview = json.metadata;
        setPreviewLink(l);
        setMetadata(meta);
        setAudit(json.audit || null);
        setPreviewEnabled(l.previewEnabled);
        setAutoRedirectSeconds(l.autoRedirectSeconds ?? 0);
        setPlayerUrl(l.playerUrl || '');
        setThumbnailUrl(l.thumbnailUrl || '');
        setTwitterCardType(l.twitterCardType || 'player');
        setPlayerWidth(l.videoWidth || meta?.twitterPlayerWidth || 0);
        setPlayerHeight(l.videoHeight || meta?.twitterPlayerHeight || 0);
        setVideoUrl(l.videoUrl || '');
        setTitle(l.videoTitle || '');
        setDescription(l.videoDescription || '');
      }

      if (htmlRes.ok) {
        const htmlText = await htmlRes.text();
        const matches =
          htmlText.match(/<meta\s+(?:name|property)=["'](?:twitter:|og:)[^"']*["'][^>]*>/gi) || [];
        setRawServerTags(matches);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedSlug) inspectSlug(selectedSlug);
  }, [selectedSlug]);

  const handleSaveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!previewLink) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/links/${previewLink.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          previewEnabled,
          autoRedirectSeconds: Number(autoRedirectSeconds) || 0,
          twitterCardType,
          playerUrl: playerUrl.trim() || null,
          videoWidth: playerWidth > 0 ? Number(playerWidth) : null,
          videoHeight: playerHeight > 0 ? Number(playerHeight) : null,
          videoUrl: videoUrl.trim(),
          thumbnailUrl: thumbnailUrl.trim() || null,
          videoTitle: title.trim() || null,
          videoDescription: description.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || 'Could not update metadata', 'error');
      } else {
        notify('Server-rendered X Player Card metadata updated', 'success');
        window.dispatchEvent(new CustomEvent('nasirlink:data-changed'));
        inspectSlug(selectedSlug);
      }
    } finally {
      setSaving(false);
    }
  };

  const livePreviewTitle = title.trim() || metadata?.title || '';
  const livePreviewDesc = description.trim() || metadata?.description || '';
  const displayWidth = playerWidth > 0 ? playerWidth : metadata?.twitterPlayerWidth || 0;
  const displayHeight = playerHeight > 0 ? playerHeight : metadata?.twitterPlayerHeight || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
            X / Twitter Video Player Card &amp; Metadata Debugger
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Inspects live server-rendered X Player Card HTML from <code className="font-mono">/s/:slug</code> and <code className="font-mono">/:slug</code> crawlers. Inline X feed playback depends on X Player Card domain allowlisting and crawler access.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-200"
          >
            {links.length === 0 && <option value="">No video links found</option>}
            {links.map((l) => (
              <option key={l.id} value={l.slug}>
                /{l.slug} — {l.videoTitle || l.destinationUrl}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => inspectSlug(selectedSlug)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Inspect Live HTML
          </button>

          {selectedSlug && (
            <>
              <a
                href={`/embed/${encodeURIComponent(selectedSlug)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <PlaySquare className="w-3.5 h-3.5" />
                Test /embed
              </a>
              <a
                href={`/s/${encodeURIComponent(selectedSlug)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-3 py-2 text-xs font-semibold text-white whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open /s/{selectedSlug}
              </a>
            </>
          )}
        </div>
      </div>

      {metadata && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Aspect-Ratio Preserved X Player Card Preview + Stream Audit */}
          <div className="lg:col-span-6 space-y-6">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  X Player Card Preview ({metadata.twitterCard})
                </span>
                <span className="font-mono tabular-nums">
                  {displayWidth > 0 && displayHeight > 0
                    ? `${displayWidth}×${displayHeight}`
                    : 'Auto aspect'}
                </span>
              </div>

              {metadata.videoError && (
                <div className="rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  {metadata.videoError}
                </div>
              )}

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
                <VideoPlayer
                  src={metadata.ogVideo}
                  poster={thumbnailUrl.trim() || metadata.ogImage || `/poster/${encodeURIComponent(selectedSlug)}.jpg`}
                  mimeType={metadata.ogVideoType}
                  title={livePreviewTitle}
                  width={metadata.twitterPlayerWidth || displayWidth}
                  height={metadata.twitterPlayerHeight || displayHeight}
                  sourceUrl={metadata.sourceUrl}
                  sourceDomain={metadata.sourceDomain}
                />
              </div>

              {/* Validation Results */}
              <div className="space-y-2.5 pt-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  X Player Card Validation Checks
                </div>
                {metadata.checks?.map((chk) => (
                  <div
                    key={chk.id}
                    className="flex items-start gap-2.5 text-xs border-b border-slate-100 dark:border-slate-800/80 pb-2 last:border-b-0"
                  >
                    {chk.passed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 dark:text-slate-200">
                        {chk.label}
                      </div>
                      <div className="text-slate-500 dark:text-slate-400 font-mono break-all">
                        {chk.detail}
                      </div>
                    </div>
                  </div>
                ))}

                {audit && (
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                        Live Stream &amp; Container Audit
                      </span>
                      <span
                        className={`text-[11px] font-mono font-semibold ${
                          audit.xCrawlerReady ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'
                        }`}
                      >
                        {audit.xCrawlerReady ? 'Crawler Ready' : 'Needs Review'}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs font-mono">
                      <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                        <div className="text-slate-500">Video Stream</div>
                        <div className={audit.videoReachable ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-amber-600'}>
                          HTTP {audit.videoStatus ?? 'ERR'} · {audit.videoHttps ? 'HTTPS' : 'HTTP'}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate mt-0.5">
                          {audit.videoMimeType || 'unknown MIME'}
                          {audit.codec ? ` (${audit.codec})` : ''}
                        </div>
                      </div>

                      <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                        <div className="text-slate-500">HTTP Range 206</div>
                        <div className={audit.rangeSupported ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-amber-600'}>
                          {audit.rangeSupported ? `206 Supported` : `Status ${audit.rangeStatus ?? 'N/A'}`}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {audit.faststart === true
                            ? 'moov faststart OK'
                            : audit.faststart === false
                              ? 'moov at EOF'
                              : 'Container checked'}
                        </div>
                      </div>

                      <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                        <div className="text-slate-500">Embed Player</div>
                        <div className={audit.playerReachable ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-amber-600'}>
                          HTTP {audit.playerStatus ?? 'ERR'} · {audit.playerHttps ? 'HTTPS' : 'HTTP'}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {audit.detectedWidth && audit.detectedHeight
                            ? `Real ${audit.detectedWidth}×${audit.detectedHeight}`
                            : 'Header dims N/A'}
                        </div>
                      </div>
                    </div>

                    {audit.warnings.length > 0 && (
                      <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-1">
                        {audit.warnings.map((w, idx) => (
                          <div key={idx}>{w}</div>
                        ))}
                      </div>
                    )}

                    {audit.errors.length > 0 && (
                      <div className="rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 space-y-1">
                        {audit.errors.map((err, idx) => (
                          <div key={idx}>{err}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Raw Server HTML Response Inspector */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-1.5">
                  <Code2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  Server-Rendered HTML Tags ({rawServerTags.length} verified on /s/{selectedSlug})
                </span>
              </div>
              <pre className="rounded-lg bg-slate-950 text-slate-200 p-3.5 text-[11px] font-mono overflow-x-auto leading-relaxed max-h-64">
                {rawServerTags.length > 0
                  ? rawServerTags.join('\n')
                  : metadata.renderedMetaHtml}
              </pre>
            </div>
          </div>

          {/* Right: Admin Metadata Editor */}
          <form
            onSubmit={handleSaveMetadata}
            className="lg:col-span-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4"
          >
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                X Player Card Editor
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Configure stream dimensions and Player Card metadata for <code className="font-mono">/s/{selectedSlug}</code> and <code className="font-mono">/embed/{selectedSlug}</code>.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3.5 py-2.5">
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={previewEnabled}
                  onChange={(e) => setPreviewEnabled(e.target.checked)}
                />
                Social Video Preview Enabled
              </label>

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">Auto-Redirect:</span>
                <select
                  value={autoRedirectSeconds}
                  onChange={(e) => setAutoRedirectSeconds(Number(e.target.value))}
                  className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-900 dark:text-slate-100"
                >
                  <option value={0}>Off</option>
                  <option value={5}>5s</option>
                  <option value={10}>10s</option>
                  <option value={15}>15s</option>
                  <option value={30}>30s</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Player Width (px)
                </label>
                <input
                  type="number"
                  min={160}
                  max={3840}
                  value={playerWidth > 0 ? playerWidth : ''}
                  placeholder="Auto-detect"
                  onChange={(e) => setPlayerWidth(e.target.value ? Number(e.target.value) : 0)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Player Height (px)
                </label>
                <input
                  type="number"
                  min={90}
                  max={3840}
                  value={playerHeight > 0 ? playerHeight : ''}
                  placeholder="Auto-detect"
                  onChange={(e) => setPlayerHeight(e.target.value ? Number(e.target.value) : 0)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Player URL (twitter:player)
              </label>
              <input
                type="text"
                value={playerUrl}
                onChange={(e) => setPlayerUrl(e.target.value)}
                placeholder={`${window.location.origin}/embed/${selectedSlug}`}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Direct Video URL (og:video &amp; twitter:player:stream)
              </label>
              <input
                type="text"
                required
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Poster / Thumbnail URL (twitter:image &amp; og:image)
                </label>
                <input
                  type="text"
                  value={thumbnailUrl}
                  onChange={(e) => setThumbnailUrl(e.target.value)}
                  placeholder={`${window.location.origin}/poster/${selectedSlug}.jpg`}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  X Card Type (twitter:card)
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
                  <option value="player">player</option>
                  <option value="summary_large_image">summary_large_image</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Video Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Video Description
              </label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="space-y-1.5 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Pre-Publish X Player Card Metadata Preview
              </div>
              <pre className="rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 text-[11px] font-mono text-slate-700 dark:text-slate-300 overflow-x-auto leading-relaxed">
                {[
                  `<meta name="twitter:card" content="${twitterCardType}" />`,
                  `<meta name="twitter:title" content="${livePreviewTitle}" />`,
                  `<meta name="twitter:description" content="${livePreviewDesc}" />`,
                  `<meta name="twitter:image" content="${thumbnailUrl.trim() || metadata.twitterImage || `${window.location.origin}/poster/${selectedSlug}.jpg`}" />`,
                  `<meta name="twitter:player" content="${playerUrl.trim() || `${window.location.origin}/embed/${selectedSlug}`}" />`,
                  ...(displayWidth > 0 && displayHeight > 0
                    ? [
                        `<meta name="twitter:player:width" content="${displayWidth}" />`,
                        `<meta name="twitter:player:height" content="${displayHeight}" />`,
                      ]
                    : []),
                  `<meta name="twitter:player:stream" content="${videoUrl.trim() || metadata.twitterPlayerStream}" />`,
                  `<meta name="twitter:player:stream:content_type" content="${metadata.twitterPlayerStreamContentType || 'video/mp4'}" />`,
                  `<meta property="og:type" content="video.other" />`,
                  `<meta property="og:image" content="${thumbnailUrl.trim() || metadata.ogImage || `${window.location.origin}/poster/${selectedSlug}.jpg`}" />`,
                  `<meta property="og:video" content="${videoUrl.trim() || metadata.ogVideo}" />`,
                ].join('\n')}
              </pre>
            </div>

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 px-5 py-2.5 text-xs font-semibold text-white transition-colors"
              >
                {saving ? 'Publishing...' : 'Publish Metadata Changes'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
