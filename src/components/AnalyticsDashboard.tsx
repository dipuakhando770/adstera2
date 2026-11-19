import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AnalyticsOverview, LinkRecord } from '../shared/types';
import { StatCard } from './StatCard';
import { BarChart, ChartCard, DonutChart, LineAreaChart } from './ChartCard';

interface AnalyticsDashboardProps {
  initialLinkId?: string | null;
  links?: LinkRecord[];
}

export function AnalyticsDashboard({ initialLinkId = null, links = [] }: AnalyticsDashboardProps) {
  const [selectedLinkId, setSelectedLinkId] = useState<string>(initialLinkId || '');
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartTab, setChartTab] = useState<'daily' | 'hourly'>('daily');

  useEffect(() => {
    if (initialLinkId !== null && initialLinkId !== undefined) {
      setSelectedLinkId(initialLinkId);
    }
  }, [initialLinkId]);

  const loadAnalytics = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const endpoint = selectedLinkId
          ? `/api/analytics/${encodeURIComponent(selectedLinkId)}`
          : '/api/analytics/overview';
        const res = await fetch(endpoint, { credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          setData(json);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [selectedLinkId]
  );

  useEffect(() => {
    loadAnalytics(false);
  }, [loadAnalytics]);

  useEffect(() => {
    const onRefresh = () => {
      loadAnalytics(true);
    };
    window.addEventListener('nasirlink:data-changed', onRefresh);
    window.addEventListener('focus', onRefresh);
    const interval = setInterval(onRefresh, 15000);
    return () => {
      window.removeEventListener('nasirlink:data-changed', onRefresh);
      window.removeEventListener('focus', onRefresh);
      clearInterval(interval);
    };
  }, [loadAnalytics]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
            Privacy-First Link Analytics
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Visitor counts use daily rotating hashes — zero raw IP addresses are permanently stored.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {links.length > 0 && (
            <select
              value={selectedLinkId}
              onChange={(e) => setSelectedLinkId(e.target.value)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-200"
            >
              <option value="">All Links Overview</option>
              {links.map((l) => (
                <option key={l.id} value={l.id}>
                  /{l.slug} ({l.clicksCount} clicks)
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => loadAnalytics(false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-24 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 animate-pulse"
            />
          ))}
        </div>
      ) : data ? (
        <>
          {/* 6 KPI Stat Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard label="Total Links" value={data.totals.totalLinks} accent="indigo" />
            <StatCard label="Total Clicks" value={data.totals.totalClicks} accent="indigo" />
            <StatCard label="Active Links" value={data.totals.activeLinks} accent="emerald" />
            <StatCard label="Video Links" value={data.totals.videoLinks} accent="violet" />
            <StatCard label="Today's Clicks" value={data.totals.todaysClicks} accent="cyan" />
            <StatCard label="Unique Visitors" value={data.totals.uniqueVisitors} accent="cyan" />
          </div>

          {/* Main Timeline Chart + Top Links */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8">
              <ChartCard
                title={chartTab === 'daily' ? 'Clicks Over Time (Last 14 Days)' : 'Hourly Click Distribution (UTC)'}
                subtitle="Total clicks vs anonymized unique visitors"
                action={
                  <div className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800">
                    <button
                      type="button"
                      onClick={() => setChartTab('daily')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        chartTab === 'daily'
                          ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      14 Days
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartTab('hourly')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        chartTab === 'hourly'
                          ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Hourly
                    </button>
                  </div>
                }
              >
                <LineAreaChart
                  data={chartTab === 'daily' ? data.clicksOverTime : data.hourlyClicks}
                />
              </ChartCard>
            </div>

            <div className="lg:col-span-4">
              <ChartCard title="Top-Performing Links" subtitle="Ranked by recorded clicks">
                <BarChart
                  color="#4F46E5"
                  data={data.topLinks.map((l) => ({
                    label: `/${l.slug}`,
                    value: l.clicks,
                  }))}
                />
              </ChartCard>
            </div>
          </div>

          {/* Breakdown Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <ChartCard title="Device Breakdown" subtitle="Desktop, mobile, and tablet share">
              <DonutChart data={data.devices} />
            </ChartCard>

            <ChartCard title="Browser Breakdown" subtitle="Client user-agent family">
              <DonutChart data={data.browsers} />
            </ChartCard>

            <ChartCard title="Operating Systems" subtitle="Visitor platform distribution">
              <DonutChart data={data.operatingSystems} />
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <ChartCard title="Referrer Sources" subtitle="Top traffic origins">
              <BarChart
                color="#7C3AED"
                data={data.referrers.map((r) => ({ label: r.name, value: r.count }))}
              />
            </ChartCard>

            <ChartCard title="Countries & Regions" subtitle="Derived from edge geo headers">
              <BarChart
                color="#06B6D4"
                data={data.countries.map((c) => ({ label: c.name, value: c.count }))}
              />
            </ChartCard>
          </div>
        </>
      ) : null}
    </div>
  );
}
