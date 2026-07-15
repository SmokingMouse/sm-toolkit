"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 列表页轮询：挂载即拉 + 固定间隔刷新 + reload 手动触发。
 * 注意：轮询结果别直接当表单初值引用（受控组件自持状态，方案 §3）。
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      fnRef.current().then(
        (d) => {
          if (alive) {
            setData(d);
            setError(null);
          }
        },
        (e) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        },
      );
    };
    pull();
    const timer = setInterval(pull, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs, tick]);

  return { data, error, reload };
}

/** 相对时间（中文短格式，与旧看板一致） */
export function ago(ts: number | null | undefined): string {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s前`;
  if (s < 3600) return `${Math.round(s / 60)}m前`;
  if (s < 86400) return `${Math.round(s / 3600)}h前`;
  return `${Math.round(s / 86400)}d前`;
}

export function fmtUsd(usd: number | null | undefined): string {
  return usd == null ? "" : `$${usd.toFixed(4)}`;
}
