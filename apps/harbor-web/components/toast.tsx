"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type ToastKind = "info" | "error" | "success";
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastCtx = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

const KIND_CLS: Record<ToastKind, string> = {
  info: "border-white/10 bg-harbor text-white",
  error: "border-red-200 bg-red-50 text-red-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-sm:left-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={`surface-shadow flex max-w-md items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${KIND_CLS[t.kind]}`}
          >
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
