"use client";

import { useEffect, useState } from "react";
import {
  automationLog,
  createAutomation,
  deleteAutomation,
  listAgents,
  listAutomations,
  listConversations,
  setAutomationEnabled,
  type AutomationLogRow,
  type AutomationWithAgent,
  type ConversationWithAgent,
  type HarborAgent,
} from "../../lib/api";
import { ago, usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Empty, Field, inputCls, Modal, ModalFooter } from "../../components/ui";

export default function AutomationsPage() {
  const autos = usePoll(listAutomations, 10_000);
  const agents = usePoll(listAgents, 30_000);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Automations</h1>
        <button className={btnPrimary} onClick={() => setCreating(true)}>
          + New
        </button>
      </div>
      {autos.error && <div className="mb-3 text-sm text-canceled">{autos.error}</div>}
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-dim">
              <th className="px-3 py-2 font-medium">name</th>
              <th className="px-3 py-2 font-medium">agent</th>
              <th className="px-3 py-2 font-medium">cron</th>
              <th className="px-3 py-2 font-medium">mode</th>
              <th className="px-3 py-2 font-medium">enabled</th>
              <th className="px-3 py-2 font-medium">lastFired</th>
              <th className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {(autos.data ?? []).map((a) => (
              <AutomationRow
                key={a.id}
                auto={a}
                expanded={expanded === a.id}
                onToggleLog={() => setExpanded(expanded === a.id ? null : a.id)}
                onChanged={autos.reload}
              />
            ))}
          </tbody>
        </table>
        {(autos.data ?? []).length === 0 && <Empty text="还没有 automation" />}
      </div>
      {creating && (
        <NewAutomationModal
          agents={agents.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            autos.reload();
          }}
        />
      )}
    </div>
  );
}

function AutomationRow({
  auto,
  expanded,
  onToggleLog,
  onChanged,
}: {
  auto: AutomationWithAgent;
  expanded: boolean;
  onToggleLog: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [log, setLog] = useState<AutomationLogRow[] | null>(null);

  useEffect(() => {
    if (expanded) {
      automationLog(auto.id).then(setLog, (e) => toast(String(e.message ?? e), "error"));
    } else {
      setLog(null);
    }
  }, [expanded, auto.id, toast]);

  const toggleEnabled = async () => {
    try {
      await setAutomationEnabled(auto.id, !auto.enabled);
      toast(auto.enabled ? `已停用 ${auto.name}` : `已启用 ${auto.name}`, "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const remove = async () => {
    if (!confirm(`删除 automation "${auto.name}"？（日志一并删除）`)) return;
    try {
      await deleteAutomation(auto.id);
      toast(`已删除 ${auto.name}`, "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <>
      <tr className="border-b border-line last:border-0">
        <td className="px-3 py-2">{auto.name}</td>
        <td className="px-3 py-2">{auto.agentName}</td>
        <td className="px-3 py-2 font-mono text-xs">{auto.cron}</td>
        <td className="px-3 py-2 text-xs">{auto.mode}</td>
        <td className="px-3 py-2">
          <span className={`text-xs font-medium ${auto.enabled ? "text-done" : "text-dim"}`}>
            {auto.enabled ? "on" : "off"}
          </span>
        </td>
        <td className="px-3 py-2 text-xs text-dim">{ago(auto.lastFiredAt)}</td>
        <td className="px-3 py-2">
          <div className="flex gap-2 text-xs">
            <button className="text-accent hover:underline" onClick={toggleEnabled}>
              {auto.enabled ? "disable" : "enable"}
            </button>
            <button className="text-dim hover:underline" onClick={onToggleLog}>
              log
            </button>
            <button className="text-canceled hover:underline" onClick={remove}>
              删除
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-line bg-bg last:border-0">
          <td colSpan={7} className="px-3 py-2">
            {!log ? (
              <span className="text-xs text-dim">加载中…</span>
            ) : log.length === 0 ? (
              <span className="text-xs text-dim">还没有触发记录</span>
            ) : (
              <div className="flex flex-col gap-1 font-mono text-xs">
                {log.map((l, i) => (
                  <div key={i}>
                    <span className={l.kind === "fired" ? "text-done" : "text-review"}>{l.kind}</span>
                    <span className="ml-2 text-dim">{new Date(l.ts).toLocaleString()}</span>
                    {l.runId && <span className="ml-2 text-dim">run {l.runId.slice(0, 12)}</span>}
                    {l.note && <span className="ml-2 text-dim">{l.note}</span>}
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function NewAutomationModal({
  agents,
  onClose,
  onCreated,
}: {
  agents: HarborAgent[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [agent, setAgent] = useState(agents[0]?.name ?? "");
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"new_issue" | "append">("new_issue");
  const [target, setTarget] = useState("");
  const [notifyChat, setNotifyChat] = useState("");
  const [busy, setBusy] = useState(false);
  const [convs, setConvs] = useState<ConversationWithAgent[]>([]);

  // append 模式才需要 target 会话下拉
  useEffect(() => {
    if (mode === "append" && convs.length === 0) {
      listConversations({}).then(setConvs, () => {});
    }
  }, [mode, convs.length]);

  const submit = async () => {
    setBusy(true);
    try {
      await createAutomation({
        name: name.trim(),
        agent,
        cron: cron.trim(),
        prompt: prompt.trim(),
        mode,
        target: mode === "append" ? target : undefined,
        notifyChat: notifyChat.trim() || undefined,
      });
      toast(`automation "${name}" 已创建（默认启用）`, "success");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New Automation" onClose={onClose} wide>
      <Field label="name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 daily-report" />
      </Field>
      <Field label="agent">
        <select className={inputCls} value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="cron（5 段：分 时 日 月 周，server 本机时区）">
        <input
          className={`${inputCls} font-mono`}
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 9 * * *"
        />
        <div className="mt-1 text-xs text-dim">
          例：<code>*/5 * * * *</code> 每 5 分钟 · <code>0 9 * * *</code> 每天 9 点 · <code>0 18 * * 5</code> 周五 18 点
        </div>
      </Field>
      <Field label="prompt">
        <textarea className={`${inputCls} h-24 resize-y`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <Field label="mode">
        <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as "new_issue" | "append")}>
          <option value="new_issue">new_issue（每次触发建新 issue）</option>
          <option value="append">append（追加到固定会话，上下文连续）</option>
        </select>
      </Field>
      {mode === "append" && (
        <Field label="target 会话">
          <select className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">选择会话…</option>
            {convs.map((c) => (
              <option key={c.id} value={c.id}>
                [{c.kind}] {c.title || c.id.slice(0, 12)}（{c.agentName}）
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="notifyChat（可空；飞书群 chat_id，须在 server allowed_chats 白名单内才真正播报）">
        <input className={`${inputCls} font-mono`} value={notifyChat} onChange={(e) => setNotifyChat(e.target.value)} placeholder="oc_xxx" />
      </Field>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button
          className={btnPrimary}
          disabled={busy || !name.trim() || !agent || !cron.trim() || !prompt.trim() || (mode === "append" && !target)}
          onClick={submit}
        >
          {busy ? "创建中…" : "创建"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
