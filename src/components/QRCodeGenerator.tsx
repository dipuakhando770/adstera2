import React, { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, QrCode, RefreshCw, Trash2 } from 'lucide-react';
import type { LinkRecord } from '../shared/types';
import { useToast } from './Toast';

interface QRCodeGeneratorProps {
  initialUrl?: string;
  links?: LinkRecord[];
}

type LogoMode = 'none' | 'text' | 'image';

async function rasterizeImageToSquarePngDataUrl(file: File, size = 128): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');

    ctx.clearRect(0, 0, size, size);
    const scale = Math.min(size / img.width, size / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const dx = (size - drawW) / 2;
    const dy = (size - drawH) / 2;
    ctx.drawImage(img, dx, dy, drawW, drawH);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function QRCodeGenerator({ initialUrl = '', links = [] }: QRCodeGeneratorProps) {
  const { notify } = useToast();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://nasirlink.com';
  const [url, setUrl] = useState(initialUrl || `${origin}/product-tour`);
  const [fgColor, setFgColor] = useState('#0F172A');
  const [bgColor, setBgColor] = useState('#FFFFFF');
  const [logoMode, setLogoMode] = useState<LogoMode>('text');
  const [logoText, setLogoText] = useState('NL');
  const [logoDataUrl, setLogoDataUrl] = useState<string>('');
  const [logoFileName, setLogoFileName] = useState<string>('');
  const [svgMarkup, setSvgMarkup] = useState('');
  const [pngDataUrl, setPngDataUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialUrl) setUrl(initialUrl);
  }, [initialUrl]);

  const includeLogo = logoMode === 'text' || (logoMode === 'image' && Boolean(logoDataUrl));

  const generateQr = async (targetUrl = url) => {
    if (!targetUrl.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl.trim(),
          fgColor,
          bgColor,
          size: 360,
          includeLogo,
          logoText: logoText.trim() || 'NL',
          logoDataUrl: logoMode === 'image' && logoDataUrl ? logoDataUrl : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || 'Failed to generate QR code', 'error');
      } else {
        setSvgMarkup(data.svg);
        setPngDataUrl(data.pngDataUrl);
      }
    } catch {
      notify('Network error generating QR code', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      generateQr(url);
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, fgColor, bgColor, logoMode, logoText, logoDataUrl]);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      notify('Logo image must be under 4 MB', 'error');
      return;
    }
    try {
      const encoded = await rasterizeImageToSquarePngDataUrl(file, 128);
      setLogoDataUrl(encoded);
      setLogoFileName(file.name);
      setLogoMode('image');
      notify('Custom logo embedded in QR code', 'success');
    } catch {
      notify('Could not process logo image', 'error');
    }
  };

  const clearUploadedLogo = () => {
    setLogoDataUrl('');
    setLogoFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setLogoMode('text');
  };

  const downloadSvg = () => {
    if (!svgMarkup) return;
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nasirlink-qr-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify('QR SVG downloaded', 'success');
  };

  const downloadPng = async () => {
    if (!svgMarkup && !pngDataUrl) return;
    try {
      if (svgMarkup) {
        const size = 720;
        const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
        const blobUrl = URL.createObjectURL(svgBlob);
        try {
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('SVG rasterize failed'));
            img.src = blobUrl;
          });
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, size, size);
            ctx.drawImage(img, 0, 0, size, size);
            const outUrl = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = outUrl;
            a.download = `nasirlink-qr-${Date.now()}.png`;
            a.click();
            notify('QR PNG downloaded', 'success');
            return;
          }
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }
    } catch {
      // Fallback to baseline server PNG data URL if browser SVG rasterization fails
    }

    if (!pngDataUrl) return;
    const a = document.createElement('a');
    a.href = pngDataUrl;
    a.download = `nasirlink-qr-${Date.now()}.png`;
    a.click();
    notify('QR PNG downloaded', 'success');
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              QR Code Studio
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Customize foreground, background, and embedded center logo for your short links.
            </p>
          </div>
          <QrCode className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
        </div>

        {links.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Select Saved Link
            </label>
            <select
              onChange={(e) => {
                if (e.target.value) setUrl(e.target.value);
              }}
              value=""
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-2 focus:outline-indigo-600"
            >
              <option value="">Choose a short link or video link...</option>
              {links.map((l) => {
                const target = `${origin}/${l.slug}`;
                return (
                  <option key={l.id} value={target}>
                    /{l.slug} {l.linkType === 'video' ? '(Video Embed)' : ''} — {l.videoTitle || l.destinationUrl}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
            Target Short URL
          </label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://nasirlink.com/abc123"
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-2 focus:outline-indigo-600"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Foreground Color
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={fgColor}
                onChange={(e) => setFgColor(e.target.value)}
                className="h-9 w-11 rounded border border-slate-200 dark:border-slate-700 cursor-pointer bg-transparent"
              />
              <input
                type="text"
                value={fgColor}
                onChange={(e) => setFgColor(e.target.value)}
                className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Background Color
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={bgColor}
                onChange={(e) => setBgColor(e.target.value)}
                className="h-9 w-11 rounded border border-slate-200 dark:border-slate-700 cursor-pointer bg-transparent"
              />
              <input
                type="text"
                value={bgColor}
                onChange={(e) => setBgColor(e.target.value)}
                className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
        </div>

        <div className="space-y-3 pt-3 border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Center Embedded Logo
            </span>
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5">
              {(
                [
                  { id: 'none', label: 'None' },
                  { id: 'text', label: 'Monogram' },
                  { id: 'image', label: 'Custom Image' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setLogoMode(m.id)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    logoMode === m.id
                      ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {logoMode === 'text' && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-3 py-2.5">
              <span className="text-xs text-slate-600 dark:text-slate-400">
                Center Monogram (up to 4 characters)
              </span>
              <input
                type="text"
                maxLength={4}
                value={logoText}
                onChange={(e) => setLogoText(e.target.value.toUpperCase())}
                className="w-20 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-mono text-center text-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          {logoMode === 'image' && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-3 py-2.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={handleLogoUpload}
                className="hidden"
              />
              {logoDataUrl ? (
                <div className="flex items-center gap-3 min-w-0">
                  <img
                    src={logoDataUrl}
                    alt="Embedded logo preview"
                    className="w-8 h-8 rounded object-contain border border-slate-200 dark:border-slate-700 bg-white"
                  />
                  <span className="text-xs text-slate-700 dark:text-slate-300 truncate max-w-[180px]">
                    {logoFileName || 'Custom logo'}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Upload a square PNG, JPG, WebP, or SVG mark
                </span>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap"
                >
                  <ImagePlus className="w-3.5 h-3.5" />
                  {logoDataUrl ? 'Replace Logo' : 'Upload Logo'}
                </button>
                {logoDataUrl && (
                  <button
                    type="button"
                    onClick={clearUploadedLogo}
                    title="Remove uploaded logo"
                    className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 p-1.5 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 flex flex-col items-center gap-5">
        <div className="w-full flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Live QR Preview (Error Correction H)
          </span>
          <button
            type="button"
            onClick={() => generateQr(url)}
            className="inline-flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div
          className="w-64 h-64 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center overflow-hidden p-3"
          style={{ backgroundColor: bgColor }}
        >
          {svgMarkup ? (
            <div
              className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
              dangerouslySetInnerHTML={{ __html: svgMarkup }}
            />
          ) : (
            <span className="text-xs text-slate-400">Generating QR code...</span>
          )}
        </div>

        <div className="w-full grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={downloadPng}
            disabled={!svgMarkup && !pngDataUrl}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 px-4 py-2.5 text-xs font-semibold text-white transition-colors"
          >
            <Download className="w-4 h-4" />
            Download PNG
          </button>
          <button
            type="button"
            onClick={downloadSvg}
            disabled={!svgMarkup}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 px-4 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors"
          >
            <Download className="w-4 h-4" />
            Download SVG
          </button>
        </div>
      </div>
    </div>
  );
}
