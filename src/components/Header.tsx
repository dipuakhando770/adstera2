import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { ThemeSwitcher } from './ThemeSwitcher';

export function Header() {
  const { user, pathname, navigate, publicSettings } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { label: 'Shortener', href: '/' },
    { label: 'Video Links', href: '/video-links' },
    { label: 'Analytics', href: '/analytics' },
    { label: 'Dashboard', href: '/dashboard' },
  ];

  const handleNav = (href: string) => {
    setMobileOpen(false);
    navigate(href);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-950/95 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Brand Wordmark */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            handleNav('/');
          }}
          className="font-display text-xl font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 flex items-center gap-2"
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white text-xs font-bold">
            NL
          </span>
          <span>{publicSettings.siteName}</span>
        </a>

        {/* Zone 2: 4 Single-line Text Navigation Links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-300">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={(e) => {
                  e.preventDefault();
                  handleNav(item.href);
                }}
                className={`whitespace-nowrap shrink-0 transition-colors hover:text-indigo-600 dark:hover:text-indigo-400 ${
                  active
                    ? 'text-indigo-600 dark:text-indigo-400 font-semibold underline decoration-indigo-500/60 underline-offset-8'
                    : ''
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* Zone 3: 1 Primary Action + Theme Switcher */}
        <div className="hidden md:flex items-center gap-3 shrink-0">
          <ThemeSwitcher />
          {user ? (
            <button
              type="button"
              onClick={() => handleNav(user.role === 'admin' ? '/admin' : '/dashboard')}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-indigo-600"
            >
              {user.role === 'admin' ? 'Admin Console' : 'Open Dashboard'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleNav('/login')}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-indigo-600"
            >
              Sign In
            </button>
          )}
        </div>

        {/* Mobile Menu Trigger */}
        <div className="flex md:hidden items-center gap-2 shrink-0">
          <ThemeSwitcher />
          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label="Toggle navigation menu"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 py-4 space-y-2">
          {navItems.map((item) => (
            <button
              key={item.href}
              type="button"
              onClick={() => handleNav(item.href)}
              className={`block w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium ${
                pathname === item.href
                  ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => handleNav(user ? '/dashboard' : '/login')}
              className="w-full px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700"
            >
              {user ? 'Open Dashboard' : 'Sign In'}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
