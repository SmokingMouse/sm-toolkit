"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSkill,
  importRuntimeSkills,
  listDevices,
  listSkills,
  updateSkill,
  type Device,
  type SkillWithAgents,
} from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnDanger, btnGhost, btnPrimary, Empty, Field, inputCls, PageHeader } from "../../components/ui";

type PanelMode = "detail" | "create" | "sync";

export default function SkillsPage() {
  const skills = usePoll(listSkills, 10_000);
  const devices = usePoll(listDevices, 10_000);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>("detail");
  const allSkills = skills.data ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allSkills;
    return allSkills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle));
  }, [allSkills, query]);
  const selected = allSkills.find((skill) => skill.id === selectedId) ?? allSkills[0];

  useEffect(() => {
    if (!selectedId && allSkills[0]) setSelectedId(allSkills[0].id);
    if (selectedId && !allSkills.some((skill) => skill.id === selectedId)) setSelectedId(allSkills[0]?.id ?? null);
  }, [allSkills, selectedId]);

  const finish = (id?: string) => {
    if (id) setSelectedId(id);
    setMode("detail");
    skills.reload();
    devices.reload();
  };

  return (
    <div className="page-enter flex h-full flex-col p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Reusable capability"
        title="Skills"
        description="把可复用的工作方式绑定给 Agent；支持本机 Runtime 同步与手动 SKILL.md。"
        actions={
          <>
            <button className={btnGhost} onClick={() => setMode("sync")}>↻ Sync local</button>
            <button className={btnPrimary} onClick={() => setMode("create")}><span className="mr-1.5 text-base">＋</span> New Skill</button>
          </>
        }
      />
      {skills.error && <div className="mb-3 text-sm text-canceled">{skills.error}</div>}
      <div className="surface-shadow grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-line bg-panel/88 max-lg:grid-cols-[300px_minmax(0,1fr)] max-md:grid-cols-1 max-md:overflow-auto">
        <aside className="flex min-h-0 flex-col border-r border-line bg-white/45 max-md:max-h-[360px] max-md:border-b max-md:border-r-0">
          <div className="border-b border-line p-3">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-dim">⌕</span>
              <input className={`${inputCls} min-h-10 py-2 pl-8 text-xs`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" />
            </div>
            <div className="mt-2 flex items-center justify-between px-1 text-[10px] text-dim">
              <span>{allSkills.length} workspace skills</span>
              <span>{allSkills.filter((skill) => skill.source === "runtime").length} runtime synced</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2.5">
            {filtered.map((skill) => (
              <button
                key={skill.id}
                className={`mb-1.5 flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left ${mode === "detail" && selected?.id === skill.id ? "border-accent/35 bg-accent-soft/60 shadow-[inset_3px_0_0_var(--color-accent)]" : "border-transparent hover:border-line hover:bg-white"}`}
                onClick={() => { setSelectedId(skill.id); setMode("detail"); }}
              >
                <SkillMark source={skill.source} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{skill.name}</span>
                  <span className="mt-1 block truncate text-[10px] text-dim">{skill.description || (skill.source === "runtime" ? "Local runtime Skill" : "Workspace Skill")}</span>
                  <span className="mt-1.5 flex items-center gap-2 text-[9px] font-medium uppercase tracking-[0.08em] text-dim/75"><span>{skill.source}</span><span>·</span><span>{skill.agents.length} agents</span></span>
                </span>
                <span className="pt-1 text-dim/40">›</span>
              </button>
            ))}
            {filtered.length === 0 && <div className="p-2"><Empty text={query ? "没有匹配的 Skill" : "还没有 Skill"} /></div>}
          </div>
        </aside>
        <section className="min-h-0 overflow-y-auto bg-panel">
          {mode === "create" ? (
            <CreateSkillPanel onClose={() => setMode("detail")} onCreated={(id) => finish(id)} />
          ) : mode === "sync" ? (
            <SyncSkillsPanel devices={devices.data ?? []} skills={allSkills} onClose={() => setMode("detail")} onSynced={(id) => finish(id)} />
          ) : selected ? (
            <SkillDetail key={selected.id} skill={selected} devices={devices.data ?? []} onChanged={() => finish(selected.id)} />
          ) : (
            <div className="grid min-h-full place-items-center p-8">
              <div className="max-w-sm text-center">
                <SkillMark source="manual" large />
                <h2 className="mt-4 text-lg font-semibold">Select a skill</h2>
                <p className="mt-2 text-sm leading-6 text-dim">从列表选择，或同步本机 Runtime 已安装的 Skill。</p>
                <button className={`${btnPrimary} mt-5`} onClick={() => setMode("sync")}>Sync local skills</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SkillMark({ source, large }: { source: "manual" | "runtime"; large?: boolean }) {
  return (
    <span className={`${large ? "mx-auto h-12 w-12 rounded-2xl" : "h-9 w-9 shrink-0 rounded-xl"} grid place-items-center border ${source === "runtime" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-accent/20 bg-accent-soft text-accent-strong"}`}>
      <svg width={large ? 23 : 17} height={large ? 23 : 17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H14v18a3 3 0 0 1 3-3h.5a2.5 2.5 0 0 1 2.5 2.5z"/></svg>
    </span>
  );
}

function SkillDetail({ skill, devices, onChanged }: { skill: SkillWithAgents; devices: Device[]; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [instruction, setInstruction] = useState(skill.instruction);
  const [busy, setBusy] = useState(false);
  const device = devices.find((item) => item.id === skill.deviceId);

  const save = async () => {
    setBusy(true);
    try {
      await updateSkill(skill.id, {
        name: name.trim(),
        description: description.trim(),
        ...(skill.source === "manual" ? { instruction: instruction.trim() } : {}),
      });
      toast(`已更新 ${name}`, "success");
      setEditing(false);
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!confirm(`归档 Skill "${skill.name}"？它会立即从 ${skill.agents.length} 个 Agent 解绑。`)) return;
    try {
      await updateSkill(skill.id, { archived: true });
      toast(`已归档 ${skill.name}`, "success");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return (
    <article className="min-h-full">
      <div className={`h-1 ${skill.source === "runtime" ? "bg-blue-500" : "bg-accent"}`} />
      <div className="p-6 max-sm:p-4">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-5">
          <div className="flex min-w-0 items-center gap-3">
            <SkillMark source={skill.source} large />
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold tracking-tight">{skill.name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-dim"><span className="uppercase">{skill.source}</span><span>·</span><span>{skill.runtimes.join(" + ")}</span><span>·</span><span>{skill.agents.length} agents</span></div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={() => setEditing((value) => !value)}>{editing ? "取消" : "编辑"}</button>
            <button className={btnDanger} onClick={archive}>归档</button>
          </div>
        </div>

        {editing ? (
          <div className="max-w-3xl">
            <Field label="Skill name"><input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="Description"><input className={inputCls} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话说明何时使用" /></Field>
            <Field label={skill.source === "manual" ? "SKILL.md" : "SKILL.md snapshot · managed by runtime sync"}>
              <textarea className={`${inputCls} min-h-72 resize-y font-mono text-xs leading-6`} value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={skill.source === "runtime"} />
            </Field>
            <div className="mt-4 flex justify-end"><button className={btnPrimary} disabled={busy || !name.trim() || !instruction.trim()} onClick={save}>{busy ? "保存中…" : "保存更改"}</button></div>
          </div>
        ) : (
          <>
            {skill.description && <p className="mb-5 max-w-3xl text-sm leading-6 text-dim">{skill.description}</p>}
            <div className="mb-5 grid gap-px overflow-hidden rounded-xl border border-line bg-line text-xs sm:grid-cols-3">
              <SkillFact label="Source" value={skill.source === "runtime" ? `${device?.name ?? skill.deviceId}` : "Workspace editor"} />
              <SkillFact label="Runtime" value={skill.runtimes.join(" · ")} />
              <SkillFact label="Updated" value={new Date(skill.updatedAt).toLocaleString()} />
            </div>
            {skill.sourcePath && <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/60 p-4"><div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-700">Local source</div><div className="break-all font-mono text-xs leading-5 text-blue-950/75">{skill.sourcePath}/SKILL.md</div></div>}
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_250px]">
              <div className="rounded-xl border border-line bg-white/55 p-4">
                <div className="mb-3 flex items-center justify-between"><span className="text-xs font-medium text-dim">SKILL.md snapshot</span><span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-dim">Injected per run</span></div>
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-ink/80">{skill.instruction}</pre>
              </div>
              <div className="rounded-xl border border-line bg-white/55 p-4">
                <div className="mb-3 text-xs font-medium text-dim">Used by Agents</div>
                <div className="space-y-2">
                  {skill.agents.map((agent) => <div key={agent.id} className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium"><span className="h-1.5 w-1.5 rounded-full bg-done" />{agent.name}</div>)}
                  {skill.agents.length === 0 && <p className="text-xs leading-5 text-dim">尚未绑定。去 Agents 详情选择它。</p>}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function SkillFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-panel px-4 py-3.5"><div className="mb-1.5 text-[10px] font-medium text-dim">{label}</div><div className="truncate text-sm font-medium" title={value}>{value}</div></div>;
}

function CreateSkillPanel({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const upload = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    const meta = parseFrontmatter(text);
    setInstruction(text);
    if (meta.name) setName(meta.name);
    else if (!name) setName(file.name.replace(/\.md$/i, ""));
    if (meta.description) setDescription(meta.description);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const skill = await createSkill({ name: name.trim(), description: description.trim(), instruction: instruction.trim() });
      toast(`Skill "${skill.name}" 已创建`, "success");
      onCreated(skill.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex min-h-full flex-col" onSubmit={submit}>
      <PanelHeader eyebrow="New Skill" title="Create reusable guidance" onClose={onClose} />
      <div className="mx-auto w-full max-w-[820px] flex-1 px-7 py-6 max-sm:px-4">
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-dashed border-accent/30 bg-accent-soft/35 p-4">
          <div><div className="text-sm font-semibold">已有 SKILL.md？</div><div className="mt-1 text-xs text-dim">上传后自动读取 name / description，也可以直接粘贴正文。</div></div>
          <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" className="hidden" onChange={(event) => void upload(event.target.files?.[0])} />
          <button type="button" className={btnGhost} onClick={() => fileRef.current?.click()}>Upload file</button>
        </div>
        <div className="grid gap-x-5 md:grid-cols-2">
          <Field label="Skill name"><input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：pr-review" /></Field>
          <Field label="Description"><input className={inputCls} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="何时应该使用它？" /></Field>
        </div>
        <Field label="SKILL.md instruction"><textarea className={`${inputCls} min-h-[420px] resize-y font-mono text-xs leading-6`} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={`---\nname: pr-review\ndescription: Review a pull request\n---\n\n# Workflow\n...`} /></Field>
        <p className="mt-2 text-xs leading-5 text-dim">保存后正文会在每个绑定 Agent 的 Run 开始前注入 system prompt。建议一个 Agent 只绑定 2–3 个高相关 Skill。</p>
      </div>
      <PanelFooter hint="Manual Skill 可用于所有 Device 和 Runtime"><button type="submit" className={btnPrimary} disabled={busy || !name.trim() || !instruction.trim()}>{busy ? "创建中…" : "创建 Skill"}</button></PanelFooter>
    </form>
  );
}

function SyncSkillsPanel({ devices, skills, onClose, onSynced }: { devices: Device[]; skills: SkillWithAgents[]; onClose: () => void; onSynced: (id?: string) => void }) {
  const toast = useToast();
  const availableDevices = devices.filter((device) => (device.capabilities.installedSkills?.length ?? 0) > 0);
  const [deviceId, setDeviceId] = useState((availableDevices.find((device) => device.online) ?? availableDevices[0])?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const device = devices.find((item) => item.id === deviceId);
  const candidates = device?.capabilities.installedSkills ?? [];
  const imported = new Map(skills.filter((skill) => skill.source === "runtime" && skill.deviceId === deviceId).map((skill) => [skill.sourcePath, skill]));

  useEffect(() => setSelected([]), [deviceId]);

  const toggle = (path: string) => setSelected((items) => items.includes(path) ? items.filter((item) => item !== path) : [...items, path]);
  const sync = async () => {
    if (!device || selected.length === 0) return;
    setBusy(true);
    try {
      const result = await importRuntimeSkills({ device: device.id, paths: selected });
      toast(`已同步 ${result.imported.length} 个本地 Skill`, "success");
      onSynced(result.imported[0]?.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <PanelHeader eyebrow="Runtime sync" title="Import local skills" onClose={onClose} />
      <div className="mx-auto w-full max-w-[820px] flex-1 px-7 py-6 max-sm:px-4">
        <Field label="Device">
          <select className={inputCls} value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            {availableDevices.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.online ? "Online" : "Offline"} · {item.capabilities.installedSkills?.length ?? 0} Skills</option>)}
          </select>
        </Field>
        {availableDevices.length === 0 ? (
          <div className="mt-5"><Empty text="尚未收到本机 Skill 清单；升级并重启 harbord 后再同步" /></div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-xl border border-line bg-white/50">
            <div className="flex items-center justify-between border-b border-line px-4 py-3 text-xs text-dim"><span>Detected from .claude / .codex / .agents</span><button className="font-medium text-accent hover:text-accent-strong" onClick={() => setSelected(candidates.map((skill) => skill.path))}>Select all</button></div>
            <div className="max-h-[510px] overflow-y-auto p-2">
              {candidates.map((candidate) => {
                const current = imported.get(candidate.path);
                const checked = selected.includes(candidate.path);
                return (
                  <button key={candidate.path} type="button" className={`mb-1 flex w-full items-start gap-3 rounded-xl border p-3 text-left ${checked ? "border-accent/35 bg-accent-soft/55" : "border-transparent hover:border-line hover:bg-white"}`} onClick={() => toggle(candidate.path)}>
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] ${checked ? "border-accent bg-accent text-white" : "border-zinc-300 bg-white text-transparent"}`}>✓</span>
                    <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-semibold"><span className="truncate">{candidate.name}</span>{current && <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[9px] font-semibold uppercase text-blue-700">synced</span>}</span><span className="mt-1 block text-xs leading-5 text-dim">{candidate.description || candidate.path}</span><span className="mt-1.5 block font-mono text-[9px] text-dim/75">{candidate.runtimes.join(" + ")} · {candidate.path}</span></span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <PanelFooter hint="再次同步会刷新已导入 Skill 的正文快照"><button className={btnPrimary} disabled={busy || selected.length === 0} onClick={sync}>{busy ? "同步中…" : `Sync ${selected.length || ""} skill${selected.length === 1 ? "" : "s"}`}</button></PanelFooter>
    </div>
  );
}

function PanelHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  return <div className="flex items-start justify-between gap-3 border-b border-line px-7 py-6 max-sm:px-4"><div><div className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">{eyebrow}</div><h2 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h2></div><button type="button" className={btnGhost} onClick={onClose}>取消</button></div>;
}

function PanelFooter({ hint, children }: { hint: string; children: React.ReactNode }) {
  return <div className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-line bg-panel/95 px-7 py-4 backdrop-blur max-sm:px-4"><span className="text-xs text-dim">{hint}</span>{children}</div>;
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const value = (key: string) => {
    const row = match[1]?.split(/\r?\n/).find((line) => line.trim().startsWith(`${key}:`));
    return row?.slice(row.indexOf(":") + 1).trim().replace(/^['"]|['"]$/g, "") || undefined;
  };
  return { name: value("name"), description: value("description") };
}
