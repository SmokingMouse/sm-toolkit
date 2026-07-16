"use client";

import type { ReactNode } from "react";

const STATUS_BADGE: Record<string, string> = {
  backlog: "border-zinc-200 bg-zinc-100 text-backlog",
  doing: "border-blue-200 bg-blue-50 text-doing",
  review: "border-amber-200 bg-amber-50 text-review",
  done: "border-emerald-200 bg-emerald-50 text-done",
  canceled: "border-red-200 bg-red-50 text-canceled",
  open: "border-blue-200 bg-blue-50 text-doing",
  queued: "border-zinc-200 bg-zinc-100 text-backlog",
  running: "border-blue-200 bg-blue-50 text-doing",
  succeeded: "border-emerald-200 bg-emerald-50 text-done",
  failed: "border-red-200 bg-red-50 text-canceled",
  pending: "border-amber-200 bg-amber-50 text-review",
  allowed: "border-emerald-200 bg-emerald-50 text-done",
  denied: "border-red-200 bg-red-50 text-canceled",
  expired: "border-zinc-200 bg-zinc-100 text-backlog",
};

const STATUS_DOT: Record<string, string> = {
  doing: "bg-doing",
  open: "bg-doing",
  running: "bg-doing",
  review: "bg-review",
  pending: "bg-review",
  done: "bg-done",
  succeeded: "bg-done",
  allowed: "bg-done",
  canceled: "bg-canceled",
  failed: "bg-canceled",
  denied: "bg-canceled",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[status] ?? "border-line bg-bg text-dim"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status] ?? "bg-backlog"}`} />
      {status}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-accent">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-ink">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-dim">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Metric({ label, value, tone = "default" }: { label: string; value: ReactNode; tone?: "default" | "good" | "warn" }) {
  const color = tone === "good" ? "text-done" : tone === "warn" ? "text-review" : "text-ink";
  return (
    <div className="min-w-[104px] border-l border-line pl-3 first:border-l-0 first:pl-0">
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">{label}</div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-harbor/55 px-3 pt-[8vh] backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${wide ? "w-[720px]" : "w-[500px]"} surface-shadow max-h-[84vh] max-w-[96vw] overflow-y-auto rounded-2xl border border-white/80 bg-panel p-5`}
      >
        <div className="mb-5 flex items-center justify-between border-b border-line pb-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">Harbor</div>
            <h2 className="mt-0.5 text-base font-semibold tracking-tight">{title}</h2>
          </div>
          <button className="grid h-8 w-8 place-items-center rounded-full text-lg text-dim hover:bg-bg hover:text-ink" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const btnPrimary =
  "inline-flex min-h-9 items-center justify-center rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(5,100,87,.18)] hover:bg-accent-strong hover:shadow-[0_5px_15px_rgba(5,100,87,.18)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40";
export const btnGhost =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-line bg-panel px-3.5 py-2 text-sm font-medium text-ink shadow-[0_1px_1px_rgba(20,35,30,.03)] hover:border-zinc-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40";
export const btnDanger =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-red-200 bg-red-50 px-3.5 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40";
export const inputCls =
  "w-full min-h-10 rounded-lg border border-line bg-white/85 px-3 py-2 text-sm text-ink shadow-[inset_0_1px_1px_rgba(20,35,30,.025)] outline-none placeholder:text-zinc-400 hover:border-zinc-300 focus:border-accent focus:ring-3 focus:ring-accent/10 disabled:bg-bg disabled:text-dim";
export const labelCls = "mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-[0.08em] text-dim first:mt-0";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-line bg-white/35 px-6 py-10 text-center">
      <div>
        <div className="mx-auto mb-3 h-8 w-px bg-line" />
        <div className="text-sm text-dim">{text}</div>
      </div>
    </div>
  );
}

/** modal 底部操作行：sticky 钉在卡片滚动区底缘，小视口下长表单的按钮不用滚就能点 */
export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-5 -mb-5 mt-5 flex justify-end gap-2 border-t border-line bg-panel/95 px-5 py-3.5 backdrop-blur">
      {children}
    </div>
  );
}
