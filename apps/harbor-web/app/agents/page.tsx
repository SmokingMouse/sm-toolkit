"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createAgent,
  listAgents,
  listDevices,
  listSkills,
  NATIVE_TIER_ALIASES,
  PERMISSIONS,
  setAgentArchived,
  setAgentSkills,
  type Device,
  type BackendKind,
  type HarborAgent,
  type ModelRouteCapability,
  type SkillWithAgents,
} from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnDanger, btnGhost, btnPrimary, Empty, Field, inputCls, PageHeader } from "../../components/ui";

export default function AgentsPage() {
  const agents = usePoll(listAgents, 10_000);
  const devices = usePoll(listDevices, 10_000);
  const skills = usePoll(listSkills, 10_000);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deviceById = useMemo(
    () => new Map((devices.data ?? []).map((d) => [d.id, d])),
    [devices.data],
  );

  const allAgents = agents.data ?? [];
  const onlineAgents = allAgents.filter((agent) => deviceById.get(agent.deviceId)?.online).length;
  const runtimes = new Set(allAgents.map((agent) => agent.backend)).size;
  const selectedAgent = allAgents.find((agent) => agent.id === selectedId) ?? allAgents[0];

  useEffect(() => {
    if (!selectedId && allAgents[0]) setSelectedId(allAgents[0].id);
    if (selectedId && !allAgents.some((agent) => agent.id === selectedId)) setSelectedId(allAgents[0]?.id ?? null);
  }, [allAgents, selectedId]);

  return (
    <div className="page-enter flex h-full flex-col p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Execution roster"
        title="Agents"
        description="一处管理执行 Runtime、sm-toolkit 模型路由与工作空间。"
        actions={
          <button
            className={btnPrimary}
            disabled={!devices.data?.length}
            title={!devices.data?.length ? "需要先注册至少一台设备" : undefined}
            onClick={() => setCreating(true)}
          >
            <span className="mr-1.5 text-base leading-none">＋</span> New Agent
          </button>
        }
      />
      {agents.error && <div className="mb-3 text-sm text-canceled">{agents.error}</div>}
      <div className="surface-shadow grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-line bg-panel/88 max-lg:grid-cols-[270px_minmax(0,1fr)] max-md:grid-cols-1 max-md:overflow-auto">
        <aside className="flex min-h-0 flex-col border-r border-line bg-white/45 max-md:max-h-[340px] max-md:border-b max-md:border-r-0">
          <div className="grid grid-cols-3 border-b border-line px-3 py-3">
            <RosterMetric label="Agents" value={allAgents.length} />
            <RosterMetric label="Ready" value={onlineAgents} good />
            <RosterMetric label="Runtimes" value={runtimes} />
          </div>
          <div className="flex-1 overflow-y-auto p-2.5">
            {allAgents.map((agent) => (
              <AgentListRow
                key={agent.id}
                agent={agent}
                device={deviceById.get(agent.deviceId)}
                selected={!creating && selectedAgent?.id === agent.id}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(agent.id);
                }}
              />
            ))}
            {allAgents.length === 0 && <div className="p-3"><Empty text="还没有 Agent" /></div>}
          </div>
        </aside>
        <section className="min-h-0 overflow-y-auto bg-panel">
          {creating ? (
            <NewAgentPanel
              devices={devices.data ?? []}
              skills={skills.data ?? []}
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                agents.reload();
                skills.reload();
              }}
            />
          ) : selectedAgent ? (
            <AgentDetail
              agent={selectedAgent}
              device={deviceById.get(selectedAgent.deviceId)}
              skills={skills.data ?? []}
              onChanged={() => { agents.reload(); skills.reload(); }}
            />
          ) : (
            <div className="p-6"><Empty text="选择一个 Agent，或创建新的执行配置" /></div>
          )}
        </section>
      </div>
    </div>
  );
}

function RosterMetric({ label, value, good }: { label: string; value: number; good?: boolean }) {
  return (
    <div className="border-l border-line px-2 first:border-0">
      <div className={`text-base font-semibold tabular-nums ${good ? "text-done" : "text-ink"}`}>{value}</div>
      <div className="mt-0.5 truncate text-[8px] font-bold uppercase tracking-[0.1em] text-dim">{label}</div>
    </div>
  );
}

function AgentListRow({
  agent,
  device,
  selected,
  onClick,
}: {
  agent: HarborAgent;
  device: Device | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`mb-1.5 flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left ${selected ? "border-accent/35 bg-accent-soft/60 shadow-[inset_3px_0_0_var(--color-accent)]" : "border-transparent hover:border-line hover:bg-white"}`} onClick={onClick}>
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-bold uppercase ${agent.backend === "claude" ? "bg-[#f2e7d7] text-[#9b5f25]" : "bg-accent-soft text-accent-strong"}`}>{agent.backend[0]}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{agent.name}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-dim"><span className={`h-1.5 w-1.5 rounded-full ${device?.online ? "bg-done" : "bg-zinc-400"}`} />{device?.online ? "ready" : "offline"} · {agent.backend}</div>
      </div>
      <span className="text-dim/50">›</span>
    </button>
  );
}

function AgentDetail({
  agent,
  device,
  skills,
  onChanged,
}: {
  agent: HarborAgent;
  device: Device | undefined;
  skills: SkillWithAgents[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [skillIds, setSkillIds] = useState(agent.skillIds);
  const [savingSkills, setSavingSkills] = useState(false);
  useEffect(() => setSkillIds(agent.skillIds), [agent.id, agent.skillIds]);
  const compatibleSkills = skills.filter((skill) =>
    skill.runtimes.includes(agent.backend) && (skill.source === "manual" || skill.deviceId === agent.deviceId),
  );
  const skillsChanged = skillIds.join("|") !== agent.skillIds.join("|");

  const saveSkills = async () => {
    setSavingSkills(true);
    try {
      await setAgentSkills(agent.id, skillIds);
      toast(`已更新 ${agent.name} 的 Skills`, "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSavingSkills(false);
    }
  };
  const archive = async () => {
    if (!confirm(`归档 agent "${agent.name}"？归档后不再出现在派活下拉（历史记录保留）。`)) return;
    try {
      await setAgentArchived(agent.id, true);
      toast(`已归档 ${agent.name}`, "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const providerMissing = !!device && !device.capabilities.clis?.[agent.backend];
  return (
    <article className="min-h-full">
      <div className={`h-1 ${agent.backend === "claude" ? "bg-[#c98b4b]" : "bg-accent"}`} />
      <div className="p-6 max-sm:p-4">
        <div className="mb-6 flex items-start justify-between gap-3 border-b border-line pb-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-sm font-bold uppercase ${agent.backend === "claude" ? "bg-[#f2e7d7] text-[#9b5f25]" : "bg-accent-soft text-accent-strong"}`}>{agent.backend[0]}</div>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold tracking-tight">{agent.name}</h2>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-dim">
                <span className={`h-1.5 w-1.5 rounded-full ${device?.online ? "bg-done" : "bg-zinc-400"}`} />
                {device?.online ? "ready" : "device offline"} · {agent.backend}
              </div>
            </div>
          </div>
          <button className={btnDanger} onClick={archive}>归档</button>
        </div>

        {agent.description && <p className="mb-5 max-w-3xl text-sm leading-6 text-dim">{agent.description}</p>}
        {providerMissing && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-canceled">设备当前缺少 {agent.backend} Runtime</div>}

        <div className="mb-7 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line text-xs lg:grid-cols-5">
          <AgentFact label="Runtime" value={agent.backend === "claude" ? "Claude Code" : "Codex CLI"} />
          <AgentFact label="Device" value={device?.name ?? agent.deviceId} />
          <AgentFact label="Model route" value={agent.model ?? "Runtime default"} mono />
          <AgentFact label="Permission" value={agent.permission} />
          <AgentFact label="Isolation" value={agent.isolation} />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-white/55 p-4">
            <div className="mb-3 text-xs font-medium text-dim">Working directory</div>
            <div className="break-all font-mono text-sm leading-6 text-ink/80">{agent.workdir}</div>
          </div>
          <div className="rounded-xl border border-line bg-white/55 p-4">
            <div className="mb-3 text-xs font-medium text-dim">Instruction</div>
            <div className="whitespace-pre-wrap text-sm leading-6 text-ink/80">{agent.instruction || "No additional instruction."}</div>
          </div>
        </div>
        <div className="mt-5 rounded-xl border border-line bg-white/55 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div><div className="text-xs font-medium text-dim">Skills</div><div className="mt-1 text-[11px] text-dim">按 Mew 的少而精原则，建议只选 2–3 个。</div></div>
            <button className={btnPrimary} disabled={!skillsChanged || savingSkills} onClick={saveSkills}>{savingSkills ? "保存中…" : "Save skills"}</button>
          </div>
          <SkillPicker skills={compatibleSkills} selected={skillIds} onChange={setSkillIds} />
        </div>
      </div>
    </article>
  );
}

function AgentFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-panel px-4 py-3.5">
      <div className="mb-1.5 text-[10px] font-medium text-dim">{label}</div>
      <div className={`truncate text-sm font-medium ${mono ? "font-mono text-xs" : ""}`} title={value}>{value}</div>
    </div>
  );
}

function NewAgentPanel({
  devices,
  skills,
  onClose,
  onCreated,
}: {
  devices: Device[];
  skills: SkillWithAgents[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const initialDevice = devices.find((candidate) => candidate.online) ?? devices[0];
  const [device, setDevice] = useState(initialDevice?.name ?? "");
  const initialRuntimes = (["claude", "codex"] as BackendKind[]).filter(
    (runtime) => !!initialDevice?.capabilities.clis?.[runtime],
  );
  const [backend, setBackend] = useState<BackendKind | "">(
    initialRuntimes.includes("claude") ? "claude" : (initialRuntimes[0] ?? ""),
  );
  const [model, setModel] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [permission, setPermission] = useState<string>("auto-edit");
  const [isolation, setIsolation] = useState("none");
  const [instruction, setInstruction] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const selectedDevice = devices.find((d) => d.name === device);
  const availableRuntimes = (["claude", "codex"] as BackendKind[]).filter(
    (runtime) => !!selectedDevice?.capabilities.clis?.[runtime],
  );
  const modelRoutes = useMemo(() => routesForDevice(selectedDevice), [selectedDevice]);
  const routeGroups = useMemo(() => {
    const groups = new Map<string, ModelRouteCapability[]>();
    for (const route of modelRoutes.filter((candidate) => candidate.runtime === backend)) {
      const rows = groups.get(route.provider) ?? [];
      rows.push(route);
      groups.set(route.provider, rows);
    }
    return [...groups.entries()];
  }, [backend, modelRoutes]);
  const readyRoutes = modelRoutes.filter((route) => route.runtime === backend && route.ready).length;
  const compatibleSkills = skills.filter((skill) =>
    backend && skill.runtimes.includes(backend) && (skill.source === "manual" || skill.deviceId === selectedDevice?.id),
  );

  const selectDevice = (name: string) => {
    setDevice(name);
    setModel("");
    const next = devices.find((d) => d.name === name);
    const available = (["claude", "codex"] as BackendKind[]).filter(
      (provider) => !!next?.capabilities.clis?.[provider],
    );
    setBackend(available.includes("claude") ? "claude" : (available[0] ?? ""));
    setSkillIds((current) => current.filter((id) => {
      const skill = skills.find((item) => item.id === id);
      const nextBackend = available.includes("claude") ? "claude" : available[0];
      return !!skill && !!nextBackend && skill.runtimes.includes(nextBackend) && (skill.source === "manual" || skill.deviceId === next?.id);
    }));
    if (!available.includes("claude") && permission === "default") setPermission("auto-edit");
  };

  const selectRuntime = (value: BackendKind) => {
    setBackend(value);
    setModel("");
    setSkillIds((current) => current.filter((id) => {
      const skill = skills.find((item) => item.id === id);
      return !!skill && skill.runtimes.includes(value) && (skill.source === "manual" || skill.deviceId === selectedDevice?.id);
    }));
    if (value === "codex" && permission === "default") setPermission("auto-edit");
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    try {
      await createAgent({
        name: name.trim(),
        device,
        backend,
        model: model.trim() || undefined,
        workdir: workdir.trim(),
        permission,
        isolation,
        instruction: instruction.trim() || undefined,
        skills: skillIds,
      });
      toast(`agent "${name}" 已创建`, "success");
      onCreated();
    } catch (e) {
      // 服务端校验错误（model 不在清单等）原样展示
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex min-h-full flex-col" onSubmit={submit}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-7 py-6 max-sm:px-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">New Agent</div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Configure a runtime</h2>
        </div>
        <button type="button" className={btnGhost} onClick={onClose}>取消</button>
      </div>
      <div className="mx-auto w-full max-w-[820px] flex-1 px-7 py-2 max-sm:px-4">
        <AgentFormSection title="Identity">
          <div className="grid gap-x-5 md:grid-cols-2">
            <Field label="Agent name">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Code reviewer" />
            </Field>
            <Field label="Device">
              <select className={inputCls} value={device} onChange={(e) => selectDevice(e.target.value)}>
                {devices.map((item) => <option key={item.id} value={item.name}>{item.name} · {item.online ? "Online" : "Offline"}</option>)}
              </select>
            </Field>
          </div>
        </AgentFormSection>

        <AgentFormSection title="Execution">
          <Field label="Runtime">
            <div className="grid gap-3 sm:grid-cols-2">
              {availableRuntimes.map((runtime) => (
                <button
                  key={runtime}
                  type="button"
                  aria-pressed={backend === runtime}
                  className={`rounded-2xl border p-4 text-left ${backend === runtime ? "border-accent bg-accent-soft/50 shadow-[inset_0_0_0_1px_rgba(8,127,111,.12)]" : "border-line bg-white/65 hover:border-zinc-300 hover:bg-white"}`}
                  onClick={() => selectRuntime(runtime)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">{runtime === "claude" ? "Claude Code" : "Codex CLI"}</span>
                    <span className={`h-2 w-2 rounded-full ${selectedDevice?.online ? "bg-done" : "bg-zinc-400"}`} />
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] text-dim">v{selectedDevice?.capabilities.clis?.[runtime]}</div>
                </button>
              ))}
            </div>
          </Field>

          {backend === "claude" ? (
            <Field label="Model route">
              <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Runtime default</option>
                <optgroup label="Claude aliases">
                  {NATIVE_TIER_ALIASES.map((alias) => <option key={alias} value={alias}>{alias}</option>)}
                </optgroup>
                {routeGroups.map(([provider, routes]) => (
                  <optgroup key={provider} label={`${provider} · sm-toolkit`}>
                    {routes.map((route) => (
                      <option key={route.id} value={route.id} disabled={!route.ready}>
                        {route.label ?? route.model} · {provider}{route.ready ? "" : " · missing key"}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <RouteSyncState total={modelRoutes.length} ready={readyRoutes} />
            </Field>
          ) : routeGroups.length > 0 ? (
            <Field label="Model">
              <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Runtime default（跟随 Codex CLI 配置）</option>
                {routeGroups.map(([provider, routes]) => (
                  <optgroup key={provider} label={`${provider} · 本机 models cache`}>
                    {routes.map((route) => (
                      <option key={route.id} value={route.model}>
                        {route.label ?? route.model}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="mt-2 text-xs leading-5 text-dim">清单来自该设备 codex CLI 按登录态缓存的可用模型。</p>
            </Field>
          ) : (
            <Field label="Model override">
              <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="留空跟随 Codex CLI 配置" />
              <p className="mt-2 text-xs leading-5 text-dim">该设备未上报 codex 模型清单（models_cache.json 缺失）；这里透传其本地 model 名。</p>
            </Field>
          )}
        </AgentFormSection>

        <AgentFormSection title="Workspace">
          <Field label="Working directory">
            <input className={`${inputCls} font-mono text-xs`} value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/absolute/path/to/repository" />
          </Field>
          <Field label="Permission">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {PERMISSIONS.filter((value) => backend !== "codex" || value !== "default").map((value) => (
                <ChoiceButton key={value} selected={permission === value} onClick={() => setPermission(value)}>{PERMISSION_LABELS[value]}</ChoiceButton>
              ))}
            </div>
          </Field>
          <Field label="Isolation">
            <div className="grid grid-cols-2 gap-2">
              <ChoiceButton selected={isolation === "none"} onClick={() => setIsolation("none")}>Shared workspace</ChoiceButton>
              <ChoiceButton selected={isolation === "worktree"} onClick={() => setIsolation("worktree")}>Git worktree</ChoiceButton>
            </div>
          </Field>
        </AgentFormSection>

        <AgentFormSection title="Skills">
          <p className="mb-3 text-xs leading-5 text-dim">选择 Workspace 已导入的能力；Runtime Skill 只显示当前 Device 真能使用的项。</p>
          <SkillPicker skills={compatibleSkills} selected={skillIds} onChange={setSkillIds} />
        </AgentFormSection>

        <AgentFormSection title="Instruction" last>
          <textarea className={`${inputCls} min-h-32 resize-y leading-6`} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="这个 Agent 应该长期遵守什么？" />
        </AgentFormSection>
      </div>
      <div className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-line bg-panel/95 px-7 py-4 backdrop-blur max-sm:px-4">
        <span className="text-xs text-dim">Agent 配置会作为新的执行快照保存</span>
        <button type="submit" className={btnPrimary} disabled={busy || !name.trim() || !device || !backend || !workdir.trim()}>
          {busy ? "创建中…" : "创建"}
        </button>
      </div>
    </form>
  );
}

const PERMISSION_LABELS: Record<string, string> = {
  readonly: "Read only",
  "auto-edit": "Auto edit",
  full: "Full access",
  default: "Ask first",
};

function routesForDevice(device: Device | undefined): ModelRouteCapability[] {
  if (!device) return [];
  if (device.capabilities.modelRoutes?.length) return device.capabilities.modelRoutes;
  return (device.capabilities.endpoints ?? []).flatMap((id) => {
    const separator = id.indexOf(":");
    if (separator <= 0) return [];
    return [{
      id,
      provider: id.slice(0, separator),
      model: id.slice(separator + 1),
      runtime: "claude" as const,
      kind: "anthropic" as const,
      ready: true,
    }];
  });
}

function AgentFormSection({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <section className={`${last ? "" : "border-b border-line"} py-6`}>
      <h3 className="mb-4 text-base font-semibold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

function ChoiceButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} className={`min-h-11 rounded-xl border px-3 text-sm font-medium ${selected ? "border-accent bg-accent-soft/60 text-accent-strong" : "border-line bg-white/70 text-ink/75 hover:border-zinc-300 hover:bg-white"}`} onClick={onClick}>
      {children}
    </button>
  );
}

function SkillPicker({
  skills,
  selected,
  onChange,
}: {
  skills: SkillWithAgents[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  if (skills.length === 0) {
    return <div className="rounded-xl border border-dashed border-line bg-white/45 px-4 py-6 text-center text-xs leading-5 text-dim">没有兼容的 Skill。先去 Skills 页面创建或同步本机 Runtime。</div>;
  }
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {skills.map((skill) => {
          const active = selected.includes(skill.id);
          return (
            <button
              key={skill.id}
              type="button"
              aria-pressed={active}
              className={`flex min-h-[68px] items-start gap-3 rounded-xl border p-3 text-left ${active ? "border-accent bg-accent-soft/55 text-accent-strong" : "border-line bg-white/70 text-ink hover:border-zinc-300 hover:bg-white"}`}
              onClick={() => toggle(skill.id)}
            >
              <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] ${active ? "border-accent bg-accent text-white" : "border-zinc-300 bg-white text-transparent"}`}>✓</span>
              <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{skill.name}</span><span className="rounded-full bg-bg px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-dim">{skill.source}</span></span><span className="mt-1 block line-clamp-2 text-[11px] leading-4 text-dim">{skill.description || "No description"}</span></span>
            </button>
          );
        })}
      </div>
      {selected.length > 3 && <div className="mt-2 text-xs text-review">已选择 {selected.length} 个；Skill 过多会放大上下文和指令冲突，建议收敛到 2–3 个。</div>}
    </div>
  );
}

function RouteSyncState({ total, ready }: { total: number; ready: number }) {
  if (total === 0) {
    return <div className="mt-2.5 flex items-center gap-2 text-xs text-review"><span className="h-1.5 w-1.5 rounded-full bg-review" />未收到 sm-toolkit routes；检查 endpoints.yaml 后重启 harbord</div>;
  }
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
      <span className="inline-flex items-center gap-2 text-done"><span className="h-1.5 w-1.5 rounded-full bg-done" />sm-toolkit synced</span>
      <span>{ready} ready</span>
      {ready < total && <span className="text-review">{total - ready} missing key</span>}
    </div>
  );
}
