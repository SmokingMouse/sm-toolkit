"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { getToken, health, listApprovals } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { ToastProvider } from "./toast";

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Issues" },
  { href: "/chats", label: "Chats" },
  { href: "/agents", label: "Agents" },
  { href: "/automations", label: "Automations" },
  { href: "/approvals", label: "Approvals" },
  { href: "/usage", label: "Usage" },
  { href: "/settings", label: "Settings" },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  // token 门：页面壳不鉴权，但无 token 直接引到 Settings
  useEffect(() => {
    if (!getToken() && !pathname.startsWith("/settings")) router.replace("/settings");
  }, [pathname, router]);

  const conn = usePoll(health, 30_000);
  const pending = usePoll(() => listApprovals("pending"), 30_000);
  const pendingCount = pending.data?.length ?? 0;
  const connected = !!conn.data && !conn.error;

  return (
    <ToastProvider>
      <div className="flex h-screen">
        <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex items-center gap-2 px-4 py-4 text-sm font-semibold tracking-wide">
            <span className="text-accent">⚓</span> HARBOR
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {NAV.map((n) => {
              const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`flex items-center justify-between rounded-md px-3 py-1.5 text-sm ${
                    active ? "bg-zinc-100 font-medium text-ink" : "text-dim hover:bg-zinc-50 hover:text-ink"
                  }`}
                >
                  {n.label}
                  {n.href === "/approvals" && pendingCount > 0 && (
                    <span className="rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
                      {pendingCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto flex items-center gap-2 px-4 py-3 text-xs text-dim">
            <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-done" : "bg-canceled"}`} />
            {connected ? "server 已连接" : "未连接"}
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </ToastProvider>
  );
}
