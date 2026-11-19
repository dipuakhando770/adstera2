import { useEffect, useRef, useState } from 'react';
import type { LinkRecord, SocialMetadataPreview } from '../shared/types';

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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const initialBoot = getBootstrappedPreview(slug);
  const [link, setLink] = useState<LinkRecord | null>(initialBoot?.link || null);
  const [metadata, setMetadata] = useState<SocialMetadataPreview | null>(initialBoot?.metadata || null);
  const [isExpired, setIsExpired] = useState(Boolean(initialBoot?.isExpired));
  const [loading, setLoading] = useState(!initialBoot?.link);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const boot = getBootstrappedPreview(slug);
    if (boot?.link) {
      setLink(boot.link);
      setMetadata(boot.metadata || null);
      setIsExpired(Boolean(boot.isExpired));
      setLoading(false);
      setNotFound(false);
      return;
    }

    setLoading(true);
    setNotFound(false);
    fetch(`/api/preview/${encodeURIComponent(slug)}?track=1`)
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = await res.json();
        setLink(data.link);
        setMetadata(data.metadata || null);
        setIsExpired(Boolean(data.isExpired));
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  // Automatic playback attempt on video element
  const videoSrc = metadata?.ogVideo || link?.videoUrl || '';
  const videoMime = metadata?.ogVideoType || link?.videoMimeType || 'video/mp4';

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoSrc) return;

    const startPlayback = () => {
      el.defaultMuted = true;
      el.muted = true;
      el.playsInline = true;
      const playPromise = el.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          // Silent catch: never display blocking UI or force audio
        });
      }
    };

    startPlayback();
    el.addEventListener('loadedmetadata', startPlayback);
    el.addEventListener('loadeddata', startPlayback);
    el.addEventListener('canplay', startPlayback);
    el.addEventListener('canplaythrough', startPlayback);
    window.addEventListener('focus', startPlayback);
    document.addEventListener('touchstart', startPlayback, { passive: true, once: true });
    document.addEventListener('click', startPlayback, { passive: true, once: true });

    return () => {
      el.removeEventListener('loadedmetadata', startPlayback);
      el.removeEventListener('loadeddata', startPlayback);
      el.removeEventListener('canplay', startPlayback);
      el.removeEventListener('canplaythrough', startPlayback);
      window.removeEventListener('focus', startPlayback);
      document.removeEventListener('touchstart', startPlayback);
      document.removeEventListener('click', startPlayback);
    };
  }, [videoSrc]);

  // Background auto-redirect timer if configured (without visible banner)
  useEffect(() => {
    if (!link || !link.isActive || isExpired || !link.autoRedirectSeconds || link.autoRedirectSeconds <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      window.location.assign(link.destinationUrl);
    }, link.autoRedirectSeconds * 1000);
    return () => clearTimeout(timer);
  }, [link, isExpired]);

  // User click on the fullscreen video redirects to the destination URL
  const handleRedirect = () => {
    if (link?.destinationUrl) {
      window.location.assign(link.destinationUrl);
    }
  };

  if (loading) {
    return <div className="fixed inset-0 w-screen h-[100dvh] bg-black" />;
  }

  if (notFound || !link) {
    return (
      <div className="fixed inset-0 w-screen h-[100dvh] bg-black flex items-center justify-center p-6 text-center text-slate-400 font-sans text-sm">
        Video not found
      </div>
    );
  }

  if (!link.isActive || isExpired) {
    return (
      <div className="fixed inset-0 w-screen h-[100dvh] bg-black flex items-center justify-center p-6 text-center text-slate-400 font-sans text-sm">
        {isExpired ? 'This video link has expired.' : 'This video link is unavailable.'}
      </div>
    );
  }

  if (!videoSrc) {
    return (
      <div
        onClick={handleRedirect}
        className="fixed inset-0 w-screen h-[100dvh] bg-black flex items-center justify-center cursor-pointer"
      />
    );
  }

  return (
    <div
      onClick={handleRedirect}
      className="fixed inset-0 w-screen h-[100dvh] max-w-[100vw] max-h-[100dvh] bg-black overflow-hidden flex items-center justify-center cursor-pointer select-none m-0 p-0"
    >
      <video
        ref={videoRef}
        key={videoSrc}
        autoPlay
        muted
        playsInline
        webkit-playsinline="true"
        loop
        controls={false}
        disablePictureInPicture
        preload="auto"
        style={{
          width: '100vw',
          height: '100dvh',
          maxWidth: '100vw',
          maxHeight: '100dvh',
          objectFit: 'contain',
          display: 'block',
          background: '#000000',
          border: 'none',
          outline: 'none',
        }}
      >
        <source src={videoSrc} type={videoMime} />
      </video>
    </div>
  );
}
