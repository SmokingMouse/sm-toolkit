"use client";

import type { ReactNode } from "react";

/** 状态 → 文字色（conversation + run 状态共用一张表） */
export const STATUS_TEXT: Record<string, string> = {
  backlog: "text-backlog",
  doing: "text-doing",
  review: "text-review",
  done: "text-done",
  canceled: "text-canceled",
  open: "text-doing",
  queued: "text-backlog",
  running: "text-doing",
  succeeded: "text-done",
  failed: "text-canceled",
  pending: "text-review",
  allowed: "text-done",
  denied: "text-canceled",
  expired: "text-backlog",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`text-xs font-medium ${STATUS_TEXT[status] ?? "text-dim"}`}>{status}</span>;
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
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[10vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`${wide ? "w-[640px]" : "w-[480px]"} max-w-[94vw] max-h-[80vh] overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-xl`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="text-dim hover:text-ink" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const btnPrimary =
  "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed";
export const btnGhost =
  "rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-ink hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed";
export const btnDanger =
  "rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 hover:bg-red-100 disabled:opacity-40";
export const inputCls =
  "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm outline-none focus:border-accent";
export const labelCls = "mb-1 mt-3 block text-xs font-medium text-dim first:mt-0";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-sm text-dim">{text}</div>;
}

/** modal 底部操作行：sticky 钉在卡片滚动区底缘，小视口下长表单的按钮不用滚就能点 */
export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-5 -mb-5 mt-4 flex justify-end gap-2 border-t border-line bg-panel px-5 py-3">
      {children}
    </div>
  );
}
