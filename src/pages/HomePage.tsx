import { ArrowRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { LinkForm } from '../components/LinkForm';

export function HomePage() {
  const { navigate } = useApp();

  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-slate-950">
      <Header />

      <main className="flex-1">
        {/* Hero Section */}
        <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-12 pb-14">
          <div className="max-w-3xl mx-auto text-center space-y-4 mb-10">
            <h1
              className="font-display font-extrabold tracking-tight text-slate-900 dark:text-white leading-[1.1] [text-wrap:balance]"
              style={{ fontSize: 'clamp(2.25rem, 4.5vw, 3.75rem)' }}
            >
              Make Your Links Smarter
            </h1>
            <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 max-w-2xl mx-auto leading-relaxed">
              Shorten URLs, create video previews, manage destinations, and track your link performance.
            </p>
          </div>

          {/* Primary Focal Anchor: Main URL Shortening Form */}
          <div className="max-w-5xl mx-auto">
            <LinkForm />
          </div>
        </section>

        {/* Live Video Preview Showcase */}
        <section className="border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h2 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
                  Aspect-Ratio Preserving X Player Cards
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 max-w-2xl">
                  Serve MP4 and WebM streams at their true portrait, landscape, or square aspect ratio with clean standalone /embed pages and clickable source-domain attribution.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/metadata-debug')}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap shrink-0"
              >
                Inspect X Card Metadata <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {[
                {
                  slug: 'product-tour',
                  title: 'NasirLink Edge Analytics — Portrait Demo (720×1278)',
                  dest: 'cloudflare.com/developer-platform/workers',
                  videoSrc: '/api/sample-video/showcase.mp4',
                  width: 720,
                  height: 1278,
                },
                {
                  slug: 'edge-routing',
                  title: 'Global Edge Routing — Landscape Demo (1290×720)',
                  dest: 'developers.cloudflare.com/d1',
                  videoSrc: '/api/sample-video/showcase1.mp4',
                  width: 1290,
                  height: 720,
                },
              ].map((demo) => (
                <div
                  key={demo.slug}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
                >
                  <div className="bg-black flex items-center justify-center">
                    <video
                      src={demo.videoSrc}
                      autoPlay
                      muted
                      loop
                      playsInline
                      preload="auto"
                      style={{ aspectRatio: `${demo.width} / ${demo.height}` }}
                      className="w-full max-h-[340px] object-contain bg-black block"
                    />
                  </div>
                  <div className="px-5 py-4 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs text-indigo-600 dark:text-indigo-400">
                        /s/{demo.slug} · {demo.width}×{demo.height}
                      </span>
                      <a
                        href={`/s/${demo.slug}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/s/${demo.slug}`);
                        }}
                        className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                      >
                        Open Social Share
                      </a>
                    </div>
                    <div className="font-display font-semibold text-sm text-slate-900 dark:text-white line-clamp-1">
                      {demo.title}
                    </div>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                      Destination: {demo.dest}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Core Capabilities (Clean Editorial Numbering) */}
        <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              {
                num: '01. Smart Routing',
                body: 'Configure custom aliases with real-time availability checks, 301/302 redirect control, expiration schedules, and password gates.',
              },
              {
                num: '02. Video Player Cards',
                body: 'Convert GitHub video blobs to raw MP4/WebM streams and serve OpenGraph & X Player Card meta tags directly from the server.',
              },
              {
                num: '03. Privacy Analytics',
                body: 'Measure daily and hourly clicks, top referrers, devices, and countries using rotating visitor hashes instead of raw IP logs.',
              },
              {
                num: '04. Edge Security',
                body: 'Enforces HTTP/HTTPS validation, blocks private IPs and localhost SSRF targets, and includes rate limiting and abuse moderation.',
              },
            ].map((cap) => (
              <div key={cap.num} className="space-y-2.5 pt-4 border-t border-slate-200 dark:border-slate-800">
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                  {cap.num}
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  {cap.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
