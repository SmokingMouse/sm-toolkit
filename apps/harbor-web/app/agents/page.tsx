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
  type HarborAgent,
} from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Empty, Field, inputCls, Modal, ModalFooter } from "../../components/ui";

export default function AgentsPage() {
  const agents = usePoll(listAgents, 10_000);
  const devices = usePoll(listDevices, 10_000);
  const [creating, setCreating] = useState(false);
  const deviceById = useMemo(
    () => new Map((devices.data ?? []).map((d) => [d.id, d])),
    [devices.data],
  );

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agents</h1>
        <button className={btnPrimary} onClick={() => setCreating(true)}>
          + New
        </button>
      </div>
      {agents.error && <div className="mb-3 text-sm text-canceled">{agents.error}</div>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {(agents.data ?? []).map((a) => (
          <AgentCard key={a.id} agent={a} device={deviceById.get(a.deviceId)} onChanged={agents.reload} />
        ))}
      </div>
      {agents.data?.length === 0 && <Empty text="还没有 agent —— 点 + New 创建（需要该设备 harbord 在线注册过）" />}
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

  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{agent.name}</span>
          <span
            className={`inline-block h-2 w-2 rounded-full ${device?.online ? "bg-done" : "bg-zinc-300"}`}
            title={device?.online ? "设备在线" : "设备离线"}
          />
        </div>
        <button className="text-xs text-dim hover:text-canceled" onClick={archive}>
          归档
        </button>
      </div>
      {agent.description && <div className="mb-2 text-xs text-dim">{agent.description}</div>}
      <dl className="grid grid-cols-[72px_1fr] gap-y-1 text-xs">
        <dt className="text-dim">device</dt>
        <dd>{device?.name ?? agent.deviceId}</dd>
        <dt className="text-dim">backend</dt>
        <dd>{agent.backend}</dd>
        <dt className="text-dim">model</dt>
        <dd className="font-mono">{agent.model ?? "（CLI 默认）"}</dd>
        <dt className="text-dim">permission</dt>
        <dd>{agent.permission}</dd>
        <dt className="text-dim">isolation</dt>
        <dd>{agent.isolation}</dd>
        <dt className="text-dim">workdir</dt>
        <dd className="break-all font-mono">{agent.workdir}</dd>
      </dl>
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
  const [model, setModel] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [permission, setPermission] = useState<string>("auto-edit");
  const [isolation, setIsolation] = useState("none");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedDevice = devices.find((d) => d.name === device);
  const modelOptions = [
    ...NATIVE_TIER_ALIASES,
    ...(selectedDevice?.capabilities.endpoints ?? []),
  ];

  const submit = async () => {
    setBusy(true);
    try {
      await createAgent({
        name: name.trim(),
        device,
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
    <Modal title="New Agent" onClose={onClose}>
      <Field label="name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 mac-mini-dev" />
      </Field>
      <Field label="device">
        <select className={inputCls} value={device} onChange={(e) => setDevice(e.target.value)}>
          {devices.map((d) => (
            <option key={d.id} value={d.name}>
              {d.name} {d.online ? "（在线）" : "（离线）"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="model（留空 = CLI 默认；可手输，服务端校验能力清单）">
        <input
          className={inputCls}
          list="model-options"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="（CLI 默认）"
        />
        <datalist id="model-options">
          {modelOptions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>
      <Field label="workdir（该设备上的绝对路径）">
        <input className={inputCls} value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/Users/xxx/repo" />
      </Field>
      <Field label="permission">
        <select className={inputCls} value={permission} onChange={(e) => setPermission(e.target.value)}>
          {PERMISSIONS.map((p) => (
            <option key={p} value={p}>
              {p}
              {p === "default" ? "（需授权工具走审批）" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="isolation">
        <select className={inputCls} value={isolation} onChange={(e) => setIsolation(e.target.value)}>
          <option value="none">none</option>
          <option value="worktree">worktree（per-issue git worktree）</option>
        </select>
      </Field>
      <Field label="instruction（systemPrompt 注入，可空）">
        <textarea
          className={`${inputCls} h-20 resize-y`}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </Field>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button className={btnPrimary} disabled={busy || !name.trim() || !device || !workdir.trim()} onClick={submit}>
          {busy ? "创建中…" : "创建"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
