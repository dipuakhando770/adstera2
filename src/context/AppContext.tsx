import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { PublicUser, RedirectStatusCode } from '../shared/types';

interface PublicSettings {
  siteName: string;
  domain: string;
  defaultRedirectType: RedirectStatusCode;
  registrationEnabled: boolean;
  maintenanceMode: boolean;
}

interface AppContextValue {
  user: PublicUser | null;
  authLoading: boolean;
  refreshAuth: () => Promise<void>;
  logout: () => Promise<void>;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  pathname: string;
  navigate: (to: string) => void;
  publicSettings: PublicSettings;
  refreshPublicSettings: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function getInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem('nasirlink_theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [pathname, setPathname] = useState(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );
  const [publicSettings, setPublicSettings] = useState<PublicSettings>({
    siteName: 'NasirLink',
    domain: 'nasirlink.com',
    defaultRedirectType: 302,
    registrationEnabled: true,
    maintenanceMode: false,
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    window.localStorage.setItem('nasirlink_theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user || null);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const refreshPublicSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/public');
      if (res.ok) {
        const data = await res.json();
        setPublicSettings(data);
      }
    } catch {
      // keep defaults
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
  }, []);

  useEffect(() => {
    refreshAuth();
    refreshPublicSettings();
  }, [refreshAuth, refreshPublicSettings]);

  useEffect(() => {
    const onPopState = () => {
      setPathname(window.location.pathname);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history.pushState({}, '', to);
    setPathname(to.split('?')[0]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <AppContext.Provider
      value={{
        user,
        authLoading,
        refreshAuth,
        logout,
        theme,
        toggleTheme,
        pathname,
        navigate,
        publicSettings,
        refreshPublicSettings,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
