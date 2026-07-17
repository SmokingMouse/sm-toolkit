"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createWorkspace,
  getActiveWorkspace,
  getToken,
  health,
  listApprovals,
  listWorkspaces,
  setActiveWorkspace,
} from "../lib/api";
import { usePoll } from "../lib/hooks";
import { ToastProvider } from "./toast";

type IconName = "search" | "issues" | "chats" | "skills" | "agents" | "repositories" | "devices" | "automations" | "approvals" | "usage" | "settings";
type NavItem = { href: string; label: string; icon: IconName };

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Workspace",
    items: [
      { href: "/", label: "Issues", icon: "issues" },
      { href: "/chats", label: "Chats", icon: "chats" },
      { href: "/skills", label: "Skills", icon: "skills" },
      { href: "/agents", label: "Agents", icon: "agents" },
      { href: "/repositories", label: "Repositories", icon: "repositories" },
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
    case "search": return <svg {...common}><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>;
    case "issues": return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5M8 17h3"/></svg>;
    case "chats": return <svg {...common}><path d="M5 18.5 3.5 21l.7-4A8 8 0 1 1 7 19.5"/><path d="M8 10h8M8 14h5"/></svg>;
    case "skills": return <svg {...common}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H14v18a3 3 0 0 1 3-3h.5a2.5 2.5 0 0 1 2.5 2.5z"/></svg>;
    case "agents": return <svg {...common}><circle cx="12" cy="8" r="3"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0M4 8h2M18 8h2"/></svg>;
    case "repositories": return <svg {...common}><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 18.5z"/><path d="M8.5 7h7M8.5 11h7M8.5 15H13"/></svg>;
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  useEffect(() => {
    if (!getToken() && !pathname.startsWith("/settings")) router.replace("/settings");
  }, [pathname, router]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const conn = usePoll(health, 30_000);
  const pending = usePoll(() => listApprovals("pending"), 30_000);
  const workspaces = usePoll(listWorkspaces, 30_000);
  const activeWorkspaceId = getActiveWorkspace() || workspaces.data?.[0]?.id || "";
  const activeWorkspace = workspaces.data?.find((item) => item.id === activeWorkspaceId) ?? workspaces.data?.[0];
  const pendingCount = pending.data?.length ?? 0;
  const connected = !!conn.data && !conn.error;
  const quickLinks = useMemo(() => [...NAV.flatMap((group) => group.items), { href: "/settings", label: "Settings", icon: "settings" as const }], []);
  const searchResults = quickLinks.filter((item) => item.label.toLowerCase().includes(searchQuery.trim().toLowerCase()));

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

          <div className="border-b border-white/7 p-3 max-md:px-2">
            <button
              className="group flex w-full items-center gap-3 rounded-xl border border-white/8 bg-black/10 px-3 py-2.5 text-left hover:bg-white/7 max-md:justify-center max-md:px-0"
              onClick={() => setWorkspaceOpen(true)}
              title={activeWorkspace?.name ?? "Choose workspace"}
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#83d6c5]/15 text-[11px] font-bold text-[#83d6c5]">
                {(activeWorkspace?.name ?? "W").slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 max-md:hidden">
                <span className="block truncate text-xs font-semibold text-white/90">{activeWorkspace?.name ?? "Workspace"}</span>
                <span className="mt-0.5 block text-[9px] uppercase tracking-[0.14em] text-white/32">Scope</span>
              </span>
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-white/35 max-md:hidden" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m6 8 4 4 4-4" /></svg>
            </button>
          </div>

          <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-5 max-md:px-2">
            <button className="flex h-10 items-center gap-3 rounded-xl border border-white/8 bg-white/5 px-3 text-[13px] font-medium text-white/55 hover:bg-white/9 hover:text-white max-md:justify-center max-md:px-0" onClick={() => { setSearchQuery(""); setSearchOpen(true); }} title="Search (⌘K)">
              <span className="text-white/45"><NavIcon name="search" /></span>
              <span className="max-md:hidden">Search</span>
              <kbd className="ml-auto rounded border border-white/10 bg-black/10 px-1.5 py-0.5 font-mono text-[9px] text-white/30 max-md:hidden">⌘K</kbd>
            </button>
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
                <div className="mt-0.5 text-[9px] text-white/35">{activeWorkspace?.slug ?? "workspace"} control plane</div>
              </div>
            </div>
          </div>
        </aside>
        <main className="harbor-grid min-w-0 flex-1 overflow-y-auto">{children}</main>
        {searchOpen && (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-harbor/45 px-4 pt-[14vh] backdrop-blur-[2px]" onClick={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
            <div role="dialog" aria-modal="true" aria-label="Search Harbor" className="surface-shadow flex max-h-[78vh] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-white/70 bg-panel">
              <div className="flex items-center gap-3 border-b border-line px-4 py-3">
                <span className="text-dim"><NavIcon name="search" /></span>
                <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="跳转到 Issues、Chats、Agents…" className="h-10 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-dim/60" />
                <kbd className="rounded border border-line bg-bg px-1.5 py-1 font-mono text-[9px] text-dim">ESC</kbd>
              </div>
              <div className="overflow-y-auto p-2">
                <div className="px-2 pb-1.5 pt-1 text-[9px] font-bold uppercase tracking-[0.15em] text-dim">Navigate</div>
                {searchResults.map((item) => (
                  <button key={item.href} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink hover:bg-accent-soft/60" onClick={() => { router.push(item.href); setSearchOpen(false); }}>
                    <span className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-accent"><NavIcon name={item.icon} /></span>
                    <span className="font-medium">{item.label}</span>
                    <span className="ml-auto text-xs text-dim">{item.href}</span>
                  </button>
                ))}
                {searchResults.length === 0 && <div className="px-3 py-8 text-center text-sm text-dim">没有匹配的页面</div>}
              </div>
              <div className="border-t border-line bg-bg/70 px-4 py-2.5 text-[10px] text-dim">全局导航已支持；跨 Issues / Chats 内容搜索将在服务端提供统一索引后接入。</div>
            </div>
          </div>
        )}
        {workspaceOpen && (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-harbor/45 px-4 pt-[14vh] backdrop-blur-[2px]" onClick={(event) => { if (event.target === event.currentTarget) setWorkspaceOpen(false); }}>
            <div role="dialog" aria-modal="true" aria-label="Choose workspace" className="surface-shadow w-[460px] max-w-full overflow-hidden rounded-2xl border border-white/70 bg-panel">
              <div className="border-b border-line px-5 py-4">
                <div className="text-[10px] font-bold uppercase tracking-[0.17em] text-accent">Harbor scope</div>
                <div className="mt-1 text-lg font-semibold text-ink">Choose a workspace</div>
                <p className="mt-1 text-xs leading-5 text-dim">Agents, Skills, Issues and Repositories stay inside the selected scope.</p>
              </div>
              <div className="max-h-[340px] space-y-1 overflow-y-auto p-2">
                {(workspaces.data ?? []).map((workspace) => (
                  <button
                    key={workspace.id}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left ${workspace.id === activeWorkspace?.id ? "bg-accent-soft text-accent" : "hover:bg-bg"}`}
                    onClick={() => { setActiveWorkspace(workspace.id); window.location.href = pathname; }}
                  >
                    <span className="grid h-9 w-9 place-items-center rounded-xl border border-current/10 bg-white text-sm font-bold">{workspace.name.slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{workspace.name}</span><span className="mt-0.5 block text-[10px] text-dim">{workspace.slug}</span></span>
                    {workspace.id === activeWorkspace?.id && <span className="text-xs font-semibold">Active</span>}
                  </button>
                ))}
              </div>
              <form
                className="flex gap-2 border-t border-line bg-bg/60 p-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!workspaceName.trim() || workspaceBusy) return;
                  setWorkspaceBusy(true);
                  try {
                    const created = await createWorkspace({ name: workspaceName.trim() });
                    setActiveWorkspace(created.id);
                    window.location.href = "/";
                  } finally {
                    setWorkspaceBusy(false);
                  }
                }}
              >
                <input className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-white px-3 text-sm outline-none focus:border-accent" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="New workspace name" />
                <button className="rounded-xl bg-accent px-4 text-xs font-semibold text-white disabled:opacity-50" disabled={!workspaceName.trim() || workspaceBusy}>{workspaceBusy ? "Creating…" : "Create"}</button>
              </form>
            </div>
          </div>
        )}
      </div>
    </ToastProvider>
  );
}
