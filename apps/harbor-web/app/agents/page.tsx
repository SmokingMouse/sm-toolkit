"use client";

import { useMemo, useState } from "react";
import {
  createAgent,
  listAgents,
  listDevices,
  NATIVE_TIER_ALIASES,
  PERMISSIONS,
  setAgentArchived,
  type Device,
  type BackendKind,
  type HarborAgent,
} from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Empty, Field, inputCls, Metric, Modal, ModalFooter, PageHeader } from "../../components/ui";

export default function AgentsPage() {
  const agents = usePoll(listAgents, 10_000);
  const devices = usePoll(listDevices, 10_000);
  const [creating, setCreating] = useState(false);
  const deviceById = useMemo(
    () => new Map((devices.data ?? []).map((d) => [d.id, d])),
    [devices.data],
  );

  const allAgents = agents.data ?? [];
  const onlineAgents = allAgents.filter((agent) => deviceById.get(agent.deviceId)?.online).length;
  const providers = new Set(allAgents.map((agent) => agent.backend)).size;

  return (
    <div className="page-enter mx-auto max-w-[1440px] p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Execution roster"
        title="Agents"
        description="Agent 是 provider、模型、权限和工作目录的可派活组合；设备状态决定它此刻能否接单。"
        actions={
          <>
            <div className="mr-2 flex gap-5 rounded-xl border border-line bg-panel/75 px-4 py-2.5 surface-shadow max-lg:hidden">
              <Metric label="Agents" value={allAgents.length} />
              <Metric label="Ready" value={onlineAgents} tone="good" />
              <Metric label="Providers" value={providers} />
            </div>
            <button
              className={btnPrimary}
              disabled={!devices.data?.length}
              title={!devices.data?.length ? "需要先注册至少一台设备" : undefined}
              onClick={() => setCreating(true)}
            >
              <span className="mr-1.5 text-base leading-none">＋</span> New Agent
            </button>
          </>
        }
      />
      {agents.error && <div className="mb-3 text-sm text-canceled">{agents.error}</div>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {allAgents.map((a) => (
          <AgentCard key={a.id} agent={a} device={deviceById.get(a.deviceId)} onChanged={agents.reload} />
        ))}
      </div>
      {allAgents.length === 0 && <Empty text="还没有 Agent——创建前需要至少一台已注册设备" />}
      {creating && (
        <NewAgentModal
          devices={devices.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            agents.reload();
          }}
        />
      )}
    </div>
  );
}

function AgentCard({
  agent,
  device,
  onChanged,
}: {
  agent: HarborAgent;
  device: Device | undefined;
  onChanged: () => void;
}) {
  const toast = useToast();
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
    <article className="surface-shadow group overflow-hidden rounded-2xl border border-line bg-panel">
      <div className={`h-1 ${agent.backend === "claude" ? "bg-[#c98b4b]" : "bg-accent"}`} />
      <div className="p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold uppercase ${agent.backend === "claude" ? "bg-[#f2e7d7] text-[#9b5f25]" : "bg-accent-soft text-accent-strong"}`}>{agent.backend[0]}</div>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">{agent.name}</h2>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-dim">
                <span className={`h-1.5 w-1.5 rounded-full ${device?.online ? "bg-done" : "bg-zinc-400"}`} />
                {device?.online ? "ready" : "device offline"} · {agent.backend}
              </div>
            </div>
          </div>
          <button className="rounded-md px-2 py-1 text-[11px] text-dim opacity-60 hover:bg-red-50 hover:text-canceled group-hover:opacity-100" onClick={archive}>归档</button>
        </div>

        {agent.description && <p className="mb-4 text-xs leading-5 text-dim">{agent.description}</p>}
        {providerMissing && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-canceled">设备当前缺少 {agent.backend} provider</div>}

        <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-y border-line py-4 text-xs">
          <AgentFact label="Device" value={device?.name ?? agent.deviceId} />
          <AgentFact label="Model" value={agent.model ?? "CLI default"} mono />
          <AgentFact label="Permission" value={agent.permission} />
          <AgentFact label="Isolation" value={agent.isolation} />
        </div>

        <div className="mt-4">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.14em] text-dim">Working directory</div>
          <div className="truncate font-mono text-[10px] text-ink/70" title={agent.workdir}>{agent.workdir}</div>
        </div>
      </div>
    </article>
  );
}

function AgentFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-dim">{label}</div>
      <div className={`truncate font-medium ${mono ? "font-mono text-[11px]" : ""}`} title={value}>{value}</div>
    </div>
  );
}

function NewAgentModal({
  devices,
  onClose,
  onCreated,
}: {
  devices: Device[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [device, setDevice] = useState(devices[0]?.name ?? "");
  const firstProviders = (["claude", "codex"] as BackendKind[]).filter(
    (provider) => !!devices[0]?.capabilities.clis?.[provider],
  );
  const [backend, setBackend] = useState<BackendKind | "">(
    firstProviders.includes("claude") ? "claude" : (firstProviders[0] ?? ""),
  );
  const [model, setModel] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [permission, setPermission] = useState<string>("auto-edit");
  const [isolation, setIsolation] = useState("none");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedDevice = devices.find((d) => d.name === device);
  const providers = (["claude", "codex"] as BackendKind[]).filter(
    (provider) => !!selectedDevice?.capabilities.clis?.[provider],
  );
  const modelOptions = backend === "claude"
    ? [...NATIVE_TIER_ALIASES, ...(selectedDevice?.capabilities.endpoints ?? [])]
    : [];

  const selectDevice = (name: string) => {
    setDevice(name);
    setModel("");
    const next = devices.find((d) => d.name === name);
    const available = (["claude", "codex"] as BackendKind[]).filter(
      (provider) => !!next?.capabilities.clis?.[provider],
    );
    setBackend(available.includes("claude") ? "claude" : (available[0] ?? ""));
    if (!available.includes("claude") && permission === "default") setPermission("auto-edit");
  };

  const selectBackend = (value: BackendKind) => {
    setBackend(value);
    setModel("");
    if (value === "codex" && permission === "default") setPermission("auto-edit");
  };

  const submit = async () => {
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
    <Modal title="New Agent" onClose={onClose} wide>
      <div className="mb-4 rounded-xl border border-line bg-accent-soft/45 px-3.5 py-3 text-xs leading-5 text-dim">
        先选择运行设备，再从设备实报能力中选择 provider 与模型；Harbor 不会假定本机存在某个 CLI。
      </div>
      <div className="grid gap-x-4 md:grid-cols-2">
        <Field label="Agent name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="mac-mini-dev" />
        </Field>
        <Field label="Runtime device">
          <select className={inputCls} value={device} onChange={(e) => selectDevice(e.target.value)}>
            {devices.map((d) => <option key={d.id} value={d.name}>{d.name} · {d.online ? "online" : "offline"}</option>)}
          </select>
        </Field>
        <Field label="Provider · device reported">
          <select className={inputCls} value={backend} onChange={(e) => selectBackend(e.target.value as BackendKind)}>
            {providers.map((provider) => <option key={provider} value={provider}>{provider} · {selectedDevice?.capabilities.clis?.[provider]}</option>)}
            {providers.length === 0 && <option value="">无可用 provider</option>}
          </select>
        </Field>
        <Field label={backend === "claude" ? "Model · endpoint validated" : "Model · optional override"}>
          <input className={inputCls} list={backend === "claude" ? "model-options" : undefined} value={model} onChange={(e) => setModel(e.target.value)} placeholder="CLI default" />
          <datalist id="model-options">{modelOptions.map((m) => <option key={m} value={m} />)}</datalist>
        </Field>
        <div className="md:col-span-2">
          <Field label="Working directory · absolute path on device">
            <input className={`${inputCls} font-mono text-xs`} value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/Users/xxx/repo" />
          </Field>
        </div>
        <Field label="Permission mode">
          <select className={inputCls} value={permission} onChange={(e) => setPermission(e.target.value)}>
            {PERMISSIONS.filter((p) => backend !== "codex" || p !== "default").map((p) => <option key={p} value={p}>{p}{p === "default" ? " · tools require approval" : ""}</option>)}
          </select>
        </Field>
        <Field label="Workspace isolation">
          <select className={inputCls} value={isolation} onChange={(e) => setIsolation(e.target.value)}>
            <option value="none">none</option>
            <option value="worktree">worktree · per-issue git worktree</option>
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label="Instruction · optional system prompt">
            <textarea className={`${inputCls} h-20 resize-y`} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="给这个 Agent 一条长期有效的工作约束…" />
          </Field>
        </div>
      </div>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button className={btnPrimary} disabled={busy || !name.trim() || !device || !backend || !workdir.trim()} onClick={submit}>
          {busy ? "创建中…" : "创建"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
