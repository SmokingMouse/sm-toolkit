"use client";

import { useState } from "react";
import { usage } from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { Empty, Metric, PageHeader } from "../../components/ui";

const DAY_OPTIONS = [7, 14, 30];

export default function UsagePage() {
  const [days, setDays] = useState(14);
  const rows = usePoll(() => usage(days), 30_000);

  const byDay = new Map<string, number>();
  for (const r of rows.data ?? []) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.usd);
  const chartDays = [...byDay.keys()].sort();
  const totalUsd = (rows.data ?? []).reduce((sum, row) => sum + row.usd, 0);
  const totalRuns = (rows.data ?? []).reduce((sum, row) => sum + row.runs, 0);

  return (
    <div className="page-enter mx-auto max-w-[1440px] p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Cost telemetry"
        title="Usage"
        description="按 Agent 与模型拆解 token 和成本，费用口径与 harbor usage CLI 保持一致。"
        actions={<div className="flex items-center gap-5 rounded-xl border border-line bg-panel/75 px-4 py-2.5 surface-shadow"><Metric label="Spend" value={`$${totalUsd.toFixed(2)}`} /><Metric label="Runs" value={totalRuns} /><div className="flex gap-1 border-l border-line pl-3">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              className={`rounded-lg px-2.5 py-1.5 text-xs ${
                days === d ? "bg-accent-soft font-semibold text-accent-strong" : "text-dim hover:bg-bg"
              }`}
              onClick={() => setDays(d)}
            >
              {d}天
            </button>
          ))}
        </div></div>}
      />
      {rows.error && <div className="mb-3 text-sm text-canceled">{rows.error}</div>}

      <BarChart days={chartDays} values={chartDays.map((d) => byDay.get(d) ?? 0)} />

      <div className="surface-shadow mt-5 overflow-x-auto rounded-2xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-dim">
              <th className="px-3 py-2 font-medium">日期</th>
              <th className="px-3 py-2 font-medium">agent</th>
              <th className="px-3 py-2 font-medium">model</th>
              <th className="px-3 py-2 text-right font-medium">runs</th>
              <th className="px-3 py-2 text-right font-medium">$</th>
              <th className="px-3 py-2 text-right font-medium">in</th>
              <th className="px-3 py-2 text-right font-medium">out</th>
              <th className="px-3 py-2 text-right font-medium">cached</th>
            </tr>
          </thead>
          <tbody>
            {(rows.data ?? []).map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5 font-mono text-xs">{r.day}</td>
                <td className="px-3 py-1.5">{r.agentName}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{r.model}</td>
                <td className="px-3 py-1.5 text-right font-mono text-xs">{r.runs}</td>
                <td className="px-3 py-1.5 text-right font-mono text-xs">{r.usd.toFixed(4)}</td>
                <td className="px-3 py-1.5 text-right font-mono text-xs">{r.inputTokens.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right font-mono text-xs">{r.outputTokens.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right font-mono text-xs">{r.cachedTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(rows.data ?? []).length === 0 && <Empty text={`近 ${days} 天无 run`} />}
      </div>
    </div>
  );
}

function BarChart({ days, values }: { days: string[]; values: number[] }) {
  const W = 800;
  const H = 180;
  const pad = 28;
  const max = Math.max(...values, 0.0001);
  const bw = Math.min(48, ((W - pad * 2) / Math.max(days.length, 1)) * 0.7);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="surface-shadow h-48 w-full rounded-2xl border border-line bg-panel">
      <text x={pad} y={16} fontSize={11} fill="var(--color-dim)">
        $/日（max ${max.toFixed(4)}）
      </text>
      {days.map((d, i) => {
        const x = pad + ((W - pad * 2) * (i + 0.5)) / days.length;
        const h = Math.max(2, (H - pad * 2) * (values[i] / max));
        return (
          <g key={d}>
            <rect
              x={x - bw / 2}
              y={H - pad - h}
              width={bw}
              height={h}
              rx={3}
              fill="var(--color-accent)"
              opacity={0.85}
            >
              <title>
                {d} ${values[i].toFixed(4)}
              </title>
            </rect>
            <text x={x} y={H - 8} textAnchor="middle" fontSize={9} fill="var(--color-dim)">
              {d.slice(5)}
            </text>
          </g>
        );
      })}
      {days.length === 0 && (
        <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={12} fill="var(--color-dim)">
          无数据
        </text>
      )}
    </svg>
  );
}
