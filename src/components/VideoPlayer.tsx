import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface VideoPlayerProps {
  src: string;
  poster?: string | null;
  mimeType?: string | null;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  showControlsBar?: boolean;
  className?: string;
}

export function VideoPlayer({
  src,
  poster,
  mimeType,
  title,
  width,
  height,
  sourceUrl,
  sourceDomain,
  showControlsBar = true,
  className = '',
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasError, setHasError] = useState(false);
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number }>({
    w: Number(width) > 0 ? Number(width) : 0,
    h: Number(height) > 0 ? Number(height) : 0,
  });

  useEffect(() => {
    setHasError(false);
    setNaturalDims({
      w: Number(width) > 0 ? Number(width) : 0,
      h: Number(height) > 0 ? Number(height) : 0,
    });
  }, [src, width, height]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !src) return;
    el.muted = true;
    el.playsInline = true;
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  }, [src]);

  const w = naturalDims.w;
  const h = naturalDims.h;
  const aspectStyle = w > 0 && h > 0 ? `${w} / ${h}` : undefined;

  if (!src) {
    return (
      <div
        className={`w-full bg-slate-950 text-slate-300 flex flex-col items-center justify-center gap-2 p-6 min-h-[220px] ${className}`}
      >
        <AlertTriangle className="w-6 h-6 text-amber-400" />
        <p className="text-sm font-medium text-center">
          No valid HTTPS MP4 or WebM video URL is configured for this link.
        </p>
      </div>
    );
  }

  if (hasError) {
    return (
      <div
        className={`w-full bg-slate-950 text-slate-100 flex flex-col items-center justify-center gap-3 p-6 text-center min-h-[240px] ${className}`}
      >
        <div className="inline-flex items-center gap-2 text-amber-400 text-sm font-semibold">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Video stream unavailable
        </div>
        <p className="text-xs text-slate-400 max-w-md">
          The configured video stream could not be loaded over HTTPS. Verify direct MP4/WebM streaming and HTTP Range support.
        </p>
        <p className="text-xs font-mono text-slate-500 max-w-md break-all">{src}</p>
        <button
          type="button"
          onClick={() => setHasError(false)}
          className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 whitespace-nowrap"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Retry Playback
        </button>
      </div>
    );
  }

  const inferredType =
    mimeType || (src.toLowerCase().split('?')[0].endsWith('.webm') ? 'video/webm' : 'video/mp4');

  return (
    <div className={`w-full ${className}`}>
      <div className="w-full bg-black flex items-center justify-center overflow-hidden">
        <div
          className="relative w-full max-w-full flex items-center justify-center bg-black"
          style={{
            aspectRatio: aspectStyle,
            maxHeight: '78vh',
          }}
        >
          <video
            ref={videoRef}
            key={src}
            controls={showControlsBar}
            autoPlay
            muted
            playsInline
            loop
            preload="auto"
            poster={poster || undefined}
            aria-label={title || 'Video player'}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              if (el.videoWidth > 0 && el.videoHeight > 0) {
                setNaturalDims({ w: el.videoWidth, h: el.videoHeight });
              }
            }}
            onError={() => setHasError(true)}
            className="w-full h-full max-w-full max-h-[78vh] object-contain bg-black block border-0 rounded-none outline-none"
          >
            <source src={src} type={inferredType} />
            Your browser does not support HTML5 MP4/WebM video playback.
          </video>
        </div>
      </div>

      {sourceUrl && sourceDomain && (
        <div className="pt-2 text-left">
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline"
          >
            From {sourceDomain}
          </a>
        </div>
      )}
    </div>
  );
}
