import React, { useState } from 'react';
import { Lock, PauseCircle, ShieldAlert } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

export function UnlockPage({ slug }: { slug: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/links/${encodeURIComponent(slug)}/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Incorrect password.');
        return;
      }
      window.location.href = data.destinationUrl;
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950">
      <Header />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-7 space-y-5">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                Password Protected Link
              </h1>
              <p className="text-xs font-mono text-slate-500">/{slug}</p>
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          <form onSubmit={handleUnlock} className="space-y-4">
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter link password"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-4 py-2.5 text-sm text-slate-900 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 text-sm font-semibold"
            >
              {loading ? 'Verifying...' : 'Unlock & Continue'}
            </button>
          </form>
        </div>
      </main>
      <Footer />
    </div>
  );
}

export function StatusPage({ state }: { state: 'disabled' | 'expired' | 'not-found' }) {
  const { navigate } = useApp();
  const params =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const slug = params?.get('slug') || '';

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950">
      <Header />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-4">
          {state === 'disabled' ? (
            <PauseCircle className="w-10 h-10 text-amber-500 mx-auto" />
          ) : (
            <ShieldAlert className="w-10 h-10 text-rose-500 mx-auto" />
          )}
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            {state === 'disabled'
              ? 'Link Disabled'
              : state === 'expired'
                ? 'Link Expired'
                : 'Link Not Found'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {slug && <span className="font-mono text-slate-800 dark:text-slate-200">/{slug} · </span>}
            {state === 'disabled'
              ? 'This link has been deactivated by its creator or a platform moderator.'
              : state === 'expired'
                ? 'This link has passed its configured expiration timestamp.'
                : 'We could not find an active destination matching this short link.'}
          </p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
          >
            Back to Homepage
          </button>
        </div>
      </main>
      <Footer />
    </div>
  );
}

export function DocsPage() {
  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-slate-950">
      <Header />
      <main className="flex-1 mx-auto max-w-4xl w-full px-4 sm:px-6 lg:px-8 py-12 space-y-10">
        <div className="space-y-2">
          <h1 className="font-display text-3xl font-bold text-slate-900 dark:text-white">
            NasirLink Architecture & API Reference
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Cloudflare Workers / D1 compatible schema, security validation rules, and REST API endpoints.
          </p>
        </div>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            01. Core API Endpoints
          </h2>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 text-xs font-mono">
            {[
              ['POST /api/links', 'Create normal or video preview link with Zod & SSRF validation'],
              ['GET /api/links', 'Paginated, searchable, filterable link list'],
              ['PUT /api/links/:id', 'Update destination, alias, 301/302, video metadata, UTM, status'],
              ['DELETE /api/links/:id', 'Delete link and cascade analytics clicks'],
              ['GET /api/preview/:slug', 'Fetch public video preview data, OpenGraph/X Card tags, and live audit checks'],
              ['GET /:slug', 'Serves uncloaked SSR video preview landing page when previewEnabled, or 301/302 redirect otherwise'],
              ['GET /v/:slug', 'Canonical video preview landing page with HTML5 player and disclosed destination CTA'],
              ['GET /player/:slug', 'Dedicated iframe-embeddable HTML5 player endpoint for twitter:player (/embed/:slug alias)'],
              ['POST /api/qr', 'Generate customizable PNG & SVG QR codes'],
              ['GET /api/analytics/overview', 'Aggregated dashboard analytics and time-series'],
              ['GET /api/analytics/:id', 'Detailed per-link click, device, browser, and country metrics'],
              ['POST /api/auth/register | login | logout', 'Web Crypto PBKDF2 + HttpOnly session auth'],
              ['GET /api/admin/stats', 'Platform user, link, report, and registration telemetry'],
              ['GET /api/health', 'Runtime and database connectivity probe'],
            ].map(([ep, desc]) => (
              <div key={ep} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <span className="text-indigo-600 dark:text-indigo-400 font-semibold">{ep}</span>
                <span className="font-sans text-slate-600 dark:text-slate-400">{desc}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            02. Security & Redirect Safeguards
          </h2>
          <ul className="list-disc pl-5 text-sm text-slate-600 dark:text-slate-400 space-y-1.5">
            <li>SSRF protection blocks localhost, 127.0.0.0/8, RFC1918 private subnets, 169.254.0.0/16 metadata IPs, and non-HTTP(S) schemes.</li>
            <li>Video preview pages disclose the exact destination domain and never hijack video clicks for hidden redirects.</li>
            <li>Visitor tracking hashes IP + User-Agent with a daily salt so raw IP addresses are never stored permanently.</li>
          </ul>
        </section>
      </main>
      <Footer />
    </div>
  );
}
