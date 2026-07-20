"use client";

import { useEffect, useMemo, useState } from "react";
import {
  automationLog,
  createAutomation,
  deleteAutomation,
  listAgents,
  listAutomations,
  listRepositories,
  runAutomation,
  setAutomationEnabled,
  updateAutomation,
  type AutomationLogRow,
  type AutomationWithAgent,
  type HarborAgent,
  type RepositoryWithMounts,
} from "../../lib/api";
import { ago, usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Empty, Field, inputCls, Modal, ModalFooter, PageHeader } from "../../components/ui";

type Output = "run" | "chat" | "issue";
type TriggerType = "schedule" | "codebase";
type CodebaseEvent =
  | "merge_request_opened"
  | "merge_request_updated"
  | "merge_request_merged"
  | "issue_opened"
  | "issue_updated"
  | "issue_commented";

const OUTPUTS: { value: Output; label: string; description: string }[] = [
  { value: "run", label: "Run", description: "Run history only" },
  { value: "chat", label: "Chat", description: "Report in a chat" },
  { value: "issue", label: "Issue", description: "Actionable work" },
];

const CODEBASE_EVENTS: { value: CodebaseEvent; label: string }[] = [
  { value: "merge_request_opened", label: "Merge request opened" },
  { value: "merge_request_updated", label: "Merge request updated" },
  { value: "merge_request_merged", label: "Merge request merged" },
  { value: "issue_opened", label: "Issue opened" },
  { value: "issue_updated", label: "Issue updated" },
  { value: "issue_commented", label: "Issue commented" },
];

const TIMEZONES = [
  "Asia/Shanghai",
  "UTC",
  "Asia/Tokyo",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
];

const SCHEDULE_PRESETS = [
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 9 * * *", label: "Daily at 09:00" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 09:00" },
  { cron: "0 9 * * 1", label: "Every Monday at 09:00" },
  { cron: "0 9 1 * *", label: "Monthly on day 1 at 09:00" },
] as const;

function scheduleLabel(cron: string | null): string {
  if (!cron) return "Schedule";
  return SCHEDULE_PRESETS.find((preset) => preset.cron === cron)?.label ?? cron;
}

export default function AutomationsPage() {
  const automations = usePoll(listAutomations, 10_000);
  const agents = usePoll(listAgents, 30_000);
  const repositories = usePoll(listRepositories, 30_000);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AutomationWithAgent | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const current = automations.data ?? [];

  return (
    <div className="page-enter mx-auto max-w-[1440px] p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Prompt-driven orchestration"
        title="Automations"
        description={`${current.filter((automation) => automation.enabled).length} 条启用 · Output 决定结果落点，Trigger 决定何时启动。`}
        actions={<button className={btnPrimary} onClick={() => setCreating(true)}><span className="mr-1.5 text-base leading-none">＋</span> New Automation</button>}
      />
      {automations.error && <div className="mb-3 text-sm text-canceled">{automations.error}</div>}
      <div className="surface-shadow overflow-x-auto rounded-2xl border border-line bg-panel">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-dim">
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">name</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">agent</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">trigger</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">output</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">state</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">last fired</th>
              <th className="px-4 py-3 font-semibold uppercase tracking-[0.08em]">actions</th>
            </tr>
          </thead>
          <tbody>
            {current.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                expanded={expanded === automation.id}
                onToggleLog={() => setExpanded(expanded === automation.id ? null : automation.id)}
                onEdit={() => setEditing(automation)}
                onChanged={automations.reload}
              />
            ))}
          </tbody>
        </table>
        {current.length === 0 && <Empty text="还没有 automation" />}
      </div>
      {creating && (
        <AutomationEditor
          agents={agents.data ?? []}
          repositories={repositories.data ?? []}
          onClose={() => setCreating(false)}
          onChanged={automations.reload}
        />
      )}
      {editing && (
        <AutomationEditor
          automation={editing}
          agents={agents.data ?? []}
          repositories={repositories.data ?? []}
          onClose={() => setEditing(null)}
          onChanged={automations.reload}
        />
      )}
    </div>
  );
}

function AutomationRow({
  automation,
  expanded,
  onToggleLog,
  onEdit,
  onChanged,
}: {
  automation: AutomationWithAgent;
  expanded: boolean;
  onToggleLog: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [log, setLog] = useState<AutomationLogRow[] | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (expanded) automationLog(automation.id).then(setLog, (error) => toast(String(error.message ?? error), "error"));
    else setLog(null);
  }, [expanded, automation.id, toast]);

  const runNow = async () => {
    setRunning(true);
    try {
      const run = await runAutomation(automation.id);
      toast(`${automation.name} 已手动触发（${run.id.slice(0, 12)}）`, "success");
      onChanged();
      if (expanded) automationLog(automation.id).then(setLog, () => {});
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setRunning(false);
    }
  };

  const toggleEnabled = async () => {
    try {
      await setAutomationEnabled(automation.id, !automation.enabled);
      toast(automation.enabled ? `已停用 ${automation.name}` : `已启用 ${automation.name}`, "success");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const remove = async () => {
    if (!confirm(`删除 automation "${automation.name}"？`)) return;
    try {
      await deleteAutomation(automation.id);
      toast(`已删除 ${automation.name}`, "success");
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return (
    <>
      <tr className="border-b border-line hover:bg-bg/55 last:border-0">
        <td className="px-4 py-3 font-medium">{automation.name}</td>
        <td className="px-4 py-3">{automation.agentName}</td>
        <td className="px-4 py-3 text-xs">
          <div className="font-medium capitalize">{automation.trigger.type}</div>
          <div className="mt-0.5 font-mono text-[11px] text-dim">
            {automation.trigger.type === "schedule"
              ? `${scheduleLabel(automation.trigger.cron)} · ${automation.trigger.timezone}`
              : CODEBASE_EVENTS.find((event) => event.value === automation.trigger.codebaseEvent)?.label ?? automation.trigger.codebaseEvent}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="font-medium capitalize">{automation.output}</div>
          <div className="mt-0.5 text-[11px] text-dim">{OUTPUTS.find((output) => output.value === automation.output)?.description}</div>
        </td>
        <td className="px-4 py-3"><span className={`text-xs font-medium ${automation.enabled ? "text-done" : "text-dim"}`}>{automation.enabled ? "on" : "off"}</span></td>
        <td className="px-4 py-3 text-xs text-dim">{ago(automation.lastFiredAt)}</td>
        <td className="px-4 py-3">
          <div className="flex gap-2 text-xs">
            <button className="text-accent hover:underline disabled:opacity-50" onClick={runNow} disabled={running}>{running ? "running…" : "run now"}</button>
            <button className="text-accent hover:underline" onClick={toggleEnabled}>{automation.enabled ? "disable" : "enable"}</button>
            <button className="text-accent hover:underline" onClick={onEdit}>edit</button>
            <button className="text-dim hover:underline" onClick={onToggleLog}>log</button>
            <button className="text-canceled hover:underline" onClick={remove}>删除</button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-line bg-bg last:border-0">
          <td colSpan={7} className="px-3 py-2">
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

function AutomationEditor({
  automation,
  agents,
  repositories,
  onClose,
  onChanged,
}: {
  automation?: AutomationWithAgent;
  agents: HarborAgent[];
  repositories: RepositoryWithMounts[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(automation?.name ?? "");
  const [agentId, setAgentId] = useState(automation?.agentId ?? agents[0]?.id ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [output, setOutput] = useState<Output>(automation?.output ?? "run");
  const [triggerType, setTriggerType] = useState<TriggerType>(automation?.trigger.type ?? "schedule");
  const [cron, setCron] = useState(automation?.trigger.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(automation?.trigger.timezone ?? "Asia/Shanghai");
  const [repositoryId, setRepositoryId] = useState(automation?.trigger.repositoryId ?? "");
  const [codebaseEvent, setCodebaseEvent] = useState<CodebaseEvent>(automation?.trigger.codebaseEvent ?? "merge_request_opened");
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const schedulePreset = SCHEDULE_PRESETS.some((preset) => preset.cron === cron) ? cron : "custom";
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const codebaseRepositories = useMemo(
    () => repositories.filter((repository) =>
      !repository.archivedAt &&
      !!selectedAgent?.repositoryIds.includes(repository.id)),
    [repositories, selectedAgent],
  );

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);

  useEffect(() => {
    if (triggerType !== "codebase") return;
    if (!codebaseRepositories.some((repository) => repository.id === repositoryId)) {
      setRepositoryId(codebaseRepositories[0]?.id ?? "");
    }
  }, [triggerType, repositoryId, codebaseRepositories]);

  const submit = async () => {
    if (!name.trim() || !agentId || !prompt.trim()) {
      toast("Name、Agent、Prompt 不能为空", "error");
      return;
    }
    if (triggerType === "codebase" && !repositoryId) {
      toast("当前 Agent 没有可用的 Repository", "error");
      return;
    }
    if (triggerType === "schedule" && !cron.trim()) {
      toast("Schedule 不能为空", "error");
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        agent: agentId,
        prompt: prompt.trim(),
        output,
        enabled,
        trigger: triggerType === "schedule"
          ? { type: "schedule", cron: cron.trim(), timezone }
          : { type: "codebase", repository: repositoryId, event: codebaseEvent },
      };
      if (automation) await updateAutomation(automation.id, body);
      else await createAutomation(body);
      toast(automation ? `已更新 ${name}` : `已创建 ${name}`, "success");
      onChanged();
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={automation ? `Edit Automation · ${automation.name}` : "New Automation"} onClose={onClose} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily repository report" /></Field>
        <Field label="Agent">
          <select className={inputCls} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Prompt"><textarea className={`${inputCls} min-h-32 resize-y`} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe what the Agent should do when triggered…" /></Field>

      <Field label="Output">
        <div className="grid gap-2 sm:grid-cols-3">
          {OUTPUTS.map((candidate) => (
            <button
              key={candidate.value}
              type="button"
              className={`rounded-xl border px-4 py-3 text-left transition ${output === candidate.value ? "border-accent bg-accent/5 ring-2 ring-accent/15" : "border-line bg-white hover:border-zinc-300"}`}
              onClick={() => setOutput(candidate.value)}
            >
              <div className="text-sm font-semibold">{candidate.label}</div>
              <div className="mt-1 text-xs text-dim">{candidate.description}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Trigger">
        <div className="grid rounded-2xl border border-line bg-bg p-1 sm:grid-cols-2">
          <TriggerChoice active={triggerType === "schedule"} title="Schedule" description="Time based" onClick={() => setTriggerType("schedule")} />
          <TriggerChoice active={triggerType === "codebase"} title="Codebase" description="Repository event" onClick={() => setTriggerType("codebase")} />
        </div>
      </Field>

      {triggerType === "schedule" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Schedule">
            <select
              className={inputCls}
              value={schedulePreset}
              onChange={(event) => {
                if (event.target.value !== "custom") setCron(event.target.value);
                else if (schedulePreset !== "custom") setCron("");
              }}
            >
              {SCHEDULE_PRESETS.map((preset) => <option key={preset.cron} value={preset.cron}>{preset.label}</option>)}
              <option value="custom">Custom cron…</option>
            </select>
            {schedulePreset === "custom" && (
              <input className={`${inputCls} mt-2 font-mono`} value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * *" />
            )}
          </Field>
          <Field label="Timezone">
            <select className={inputCls} value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              {!TIMEZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {TIMEZONES.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Repository">
            <select className={inputCls} value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
              <option value="">Select a repository</option>
              {codebaseRepositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
            </select>
          </Field>
          <Field label="Events">
            <select className={inputCls} value={codebaseEvent} onChange={(event) => setCodebaseEvent(event.target.value as CodebaseEvent)}>
              {CODEBASE_EVENTS.map((event) => <option key={event.value} value={event.value}>{event.label}</option>)}
            </select>
          </Field>
        </div>
      )}

      <label className="mt-5 flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> enabled</label>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>取消</button>
        <button className={btnPrimary} onClick={submit} disabled={busy}>{busy ? "保存中…" : automation ? "Save changes" : "Create Automation"}</button>
      </ModalFooter>
    </Modal>
  );
}

function TriggerChoice({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-xl px-5 py-3 text-left transition ${active ? "bg-white shadow-sm ring-1 ring-line" : "text-dim hover:text-ink"}`}
      onClick={onClick}
    >
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-0.5 text-xs text-dim">{description}</div>
    </button>
  );
}
