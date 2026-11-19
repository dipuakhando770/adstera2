export interface CapturedVideoMetadata {
  width: number;
  height: number;
  thumbnailDataUrl: string | null;
}

const MAX_POSTER_EDGE = 640;
const MAX_DATA_URL_LENGTH = 180_000;

export function captureVideoFrameAndDims(
  videoUrl: string,
  options?: { captureFrame?: boolean; timeoutMs?: number }
): Promise<CapturedVideoMetadata> {
  const captureFrame = options?.captureFrame !== false;
  const timeoutMs = options?.timeoutMs ?? 8000;

  if (typeof document === 'undefined' || !videoUrl.trim()) {
    return Promise.resolve({ width: 0, height: 0, thumbnailDataUrl: null });
  }

  return new Promise((resolve) => {
    let settled = false;
    let triedWithoutCors = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = captureFrame ? 'auto' : 'metadata';
    if (captureFrame) {
      video.crossOrigin = 'anonymous';
    }

    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // ignore cleanup errors
      }
    };

    const finish = (result: CapturedVideoMetadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const drawCurrentFrame = (): string | null => {
      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      if (!vw || !vh) return null;
      const scale = Math.min(1, MAX_POSTER_EDGE / Math.max(vw, vh));
      const targetW = Math.max(160, Math.round(vw * scale));
      const targetH = Math.max(90, Math.round(vh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      try {
        ctx.drawImage(video, 0, 0, targetW, targetH);
        let dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        if (dataUrl.length > MAX_DATA_URL_LENGTH) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.65);
        }
        return dataUrl.length <= MAX_DATA_URL_LENGTH ? dataUrl : null;
      } catch {
        return null;
      }
    };

    const onLoadedMetadata = () => {
      if (!captureFrame) {
        finish({
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          thumbnailDataUrl: null,
        });
      }
    };

    const onLoadedData = () => {
      if (!captureFrame) return;
      if (triedWithoutCors) {
        finish({
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          thumbnailDataUrl: null,
        });
        return;
      }
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const targetSeek = duration > 0.4 ? Math.min(0.2, duration * 0.1) : 0;
      if (targetSeek > 0.02) {
        try {
          video.currentTime = targetSeek;
          return;
        } catch {
          // fall through to drawing frame 0 immediately
        }
      }
      const thumb = drawCurrentFrame();
      finish({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        thumbnailDataUrl: thumb,
      });
    };

    const onSeeked = () => {
      if (!captureFrame || triedWithoutCors) return;
      const thumb = drawCurrentFrame();
      finish({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        thumbnailDataUrl: thumb,
      });
    };

    const onError = () => {
      if (captureFrame && !triedWithoutCors) {
        // Retry without crossOrigin so dimensions can still be read on CORS-restricted hosts
        triedWithoutCors = true;
        video.removeAttribute('crossorigin');
        video.preload = 'metadata';
        video.src = videoUrl;
        return;
      }
      finish({ width: 0, height: 0, thumbnailDataUrl: null });
    };

    const timer = setTimeout(() => {
      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      const thumb = captureFrame && !triedWithoutCors && video.readyState >= 2 ? drawCurrentFrame() : null;
      finish({ width: vw, height: vh, thumbnailDataUrl: thumb });
    }, timeoutMs);

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.src = videoUrl;
  });
}
