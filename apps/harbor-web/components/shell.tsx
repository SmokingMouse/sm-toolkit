"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { getToken, health, listApprovals } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { ToastProvider } from "./toast";

type IconName = "issues" | "chats" | "agents" | "devices" | "automations" | "approvals" | "usage" | "settings";
type NavItem = { href: string; label: string; icon: IconName };

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Workspace",
    items: [
      { href: "/", label: "Issues", icon: "issues" },
      { href: "/chats", label: "Chats", icon: "chats" },
      { href: "/agents", label: "Agents", icon: "agents" },
    ],
  },
  {
    section: "Operations",
    items: [
      { href: "/devices", label: "Devices", icon: "devices" },
      { href: "/automations", label: "Automations", icon: "automations" },
      { href: "/approvals", label: "Approvals", icon: "approvals" },
      { href: "/usage", label: "Usage", icon: "usage" },
    ],
  },
];

function NavIcon({ name }: { name: IconName }) {
  const common = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "issues": return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5M8 17h3"/></svg>;
    case "chats": return <svg {...common}><path d="M5 18.5 3.5 21l.7-4A8 8 0 1 1 7 19.5"/><path d="M8 10h8M8 14h5"/></svg>;
    case "agents": return <svg {...common}><circle cx="12" cy="8" r="3"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0M4 8h2M18 8h2"/></svg>;
    case "devices": return <svg {...common}><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
    case "automations": return <svg {...common}><path d="M20 12a8 8 0 1 1-2.35-5.65L20 8.7"/><path d="M20 4v4.7h-4.7M12 8v4l2.5 1.5"/></svg>;
    case "approvals": return <svg {...common}><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>;
    case "usage": return <svg {...common}><path d="M4 19V9M10 19V4M16 19v-7M22 19H2"/></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.4v-4h.1A1.7 1.7 0 0 0 4.2 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.6 4.2a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4v.1a1.7 1.7 0 0 0 1 1.7 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.6a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.7 1Z"/></svg>;
  }
}

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#dcefe9" />
      <path d="M9 9v9a7 7 0 0 0 14 0V9M7 13h18M12 22l-3 3M20 22l3 3" fill="none" stroke="#087f6f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!getToken() && !pathname.startsWith("/settings")) router.replace("/settings");
  }, [pathname, router]);

  const conn = usePoll(health, 30_000);
  const pending = usePoll(() => listApprovals("pending"), 30_000);
  const pendingCount = pending.data?.length ?? 0;
  const connected = !!conn.data && !conn.error;

  return (
    <ToastProvider>
      <div className="flex h-screen bg-bg">
        <aside className="flex w-[232px] shrink-0 flex-col border-r border-white/5 bg-harbor text-white max-md:w-[76px]">
          <div className="flex h-[72px] items-center gap-3 border-b border-white/7 px-4 max-md:justify-center max-md:px-2">
            <BrandMark />
            <div className="max-md:hidden">
              <div className="text-sm font-semibold tracking-[0.13em]">HARBOR</div>
              <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-white/38">Local control</div>
            </div>
          </div>

          <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-5 max-md:px-2">
            {NAV.map((group) => (
              <div key={group.section}>
                <div className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[0.18em] text-white/30 max-md:hidden">{group.section}</div>
                <div className="space-y-1">
                  {group.items.map((n) => {
                    const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
                    return (
                      <Link
                        key={n.href}
                        href={n.href}
                        title={n.label}
                        className={`group flex h-10 items-center justify-between rounded-xl px-3 text-[13px] font-medium max-md:justify-center max-md:px-0 ${active ? "bg-white/11 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.05)]" : "text-white/55 hover:bg-white/6 hover:text-white/90"}`}
                      >
                        <span className="flex items-center gap-3">
                          <span className={active ? "text-[#83d6c5]" : "text-white/45 group-hover:text-white/75"}><NavIcon name={n.icon} /></span>
                          <span className="max-md:hidden">{n.label}</span>
                        </span>
                        {n.href === "/approvals" && pendingCount > 0 && (
                          <span className="min-w-5 rounded-full bg-[#ef6a63] px-1.5 py-0.5 text-center text-[10px] font-bold text-white max-md:absolute max-md:ml-7 max-md:-mt-6">
                            {pendingCount}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="mt-auto border-t border-white/7 pt-4">
              <Link
                href="/settings"
                title="Settings"
                className={`group flex h-10 items-center gap-3 rounded-xl px-3 text-[13px] font-medium max-md:justify-center max-md:px-0 ${pathname.startsWith("/settings") ? "bg-white/11 text-white" : "text-white/55 hover:bg-white/6 hover:text-white/90"}`}
              >
                <span className={pathname.startsWith("/settings") ? "text-[#83d6c5]" : "text-white/45 group-hover:text-white/75"}><NavIcon name="settings" /></span>
                <span className="max-md:hidden">Settings</span>
              </Link>
            </div>
          </nav>

          <div className="m-3 rounded-xl border border-white/7 bg-black/10 p-3 max-md:m-2 max-md:p-2">
            <div className="flex items-center gap-2 max-md:justify-center">
              <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? "bg-[#62cfb6]" : "bg-[#ef6a63]"}`}>
                {connected && <span className="absolute inset-0 animate-ping rounded-full bg-[#62cfb6] opacity-50" />}
              </span>
              <div className="max-md:hidden">
                <div className="text-[11px] font-semibold text-white/80">{connected ? "Server online" : "Disconnected"}</div>
                <div className="mt-0.5 text-[9px] text-white/35">personal control plane</div>
              </div>
            </div>
          </div>
        </aside>
        <main className="harbor-grid min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </ToastProvider>
  );
}
