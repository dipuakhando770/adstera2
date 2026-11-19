import { useApp } from '../context/AppContext';

export function Footer() {
  const { navigate, publicSettings } = useApp();

  return (
    <footer className="border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 mt-auto">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div className="space-y-1.5">
          <div className="font-display text-base font-bold text-slate-900 dark:text-white">
            {publicSettings.siteName}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Smart URL shortening, transparent video previews, and privacy-friendly analytics · Edge-ready architecture
          </p>
        </div>

        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-medium text-slate-600 dark:text-slate-400">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            Shortener
          </a>
          <a
            href="/dashboard"
            onClick={(e) => {
              e.preventDefault();
              navigate('/dashboard');
            }}
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            Dashboard
          </a>
          <a
            href="/metadata-debug"
            onClick={(e) => {
              e.preventDefault();
              navigate('/metadata-debug');
            }}
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            X Card Debugger
          </a>
          <a
            href="/qr-codes"
            onClick={(e) => {
              e.preventDefault();
              navigate('/qr-codes');
            }}
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            QR Studio
          </a>
          <a
            href="/docs"
            onClick={(e) => {
              e.preventDefault();
              navigate('/docs');
            }}
            className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            Documentation
          </a>
          <span className="text-slate-400 dark:text-slate-600">
            © {new Date().getFullYear()} {publicSettings.siteName}
          </span>
        </nav>
      </div>
    </footer>
  );
}
