import React, { useState } from 'react';
import type { BreakdownItem, TimeSeriesPoint } from '../shared/types';

export function ChartCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          {subtitle && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function LineAreaChart({ data }: { data: TimeSeriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!data.length) {
    return (
      <div className="h-56 flex items-center justify-center text-xs text-slate-400">
        No click timeline data yet.
      </div>
    );
  }

  const width = 640;
  const height = 220;
  const padL = 36;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = Math.max(4, ...data.map((d) => d.clicks));
  const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;

  const pointsClicks = data.map((d, i) => ({
    x: padL + i * stepX,
    y: padT + plotH - (d.clicks / maxVal) * plotH,
    d,
  }));

  const pointsUnique = data.map((d, i) => ({
    x: padL + i * stepX,
    y: padT + plotH - (d.uniqueVisitors / maxVal) * plotH,
  }));

  const linePath = pointsClicks
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const uniquePath = pointsUnique
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const areaPath = `${linePath} L ${pointsClicks[pointsClicks.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${pointsClicks[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  const yTicks = [0, 0.5, 1].map((ratio) => ({
    val: Math.round(maxVal * ratio),
    y: padT + plotH - ratio * plotH,
  }));

  const activePoint = hoverIdx !== null ? pointsClicks[hoverIdx] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-56 overflow-visible"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="nasirClicksGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4F46E5" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#4F46E5" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, idx) => (
          <g key={idx}>
            <line
              x1={padL}
              x2={width - padR}
              y1={t.y}
              y2={t.y}
              className="stroke-slate-200 dark:stroke-slate-800"
              strokeDasharray="3 3"
            />
            <text
              x={padL - 8}
              y={t.y + 4}
              textAnchor="end"
              className="fill-slate-400 text-[10px] font-mono"
            >
              {t.val}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#nasirClicksGrad)" />
        <path
          d={linePath}
          fill="none"
          stroke="#4F46E5"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={uniquePath}
          fill="none"
          stroke="#06B6D4"
          strokeWidth="2"
          strokeDasharray="4 4"
          strokeLinecap="round"
        />

        {pointsClicks.map((p, i) => (
          <g key={i}>
            {(i === 0 || i === pointsClicks.length - 1 || i % Math.ceil(pointsClicks.length / 6) === 0) && (
              <text
                x={p.x}
                y={height - 8}
                textAnchor="middle"
                className="fill-slate-400 text-[10px] font-mono"
              >
                {p.d.label}
              </text>
            )}
            <rect
              x={p.x - stepX / 2}
              y={padT}
              width={Math.max(stepX, 16)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
            {hoverIdx === i && (
              <>
                <line
                  x1={p.x}
                  x2={p.x}
                  y1={padT}
                  y2={padT + plotH}
                  className="stroke-indigo-400/50"
                />
                <circle cx={p.x} cy={p.y} r="4.5" fill="#4F46E5" stroke="#fff" strokeWidth="2" />
              </>
            )}
          </g>
        ))}
      </svg>

      <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-indigo-600 inline-block" /> Total Clicks
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-cyan-500 inline-block" /> Unique Visitors
          </span>
        </div>
        {activePoint && (
          <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {activePoint.d.label}: {activePoint.d.clicks} clicks · {activePoint.d.uniqueVisitors} unique
          </span>
        )}
      </div>
    </div>
  );
}

export function BarChart({
  data,
  color = '#7C3AED',
}: {
  data: Array<{ label: string; value: number }>;
  color?: string;
}) {
  if (!data.length) {
    return (
      <div className="h-48 flex items-center justify-center text-xs text-slate-400">
        No breakdown data available.
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <div className="space-y-2.5">
      {data.map((item, idx) => {
        const pct = Math.max(2, Math.round((item.value / max) * 100));
        return (
          <div key={idx} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-700 dark:text-slate-300 truncate max-w-[70%]">
                {item.label}
              </span>
              <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100 font-medium">
                {item.value.toLocaleString()}
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const DONUT_COLORS = ['#4F46E5', '#7C3AED', '#06B6D4', '#0EA5E9', '#64748B', '#94A3B8'];

export function DonutChart({ data }: { data: BreakdownItem[] }) {
  if (!data.length) {
    return (
      <div className="h-44 flex items-center justify-center text-xs text-slate-400">
        No breakdown recorded yet.
      </div>
    );
  }

  const total = data.reduce((sum, item) => sum + item.count, 0) || 1;
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <svg viewBox="0 0 120 120" className="w-32 h-32 shrink-0 -rotate-90">
        {data.slice(0, 6).map((item, i) => {
          const fraction = item.count / total;
          const dash = fraction * circumference;
          const offset = -cumulative * circumference;
          cumulative += fraction;
          return (
            <circle
              key={item.name}
              cx="60"
              cy="60"
              r={radius}
              fill="transparent"
              stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
              strokeWidth="16"
              strokeDasharray={`${dash} ${circumference}`}
              strokeDashoffset={offset}
            />
          );
        })}
      </svg>

      <div className="flex-1 w-full space-y-2">
        {data.slice(0, 6).map((item, i) => (
          <div key={item.name} className="flex items-center justify-between text-xs gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
              />
              <span className="text-slate-700 dark:text-slate-300 truncate">{item.name}</span>
            </div>
            <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100 shrink-0">
              {item.count.toLocaleString()} · {item.percentage}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
