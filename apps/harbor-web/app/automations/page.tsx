"use client";

import { useEffect, useState } from "react";
import {
  automationLog,
  createAutomation,
  deleteAutomation,
  listAgents,
  listAutomations,
  listConversations,
  runAutomation,
  setAutomationEnabled,
  type AutomationLogRow,
  type AutomationWithAgent,
  type ConversationWithAgent,
  type HarborAgent,
} from "../../lib/api";
import { ago, usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Empty, Field, inputCls, Modal, ModalFooter, PageHeader } from "../../components/ui";

type TriggerType = "schedule" | "webhook";
type OutputMode = "run" | "chat" | "issue" | "append";
type OverlapMode = "skip" | "queue";

export default function AutomationsPage() {
  const autos = usePoll(listAutomations, 10_000);
  const agents = usePoll(listAgents, 30_000);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const current = autos.data ?? [];
  const scheduleCount = current.flatMap((automation) => automation.triggers).filter((trigger) => trigger.type === "schedule").length;
  const webhookCount = current.flatMap((automation) => automation.triggers).filter((trigger) => trigger.type === "webhook").length;

  return (
    <div className="page-enter mx-auto max-w-[1440px] p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Prompt-driven orchestration"
        title="Automations"
        description={`${current.filter((automation) => automation.enabled).length} 条启用 · ${scheduleCount} schedule · ${webhookCount} webhook。Manual 可随时执行；overlap 决定重叠触发是跳过还是排队。`}
        actions={<button className={btnPrimary} onClick={() => setCreating(true)}><span className="mr-1.5 text-base leading-none">＋</span> New Automation</button>}
      />
      {autos.error && <div className="mb-3 text-sm text-canceled">{autos.error}</div>}
      <div className="surface-shadow overflow-x-auto rounded-2xl border border-line bg-panel">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-dim">
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">name</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">agent</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">triggers</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">output</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">overlap</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">state</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">last fired</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">actions</th>
            </tr>
          </thead>
          <tbody>
            {current.map((automation) => (
              <AutomationRow
                key={automation.id}
                auto={automation}
                expanded={expanded === automation.id}
                onToggleLog={() => setExpanded(expanded === automation.id ? null : automation.id)}
                onChanged={autos.reload}
              />
            ))}
          </tbody>
        </table>
        {current.length === 0 && <Empty text="还没有 automation" />}
      </div>
      {creating && (
        <NewAutomationModal
          agents={agents.data ?? []}
          onClose={() => setCreating(false)}
          onChanged={autos.reload}
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
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (expanded) automationLog(auto.id).then(setLog, (error) => toast(String(error.message ?? error), "error"));
    else setLog(null);
  }, [expanded, auto.id, toast]);

  const toggleEnabled = async () => {
    try {
      await setAutomationEnabled(auto.id, !auto.enabled);
      toast(auto.enabled ? `已停用 ${auto.name}` : `已启用 ${auto.name}`, "success");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const remove = async () => {
    if (!confirm(`删除 automation "${auto.name}"？（Trigger 与日志一并删除）`)) return;
    try {
      await deleteAutomation(auto.id);
      toast(`已删除 ${auto.name}`, "success");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const run = await runAutomation(auto.id);
      toast(`${auto.name} 已手动触发（${run.id.slice(0, 12)}）`, "success");
      onChanged();
      if (expanded) automationLog(auto.id).then(setLog, () => {});
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <tr className="border-b border-line hover:bg-bg/55 last:border-0">
        <td className="px-4 py-3 font-medium">{auto.name}</td>
        <td className="px-4 py-3">{auto.agentName}</td>
        <td className="px-4 py-3 text-xs">
          <div className="flex flex-wrap gap-1">
            {auto.triggers.map((trigger) => (
              <span key={trigger.id} className="rounded-full border border-line bg-bg px-2 py-0.5 font-mono">
                {trigger.type === "schedule" ? trigger.cron : `${trigger.provider ?? "generic"}:webhook`}
              </span>
            ))}
            {auto.triggers.length === 0 && <span className="text-dim">manual only</span>}
          </div>
        </td>
        <td className="px-4 py-3 font-mono text-xs">{auto.outputMode}</td>
        <td className="px-4 py-3 font-mono text-xs">{auto.overlapMode}</td>
        <td className="px-4 py-3">
          <span className={`text-xs font-medium ${auto.enabled ? "text-done" : "text-dim"}`}>{auto.enabled ? "on" : "off"}</span>
        </td>
        <td className="px-4 py-3 text-xs text-dim">{ago(auto.lastFiredAt)}</td>
        <td className="px-4 py-3">
          <div className="flex gap-2 text-xs">
            <button className="text-accent hover:underline disabled:opacity-50" onClick={runNow} disabled={running}>
              {running ? "running…" : "run now"}
            </button>
            <button className="text-accent hover:underline" onClick={toggleEnabled}>{auto.enabled ? "disable" : "enable"}</button>
            <button className="text-dim hover:underline" onClick={onToggleLog}>log</button>
            <button className="text-canceled hover:underline" onClick={remove}>删除</button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-line bg-bg last:border-0">
          <td colSpan={8} className="px-3 py-2">
            {!log ? <span className="text-xs text-dim">加载中…</span> : log.length === 0 ? (
              <span className="text-xs text-dim">还没有触发记录</span>
            ) : (
              <div className="flex flex-col gap-1 font-mono text-xs">
                {log.map((entry, index) => (
                  <div key={`${entry.ts}-${index}`}>
                    <span className={entry.kind === "fired" ? "text-done" : entry.kind === "rejected" ? "text-canceled" : "text-review"}>{entry.kind}</span>
                    <span className="ml-2 text-dim">{new Date(entry.ts).toLocaleString()}</span>
                    {entry.runId && <span className="ml-2 text-dim">run {entry.runId.slice(0, 12)}</span>}
                    {entry.eventId && <span className="ml-2 text-dim">event {entry.eventId}</span>}
                    {entry.note && <span className="ml-2 text-dim">{entry.note}</span>}
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
  onChanged,
}: {
  agents: HarborAgent[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [agent, setAgent] = useState(agents[0]?.name ?? "");
  const selectedAgent = agents.find((candidate) => candidate.name === agent);
  const [triggerType, setTriggerType] = useState<TriggerType>("schedule");
  const [cron, setCron] = useState("");
  const [provider, setProvider] = useState("generic");
  const [events, setEvents] = useState("");
  const [filterPath, setFilterPath] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [prompt, setPrompt] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("run");
  const [overlapMode, setOverlapMode] = useState<OverlapMode>("skip");
  const [target, setTarget] = useState("");
  const [notifyChat, setNotifyChat] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<ConversationWithAgent[]>([]);
  const [createdWebhook, setCreatedWebhook] = useState<{ path: string; secret: string } | null>(null);

  useEffect(() => {
    if (outputMode === "append" && conversations.length === 0) listConversations({}).then(setConversations, () => {});
  }, [outputMode, conversations.length]);

  const submit = async () => {
    setBusy(true);
    try {
      const created = await createAutomation({
        name: name.trim(),
        agent,
        triggerType,
        ...(triggerType === "schedule" ? { cron: cron.trim() } : {
          provider: provider.trim() || "generic",
          events: events.split(",").map((event) => event.trim()).filter(Boolean),
          filters: filterPath.trim() ? [{ path: filterPath.trim(), equals: filterValue }] : [],
        }),
        prompt: prompt.trim(),
        outputMode,
        overlapMode,
        target: outputMode === "append" ? target : undefined,
        notifyChat: notifyChat.trim() || undefined,
      });
      onChanged();
      const webhook = created.triggers.find((trigger) => trigger.type === "webhook");
      if (webhook?.webhookPath && created.webhookSecret) {
        setCreatedWebhook({ path: webhook.webhookPath, secret: created.webhookSecret });
        toast(`automation "${name}" 已创建；请保存 webhook secret`, "success");
      } else {
        toast(`automation "${name}" 已创建并排班`, "success");
        onClose();
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  if (createdWebhook) {
    return (
      <Modal title="Webhook created" onClose={onClose} wide>
        <div className="rounded-xl border border-review/35 bg-review/5 p-4 text-sm">
          <div className="font-semibold text-ink">Secret 只显示这一次</div>
          <div className="mt-3 text-xs text-dim">Path</div>
          <div className="mt-1 break-all rounded-lg bg-panel p-3 font-mono text-xs">{createdWebhook.path}</div>
          <div className="mt-3 text-xs text-dim">X-Harbor-Webhook-Secret</div>
          <div className="mt-1 break-all rounded-lg bg-panel p-3 font-mono text-xs">{createdWebhook.secret}</div>
          <button
            className={`${btnGhost} mt-3`}
            onClick={() => navigator.clipboard.writeText(`path=${createdWebhook.path}\nsecret=${createdWebhook.secret}`).then(() => toast("已复制", "success"))}
          >
            Copy path + secret
          </button>
        </div>
        <ModalFooter><button className={btnPrimary} onClick={onClose}>完成</button></ModalFooter>
      </Modal>
    );
  }

  const directWorktreeConflict = outputMode === "run" && selectedAgent?.isolation === "worktree";
  return (
    <Modal title="New Automation" onClose={onClose} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="name">
          <input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} placeholder="如 release-feedback" />
        </Field>
        <Field label="agent">
          <select className={inputCls} value={agent} onChange={(event) => setAgent(event.target.value)}>
            {agents.map((candidate) => <option key={candidate.id} value={candidate.name}>{candidate.name}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="trigger">
          <select className={inputCls} value={triggerType} onChange={(event) => setTriggerType(event.target.value as TriggerType)}>
            <option value="schedule">Schedule</option>
            <option value="webhook">Webhook</option>
          </select>
        </Field>
        {triggerType === "schedule" ? (
          <Field label="cron（Server 本机时区）">
            <input className={`${inputCls} font-mono`} value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * *" />
          </Field>
        ) : (
          <Field label="provider">
            <select className={inputCls} value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="generic">Generic</option>
              <option value="codebase">Codebase</option>
            </select>
          </Field>
        )}
      </div>

      {triggerType === "webhook" && (
        <div className="grid gap-4 rounded-xl border border-line bg-bg p-3 sm:grid-cols-2">
          <Field label="events（逗号分隔；留空接受全部）">
            <input className={`${inputCls} font-mono`} value={events} onChange={(event) => setEvents(event.target.value)} placeholder="push, merge_request" />
          </Field>
          <Field label="可选 OR filter">
            <div className="grid grid-cols-2 gap-2">
              <input className={`${inputCls} font-mono`} value={filterPath} onChange={(event) => setFilterPath(event.target.value)} placeholder="ref" />
              <input className={`${inputCls} font-mono`} value={filterValue} onChange={(event) => setFilterValue(event.target.value)} placeholder="refs/tags/release/prod" />
            </div>
          </Field>
        </div>
      )}

      <Field label="prompt">
        <textarea className={`${inputCls} h-28 resize-y`} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="output">
          <select className={inputCls} value={outputMode} onChange={(event) => setOutputMode(event.target.value as OutputMode)}>
            <option value="run">Run（Automation 直接执行）</option>
            <option value="chat">Chat（每次创建 Chat）</option>
            <option value="issue">Issue（兼容模式）</option>
            <option value="append">Append（固定会话）</option>
          </select>
        </Field>
        <Field label="overlap">
          <select className={inputCls} value={overlapMode} onChange={(event) => setOverlapMode(event.target.value as OverlapMode)}>
            <option value="skip">Skip（有活动 Run 时跳过）</option>
            <option value="queue">Queue（串行排队）</option>
          </select>
        </Field>
      </div>

      {directWorktreeConflict && (
        <div className="rounded-xl border border-canceled/30 bg-canceled/5 px-3 py-2 text-xs text-canceled">
          {selectedAgent?.name} 使用 worktree isolation。Automation 直跑没有 Issue 生命周期负责清理，请改用 Chat/Issue 输出或把 Agent isolation 改为 none。
        </div>
      )}
      {outputMode === "append" && (
        <Field label="target conversation">
          <select className={inputCls} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">选择会话…</option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>[{conversation.kind}] {conversation.title || conversation.id.slice(0, 12)}（{conversation.agentName}）</option>
            ))}
          </select>
        </Field>
      )}
      <Field label="notifyChat（可空；飞书 chat_id）">
        <input className={`${inputCls} font-mono`} value={notifyChat} onChange={(event) => setNotifyChat(event.target.value)} placeholder="oc_xxx" />
      </Field>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>取消</button>
        <button
          className={btnPrimary}
          disabled={busy || !name.trim() || !agent || !prompt.trim() || (triggerType === "schedule" && !cron.trim()) || (outputMode === "append" && !target) || directWorktreeConflict}
          onClick={submit}
        >
          {busy ? "创建中…" : "创建"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
