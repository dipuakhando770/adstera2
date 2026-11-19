import React from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  helper?: string;
  accent?: 'indigo' | 'violet' | 'cyan' | 'emerald';
}

export function StatCard({ label, value, helper, accent = 'indigo' }: StatCardProps) {
  const accentText =
    accent === 'cyan'
      ? 'text-cyan-600 dark:text-cyan-400'
      : accent === 'violet'
        ? 'text-violet-600 dark:text-violet-400'
        : accent === 'emerald'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-indigo-600 dark:text-indigo-400';

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-2 font-mono text-2xl sm:text-3xl font-semibold tabular-nums ${accentText}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {helper && (
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 truncate">
          {helper}
        </div>
      )}
    </div>
  );
}
