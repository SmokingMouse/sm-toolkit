"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createRepository,
  deleteRepositoryMount,
  listAgents,
  listDevices,
  listRepositories,
  setRepositoryMount,
  type RepositoryWithMounts,
} from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { Empty, Field, Modal, ModalFooter, PageHeader, btnGhost, btnPrimary, inputCls } from "../../components/ui";

export default function RepositoriesPage() {
  const repositories = usePoll(listRepositories, 10_000);
  const devices = usePoll(listDevices, 15_000);
  const agents = usePoll(listAgents, 15_000);
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const items = repositories.data ?? [];
    if (!selectedId || !items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [repositories.data, selectedId]);

  const selected = repositories.data?.find((item) => item.id === selectedId) ?? null;
  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents.data ?? []) {
      if (agent.defaultRepositoryId) counts.set(agent.defaultRepositoryId, (counts.get(agent.defaultRepositoryId) ?? 0) + 1);
    }
    return counts;
  }, [agents.data]);

  return (
    <div className="min-h-full p-6 max-sm:p-4">
      <PageHeader
        eyebrow="Workspace resources"
        title="Repositories"
        description="Logical repositories live in the Workspace. Device mounts tell Harbor where each checkout exists."
        actions={<button className={btnPrimary} onClick={() => setCreating(true)}>+ Add repository</button>}
      />

      {repositories.error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{repositories.error}</div>}

      <div className="grid min-h-[620px] grid-cols-[310px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_12px_40px_rgba(18,45,38,.06)] max-lg:grid-cols-1">
        <aside className="border-r border-line bg-bg/55 p-3 max-lg:border-b max-lg:border-r-0">
          <div className="mb-2 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-dim">{repositories.data?.length ?? 0} connected</div>
          <div className="space-y-1">
            {(repositories.data ?? []).map((repository) => (
              <button
                key={repository.id}
                onClick={() => setSelectedId(repository.id)}
                className={`w-full rounded-xl border px-3 py-3 text-left transition ${repository.id === selectedId ? "border-accent/20 bg-white shadow-[0_5px_18px_rgba(5,100,87,.08)]" : "border-transparent hover:border-line hover:bg-white/70"}`}
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-harbor text-white shadow-sm">
                    <RepoGlyph />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{repository.name}</span>
                    <span className="mt-1 block text-[10px] text-dim">{repository.mounts.length} mount{repository.mounts.length === 1 ? "" : "s"} · {agentCounts.get(repository.id) ?? 0} agents</span>
                  </span>
                </div>
              </button>
            ))}
          </div>
          {(repositories.data?.length ?? 0) === 0 && <Empty text="No repositories in this Workspace" />}
        </aside>

        <section className="min-w-0">
          {selected ? (
            <RepositoryDetail
              repository={selected}
              devices={devices.data ?? []}
              agentCount={agentCounts.get(selected.id) ?? 0}
              onChanged={repositories.reload}
            />
          ) : (
            <div className="grid h-full min-h-[520px] place-items-center px-6 text-center">
              <div><div className="text-xl font-semibold text-ink">Connect the first codebase</div><p className="mt-2 max-w-md text-sm leading-6 text-dim">A Workspace can contain many repositories—or none at all. Add one only when Agents need a code execution target.</p></div>
            </div>
          )}
        </section>
      </div>

      {creating && (
        <CreateRepositoryModal
          devices={devices.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(repository) => {
            setCreating(false);
            setSelectedId(repository.id);
            repositories.reload();
            toast(`Repository ${repository.name} connected`, "success");
          }}
        />
      )}
    </div>
  );
}

function RepositoryDetail({
  repository,
  devices,
  agentCount,
  onChanged,
}: {
  repository: RepositoryWithMounts;
  devices: Awaited<ReturnType<typeof listDevices>>;
  agentCount: number;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [device, setDevice] = useState(devices[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!device && devices[0]) setDevice(devices[0].id);
  }, [device, devices]);

  return (
    <div className="p-7 max-sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-6">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">Repository</div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-ink">{repository.name}</h2>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-dim">
            <span className="rounded-full border border-line bg-bg px-2.5 py-1">base · {repository.defaultBranch}</span>
            <span className="rounded-full border border-line bg-bg px-2.5 py-1">{agentCount} default agents</span>
            <span className="rounded-full border border-line bg-bg px-2.5 py-1">one Run · one repository</span>
          </div>
        </div>
        {repository.remoteUrl && <a className={btnGhost} href={repository.remoteUrl} target="_blank" rel="noreferrer">Open remote ↗</a>}
      </div>

      <div className="mt-7">
        <div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="text-sm font-semibold text-ink">Device mounts</h3><p className="mt-1 text-xs text-dim">The same Repository may live at a different path on every Device.</p></div><span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">{repository.mounts.length} configured</span></div>
        <div className="space-y-2">
          {repository.mounts.map((mount) => (
            <div key={mount.id} className="group flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3">
              <span className="relative h-2.5 w-2.5 rounded-full bg-done"><span className="absolute inset-0 rounded-full bg-done/30 ring-4 ring-done/10" /></span>
              <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-ink">{mount.deviceName}</div><div className="mt-1 truncate font-mono text-[11px] text-dim">{mount.path}</div></div>
              <button
                className="rounded-lg px-2 py-1 text-xs text-dim opacity-0 hover:bg-red-50 hover:text-red-700 group-hover:opacity-100"
                onClick={async () => {
                  if (!confirm(`Remove mount ${mount.deviceName}:${mount.path}?`)) return;
                  try { await deleteRepositoryMount(repository.id, mount.id); onChanged(); toast("Mount removed", "success"); }
                  catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
                }}
              >Remove</button>
            </div>
          ))}
          {repository.mounts.length === 0 && <Empty text="No Device mount yet — Agents cannot execute code here" />}
        </div>

        <form
          className="mt-4 grid grid-cols-[190px_minmax(0,1fr)_auto] gap-2 rounded-xl border border-dashed border-line bg-bg/45 p-3 max-md:grid-cols-1"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!device || !path.trim()) return;
            setBusy(true);
            try { await setRepositoryMount(repository.id, { device, path: path.trim() }); setPath(""); onChanged(); toast("Mount saved", "success"); }
            catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
            finally { setBusy(false); }
          }}
        >
          <select className={inputCls} value={device} onChange={(event) => setDevice(event.target.value)}><option value="">Choose Device</option>{devices.map((item) => <option key={item.id} value={item.id}>{item.name}{item.online ? " · online" : " · offline"}</option>)}</select>
          <input className={`${inputCls} font-mono text-xs`} value={path} onChange={(event) => setPath(event.target.value)} placeholder="/absolute/path/to/checkout" />
          <button className={btnPrimary} disabled={!device || !path.trim() || busy}>{busy ? "Saving…" : "Add mount"}</button>
        </form>
      </div>
    </div>
  );
}

function CreateRepositoryModal({ devices, onClose, onCreated }: { devices: Awaited<ReturnType<typeof listDevices>>; onClose: () => void; onCreated: (repository: RepositoryWithMounts) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [device, setDevice] = useState(devices[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Connect repository" onClose={onClose}>
      <form onSubmit={async (event) => {
        event.preventDefault(); setBusy(true);
        try { onCreated(await createRepository({ name: name.trim(), remoteUrl: remoteUrl.trim() || undefined, defaultBranch: defaultBranch.trim() || "main", ...(device && path.trim() ? { device, path: path.trim() } : {}) })); }
        catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); }
        finally { setBusy(false); }
      }}>
        <Field label="Repository name"><input autoFocus className={inputCls} value={name} onChange={(event) => setName(event.target.value)} placeholder="harbor-web" /></Field>
        <Field label="Remote URL (optional)"><input className={inputCls} value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://github.com/org/repo" /></Field>
        <Field label="Default branch"><input className={inputCls} value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} /></Field>
        <div className="mt-5 rounded-xl border border-line bg-bg/60 p-3">
          <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.14em] text-dim">Optional first mount</div>
          <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1"><select className={inputCls} value={device} onChange={(event) => setDevice(event.target.value)}><option value="">No mount yet</option>{devices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className={`${inputCls} font-mono text-xs`} value={path} onChange={(event) => setPath(event.target.value)} placeholder="/absolute/path" /></div>
        </div>
        <ModalFooter><button type="button" className={btnGhost} onClick={onClose}>Cancel</button><button className={btnPrimary} disabled={!name.trim() || busy || (!!device !== !!path.trim())}>{busy ? "Connecting…" : "Connect"}</button></ModalFooter>
      </form>
    </Modal>
  );
}

function RepoGlyph() {
  return <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 3.5h8.5A1.5 1.5 0 0 1 15 5v11.5H6.5A1.5 1.5 0 0 1 5 15z"/><path d="M8 7h4M8 10h4M5 15a1.5 1.5 0 0 0 1.5 1.5"/></svg>;
}
