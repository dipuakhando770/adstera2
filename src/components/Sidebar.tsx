import {
  BarChart3,
  Code2,
  Home,
  LayoutDashboard,
  Link2,
  LogOut,
  QrCode,
  Settings,
  ShieldCheck,
  Video,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { ThemeSwitcher } from './ThemeSwitcher';

export type DashboardTab =
  | 'overview'
  | 'links'
  | 'video-links'
  | 'analytics'
  | 'metadata-debug'
  | 'qr-codes'
  | 'settings'
  | 'admin';

interface SidebarProps {
  activeTab: DashboardTab;
  onSelectTab: (tab: DashboardTab) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  activeTab,
  onSelectTab,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const { user, logout, navigate, publicSettings } = useApp();

  const items: Array<{
    id: DashboardTab;
    label: string;
    icon: typeof LayoutDashboard;
    adminOnly?: boolean;
  }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'links', label: 'Links', icon: Link2 },
    { id: 'video-links', label: 'Video Links', icon: Video },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'metadata-debug', label: 'Metadata Debug', icon: Code2 },
    { id: 'qr-codes', label: 'QR Codes', icon: QrCode },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'admin', label: 'Admin', icon: ShieldCheck },
  ];

  const handleSelect = (id: DashboardTab) => {
    onSelectTab(id);
    onCloseMobile();
  };

  const navBody = (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 w-64">
      <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2 whitespace-nowrap"
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white text-xs font-bold">
            NL
          </span>
          <span>{publicSettings.siteName}</span>
        </a>
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          aria-label="Close sidebar"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelect(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <ThemeSwitcher showLabel />
          <button
            type="button"
            onClick={() => navigate('/')}
            title="Public Homepage"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Home className="w-4 h-4" />
          </button>
        </div>

        {user ? (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                {user.name}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {user.role === 'admin' ? 'Administrator' : 'Creator'} · {user.email}
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate('/');
              }}
              title="Sign out"
              className="shrink-0 p-2 rounded-lg text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="w-full py-2 px-3 rounded-lg bg-slate-900 dark:bg-slate-800 text-white text-xs font-semibold hover:bg-slate-800 dark:hover:bg-slate-700 transition-colors"
          >
            Sign In / Register
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block shrink-0">{navBody}</aside>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden flex bg-slate-950/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) onCloseMobile();
          }}
        >
          {navBody}
        </div>
      )}
    </>
  );
}
