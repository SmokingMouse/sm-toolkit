"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createAgent,
  createRepository,
  listAgents,
  listDevices,
  listRepositories,
  listSkills,
  moveAgentToDevice,
  NATIVE_TIER_ALIASES,
  PERMISSIONS,
  setAgentArchived,
  setAgentRepository,
  setAgentSkills,
  setRepositoryMount,
  updateRepository,
  updateAgent,
  type Device,
  type BackendKind,
  type HarborAgent,
  type ModelRouteCapability,
  type RepositoryWithMounts,
  type SkillWithAgents,
} from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  Empty,
  Field,
  inputCls,
  PageHeader,
} from "../../components/ui";

export default function AgentsPage() {
  const agents = usePoll(listAgents, 10_000);
  const devices = usePoll(listDevices, 10_000);
  const skills = usePoll(listSkills, 10_000);
  const repositories = usePoll(listRepositories, 10_000);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deviceById = useMemo(
    () => new Map((devices.data ?? []).map((d) => [d.id, d])),
    [devices.data],
  );
  const repositoryById = useMemo(
    () =>
      new Map(
        (repositories.data ?? []).map((repository) => [
          repository.id,
          repository,
        ]),
      ),
    [repositories.data],
  );

  const allAgents = agents.data ?? [];
  const onlineAgents = allAgents.filter(
    (agent) => deviceById.get(agent.deviceId)?.online,
  ).length;
  const runtimes = new Set(allAgents.map((agent) => agent.backend)).size;
  const selectedAgent =
    allAgents.find((agent) => agent.id === selectedId) ?? allAgents[0];

  useEffect(() => {
    if (!selectedId && allAgents[0]) setSelectedId(allAgents[0].id);
    if (selectedId && !allAgents.some((agent) => agent.id === selectedId))
      setSelectedId(allAgents[0]?.id ?? null);
  }, [allAgents, selectedId]);

  return (
    <div className="page-enter flex h-full flex-col p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Execution roster"
        title="Agents"
        description="每个 Agent 固定绑定一个 Repository 与当前 Device 的本地 checkout。"
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
      {agents.error && (
        <div className="mb-3 text-sm text-canceled">{agents.error}</div>
      )}
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
            {allAgents.length === 0 && (
              <div className="p-3">
                <Empty text="还没有 Agent" />
              </div>
            )}
          </div>
        </aside>
        <section className="min-h-0 overflow-y-auto bg-panel">
          {creating ? (
            <NewAgentPanel
              devices={devices.data ?? []}
              skills={skills.data ?? []}
              repositories={repositories.data ?? []}
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                agents.reload();
                skills.reload();
                repositories.reload();
              }}
            />
          ) : selectedAgent ? (
            <AgentDetail
              agent={selectedAgent}
              device={deviceById.get(selectedAgent.deviceId)}
              devices={devices.data ?? []}
              repository={
                selectedAgent.repositoryId
                  ? repositoryById.get(selectedAgent.repositoryId)
                  : undefined
              }
              repositories={repositories.data ?? []}
              skills={skills.data ?? []}
              onChanged={() => {
                agents.reload();
                devices.reload();
                skills.reload();
                repositories.reload();
              }}
            />
          ) : (
            <div className="p-6">
              <Empty text="选择一个 Agent，或创建新的执行配置" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function RosterMetric({
  label,
  value,
  good,
}: {
  label: string;
  value: number;
  good?: boolean;
}) {
  return (
    <div className="border-l border-line px-2 first:border-0">
      <div
        className={`text-base font-semibold tabular-nums ${good ? "text-done" : "text-ink"}`}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-[8px] font-bold uppercase tracking-[0.1em] text-dim">
        {label}
      </div>
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
    <button
      className={`mb-1.5 flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left ${selected ? "border-accent/35 bg-accent-soft/60 shadow-[inset_3px_0_0_var(--color-accent)]" : "border-transparent hover:border-line hover:bg-white"}`}
      onClick={onClick}
    >
      <div
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-bold uppercase ${agent.backend === "claude" ? "bg-[#f2e7d7] text-[#9b5f25]" : "bg-accent-soft text-accent-strong"}`}
      >
        {agent.backend[0]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{agent.name}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-dim">
          <span
            className={`h-1.5 w-1.5 rounded-full ${device?.online ? "bg-done" : "bg-zinc-400"}`}
          />
          {device?.online ? "ready" : "offline"} · {agent.backend}
        </div>
      </div>
      <span className="text-dim/50">›</span>
    </button>
  );
}

function AgentDetail({
  agent,
  device,
  devices,
  repository,
  repositories,
  skills,
  onChanged,
}: {
  agent: HarborAgent;
  device: Device | undefined;
  devices: Device[];
  repository: RepositoryWithMounts | undefined;
  repositories: RepositoryWithMounts[];
  skills: SkillWithAgents[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [skillIds, setSkillIds] = useState(agent.skillIds);
  const [savingSkills, setSavingSkills] = useState(false);
  const [editingRepository, setEditingRepository] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  const [editingDevice, setEditingDevice] = useState(false);
  useEffect(() => setSkillIds(agent.skillIds), [agent.id, agent.skillIds]);
  useEffect(() => setEditingDevice(false), [agent.id, agent.deviceId]);
  const compatibleSkills = skills.filter(
    (skill) =>
      skill.runtimes.includes(agent.backend) &&
      (skill.source !== "runtime" || skill.deviceId === agent.deviceId),
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
    if (
      !confirm(
        `归档 agent "${agent.name}"？归档后不再出现在派活下拉（历史记录保留）。`,
      )
    )
      return;
    try {
      await setAgentArchived(agent.id, true);
      toast(`已归档 ${agent.name}`, "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const providerMissing =
    !!device && !device.capabilities.clis?.[agent.backend];
  return (
    <article className="min-h-full">
      <div
        className={`h-1 ${agent.backend === "claude" ? "bg-[#c98b4b]" : "bg-accent"}`}
      />
      <div className="p-6 max-sm:p-4">
        <div className="mb-6 flex items-start justify-between gap-3 border-b border-line pb-5">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-sm font-bold uppercase ${agent.backend === "claude" ? "bg-[#f2e7d7] text-[#9b5f25]" : "bg-accent-soft text-accent-strong"}`}
            >
              {agent.backend[0]}
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold tracking-tight">
                {agent.name}
              </h2>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-dim">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${device?.online ? "bg-done" : "bg-zinc-400"}`}
                />
                {device?.online ? "ready" : "device offline"} · {agent.backend}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              className={btnGhost}
              onClick={() => setEditingConfig((value) => !value)}
            >
              {editingConfig ? "收起配置" : "Edit config"}
            </button>
            <button
              className={btnGhost}
              onClick={() => setEditingDevice((value) => !value)}
            >
              {editingDevice ? "取消迁移" : "Change Device"}
            </button>
            <button className={btnDanger} onClick={archive}>
              归档
            </button>
          </div>
        </div>

        {agent.description && (
          <p className="mb-5 max-w-3xl text-sm leading-6 text-dim">
            {agent.description}
          </p>
        )}
        {providerMissing && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-canceled">
            设备当前缺少 {agent.backend} Runtime
          </div>
        )}

        <div className="mb-7 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line text-xs lg:grid-cols-5">
          <AgentFact
            label="Runtime"
            value={agent.backend === "claude" ? "Claude Code" : "Codex CLI"}
          />
          <AgentFact label="Device" value={device?.name ?? agent.deviceId} />
          <AgentFact
            label="Model route"
            value={agent.model ?? "Runtime default"}
            mono
          />
          <AgentFact label="Permission" value={agent.permission} />
          <AgentFact label="Isolation" value={agent.isolation} />
        </div>

        {editingConfig && (
          <AgentConfigEditor
            agent={agent}
            repositories={repositories}
            onSaved={() => {
              setEditingConfig(false);
              onChanged();
            }}
          />
        )}
        {editingDevice && (
          <AgentDeviceEditor
            agent={agent}
            currentDevice={device}
            devices={devices}
            repository={repository}
            skills={skills}
            onSaved={onChanged}
          />
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-white/55 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-dim">Repository</div>
              <button
                className="text-[11px] font-semibold text-accent hover:text-accent-strong"
                onClick={() => setEditingRepository((value) => !value)}
              >
                {editingRepository ? "收起" : "Configure"}
              </button>
            </div>
            <div className="text-sm font-semibold leading-6 text-ink/80">
              {repository?.name ?? "Repository unavailable"}
            </div>
            {repository?.remoteUrl && (
              <div
                className="mt-0.5 truncate text-[11px] text-dim"
                title={repository.remoteUrl}
              >
                {repository.remoteUrl}
              </div>
            )}
            <div className="mt-2 break-all rounded-lg bg-bg px-2.5 py-2 font-mono text-[11px] leading-5 text-dim">
              {repository?.mounts.find(
                (mount) => mount.deviceId === agent.deviceId,
              )?.path ?? "Checkout missing"}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-white/55 p-4">
            <div className="mb-3 text-xs font-medium text-dim">Instruction</div>
            <div className="whitespace-pre-wrap text-sm leading-6 text-ink/80">
              {agent.instruction || "No additional instruction."}
            </div>
          </div>
        </div>
        {editingRepository && device && (
          <RepositoryEditor
            agent={agent}
            device={device}
            current={repository}
            repositories={repositories}
            onSaved={() => {
              setEditingRepository(false);
              onChanged();
            }}
          />
        )}
        <div className="mt-5 rounded-xl border border-line bg-white/55 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-dim">Skills</div>
              <div className="mt-1 text-[11px] text-dim">
                按 Mew 的少而精原则，建议只选 2–3 个。
              </div>
            </div>
            <button
              className={btnPrimary}
              disabled={!skillsChanged || savingSkills}
              onClick={saveSkills}
            >
              {savingSkills ? "保存中…" : "Save skills"}
            </button>
          </div>
          <SkillPicker
            skills={compatibleSkills}
            selected={skillIds}
            onChange={setSkillIds}
          />
        </div>
      </div>
    </article>
  );
}

function AgentConfigEditor({
  agent,
  repositories,
  onSaved,
}: {
  agent: HarborAgent;
  repositories: RepositoryWithMounts[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [permission, setPermission] = useState(agent.permission);
  const [isolation, setIsolation] = useState(agent.isolation);
  const [instruction, setInstruction] = useState(agent.instruction ?? "");
  const [concurrency, setConcurrency] = useState(agent.concurrency);
  const [visibility, setVisibility] = useState(agent.visibility);
  const [setupScript, setSetupScript] = useState(agent.setupScript ?? "");
  const [environment, setEnvironment] = useState("");
  const [repositoryIds, setRepositoryIds] = useState(agent.repositoryIds);
  const [busy, setBusy] = useState(false);
  const mounted = repositories.filter((repository) =>
    repository.mounts.some((mount) => mount.deviceId === agent.deviceId),
  );
  const toggleRepository = (id: string) =>
    setRepositoryIds((ids) =>
      id === agent.repositoryId
        ? ids
        : ids.includes(id)
          ? ids.filter((item) => item !== id)
          : [...ids, id],
    );
  const save = async () => {
    setBusy(true);
    try {
      let parsedEnvironment: Record<string, string> | undefined;
      if (environment.trim()) {
        const parsed = JSON.parse(environment) as unknown;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((value) => typeof value !== "string")
        )
          throw new Error("Environment 必须是 string value 的 JSON object");
        parsedEnvironment = parsed as Record<string, string>;
      }
      await updateAgent(agent.id, {
        description: description.trim() || null,
        model: model.trim() || null,
        permission,
        isolation,
        instruction: instruction.trim() || null,
        concurrency,
        visibility,
        setupScript: setupScript.trim() || null,
        repositories: repositoryIds,
        ...(parsedEnvironment !== undefined
          ? { environment: parsedEnvironment }
          : {}),
      });
      toast(`${agent.name} 配置已保存`, "success");
      onSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-accent/20 bg-accent-soft/25">
      <div className="border-b border-accent/15 px-5 py-4">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
          Agent execution config
        </div>
        <div className="mt-1 text-sm font-semibold">
          并发、可见性、环境、setup 与多仓库上下文
        </div>
      </div>
      <div className="grid gap-x-5 p-5 md:grid-cols-2">
        <Field label="Description">
          <input
            className={inputCls}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="Model override">
          <input
            className={inputCls}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Runtime default"
          />
        </Field>
        <Field label="Concurrency">
          <input
            type="number"
            min={1}
            max={64}
            className={inputCls}
            value={concurrency}
            onChange={(event) => setConcurrency(Number(event.target.value))}
          />
        </Field>
        <Field label="Visibility">
          <select
            className={inputCls}
            value={visibility}
            onChange={(event) =>
              setVisibility(event.target.value as HarborAgent["visibility"])
            }
          >
            <option value="workspace">Workspace</option>
            <option value="private">Private</option>
          </select>
        </Field>
        <Field label="Permission">
          <select
            className={inputCls}
            value={permission}
            onChange={(event) =>
              setPermission(event.target.value as HarborAgent["permission"])
            }
          >
            {PERMISSIONS.filter(
              (value) => agent.backend !== "codex" || value !== "default",
            ).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </Field>
        <Field label="Isolation">
          <select
            className={inputCls}
            value={isolation}
            onChange={(event) =>
              setIsolation(event.target.value as HarborAgent["isolation"])
            }
          >
            <option value="none">Direct checkout</option>
            <option value="worktree">Git worktree</option>
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label="Visible repositories">
            <div className="grid gap-2 sm:grid-cols-2">
              {mounted.map((repository) => (
                <label
                  key={repository.id}
                  className="flex gap-2 rounded-xl border border-line bg-white/65 p-3 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={repositoryIds.includes(repository.id)}
                    disabled={repository.id === agent.repositoryId}
                    onChange={() => toggleRepository(repository.id)}
                  />
                  <span>
                    <b>{repository.name}</b>
                    {repository.id === agent.repositoryId && (
                      <span className="ml-1 text-[9px] text-accent">
                        PRIMARY
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Environment JSON（留空保留现值；{} 清空）">
            <textarea
              className={`${inputCls} min-h-24 font-mono text-xs`}
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              placeholder={`Existing keys: ${Object.keys(agent.environment).join(", ") || "none"}\n{"API_BASE":"https://…"}`}
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Setup commands">
            <textarea
              className={`${inputCls} min-h-28 font-mono text-xs`}
              value={setupScript}
              onChange={(event) => setSetupScript(event.target.value)}
              placeholder="bun install --frozen-lockfile"
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Instruction">
            <textarea
              className={`${inputCls} min-h-28`}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </Field>
        </div>
        <label className="md:col-span-2 flex gap-2 text-xs text-dim">
          <input type="checkbox" checked disabled /> Reuse Device CLI
          credentials（个人部署版不托管独立 Runtime 登录态）
        </label>
      </div>
      <div className="flex justify-end border-t border-accent/15 bg-white/35 px-5 py-4">
        <button
          className={btnPrimary}
          disabled={busy || concurrency < 1 || concurrency > 64}
          onClick={save}
        >
          {busy ? "保存中…" : "Save Agent config"}
        </button>
      </div>
    </section>
  );
}

function AgentFact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-panel px-4 py-3.5">
      <div className="mb-1.5 text-[10px] font-medium text-dim">{label}</div>
      <div
        className={`truncate text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function AgentDeviceEditor({
  agent,
  currentDevice,
  devices,
  repository,
  skills,
  onSaved,
}: {
  agent: HarborAgent;
  currentDevice: Device | undefined;
  devices: Device[];
  repository: RepositoryWithMounts | undefined;
  skills: SkillWithAgents[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const candidates = useMemo(
    () => devices.filter((candidate) => candidate.id !== agent.deviceId),
    [agent.deviceId, devices],
  );
  const defaultDeviceId = candidates.find((candidate) => candidate.online)?.id ?? candidates[0]?.id ?? "";
  const [deviceId, setDeviceId] = useState(defaultDeviceId);
  const [checkoutPath, setCheckoutPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDeviceId((selected) => candidates.some((candidate) => candidate.id === selected) ? selected : defaultDeviceId);
  }, [agent.id, candidates, defaultDeviceId]);

  const targetDevice = candidates.find((candidate) => candidate.id === deviceId);
  const targetMount = repository?.mounts.find((mount) => mount.deviceId === targetDevice?.id);
  useEffect(() => {
    setCheckoutPath(targetMount?.path ?? "");
  }, [repository?.id, targetDevice?.id, targetMount?.path]);

  const runtimeVersion = targetDevice?.capabilities.clis?.[agent.backend];
  const bareModel = agent.model?.startsWith("claude-") ? agent.model.slice("claude-".length) : agent.model;
  const modelRoutes = targetDevice?.capabilities.modelRoutes?.filter((route) => route.runtime === "claude") ?? [];
  const modelAvailable = !agent.model || agent.backend !== "claude" || NATIVE_TIER_ALIASES.includes(bareModel ?? "") || (
    modelRoutes.length > 0
      ? modelRoutes.some((route) => (route.id === agent.model || route.model === agent.model) && route.ready)
      : (targetDevice?.capabilities.endpoints ?? []).includes(agent.model)
  );
  const incompatibleRuntimeSkills = skills.filter((skill) =>
    agent.skillIds.includes(skill.id) && skill.source === "runtime" && skill.deviceId !== targetDevice?.id,
  );
  const ready = !!targetDevice && !!repository && !!runtimeVersion && modelAvailable && !!checkoutPath.trim();

  const migrate = async () => {
    if (!targetDevice || !repository || !ready) return;
    const skillNotice = incompatibleRuntimeSkills.length > 0
      ? `\n将解除旧 Device 的 runtime Skills：${incompatibleRuntimeSkills.map((skill) => skill.name).join("、")}`
      : "";
    const offlineNotice = targetDevice.online ? "" : "\n目标 Device 当前 Offline，上线前新 Run 不会执行。";
    if (!confirm(
      `将 Agent "${agent.name}" 从 ${currentDevice?.name ?? agent.deviceId} 迁移到 ${targetDevice.name}？` +
      `\nRepository：${repository.name}` +
      `\n目标 checkout：${checkoutPath.trim()}` +
      "\n历史 Run 保留原 Device 快照，仅未来 Run 使用新 Device。" +
      skillNotice + offlineNotice,
    )) return;

    setBusy(true);
    try {
      if (!targetMount) {
        await setRepositoryMount(repository.id, { device: targetDevice.name, path: checkoutPath.trim() });
      }
      await moveAgentToDevice(agent.id, targetDevice.id, incompatibleRuntimeSkills.length > 0);
      toast(`已将 ${agent.name} 迁移到 ${targetDevice.name}`, "success");
      onSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-7 overflow-hidden rounded-2xl border border-accent/25 bg-accent-soft/25">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-accent/15 px-5 py-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Execution migration</div>
          <div className="mt-1 text-sm font-semibold">Change Device</div>
          <p className="mt-1 text-[11px] leading-5 text-dim">只改变未来派发；active Run 或未清理 worktree 会阻止迁移。</p>
        </div>
        <div className="rounded-full bg-white/70 px-3 py-1 text-[10px] text-dim">
          {currentDevice?.name ?? agent.deviceId} <span className="px-1 text-accent">→</span> {targetDevice?.name ?? "Select target"}
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="px-5 py-6 text-sm text-dim">没有其他已注册 Device。请先在目标机器启动 harbord。</div>
      ) : (
        <>
          <div className="grid gap-x-5 p-5 md:grid-cols-2">
            <Field label="Target Device">
              <select className={inputCls} value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.online ? "Online" : "Offline"}</option>
                ))}
              </select>
            </Field>
            <Field label="Runtime compatibility">
              <div className={`flex h-11 items-center rounded-xl border px-3 text-sm ${runtimeVersion && modelAvailable ? "border-line bg-white/75 text-ink" : "border-red-200 bg-red-50 text-canceled"}`}>
                {runtimeVersion
                  ? `${agent.backend === "claude" ? "Claude Code" : "Codex CLI"} v${runtimeVersion}${modelAvailable ? "" : ` · model ${agent.model} unavailable`}`
                  : `${agent.backend} Runtime unavailable`}
              </div>
            </Field>
            <div className="md:col-span-2">
              <Field label="Target checkout path">
                <input
                  className={`${inputCls} font-mono text-xs`}
                  value={checkoutPath}
                  disabled={!!targetMount}
                  onChange={(event) => setCheckoutPath(event.target.value)}
                  placeholder="/absolute/path/to/repository"
                />
                <p className="mt-2 text-xs leading-5 text-dim">
                  {targetMount
                    ? `Repository 已在 ${targetDevice?.name} 挂载，迁移将复用该 checkout。`
                    : `Repository 尚未在 ${targetDevice?.name} 挂载；填入目标机器上的绝对路径，确认时会先创建 mount。`}
                </p>
              </Field>
            </div>
            {incompatibleRuntimeSkills.length > 0 && (
              <div className="md:col-span-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-900">
                迁移后将解除旧 Device 独占的 runtime Skills：{incompatibleRuntimeSkills.map((skill) => skill.name).join("、")}。Manual Skills 保留。
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-accent/15 bg-white/35 px-5 py-3.5">
            <p className="text-[11px] leading-5 text-dim">迁移后 Agent 的 Repository 不变，执行 checkout 切换到目标 Device。</p>
            <button className={btnPrimary} disabled={busy || !ready} onClick={migrate}>
              {busy ? "迁移中…" : "Migrate Agent"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function RepositoryEditor({
  agent,
  device,
  current,
  repositories,
  onSaved,
}: {
  agent: HarborAgent;
  device: Device;
  current: RepositoryWithMounts | undefined;
  repositories: RepositoryWithMounts[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const mounted = repositories.filter((item) =>
    item.mounts.some((mount) => mount.deviceId === device.id),
  );
  const [choice, setChoice] = useState(current?.id ?? "__new__");
  const selected = repositories.find((item) => item.id === choice);
  const [name, setName] = useState(current?.name ?? "");
  const [remoteUrl, setRemoteUrl] = useState(current?.remoteUrl ?? "");
  const [branch, setBranch] = useState(current?.defaultBranch ?? "main");
  const [path, setPath] = useState(
    current?.mounts.find((mount) => mount.deviceId === device.id)?.path ?? "",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const repository =
      choice === "__new__"
        ? undefined
        : repositories.find((item) => item.id === choice);
    setName(repository?.name ?? "");
    setRemoteUrl(repository?.remoteUrl ?? "");
    setBranch(repository?.defaultBranch ?? "main");
    setPath(
      repository?.mounts.find((mount) => mount.deviceId === device.id)?.path ??
        "",
    );
  }, [choice, device.id]);

  const save = async () => {
    setBusy(true);
    try {
      let repositoryId = choice;
      if (choice === "__new__") {
        const created = await createRepository({
          name: name.trim(),
          remoteUrl: remoteUrl.trim() || undefined,
          defaultBranch: branch.trim() || "main",
          device: device.name,
          path: path.trim(),
        });
        repositoryId = created.id;
      } else if (selected) {
        await updateRepository(selected.id, {
          name: name.trim(),
          remoteUrl: remoteUrl.trim() || null,
          defaultBranch: branch.trim() || "main",
        });
        const mount = selected.mounts.find(
          (item) => item.deviceId === device.id,
        );
        if (!mount || mount.path !== path.trim()) {
          await setRepositoryMount(selected.id, {
            device: device.name,
            path: path.trim(),
          });
        }
      }
      await setAgentRepository(agent.id, repositoryId);
      toast(`已更新 ${agent.name} 的 Repository`, "success");
      onSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-accent/20 bg-accent-soft/25">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-accent/15 px-5 py-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
            Execution repository
          </div>
          <div className="mt-1 text-sm font-semibold">
            仓库与本机 checkout 都配置在 Agent 上
          </div>
        </div>
        <div className="rounded-full bg-white/70 px-3 py-1 text-[10px] text-dim">
          {device.name}
        </div>
      </div>
      <div className="grid gap-x-5 p-5 md:grid-cols-2">
        <Field label="Repository">
          <select
            className={inputCls}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          >
            {mounted.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            <option value="__new__">＋ New repository</option>
          </select>
        </Field>
        <Field label="Repository name">
          <input
            className={inputCls}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="sm-toolkit"
          />
        </Field>
        <Field label="Remote URL（optional）">
          <input
            className={inputCls}
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="git@github.com:org/repo.git"
          />
        </Field>
        <Field label="Base branch">
          <input
            className={inputCls}
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Local checkout path">
            <input
              className={`${inputCls} font-mono text-xs`}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/absolute/path/to/repository"
            />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-accent/15 bg-white/35 px-5 py-3.5">
        <p className="text-[11px] leading-5 text-dim">
          同一 Repository 在同一 Device 上共用
          checkout；修改路径会影响绑定它的其他 Agent。
        </p>
        <button
          className={btnPrimary}
          disabled={busy || !name.trim() || !branch.trim() || !path.trim()}
          onClick={save}
        >
          {busy ? "保存中…" : "Save repository"}
        </button>
      </div>
    </section>
  );
}

function NewAgentPanel({
  devices,
  skills,
  repositories,
  onClose,
  onCreated,
}: {
  devices: Device[];
  skills: SkillWithAgents[];
  repositories: RepositoryWithMounts[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const initialDevice =
    devices.find((candidate) => candidate.online) ?? devices[0];
  const [device, setDevice] = useState(initialDevice?.name ?? "");
  const initialRuntimes = (["claude", "codex"] as BackendKind[]).filter(
    (runtime) => !!initialDevice?.capabilities.clis?.[runtime],
  );
  const [backend, setBackend] = useState<BackendKind | "">(
    initialRuntimes.includes("claude") ? "claude" : (initialRuntimes[0] ?? ""),
  );
  const [model, setModel] = useState("");
  const [repository, setRepository] = useState("__new__");
  const [repositoryName, setRepositoryName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [checkoutPath, setCheckoutPath] = useState("");
  const [permission, setPermission] = useState<string>("auto-edit");
  const [isolation, setIsolation] = useState("none");
  const [instruction, setInstruction] = useState("");
  const [concurrency, setConcurrency] = useState(1);
  const [visibility, setVisibility] =
    useState<HarborAgent["visibility"]>("workspace");
  const [environment, setEnvironment] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [additionalRepositoryIds, setAdditionalRepositoryIds] = useState<
    string[]
  >([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const selectedDevice = devices.find((d) => d.name === device);
  const availableRepositories = repositories.filter((item) =>
    item.mounts.some((mount) => mount.deviceId === selectedDevice?.id),
  );
  const selectedRepository = repositories.find(
    (item) => item.id === repository,
  );
  const availableRuntimes = (["claude", "codex"] as BackendKind[]).filter(
    (runtime) => !!selectedDevice?.capabilities.clis?.[runtime],
  );
  const modelRoutes = useMemo(
    () => routesForDevice(selectedDevice),
    [selectedDevice],
  );
  const routeGroups = useMemo(() => {
    const groups = new Map<string, ModelRouteCapability[]>();
    for (const route of modelRoutes.filter(
      (candidate) => candidate.runtime === backend,
    )) {
      const rows = groups.get(route.provider) ?? [];
      rows.push(route);
      groups.set(route.provider, rows);
    }
    return [...groups.entries()];
  }, [backend, modelRoutes]);
  const readyRoutes = modelRoutes.filter(
    (route) => route.runtime === backend && route.ready,
  ).length;
  const compatibleSkills = skills.filter(
    (skill) =>
      backend &&
      skill.runtimes.includes(backend) &&
      (skill.source !== "runtime" || skill.deviceId === selectedDevice?.id),
  );

  const selectDevice = (name: string) => {
    setDevice(name);
    setModel("");
    const next = devices.find((d) => d.name === name);
    const available = (["claude", "codex"] as BackendKind[]).filter(
      (provider) => !!next?.capabilities.clis?.[provider],
    );
    setBackend(available.includes("claude") ? "claude" : (available[0] ?? ""));
    setSkillIds((current) =>
      current.filter((id) => {
        const skill = skills.find((item) => item.id === id);
        const nextBackend = available.includes("claude")
          ? "claude"
          : available[0];
        return (
          !!skill &&
          !!nextBackend &&
          skill.runtimes.includes(nextBackend) &&
          (skill.source === "manual" || skill.deviceId === next?.id)
        );
      }),
    );
    if (!available.includes("claude") && permission === "default")
      setPermission("auto-edit");
    if (
      repository !== "__new__" &&
      !repositories
        .find((item) => item.id === repository)
        ?.mounts.some((mount) => mount.deviceId === next?.id)
    ) {
      setRepository("__new__");
    }
    setAdditionalRepositoryIds((ids) =>
      ids.filter((id) =>
        repositories
          .find((item) => item.id === id)
          ?.mounts.some((mount) => mount.deviceId === next?.id),
      ),
    );
  };

  const selectRuntime = (value: BackendKind) => {
    setBackend(value);
    setModel("");
    setSkillIds((current) =>
      current.filter((id) => {
        const skill = skills.find((item) => item.id === id);
        return (
          !!skill &&
          skill.runtimes.includes(value) &&
          (skill.source === "manual" || skill.deviceId === selectedDevice?.id)
        );
      }),
    );
    if (value === "codex" && permission === "default")
      setPermission("auto-edit");
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    try {
      let repositoryId = repository;
      if (repository === "__new__") {
        const created = await createRepository({
          name: repositoryName.trim(),
          remoteUrl: remoteUrl.trim() || undefined,
          defaultBranch: defaultBranch.trim() || "main",
          device,
          path: checkoutPath.trim(),
        });
        repositoryId = created.id;
      }
      await createAgent({
        name: name.trim(),
        description: description.trim() || undefined,
        device,
        backend,
        model: model.trim() || undefined,
        repository: repositoryId,
        repositories: additionalRepositoryIds,
        permission,
        isolation,
        instruction: instruction.trim() || undefined,
        concurrency,
        visibility,
        environment: environment.trim() ? JSON.parse(environment) : {},
        setupScript: setupScript.trim() || undefined,
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
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">
            New Agent
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">
            Configure a runtime
          </h2>
        </div>
        <button type="button" className={btnGhost} onClick={onClose}>
          取消
        </button>
      </div>
      <div className="mx-auto w-full max-w-[820px] flex-1 px-7 py-2 max-sm:px-4">
        <AgentFormSection title="Identity">
          <div className="grid gap-x-5 md:grid-cols-2">
            <Field label="Agent name">
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：Code reviewer"
              />
            </Field>
            <Field label="Device">
              <select
                className={inputCls}
                value={device}
                onChange={(e) => selectDevice(e.target.value)}
              >
                {devices.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name} · {item.online ? "Online" : "Offline"}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Description">
            <input
              className={inputCls}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个 Agent 的职责边界"
            />
          </Field>
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
                    <span className="font-semibold">
                      {runtime === "claude" ? "Claude Code" : "Codex CLI"}
                    </span>
                    <span
                      className={`h-2 w-2 rounded-full ${selectedDevice?.online ? "bg-done" : "bg-zinc-400"}`}
                    />
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] text-dim">
                    v{selectedDevice?.capabilities.clis?.[runtime]}
                  </div>
                </button>
              ))}
            </div>
          </Field>

          {backend === "claude" ? (
            <Field label="Model route">
              <select
                className={inputCls}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">Runtime default</option>
                <optgroup label="Claude aliases">
                  {NATIVE_TIER_ALIASES.map((alias) => (
                    <option key={alias} value={alias}>
                      {alias}
                    </option>
                  ))}
                </optgroup>
                {routeGroups.map(([provider, routes]) => (
                  <optgroup key={provider} label={`${provider} · sm-toolkit`}>
                    {routes.map((route) => (
                      <option
                        key={route.id}
                        value={route.id}
                        disabled={!route.ready}
                      >
                        {route.label ?? route.model} · {provider}
                        {route.ready ? "" : " · missing key"}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <RouteSyncState total={modelRoutes.length} ready={readyRoutes} />
            </Field>
          ) : routeGroups.length > 0 ? (
            <Field label="Model">
              <select
                className={inputCls}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">Runtime default（跟随 Codex CLI 配置）</option>
                {routeGroups.map(([provider, routes]) => (
                  <optgroup
                    key={provider}
                    label={`${provider} · 本机 models cache`}
                  >
                    {routes.map((route) => (
                      <option key={route.id} value={route.model}>
                        {route.label ?? route.model}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="mt-2 text-xs leading-5 text-dim">
                清单来自该设备 codex CLI 按登录态缓存的可用模型。
              </p>
            </Field>
          ) : (
            <Field label="Model override">
              <input
                className={inputCls}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="留空跟随 Codex CLI 配置"
              />
              <p className="mt-2 text-xs leading-5 text-dim">
                该设备未上报 codex 模型清单（models_cache.json
                缺失）；这里透传其本地 model 名。
              </p>
            </Field>
          )}
        </AgentFormSection>

        <AgentFormSection title="Execution target">
          <Field label="Repository">
            <select
              className={inputCls}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            >
              {availableRepositories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              <option value="__new__">＋ New repository</option>
            </select>
            <p className="mt-2 text-xs leading-5 text-dim">
              这是 Agent 的固定代码上下文；Issue 与 Chat 指派后自动继承。
            </p>
            {selectedRepository && (
              <div className="mt-2 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[10px] text-dim">
                {
                  selectedRepository.mounts.find(
                    (mount) => mount.deviceId === selectedDevice?.id,
                  )?.path
                }
              </div>
            )}
          </Field>
          {repository === "__new__" && (
            <div className="mb-5 grid gap-x-5 rounded-2xl border border-accent/20 bg-accent-soft/25 p-4 md:grid-cols-2">
              <Field label="Repository name">
                <input
                  className={inputCls}
                  value={repositoryName}
                  onChange={(event) => setRepositoryName(event.target.value)}
                  placeholder="sm-toolkit"
                />
              </Field>
              <Field label="Base branch">
                <input
                  className={inputCls}
                  value={defaultBranch}
                  onChange={(event) => setDefaultBranch(event.target.value)}
                  placeholder="main"
                />
              </Field>
              <div className="md:col-span-2">
                <Field label="Remote URL（optional）">
                  <input
                    className={inputCls}
                    value={remoteUrl}
                    onChange={(event) => setRemoteUrl(event.target.value)}
                    placeholder="git@github.com:org/repo.git"
                  />
                </Field>
              </div>
              <div className="md:col-span-2">
                <Field label="Local checkout path">
                  <input
                    className={`${inputCls} font-mono text-xs`}
                    value={checkoutPath}
                    onChange={(event) => setCheckoutPath(event.target.value)}
                    placeholder="/absolute/path/to/repository"
                  />
                </Field>
              </div>
            </div>
          )}
          {availableRepositories.length > 1 && (
            <Field label="Additional visible repositories">
              <div className="grid gap-2 sm:grid-cols-2">
                {availableRepositories
                  .filter((item) => item.id !== repository)
                  .map((item) => {
                    const checked = additionalRepositoryIds.includes(item.id);
                    return (
                      <label
                        key={item.id}
                        className="flex gap-2 rounded-xl border border-line bg-white/65 p-3 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setAdditionalRepositoryIds((ids) =>
                              checked
                                ? ids.filter((id) => id !== item.id)
                                : [...ids, item.id],
                            )
                          }
                        />
                        <span>{item.name}</span>
                      </label>
                    );
                  })}
              </div>
            </Field>
          )}
          <Field label="Permission">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {PERMISSIONS.filter(
                (value) => backend !== "codex" || value !== "default",
              ).map((value) => (
                <ChoiceButton
                  key={value}
                  selected={permission === value}
                  onClick={() => setPermission(value)}
                >
                  {PERMISSION_LABELS[value]}
                </ChoiceButton>
              ))}
            </div>
          </Field>
          <Field label="Isolation">
            <div className="grid grid-cols-2 gap-2">
              <ChoiceButton
                selected={isolation === "none"}
                onClick={() => setIsolation("none")}
              >
                Direct checkout
              </ChoiceButton>
              <ChoiceButton
                selected={isolation === "worktree"}
                onClick={() => setIsolation("worktree")}
              >
                Git worktree
              </ChoiceButton>
            </div>
          </Field>
        </AgentFormSection>

        <AgentFormSection title="Skills">
          <p className="mb-3 text-xs leading-5 text-dim">
            选择 Workspace 已导入的能力；Runtime Skill 只显示当前 Device
            真能使用的项。
          </p>
          <SkillPicker
            skills={compatibleSkills}
            selected={skillIds}
            onChange={setSkillIds}
          />
        </AgentFormSection>

        <AgentFormSection title="Runtime policy">
          <div className="grid gap-x-5 md:grid-cols-2">
            <Field label="Concurrency">
              <input
                type="number"
                min={1}
                max={64}
                className={inputCls}
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              />
            </Field>
            <Field label="Visibility">
              <select
                className={inputCls}
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as HarborAgent["visibility"])
                }
              >
                <option value="workspace">Workspace</option>
                <option value="private">Private</option>
              </select>
            </Field>
          </div>
          <Field label="Environment JSON">
            <textarea
              className={`${inputCls} min-h-24 font-mono text-xs`}
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              placeholder={'{"API_BASE":"https://…"}'}
            />
          </Field>
          <Field label="Setup commands">
            <textarea
              className={`${inputCls} min-h-28 font-mono text-xs`}
              value={setupScript}
              onChange={(event) => setSetupScript(event.target.value)}
              placeholder="bun install --frozen-lockfile"
            />
          </Field>
          <label className="flex gap-2 text-xs text-dim">
            <input type="checkbox" checked disabled /> Reuse Device CLI
            credentials
          </label>
        </AgentFormSection>

        <AgentFormSection title="Instruction" last>
          <textarea
            className={`${inputCls} min-h-32 resize-y leading-6`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="这个 Agent 应该长期遵守什么？"
          />
        </AgentFormSection>
      </div>
      <div className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-line bg-panel/95 px-7 py-4 backdrop-blur max-sm:px-4">
        <span className="text-xs text-dim">
          Agent 配置会作为新的执行快照保存
        </span>
        <button
          type="submit"
          className={btnPrimary}
          disabled={
            busy ||
            !name.trim() ||
            !device ||
            !backend ||
            !repository ||
            (repository === "__new__" &&
              (!repositoryName.trim() ||
                !defaultBranch.trim() ||
                !checkoutPath.trim()))
          }
        >
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
  if (device.capabilities.modelRoutes?.length)
    return device.capabilities.modelRoutes;
  return (device.capabilities.endpoints ?? []).flatMap((id) => {
    const separator = id.indexOf(":");
    if (separator <= 0) return [];
    return [
      {
        id,
        provider: id.slice(0, separator),
        model: id.slice(separator + 1),
        runtime: "claude" as const,
        kind: "anthropic" as const,
        ready: true,
      },
    ];
  });
}

function AgentFormSection({
  title,
  children,
  last,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section className={`${last ? "" : "border-b border-line"} py-6`}>
      <h3 className="mb-4 text-base font-semibold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

function ChoiceButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`min-h-11 rounded-xl border px-3 text-sm font-medium ${selected ? "border-accent bg-accent-soft/60 text-accent-strong" : "border-line bg-white/70 text-ink/75 hover:border-zinc-300 hover:bg-white"}`}
      onClick={onClick}
    >
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
  const toggle = (id: string) =>
    onChange(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id],
    );
  if (skills.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-white/45 px-4 py-6 text-center text-xs leading-5 text-dim">
        没有兼容的 Skill。先去 Skills 页面创建或同步本机 Runtime。
      </div>
    );
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
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] ${active ? "border-accent bg-accent text-white" : "border-zinc-300 bg-white text-transparent"}`}
              >
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {skill.name}
                  </span>
                  <span className="rounded-full bg-bg px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-dim">
                    {skill.source}
                  </span>
                </span>
                <span className="mt-1 block line-clamp-2 text-[11px] leading-4 text-dim">
                  {skill.description || "No description"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {selected.length > 3 && (
        <div className="mt-2 text-xs text-review">
          已选择 {selected.length} 个；Skill
          过多会放大上下文和指令冲突，建议收敛到 2–3 个。
        </div>
      )}
    </div>
  );
}

function RouteSyncState({ total, ready }: { total: number; ready: number }) {
  if (total === 0) {
    return (
      <div className="mt-2.5 flex items-center gap-2 text-xs text-review">
        <span className="h-1.5 w-1.5 rounded-full bg-review" />
        未收到 sm-toolkit routes；检查 endpoints.yaml 后重启 harbord
      </div>
    );
  }
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
      <span className="inline-flex items-center gap-2 text-done">
        <span className="h-1.5 w-1.5 rounded-full bg-done" />
        sm-toolkit synced
      </span>
      <span>{ready} ready</span>
      {ready < total && (
        <span className="text-review">{total - ready} missing key</span>
      )}
    </div>
  );
}
