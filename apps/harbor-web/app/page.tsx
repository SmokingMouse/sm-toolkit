"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  approveIssue,
  BOARD_STATUSES,
  cancelIssue,
  cancelRun,
  createConversation,
  createDelivery,
  createIssueDraft,
  createConversationMessage,
  dispatchIssue,
  finishDeliveryDeployment,
  getConversation,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  listAgents,
  listConversations,
  listDevices,
  listLabels,
  listMembers,
  publishIssueDraft,
  requestIssueChanges,
  reviewIssue,
  mergeDelivery,
  syncDelivery,
  refreshDelivery,
  startDeliveryDeployment,
  updateConversation,
  updateDelivery,
  type ConversationStatus,
  type ConversationWithAgent,
  type Delivery,
  type DeliveryCheckStatus,
  type DeliveryEvent,
  type DeliveryProviderKind,
  type HarborAgent,
  type IssuePriority,
  type IssueLabel,
  type ConversationMessage,
  type WorkspaceMember,
  type Run,
  type RunWithResult,
} from "../lib/api";
import { ago, fmtUsd, usePoll } from "../lib/hooks";
import { useToast } from "../components/toast";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  Empty,
  Field,
  inputCls,
  Modal,
  ModalFooter,
  PageHeader,
  StatusBadge,
} from "../components/ui";
import { RunTrace } from "../components/run-stream";
import { Markdown } from "../components/markdown";

type BoardStatus = (typeof BOARD_STATUSES)[number];
type IssueAction = "dispatch" | "changes" | "review";

const STAGE: Record<
  BoardStatus,
  { label: string; note: string; color: string }
> = {
  backlog: { label: "Inbox", note: "待确认", color: "bg-backlog" },
  todo: { label: "Ready", note: "可派发", color: "bg-zinc-500" },
  doing: { label: "Running", note: "执行中", color: "bg-doing" },
  review: { label: "Review", note: "待验收", color: "bg-review" },
  done: { label: "Done", note: "已交付", color: "bg-done" },
};

const PRIORITY: Record<IssuePriority, { label: string; color: string }> = {
  none: { label: "No priority", color: "bg-zinc-300" },
  low: { label: "Low", color: "bg-sky-400" },
  medium: { label: "Medium", color: "bg-amber-400" },
  high: { label: "High", color: "bg-orange-500" },
  urgent: { label: "Urgent", color: "bg-red-500" },
};

const DELIVERY_STATUS: Record<
  Delivery["status"],
  { label: string; note: string; tone: string }
> = {
  awaiting_change: {
    label: "Awaiting change",
    note: "等待关联 MR / PR",
    tone: "bg-zinc-100 text-zinc-600",
  },
  review_pending: {
    label: "Review pending",
    note: "等待人工验收",
    tone: "bg-amber-50 text-amber-700",
  },
  checks_pending: {
    label: "Checks pending",
    note: "等待 CI 结果",
    tone: "bg-sky-50 text-sky-700",
  },
  blocked: {
    label: "Blocked",
    note: "CI 未通过",
    tone: "bg-red-50 text-red-700",
  },
  merge_ready: {
    label: "Merge ready",
    note: "门槛全部通过",
    tone: "bg-emerald-50 text-emerald-700",
  },
  merged: {
    label: "Merged",
    note: "等待部署",
    tone: "bg-teal-50 text-teal-700",
  },
  deploying: {
    label: "Deploying",
    note: "外部部署进行中",
    tone: "bg-blue-50 text-blue-700",
  },
  succeeded: {
    label: "Delivered",
    note: "交付链路完成",
    tone: "bg-emerald-50 text-emerald-700",
  },
  failed: {
    label: "Deploy failed",
    note: "可重新发起部署",
    tone: "bg-red-50 text-red-700",
  },
};

export default function IssuesPage() {
  const toast = useToast();
  const convs = usePoll(() => listConversations({ kind: "issue" }), 8_000);
  const agents = usePoll(listAgents, 30_000);
  const devices = usePoll(listDevices, 10_000);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [initialAction, setInitialAction] = useState<IssueAction | null>(null);
  const [view, setView] = useState<"board" | "list">("board");
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState<"updated" | "oldest" | "title">("updated");
  const [dragOver, setDragOver] = useState<BoardStatus | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("harbor_issues_view");
    if (saved === "board" || saved === "list") setView(saved);
  }, []);

  const setIssueView = (next: "board" | "list") => {
    setView(next);
    localStorage.setItem("harbor_issues_view", next);
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...(convs.data ?? [])]
      .filter((c) => statusFilter === "all" || c.status === statusFilter)
      .filter(
        (c) =>
          agentFilter === "all" ||
          (agentFilter === "unassigned"
            ? !c.agentId
            : c.agentId === agentFilter),
      )
      .filter(
        (c) =>
          !needle ||
          `${c.title ?? ""} ${c.description ?? ""} ${c.agentName ?? ""} ${c.id}`
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => {
        if (sort === "oldest") return a.updatedAt - b.updatedAt;
        if (sort === "title")
          return (a.title ?? "").localeCompare(b.title ?? "", "zh-CN");
        return b.updatedAt - a.updatedAt;
      });
  }, [agentFilter, convs.data, query, sort, statusFilter]);

  const byStatus = new Map<BoardStatus, ConversationWithAgent[]>(
    BOARD_STATUSES.map((s) => [s, []]),
  );
  for (const c of visible)
    if (BOARD_STATUSES.includes(c.status as BoardStatus))
      byStatus.get(c.status as BoardStatus)?.push(c);
  const total = (convs.data ?? []).length;
  const archived = (convs.data ?? []).filter(
    (c) => c.status === "canceled",
  ).length;
  const effectiveView = statusFilter === "canceled" ? "list" : view;
  const onlineDeviceIds = useMemo(
    () =>
      new Set(
        (devices.data ?? [])
          .filter((device) => device.online)
          .map((device) => device.id),
      ),
    [devices.data],
  );

  const openAction = (id: string, action: IssueAction) => {
    setOpenId(id);
    setInitialAction(action);
  };

  const handleDrop = async (id: string, target: BoardStatus) => {
    setDragOver(null);
    const issue = (convs.data ?? []).find((c) => c.id === id);
    if (!issue || issue.status === target) return;
    try {
      if (
        (issue.status === "backlog" || issue.status === "todo") &&
        (target === "backlog" || target === "todo")
      ) {
        await updateConversation(id, { status: target });
        convs.reload();
        return;
      }
      if (
        (issue.status === "backlog" || issue.status === "todo") &&
        target === "doing"
      ) {
        openAction(id, "dispatch");
        return;
      }
      if (issue.status === "doing" && target === "todo") {
        if (
          !issue.latestRun ||
          !["queued", "running"].includes(issue.latestRun.status)
        )
          throw new Error("没有可停止的 Run");
        if (
          !confirm(
            "停止当前 Run 并把 Issue 放回 Ready？上下文和 worktree 会保留。",
          )
        )
          return;
        await cancelRun(issue.latestRun.id);
        toast("已请求停止 Run", "success");
        convs.reload();
        return;
      }
      if (issue.status === "review" && target === "todo") {
        openAction(id, "changes");
        return;
      }
      if (issue.status === "review" && target === "done") {
        setOpenId(id);
        toast("请在详情确认 Delivery，或明确选择无代码交付完成", "success");
        return;
      }
      throw new Error("这个阶段不能直接拖拽；请打开 Issue 使用对应动作");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  if (openId) {
    return (
      <IssueDrawer
        id={openId}
        agents={agents.data ?? []}
        onlineDeviceIds={onlineDeviceIds}
        initialAction={initialAction}
        onInitialActionConsumed={() => setInitialAction(null)}
        onChanged={convs.reload}
        onClose={() => {
          setOpenId(null);
          setInitialAction(null);
          convs.reload();
        }}
      />
    );
  }

  return (
    <div className="page-enter flex h-full flex-col p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Ship work, not status"
        title="Issues"
        description={`${visible.length === total ? total : `${visible.length} / ${total}`} 个任务 · 看板表示交付阶段，Run 表示真实执行${archived ? ` · ${archived} 个已取消归档` : ""}`}
        actions={
          <button className={btnPrimary} onClick={() => setCreating(true)}>
            <span className="mr-1.5 text-base leading-none">＋</span> New Issue
          </button>
        }
      />

      {convs.error && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-canceled">
          {convs.error}
        </div>
      )}
      <div className="surface-shadow mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel/85 p-2">
        <label className="relative min-w-[220px] flex-1 lg:max-w-sm">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-dim">
            ⌕
          </span>
          <input
            className="h-9 w-full rounded-lg border border-transparent bg-bg/85 pl-8 pr-3 text-sm outline-none placeholder:text-dim/70 hover:border-line focus:border-accent focus:bg-white focus:ring-3 focus:ring-accent/10"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、描述、Agent 或 ID"
            aria-label="搜索 Issues"
          />
        </label>
        <select
          className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-medium text-ink"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="筛选状态"
        >
          <option value="all">全部阶段</option>
          {ISSUE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "canceled"
                ? "Canceled archive"
                : (STAGE[s as BoardStatus]?.label ?? s)}
            </option>
          ))}
        </select>
        <select
          className="h-9 max-w-[180px] rounded-lg border border-line bg-white px-2.5 text-xs font-medium text-ink"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          aria-label="筛选 Agent"
        >
          <option value="all">全部 Assignees</option>
          <option value="unassigned">Unassigned</option>
          {(agents.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-lg border border-line bg-white px-2.5 text-xs font-medium text-ink"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          aria-label="排序"
        >
          <option value="updated">最近更新</option>
          <option value="oldest">最早更新</option>
          <option value="title">标题排序</option>
        </select>
        <div
          className="ml-auto flex rounded-lg border border-line bg-bg p-0.5"
          aria-label="Issues 视图"
        >
          <button
            className={`h-8 rounded-md px-3 text-xs font-semibold ${effectiveView === "board" ? "bg-panel text-ink shadow-sm" : "text-dim hover:text-ink"}`}
            aria-pressed={effectiveView === "board"}
            onClick={() => {
              setStatusFilter(
                statusFilter === "canceled" ? "all" : statusFilter,
              );
              setIssueView("board");
            }}
          >
            ▦ <span className="max-sm:hidden">Board</span>
          </button>
          <button
            className={`h-8 rounded-md px-3 text-xs font-semibold ${effectiveView === "list" ? "bg-panel text-ink shadow-sm" : "text-dim hover:text-ink"}`}
            aria-pressed={effectiveView === "list"}
            onClick={() => setIssueView("list")}
          >
            ☷ <span className="max-sm:hidden">List</span>
          </button>
        </div>
      </div>

      {effectiveView === "board" ? (
        <div className="grid min-h-0 flex-1 auto-cols-[minmax(185px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1">
          {BOARD_STATUSES.map((status) => {
            const cards = byStatus.get(status) ?? [];
            const meta = STAGE[status];
            return (
              <section
                key={status}
                className={`surface-shadow flex min-h-[150px] flex-col overflow-hidden rounded-2xl border bg-panel/78 transition ${dragOver === status ? "border-accent ring-4 ring-accent/10" : "border-line"}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(status);
                }}
                onDragLeave={() =>
                  setDragOver((s) => (s === status ? null : s))
                }
                onDrop={(e) => {
                  e.preventDefault();
                  void handleDrop(
                    e.dataTransfer.getData("text/issue-id"),
                    status,
                  );
                }}
              >
                <header className="flex items-center justify-between border-b border-line bg-white/60 px-3.5 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`h-2 w-2 rounded-full ${meta.color}`} />
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.12em]">
                        {meta.label}
                      </div>
                      <div className="mt-0.5 text-[9px] text-dim">
                        {meta.note}
                      </div>
                    </div>
                  </div>
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-bg px-1.5 font-mono text-[10px] text-dim">
                    {cards.length}
                  </span>
                </header>
                <div className="flex flex-col gap-2.5 overflow-y-auto p-2.5">
                  {cards.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      onOpen={() => setOpenId(issue.id)}
                    />
                  ))}
                  {cards.length === 0 && (
                    <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-line/80 text-[10px] uppercase tracking-[0.12em] text-dim/55">
                      Drop here
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <IssueList issues={visible} onOpen={setOpenId} />
      )}

      {creating && (
        <NewIssueModal
          agents={agents.data ?? []}
          onlineDeviceIds={onlineDeviceIds}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            convs.reload();
            setOpenId(id);
          }}
        />
      )}
    </div>
  );
}

function IssueCard({
  issue,
  onOpen,
}: {
  issue: ConversationWithAgent;
  onOpen: () => void;
}) {
  const run = issue.latestRun;
  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/issue-id", issue.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="group cursor-grab rounded-xl border border-line bg-panel p-3 text-left shadow-[0_1px_1px_rgba(20,35,30,.03)] transition hover:-translate-y-0.5 hover:border-accent/45 hover:shadow-[0_7px_18px_rgba(20,35,30,.07)] active:cursor-grabbing"
      onClick={onOpen}
    >
      <div className="mb-2.5 flex items-start gap-2">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY[issue.priority].color}`}
          title={PRIORITY[issue.priority].label}
        />
        <h3 className="min-w-0 flex-1 break-words text-[13px] font-medium leading-5 text-ink">
          {issue.title || "Untitled issue"}
        </h3>
      </div>
      {issue.description && (
        <p className="mb-3 line-clamp-2 text-[11px] leading-4 text-dim">
          {issue.description}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-dim">
        <span
          className={`rounded-md px-1.5 py-1 font-medium ${issue.agentName ? "bg-bg text-ink/75" : "border border-dashed border-line text-dim"}`}
        >
          {issue.agentName ?? "Unassigned"}
        </span>
        {run && (
          <span className="inline-flex items-center gap-1 rounded-md bg-bg px-1.5 py-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${run.status === "running" ? "animate-pulse bg-doing" : run.status === "failed" ? "bg-canceled" : run.status === "succeeded" ? "bg-done" : "bg-backlog"}`}
            />
            {run.purpose === "review" ? "review · " : ""}
            {run.status}
          </span>
        )}
        <span className="ml-auto">{ago(issue.updatedAt)}</span>
      </div>
    </article>
  );
}

function IssueList({
  issues,
  onOpen,
}: {
  issues: ConversationWithAgent[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="surface-shadow min-h-0 flex-1 overflow-auto rounded-2xl border border-line bg-panel/88">
      <table className="w-full min-w-[820px] border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-panel/95 text-[10px] font-bold uppercase tracking-[0.12em] text-dim backdrop-blur">
          <tr>
            <th className="border-b border-line px-4 py-3">Issue</th>
            <th className="border-b border-line px-3 py-3">Stage</th>
            <th className="border-b border-line px-3 py-3">Priority</th>
            <th className="border-b border-line px-3 py-3">Assignee</th>
            <th className="border-b border-line px-3 py-3">Latest run</th>
            <th className="border-b border-line px-4 py-3 text-right">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr
              key={issue.id}
              className="group cursor-pointer border-b border-line/70 last:border-0 hover:bg-accent-soft/30"
              onClick={() => onOpen(issue.id)}
            >
              <td className="px-4 py-3.5">
                <div className="text-[13px] font-medium group-hover:text-accent-strong">
                  {issue.title || "Untitled issue"}
                </div>
                <div className="mt-1 line-clamp-1 max-w-md text-[10px] text-dim">
                  {issue.description || issue.id}
                </div>
              </td>
              <td className="px-3 py-3.5">
                <StatusBadge status={issue.status} />
              </td>
              <td className="px-3 py-3.5 text-xs">
                <span
                  className={`mr-2 inline-block h-2 w-2 rounded-full ${PRIORITY[issue.priority].color}`}
                />
                {PRIORITY[issue.priority].label}
              </td>
              <td className="px-3 py-3.5 text-xs text-ink/75">
                {issue.agentName ?? "Unassigned"}
              </td>
              <td className="px-3 py-3.5 text-xs text-dim">
                {issue.latestRun
                  ? `${issue.latestRun.purpose} · ${issue.latestRun.status}`
                  : "—"}
              </td>
              <td className="px-4 py-3.5 text-right text-xs text-dim">
                {ago(issue.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {issues.length === 0 && (
        <div className="p-5">
          <Empty text="没有符合当前筛选条件的 Issue" />
        </div>
      )}
    </div>
  );
}

function NewIssueModal({
  agents,
  onlineDeviceIds,
  onClose,
  onCreated,
}: {
  agents: HarborAgent[];
  onlineDeviceIds: Set<string>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const sortedAgents = useMemo(
    () => sortAgentsByAvailability(agents, onlineDeviceIds),
    [agents, onlineDeviceIds],
  );
  const [agent, setAgent] = useState(() => sortedAgents[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [stage, setStage] = useState<"backlog" | "todo">("todo");
  const [ownerMemberId, setOwnerMemberId] = useState("");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [aiDraft, setAiDraft] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftRunId, setDraftRunId] = useState<string | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const draftDetail = usePoll(
    () => (draftId ? getConversation(draftId) : Promise.resolve(null)),
    draftId ? 1_500 : 60_000,
  );
  const draftRun = draftDetail.data?.runs.at(-1);
  const members = usePoll(listMembers, 15_000);
  const labels = usePoll(listLabels, 15_000);

  useEffect(() => {
    if (
      draftHydrated ||
      !draftRun?.resultText ||
      draftRun.status !== "succeeded"
    )
      return;
    const parsed = parseIssueDraft(draftRun.resultText, description);
    setTitle(parsed.title);
    setDescription(parsed.description);
    setDraftHydrated(true);
  }, [description, draftHydrated, draftRun?.resultText, draftRun?.status]);

  const submitRegular = async () => {
    setBusy(true);
    try {
      const conv = await createConversation({
        kind: "issue",
        ...(agent ? { agent } : {}),
        title: title.trim() || description.trim().slice(0, 60),
        description: description.trim(),
        priority,
        origin: "web",
        ...(ownerMemberId ? { ownerMemberId } : {}),
        labelIds,
      });
      if (agent) {
        try {
          await dispatchIssue(conv.id, { agent, prompt: description.trim() });
          toast("Issue 已创建并派发", "success");
        } catch (error) {
          // 创建和派发是两个请求。派发失败时保留已创建的 Issue 并直接打开，避免用户重试后产生重复项。
          toast(
            `Issue 已保存，但派发失败：${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          onCreated(conv.id);
          return;
        }
      } else {
        if (stage === "todo")
          await updateConversation(conv.id, { status: "todo" });
        toast(
          stage === "todo" ? "Issue 已创建到 Ready" : "Issue 已保存到 Inbox",
          "success",
        );
      }
      onCreated(conv.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setBusy(false);
    }
  };

  const askAgent = async () => {
    if (!agent || !description.trim()) return;
    setBusy(true);
    try {
      const created = await createIssueDraft({
        request: description.trim(),
        agent,
        priority,
      });
      setDraftId(created.conversation.id);
      setDraftRunId(created.run.id);
      toast("Agent 已开始只读分诊", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const publishDraft = async () => {
    if (!draftId) return;
    setBusy(true);
    try {
      const conv = await publishIssueDraft(draftId, {
        title: title.trim(),
        description: description.trim(),
        priority,
        status: stage,
      });
      await updateConversation(conv.id, {
        ...(ownerMemberId ? { ownerMemberId } : {}),
        labelIds,
      });
      toast("AI draft 已确认并创建 Issue", "success");
      onCreated(conv.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const drafting =
    draftRun?.status === "queued" || draftRun?.status === "running";
  const draftFailed =
    draftRun?.status === "failed" || draftRun?.status === "canceled";

  return (
    <Modal title="New Issue" onClose={onClose} wide>
      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        {!aiDraft && (
          <div className="px-5 pt-5">
            <input
              autoFocus
              className="w-full border-0 bg-transparent px-0 py-1 text-xl font-semibold tracking-tight outline-none placeholder:text-dim/45"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Issue title"
            />
            <textarea
              className="mt-3 min-h-48 w-full resize-y border-0 bg-transparent px-0 py-1 text-sm leading-6 outline-none placeholder:text-dim/55"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe what the assigned Agent should handle."
            />
          </div>
        )}

        {aiDraft && !draftId && (
          <div className="px-5 pt-5">
            <textarea
              autoFocus
              className="min-h-56 w-full resize-y border-0 bg-transparent px-0 py-1 text-sm leading-6 outline-none placeholder:text-dim/55"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe the request; the Agent will triage it before creating an Issue."
            />
          </div>
        )}

        {aiDraft && draftId && (
          <div className="max-h-[52vh] overflow-y-auto px-5 pt-5">
            <div className="mb-5 ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-bg px-4 py-3 text-sm leading-6 text-ink/80">
              {draftDetail.data?.conversation.description}
            </div>
            <div className="mb-5 flex gap-3">
              <AgentAvatar
                name={
                  sortedAgents.find((candidate) => candidate.id === agent)
                    ?.name ?? "AI"
                }
              />
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <span className="font-semibold">
                    {sortedAgents.find((candidate) => candidate.id === agent)
                      ?.name ?? "Agent"}
                  </span>
                  <span className="text-dim">
                    {drafting
                      ? "Triaging…"
                      : draftRun?.status === "succeeded"
                        ? "Draft ready"
                        : (draftRun?.status ?? "Queued")}
                  </span>
                </div>
                {drafting && <RunTrace runId={draftRunId} />}
                {draftFailed && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    分诊未完成：{draftRun?.error ?? "Run 已停止"}
                    。你仍可切回普通模式手工创建。
                  </div>
                )}
              </div>
            </div>
            {draftHydrated && (
              <div className="mb-5 rounded-2xl border border-line bg-bg/40 p-4">
                <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.14em] text-accent">
                  Proposed issue · 可编辑
                </div>
                <input
                  className="w-full border-0 border-b border-line bg-transparent px-0 pb-3 text-lg font-semibold outline-none focus:border-accent"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <textarea
                  className="mt-3 min-h-52 w-full resize-y border-0 bg-transparent px-0 text-sm leading-6 outline-none"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-bg/35 px-4 py-3">
          <select
            className="h-9 rounded-lg border border-line bg-white pl-3 text-xs font-medium"
            value={stage}
            onChange={(event) =>
              setStage(event.target.value as "backlog" | "todo")
            }
            aria-label="Initial stage"
          >
            <option value="todo">Ready</option>
            <option value="backlog">Inbox</option>
          </select>
          <select
            className="h-9 max-w-[190px] rounded-lg border border-line bg-white pl-3 text-xs font-medium"
            value={ownerMemberId}
            onChange={(event) => setOwnerMemberId(event.target.value)}
            aria-label="Owner"
          >
            <option value="">Owner: creator</option>
            {(members.data ?? [])
              .filter((member) => member.status === "active")
              .map((member) => (
                <option key={member.id} value={member.id}>
                  Owner: {member.name}
                </option>
              ))}
          </select>
          <select
            className="h-9 rounded-lg border border-line bg-white pl-3 text-xs font-medium"
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as IssuePriority)
            }
            aria-label="Priority"
          >
            {ISSUE_PRIORITIES.map((item) => (
              <option key={item} value={item}>
                {PRIORITY[item].label}
              </option>
            ))}
          </select>
          <select
            className="h-9 max-w-[250px] rounded-lg border border-line bg-white pl-3 text-xs font-medium"
            value={agent}
            onChange={(event) => setAgent(event.target.value)}
            aria-label="Agent"
            disabled={!!draftId}
          >
            <option value="">Unassigned</option>
            {sortedAgents.map((item) => (
              <option key={item.id} value={item.id}>
                {agentOptionLabel(item, onlineDeviceIds)}
              </option>
            ))}
          </select>
          <label className="ml-auto inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs font-medium text-dim hover:bg-white hover:text-ink">
            <span
              className={`relative h-5 w-9 rounded-full transition ${aiDraft ? "bg-accent" : "bg-zinc-300"}`}
            >
              <input
                className="sr-only"
                type="checkbox"
                checked={aiDraft}
                disabled={!!draftId}
                onChange={(event) => setAiDraft(event.target.checked)}
              />
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${aiDraft ? "left-[18px]" : "left-0.5"}`}
              />
            </span>
            AI draft
          </label>
        </div>
        {!!labels.data?.length && (
          <div className="flex flex-wrap gap-2 border-t border-line bg-white px-4 py-3">
            <span className="mr-1 self-center text-[10px] font-bold uppercase tracking-[0.12em] text-dim">
              Labels
            </span>
            {labels.data.map((label) => {
              const selected = labelIds.includes(label.id);
              return (
                <button
                  key={label.id}
                  type="button"
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${selected ? "border-transparent text-white" : "border-line bg-white text-dim hover:text-ink"}`}
                  style={
                    selected ? { backgroundColor: label.color } : undefined
                  }
                  onClick={() =>
                    setLabelIds((current) =>
                      selected
                        ? current.filter((id) => id !== label.id)
                        : [...current, label.id],
                    )
                  }
                >
                  {label.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        {!aiDraft && (
          <button
            className={btnPrimary}
            disabled={busy || !description.trim()}
            onClick={submitRegular}
          >
            {busy ? "处理中…" : agent ? "Create & run" : "Create"}
          </button>
        )}
        {aiDraft && !draftId && (
          <button
            className={btnPrimary}
            disabled={busy || !description.trim() || !agent}
            onClick={askAgent}
          >
            {busy ? "Starting…" : "Ask Agent"}
          </button>
        )}
        {aiDraft && draftId && !draftHydrated && draftFailed && (
          <button
            className={btnGhost}
            onClick={() => {
              setDraftId(null);
              setDraftRunId(null);
              setAiDraft(false);
            }}
          >
            普通模式创建
          </button>
        )}
        {aiDraft && draftId && (
          <button
            className={btnPrimary}
            disabled={
              busy || !draftHydrated || !title.trim() || !description.trim()
            }
            onClick={publishDraft}
          >
            {busy ? "Creating…" : drafting ? "Agent triaging…" : "Create Issue"}
          </button>
        )}
      </ModalFooter>
    </Modal>
  );
}

function parseIssueDraft(
  text: string,
  fallback: string,
): { title: string; description: string } {
  const normalized = text.trim();
  const lines = normalized.split("\n");
  const heading = lines.findIndex((line) => /^#\s+/.test(line));
  if (heading < 0)
    return {
      title: fallback.trim().slice(0, 72) || "AI drafted issue",
      description: normalized,
    };
  const title = lines[heading]!.replace(/^#\s+/, "").trim();
  const description = [...lines.slice(0, heading), ...lines.slice(heading + 1)]
    .join("\n")
    .trim();
  return {
    title: title || fallback.trim().slice(0, 72),
    description: description || normalized,
  };
}

function IssueDrawer({
  id,
  agents,
  onlineDeviceIds,
  initialAction,
  onInitialActionConsumed,
  onChanged,
  onClose,
}: {
  id: string;
  agents: HarborAgent[];
  onlineDeviceIds: Set<string>;
  initialAction: IssueAction | null;
  onInitialActionConsumed: () => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const detail = usePoll(() => getConversation(id), 4_000);
  const members = usePoll(listMembers, 30_000);
  const labels = usePoll(listLabels, 30_000);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [action, setAction] = useState<IssueAction | null>(null);
  const [actionAgent, setActionAgent] = useState("");
  const [actionPrompt, setActionPrompt] = useState("");
  const [composerAgent, setComposerAgent] = useState("");
  const [composerText, setComposerText] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [deliverySetup, setDeliverySetup] = useState(false);
  const [busy, setBusy] = useState(false);

  const conv = detail.data?.conversation;
  const runs = detail.data?.runs ?? [];
  const delivery = detail.data?.delivery ?? null;
  const deliveryEvents = detail.data?.deliveryEvents ?? [];
  const discussionMessages = detail.data?.messages ?? [];
  const activeRun = [...runs]
    .reverse()
    .find((r) => r.status === "queued" || r.status === "running");
  const threadRuns = runs.filter((run) => run.purpose !== "triage");
  const repositoryLocked = !!conv?.worktreePath || conv?.status === "review";
  const agentsForConversation =
    repositoryLocked && conv?.repositoryId
      ? agents.filter((agent) => agent.repositoryId === conv.repositoryId)
      : agents;
  const agentScopeKey = agentsForConversation
    .map((agent) => agent.id)
    .join("|");
  const selectedComposerAgent = agentsForConversation.find(
    (agent) => agent.id === composerAgent,
  );
  const dirty =
    !!conv &&
    (title !== (conv.title ?? "") ||
      description !== (conv.description ?? "") ||
      priority !== conv.priority);

  useEffect(() => {
    if (!conv) return;
    setTitle(conv.title ?? "");
    setDescription(conv.description ?? "");
    setPriority(conv.priority);
    setComposerAgent((current) =>
      current && agentsForConversation.some((agent) => agent.id === current)
        ? current
        : conv.agentId || agentsForConversation[0]?.id || "",
    );
  }, [conv?.id, conv?.agentId, conv?.repositoryId, agentScopeKey]);

  useEffect(() => {
    if (!initialAction) return;
    if (initialAction === "review") setAction("review");
    else {
      setComposerText(
        initialAction === "dispatch" ? (conv?.description ?? "") : "",
      );
      setTimeout(() => composerRef.current?.focus(), 0);
    }
    onInitialActionConsumed();
  }, [conv?.description, initialAction, onInitialActionConsumed]);

  useEffect(() => {
    if (!conv || action !== "review") return;
    const firstOnline = agentsForConversation.find((candidate) =>
      onlineDeviceIds.has(candidate.deviceId),
    );
    const reviewer =
      agentsForConversation.find(
        (candidate) =>
          candidate.id !== conv.agentId &&
          onlineDeviceIds.has(candidate.deviceId),
      ) ??
      firstOnline ??
      agentsForConversation[0];
    setActionAgent(reviewer?.id ?? "");
    setActionPrompt("");
  }, [action, conv?.id]);

  const refresh = () => {
    detail.reload();
    onChanged();
  };

  const saveMetadata = async () => {
    setBusy(true);
    try {
      await updateConversation(id, {
        title: title.trim(),
        description: description.trim(),
        priority,
      });
      toast("Issue 已保存", "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async () => {
    if (action !== "review") return;
    setBusy(true);
    try {
      await reviewIssue(id, {
        agent: actionAgent,
        prompt: actionPrompt.trim() || undefined,
      });
      setAction(null);
      setActionPrompt("");
      toast("Reviewer Run 已排队", "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    if (!conv || !composerAgent || activeRun) return;
    const prompt = composerText.trim();
    if (!prompt && conv.status !== "backlog" && conv.status !== "todo") return;
    setBusy(true);
    try {
      if (conv.status === "review") {
        await requestIssueChanges(id, {
          agent: composerAgent,
          feedback: prompt,
        });
        toast("修改意见已发给实现 Agent", "success");
      } else if (conv.status === "backlog" || conv.status === "todo") {
        await dispatchIssue(id, {
          agent: composerAgent,
          prompt: prompt || conv.description || undefined,
        });
        toast("Implementation Run 已排队", "success");
      } else {
        throw new Error("当前阶段不能发送新消息");
      }
      setComposerText("");
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const addNote = async () => {
    const body = composerText.trim();
    if (!body) return;
    setBusy(true);
    try {
      await createConversationMessage(id, { body, dispatch: false });
      setComposerText("");
      toast("消息已记录，不触发 Agent", "success");
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    try {
      const approved = await approveIssue(id);
      toast(
        approved.status === "done"
          ? "Issue 交付已完成"
          : delivery
            ? "实现已验收；通过 CI 后即可合并"
            : "非代码 Issue 已完成",
        "success",
      );
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const setupDelivery = async (input: {
    provider: DeliveryProviderKind;
    changeUrl?: string;
    externalId?: string;
    deploymentRequired: boolean;
  }) => {
    setBusy(true);
    try {
      const created = await createDelivery(id, input);
      if (created.provider === "codebase") await refreshDelivery(created.id);
      setDeliverySetup(false);
      toast(input.provider === "github" ? "GitHub Delivery 已建立；请同步 PR / CI" : "Delivery 已建立；请同步 CI 结果并完成验收", "success");
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const syncFromGitHub = async () => {
    if (!delivery) return;
    setBusy(true);
    try {
      const synced = await syncDelivery(delivery.id);
      toast(`GitHub 已同步：checks ${synced.checkStatus} · PR ${synced.mergeStatus}`, synced.checkStatus === "failed" || synced.mergeStatus === "closed" ? "error" : "success");
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const refreshProviderDelivery = async () => {
    if (!delivery) return;
    setBusy(true);
    try {
      await refreshDelivery(delivery.id);
      toast("已从 Codebase 刷新 Review / CI / Merge", "success");
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const updateOwner = async (ownerMemberId: string) => {
    try {
      await updateConversation(id, { ownerMemberId: ownerMemberId || null });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const toggleLabel = async (labelId: string) => {
    const ids = conv?.labelIds.includes(labelId)
      ? conv.labelIds.filter((id) => id !== labelId)
      : [...(conv?.labelIds ?? []), labelId];
    try {
      await updateConversation(id, { labelIds: ids });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const setDeliveryChecks = async (status: DeliveryCheckStatus) => {
    if (!delivery) return;
    setBusy(true);
    try {
      await updateDelivery(delivery.id, { checkStatus: status });
      toast(`CI checks → ${status}`, status === "failed" ? "error" : "success");
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const confirmDeliveryMerge = async () => {
    if (!delivery) return;
    const prompt =
      delivery.provider === "github"
        ? "确认由 Harbor 调用 GitHub 合并该 PR？仍会再次校验人工验收与 CI checks。"
        : delivery.provider === "codebase"
          ? "确认由 Harbor 调用 bitscli 合并该 Codebase MR？仍会再次校验 Review 与 CI。"
          : "确认该 MR / PR 已在外部 SCM 合并？Harbor 只记录事实，不会替你调用平台。";
    if (!confirm(prompt)) return;
    setBusy(true);
    try {
      await mergeDelivery(delivery.id);
      toast(
        delivery.provider === "github"
          ? "GitHub PR 已合并"
          : delivery.provider === "codebase"
            ? "Codebase MR 已合并"
            : delivery.deploymentStatus === "not_required"
              ? "已记录合并，Issue 交付完成"
              : "已记录合并，等待部署",
        "success",
      );
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const startDeployment = async () => {
    if (!delivery || !confirm("确认外部部署已经开始？这不会主动触发部署。"))
      return;
    setBusy(true);
    try {
      await startDeliveryDeployment(delivery.id);
      toast("已记录部署开始", "success");
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const finishDeployment = async (status: "succeeded" | "failed") => {
    if (!delivery) return;
    const label = status === "succeeded" ? "成功" : "失败";
    if (!confirm(`确认外部部署结果为${label}？`)) return;
    setBusy(true);
    try {
      await finishDeliveryDeployment(delivery.id, status);
      toast(
        status === "succeeded" ? "部署成功，Issue 已完成" : "已记录部署失败",
        status === "succeeded" ? "success" : "error",
      );
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (
      !activeRun ||
      !confirm("停止当前 Run？Issue 会回到 Ready，执行上下文仍保留。")
    )
      return;
    try {
      await cancelRun(activeRun.id);
      toast("已请求停止 Run", "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const cancel = async () => {
    if (
      !confirm("取消整个 Issue？正在执行的 Run 会停止，并开始收尾 worktree。")
    )
      return;
    try {
      await cancelIssue(id);
      toast("Issue 已取消", "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  if (!conv)
    return (
      <div className="grid h-full place-items-center bg-panel text-sm text-dim">
        {detail.error ?? "加载 Issue…"}
      </div>
    );

  const composerDisabled =
    busy ||
    !!activeRun ||
    conv.status === "doing" ||
    conv.status === "done" ||
    conv.status === "canceled";
  const composerPlaceholder =
    conv.status === "review"
      ? "Write feedback for the implementation Agent…"
      : conv.status === "doing"
        ? "Agent is working…"
        : conv.status === "done"
          ? "This issue is complete"
          : conv.status === "canceled"
            ? "This issue is canceled"
            : "Write a message…";

  return (
    <div className="page-enter flex h-full min-h-0 flex-col bg-panel/95">
      <header className="flex min-h-[64px] shrink-0 items-center gap-3 border-b border-line bg-panel/95 px-5 backdrop-blur max-sm:px-3">
        <button
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-lg text-dim hover:bg-bg hover:text-ink"
          onClick={onClose}
          aria-label="Back to issues"
        >
          ‹
        </button>
        <span className="shrink-0 font-mono text-[11px] text-dim">
          {conv.id}
        </span>
        <input
          className="min-w-0 flex-1 border-0 bg-transparent px-1 text-[14px] font-semibold outline-none placeholder:text-dim"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Untitled issue"
          aria-label="Issue title"
        />
        <StatusBadge status={conv.status} />
        {activeRun && <StatusBadge status={activeRun.status} />}
        {dirty && (
          <button
            className="h-8 rounded-lg bg-accent px-3 text-xs font-semibold text-white hover:bg-accent-strong"
            disabled={busy}
            onClick={saveMetadata}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        )}
        {conv.status === "review" &&
          (!delivery || delivery.reviewStatus !== "approved") && (
            <button
              className="h-8 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink hover:border-zinc-300"
              disabled={busy || !!activeRun}
              onClick={approve}
            >
              {delivery ? "Approve" : "Complete"}
            </button>
          )}
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_268px]">
        <main className="flex min-h-0 min-w-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[760px] px-7 py-8 max-sm:px-4 max-sm:py-5">
              <section className="group border-b border-line/80 pb-8">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-dim">
                    Issue description
                  </span>
                  <button
                    className="text-[10px] font-medium text-dim opacity-0 transition group-hover:opacity-100 hover:text-accent"
                    disabled={!dirty || busy}
                    onClick={saveMetadata}
                  >
                    Save changes
                  </button>
                </div>
                <textarea
                  className="min-h-44 w-full resize-y border-0 bg-transparent p-0 text-[14px] leading-7 text-ink/88 outline-none placeholder:text-dim/55"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Add context, scope and acceptance criteria…"
                  aria-label="Issue description"
                />
              </section>

              <div className="border-b border-line/80 py-6 lg:hidden">
                <DeliveryCard
                  issueStatus={conv.status}
                  delivery={delivery}
                  events={deliveryEvents}
                  disabled={busy || !!activeRun}
                  onSetup={() => setDeliverySetup(true)}
                  onApprove={approve}
                  onChecks={setDeliveryChecks}
                  onSync={syncFromGitHub}
                  onRefresh={refreshProviderDelivery}
                  onMerge={confirmDeliveryMerge}
                  onDeploy={startDeployment}
                  onDeploymentResult={finishDeployment}
                />
              </div>

              <section className="py-8">
                {discussionMessages.length > 0 && (
                  <div className="mb-8 space-y-3 border-b border-line/80 pb-8">
                    <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-dim">
                      Discussion · {discussionMessages.length}
                    </div>
                    {discussionMessages.map((message) => (
                      <ConversationMessageCard
                        key={message.id}
                        message={message}
                      />
                    ))}
                  </div>
                )}
                {threadRuns.length === 0 ? (
                  <div className="py-10 text-center">
                    <div className="text-sm font-medium text-ink/70">
                      No Agent responses yet
                    </div>
                    <div className="mt-1 text-xs text-dim">
                      从底部选择 Agent 并发送，Issue 会自动进入 Running。
                    </div>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {threadRuns.map((run, index) => (
                      <IssueRunComment
                        key={run.id}
                        run={run}
                        index={index}
                        agents={agents}
                      />
                    ))}
                  </div>
                )}
              </section>

              {detail.data && detail.data.statusLog.length > 0 && (
                <details className="border-t border-line/80 py-5 text-xs text-dim">
                  <summary className="cursor-pointer select-none font-medium text-ink/60">
                    Activity · {detail.data.statusLog.length} transitions
                  </summary>
                  <div className="mt-4 space-y-2 border-l border-line pl-4">
                    {detail.data.statusLog
                      .slice()
                      .reverse()
                      .map((entry, index) => (
                        <div key={`${entry.ts}-${index}`}>
                          <span className="font-medium text-ink/75">
                            {entry.fromStatus ?? "created"} → {entry.toStatus}
                          </span>{" "}
                          · {entry.actor} · {ago(entry.ts)}
                        </div>
                      ))}
                  </div>
                </details>
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-line bg-panel/96 px-5 py-4 backdrop-blur max-sm:px-3">
            <div className="mx-auto max-w-[720px] rounded-2xl border border-line bg-white p-3 shadow-[0_8px_28px_rgba(20,35,30,.08)] focus-within:border-zinc-300 focus-within:ring-3 focus-within:ring-accent/8">
              <textarea
                ref={composerRef}
                className="min-h-14 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-dim/55"
                value={composerText}
                disabled={composerDisabled}
                onChange={(event) => setComposerText(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={composerPlaceholder}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  className="h-8 max-w-[250px] rounded-lg border border-transparent bg-bg px-2 text-[11px] font-medium hover:border-line"
                  value={composerAgent}
                  disabled={composerDisabled}
                  onChange={(event) => setComposerAgent(event.target.value)}
                  aria-label="Message Agent"
                >
                  <option value="">Select Agent…</option>
                  {sortAgentsByAvailability(
                    agentsForConversation,
                    onlineDeviceIds,
                  ).map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agentOptionLabel(agent, onlineDeviceIds)}
                    </option>
                  ))}
                </select>
                {selectedComposerAgent && (
                  <span className="text-[10px] text-dim">
                    {selectedComposerAgent.permission} ·{" "}
                    {selectedComposerAgent.model ?? "CLI default"}
                  </span>
                )}
                <span className="ml-auto text-[9px] text-dim/70 max-sm:hidden">
                  ⌘↵ send
                </span>
                <button
                  className="h-8 rounded-lg border border-line bg-bg px-2.5 text-[10px] font-semibold text-dim hover:text-ink"
                  disabled={composerDisabled || !composerText.trim()}
                  onClick={addNote}
                >
                  Note only
                </button>
                <button
                  className="grid h-9 w-9 place-items-center rounded-full bg-ink text-base text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={
                    composerDisabled ||
                    !composerAgent ||
                    (conv.status === "review" && !composerText.trim())
                  }
                  onClick={sendMessage}
                  aria-label={
                    conv.status === "review"
                      ? "Send changes"
                      : "Start implementation"
                  }
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        </main>

        <aside className="min-h-0 overflow-y-auto border-l border-line bg-bg/45 p-5 max-lg:hidden">
          <div className="rounded-2xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(20,35,30,.03)]">
            <PropertyRow label="Status">
              <StatusBadge status={conv.status} />
            </PropertyRow>
            <PropertyRow label="Priority">
              <select
                className="h-8 max-w-[130px] rounded-lg border border-transparent bg-transparent pl-2 text-xs font-medium hover:border-line hover:bg-bg"
                value={priority}
                onChange={async (event) => {
                  const next = event.target.value as IssuePriority;
                  setPriority(next);
                  try {
                    await updateConversation(id, { priority: next });
                    refresh();
                  } catch (error) {
                    toast(
                      error instanceof Error ? error.message : String(error),
                      "error",
                    );
                  }
                }}
              >
                {ISSUE_PRIORITIES.map((item) => (
                  <option key={item} value={item}>
                    {PRIORITY[item].label}
                  </option>
                ))}
              </select>
            </PropertyRow>
            <PropertyRow label="Owner">
              <select
                className="h-8 max-w-[142px] rounded-lg border border-transparent bg-transparent pl-2 text-xs font-medium hover:border-line hover:bg-bg"
                value={conv.ownerMemberId ?? ""}
                onChange={(event) => void updateOwner(event.target.value)}
              >
                <option value="">Unowned</option>
                {(members.data ?? [])
                  .filter((member) => member.status === "active")
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </PropertyRow>
            <PropertyRow label="Assignee">
              <select
                className="h-8 max-w-[142px] rounded-lg border border-transparent bg-transparent pl-2 text-xs font-medium hover:border-line hover:bg-bg"
                value={conv.agentId ?? ""}
                disabled={
                  !!activeRun ||
                  conv.status === "done" ||
                  conv.status === "canceled"
                }
                onChange={async (event) => {
                  try {
                    await updateConversation(id, {
                      agent: event.target.value || null,
                    });
                    setComposerAgent(event.target.value);
                    refresh();
                  } catch (error) {
                    toast(
                      error instanceof Error ? error.message : String(error),
                      "error",
                    );
                  }
                }}
              >
                <option value="">Unassigned</option>
                {sortAgentsByAvailability(
                  agentsForConversation,
                  onlineDeviceIds,
                ).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </PropertyRow>
            <PropertyRow label="Repository">
              <span
                className="max-w-[142px] truncate text-xs font-medium text-ink/75"
                title={detail.data?.repository?.name ?? "Unassigned"}
              >
                {detail.data?.repository?.name ?? "Unassigned"}
              </span>
            </PropertyRow>
            <PropertyRow label="Source">
              <span
                className="max-w-[142px] truncate text-xs font-medium text-ink/75"
                title={conv.originRef ?? conv.origin}
              >
                {conv.origin}
                {conv.originRef ? ` · ${conv.originRef}` : ""}
              </span>
            </PropertyRow>
            <PropertyRow label="Updated">
              <span className="text-xs text-dim">{ago(conv.updatedAt)}</span>
            </PropertyRow>
            <PropertyRow label="Created">
              <span className="text-xs text-dim">{ago(conv.createdAt)}</span>
            </PropertyRow>
          </div>

          <details
            className="mt-4 rounded-xl border border-line bg-white p-3"
            open={conv.labelIds.length > 0}
          >
            <summary className="cursor-pointer text-[9px] font-bold uppercase tracking-[0.14em] text-dim">
              Labels · {conv.labelIds.length}
            </summary>
            <div className="mt-3 flex flex-wrap gap-2">
              {(labels.data ?? []).map((label) => {
                const selected = conv.labelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    onClick={() => void toggleLabel(label.id)}
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-medium ${selected ? "ring-2 ring-offset-1" : "opacity-55"}`}
                    style={{
                      color: label.color,
                      borderColor: `${label.color}77`,
                      backgroundColor: `${label.color}12`,
                    }}
                  >
                    {selected ? "✓ " : ""}
                    {label.name}
                  </button>
                );
              })}
              {!(labels.data ?? []).length && (
                <span className="text-[10px] text-dim">
                  No labels configured
                </span>
              )}
            </div>
          </details>

          {conv.worktreePath && (
            <div className="mt-4 rounded-xl border border-line bg-white p-3">
              <div className="mb-2 text-[9px] font-bold uppercase tracking-[0.14em] text-dim">
                Worktree
              </div>
              <div className="break-all font-mono text-[9px] leading-4 text-dim">
                {conv.worktreePath}
              </div>
            </div>
          )}

          <div className="mt-4">
            <DeliveryCard
              issueStatus={conv.status}
              delivery={delivery}
              events={deliveryEvents}
              disabled={busy || !!activeRun}
              onSetup={() => setDeliverySetup(true)}
              onApprove={approve}
              onChecks={setDeliveryChecks}
              onSync={syncFromGitHub}
              onRefresh={refreshProviderDelivery}
              onMerge={confirmDeliveryMerge}
              onDeploy={startDeployment}
              onDeploymentResult={finishDeployment}
            />
          </div>

          <div className="mt-5 grid gap-2">
            {conv.status === "backlog" && (
              <button
                className={btnGhost}
                onClick={async () => {
                  await updateConversation(id, { status: "todo" });
                  refresh();
                }}
              >
                Move to Ready
              </button>
            )}
            {conv.status === "doing" && (
              <button className={btnDanger} onClick={stop}>
                Stop Run
              </button>
            )}
            {conv.status === "review" && !delivery && (
              <button
                className={btnGhost}
                disabled={busy || !!activeRun}
                onClick={approve}
              >
                Complete without delivery
              </button>
            )}
            {conv.status === "review" && (
              <button
                className={btnGhost}
                disabled={!!activeRun}
                onClick={() => setAction("review")}
              >
                AI Review
              </button>
            )}
            {conv.status === "done" && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-done">
                {delivery
                  ? "合并与部署策略已经满足，执行记录和交付证据已保留。"
                  : "非代码交付已验收，执行记录保留在正文。"}
              </div>
            )}
            {conv.status === "canceled" && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-canceled">
                Issue 已取消并归档。
              </div>
            )}
            {conv.status !== "done" && conv.status !== "canceled" && (
              <button
                className="mt-2 text-center text-xs font-medium text-canceled hover:underline"
                onClick={cancel}
              >
                Cancel issue
              </button>
            )}
          </div>
        </aside>
      </div>

      {action === "review" && (
        <ActionModal
          action="review"
          agents={agentsForConversation}
          onlineDeviceIds={onlineDeviceIds}
          agent={actionAgent}
          prompt={actionPrompt}
          busy={busy}
          onAgent={setActionAgent}
          onPrompt={setActionPrompt}
          onClose={() => setAction(null)}
          onSubmit={submitReview}
        />
      )}
      {deliverySetup && (
        <DeliverySetupModal
          busy={busy}
          defaultProvider={
            detail.data?.repository?.scmProvider === "codebase"
              ? "codebase"
              : "manual"
          }
          onClose={() => setDeliverySetup(false)}
          onSubmit={setupDelivery}
        />
      )}
    </div>
  );
}

function AgentAvatar({ name }: { name: string }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-strong">
      {name.trim().slice(0, 1).toUpperCase() || "A"}
    </span>
  );
}

function ConversationMessageCard({
  message,
}: {
  message: ConversationMessage;
}) {
  const external = message.authorType === "external";
  return (
    <article
      className={`rounded-2xl border p-3 ${external ? "border-blue-100 bg-blue-50/45" : "border-accent/15 bg-accent-soft/25"}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink/70">
          {message.authorName ?? message.authorType}
        </span>
        <span className="rounded-full bg-white/70 px-2 py-0.5 text-[8px] uppercase text-dim">
          {message.authorType}
        </span>
        <span className="ml-auto text-[9px] text-dim">
          {ago(message.createdAt)}
        </span>
      </div>
      <Markdown
        text={message.body}
        className="text-[13px] leading-6 text-ink/82"
      />
    </article>
  );
}

function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 border-b border-line/65 py-1 last:border-0">
      <span className="text-[11px] text-dim">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

function DeliveryCard({
  issueStatus,
  delivery,
  events,
  disabled,
  onSetup,
  onApprove,
  onChecks,
  onSync,
  onRefresh,
  onMerge,
  onDeploy,
  onDeploymentResult,
}: {
  issueStatus: ConversationStatus;
  delivery: Delivery | null;
  events: DeliveryEvent[];
  disabled: boolean;
  onSetup: () => void;
  onApprove: () => void;
  onChecks: (status: DeliveryCheckStatus) => void;
  onSync: () => void;
  onRefresh: () => void;
  onMerge: () => void;
  onDeploy: () => void;
  onDeploymentResult: (status: "succeeded" | "failed") => void;
}) {
  if (!delivery) {
    const ready = issueStatus === "review";
    return (
      <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(20,35,30,.03)]">
        <div className="border-b border-line/70 px-4 py-3">
          <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-dim">
            Delivery lane
          </div>
          <div className="mt-1 text-sm font-semibold text-ink">
            {issueStatus === "done" ? "No code delivery" : "Not configured"}
          </div>
        </div>
        <div className="p-4">
          <div
            className="flex items-center gap-1.5"
            aria-label="Delivery stages"
          >
            {["Review", "Checks", "Merge", "Deploy"].map((label, index) => (
              <div key={label} className="min-w-0 flex-1">
                <div
                  className={`h-1 rounded-full ${index === 0 && ready ? "bg-review" : "bg-line"}`}
                />
                <div className="mt-1.5 truncate text-[8px] font-semibold uppercase tracking-[0.08em] text-dim">
                  {label}
                </div>
              </div>
            ))}
          </div>
          {issueStatus === "done" ? (
            <p className="mt-3 text-[11px] leading-5 text-dim">
              该 Issue 通过“无代码交付”路径完成，没有 MR、CI 或部署记录。
            </p>
          ) : (
            <>
              <p className="mt-3 text-[11px] leading-5 text-dim">
                {ready
                  ? "关联主 MR / PR 后，Harbor 才会启用 CI、合并与部署门槛。"
                  : "Implementation 成功进入 Review 后可建立交付记录。"}
              </p>
              {ready && (
                <button
                  className={`${btnPrimary} mt-3 w-full`}
                  disabled={disabled}
                  onClick={onSetup}
                >
                  Set up delivery
                </button>
              )}
            </>
          )}
        </div>
      </section>
    );
  }

  const meta = delivery.mergeStatus === "closed"
    ? { label: "PR closed", note: "PR 已关闭且未合并", tone: "bg-red-50 text-red-700" }
    : DELIVERY_STATUS[delivery.status];
  const reviewDone = delivery.reviewStatus === "approved";
  const checksDone = delivery.checkStatus === "passed";
  const mergeDone = delivery.mergeStatus === "merged";
  const deployDone =
    delivery.deploymentStatus === "not_required" ||
    delivery.deploymentStatus === "succeeded";
  const steps = [
    { label: "Review", done: reviewDone, active: !reviewDone },
    { label: "Checks", done: checksDone, active: reviewDone && !checksDone },
    {
      label: "Merge",
      done: mergeDone,
      active: reviewDone && checksDone && !mergeDone,
    },
    {
      label: "Deploy",
      done: mergeDone && deployDone,
      active: mergeDone && !deployDone,
    },
  ];

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(20,35,30,.03)]">
      <div className="flex items-start justify-between gap-3 border-b border-line/70 px-4 py-3">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-dim">
            Delivery lane
          </div>
          <div className="mt-1 text-sm font-semibold text-ink">
            {delivery.provider === "github"
              ? "GitHub pull request"
              : delivery.provider === "codebase"
                ? "Codebase delivery"
                : "Manual handoff"}
          </div>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[9px] font-bold ${meta.tone}`}
        >
          {meta.label}
        </span>
      </div>

      <div className="p-4">
        <div
          className="flex items-center gap-1.5"
          aria-label="Delivery progress"
        >
          {steps.map((step) => (
            <div key={step.label} className="min-w-0 flex-1">
              <div
                className={`h-1 rounded-full ${step.done ? "bg-done" : step.active ? "bg-review" : "bg-line"}`}
              />
              <div
                className={`mt-1.5 truncate text-[8px] font-semibold uppercase tracking-[0.08em] ${step.done || step.active ? "text-ink/70" : "text-dim"}`}
              >
                {step.label}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-line bg-bg/55 p-3">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-harbor text-[10px] font-bold text-white">
              ↗
            </span>
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-ink">
                {delivery.externalId || deliveryLinkLabel(delivery.changeUrl)}
              </div>
              <div className="mt-0.5 truncate text-[9px] text-dim">
                {delivery.changeUrl}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 divide-y divide-line/65">
          <DeliveryFact
            label="Human review"
            value={reviewDone ? "Approved" : "Pending"}
            ok={reviewDone}
          />
          <div className="flex min-h-10 items-center justify-between gap-3 py-1">
            <span className="text-[10px] text-dim">CI checks</span>
            {delivery.provider === "manual" &&
            delivery.mergeStatus === "open" ? (
              <select
                className="h-8 max-w-[126px] rounded-lg border border-transparent bg-bg pl-2 text-[10px] font-semibold hover:border-line"
                value={delivery.checkStatus}
                disabled={disabled}
                onChange={(event) =>
                  onChecks(event.target.value as DeliveryCheckStatus)
                }
              >
                <option value="unknown">Unknown</option>
                <option value="pending">Pending</option>
                <option value="passed">Passed</option>
                <option value="failed">Failed</option>
              </select>
            ) : (
              <span
                className={`text-[10px] font-semibold ${checksDone ? "text-done" : delivery.checkStatus === "failed" ? "text-canceled" : "text-ink/65"}`}
              >
                {delivery.checkStatus}
              </span>
            )}
          </div>
          <DeliveryFact
            label="Merge"
            value={
              mergeDone
                ? "Merged"
                : delivery.mergeStatus === "closed"
                  ? "Closed"
                  : "Open"
            }
            ok={mergeDone}
          />
          <DeliveryFact
            label="Deploy"
            value={delivery.deploymentStatus.replace("_", " ")}
            ok={deployDone && mergeDone}
          />
        </div>

        <p className="mt-3 rounded-lg bg-bg px-3 py-2 text-[10px] leading-4 text-dim">
          <span className="font-semibold text-ink/70">
            {delivery.provider === "github"
              ? "GitHub provider"
              : delivery.provider === "codebase"
                ? "Codebase provider"
                : "Manual provider"}
          </span>{" "}
          ·{" "}
          {delivery.provider === "github"
            ? "PR / checks 以 GitHub sync 为准；Merge 仍受人工验收与 CI 闸控制。"
            : delivery.provider === "codebase"
              ? `${meta.note}。Review / CI / Merge 从 Codebase 刷新；Merge 会调用 bitscli 并再次确认。`
              : `${meta.note}。按钮只记录外部事实，不会调用 SCM/CD。`}
        </p>

        {issueStatus === "review" && (
          <div className="mt-3 grid gap-2">
            {delivery.provider === "github" && (
              <button
                className={btnGhost}
                disabled={disabled}
                onClick={onSync}
              >
                Sync from GitHub
              </button>
            )}
            {delivery.provider === "codebase" && (
              <button
                className={btnGhost}
                disabled={disabled}
                onClick={onRefresh}
              >
                ↻ Refresh from Codebase
              </button>
            )}
            {!reviewDone && (
              <button
                className={btnPrimary}
                disabled={disabled}
                onClick={onApprove}
              >
                Approve implementation
              </button>
            )}
            {delivery.status === "merge_ready" && (
              <button
                className={btnPrimary}
                disabled={disabled}
                onClick={onMerge}
              >
                {delivery.provider === "github"
                  ? "Merge on GitHub"
                  : delivery.provider === "codebase"
                    ? "Merge in Codebase"
                    : "Confirm externally merged"}
              </button>
            )}
            {(delivery.status === "merged" || delivery.status === "failed") && (
              <button
                className={
                  delivery.status === "failed" ? btnDanger : btnPrimary
                }
                disabled={disabled}
                onClick={onDeploy}
              >
                {delivery.status === "failed"
                  ? "Record deploy retry"
                  : "Record deploy started"}
              </button>
            )}
            {delivery.status === "deploying" && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  className={btnPrimary}
                  disabled={disabled}
                  onClick={() => onDeploymentResult("succeeded")}
                >
                  Succeeded
                </button>
                <button
                  className={btnDanger}
                  disabled={disabled}
                  onClick={() => onDeploymentResult("failed")}
                >
                  Failed
                </button>
              </div>
            )}
          </div>
        )}

        {events.length > 0 && (
          <details className="mt-3 border-t border-line/70 pt-3">
            <summary className="cursor-pointer select-none text-[9px] font-semibold uppercase tracking-[0.1em] text-dim">
              Audit · {events.length}
            </summary>
            <div className="mt-2 space-y-1.5">
              {events
                .slice(-4)
                .reverse()
                .map((event, index) => (
                  <div
                    key={`${event.ts}-${index}`}
                    className="flex items-center justify-between gap-2 text-[9px] text-dim"
                  >
                    <span className="truncate font-medium text-ink/65">
                      {event.kind.replaceAll("_", " ")}
                    </span>
                    <span className="shrink-0">{ago(event.ts)}</span>
                  </div>
                ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function DeliveryFact({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 py-1">
      <span className="text-[10px] text-dim">{label}</span>
      <span
        className={`text-[10px] font-semibold capitalize ${ok ? "text-done" : "text-ink/65"}`}
      >
        {value}
      </span>
    </div>
  );
}

function deliveryLinkLabel(value: string | null): string {
  if (!value) return "MR / PR";
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return value;
  }
}

function DeliverySetupModal({
  busy,
  defaultProvider,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  defaultProvider: "manual" | "codebase";
  onClose: () => void;
  onSubmit: (input: {
    provider: DeliveryProviderKind;
    changeUrl?: string;
    externalId?: string;
    deploymentRequired: boolean;
  }) => void;
}) {
  const [provider, setProvider] =
    useState<DeliveryProviderKind>(defaultProvider);
  const [changeUrl, setChangeUrl] = useState("");
  const [externalId, setExternalId] = useState("");
  const [deploymentRequired, setDeploymentRequired] = useState(true);
  return (
    <Modal title="Set up delivery" onClose={onClose}>
      <div className="mb-5 rounded-xl border border-line bg-bg/65 p-4">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-dim">
          {provider === "github"
            ? "GitHub provider"
            : provider === "codebase"
              ? "Codebase provider"
              : "Manual provider"}
        </div>
        <p className="mt-1.5 text-xs leading-5 text-ink/70">
          {provider === "github"
            ? "同步已有 GitHub PR 与 checks，并在 Harbor policy 通过后受控合并。server 必须配置 GitHub token。"
            : provider === "codebase"
              ? "填写 MR number 后会立即刷新 Review、CI、branch 与 merge 状态；合并动作仍要求显式确认。"
              : "把交付事实纳入 Harbor。不会自动创建或合并 MR，也不会主动触发部署。"}
        </p>
      </div>
      <Field label="Provider">
        <select
          className={inputCls}
          value={provider}
          onChange={(event) => {
            const next = event.target.value as DeliveryProviderKind;
            setProvider(next);
          }}
        >
          <option value="manual">Manual</option>
          <option value="github">GitHub</option>
          <option value="codebase" disabled={defaultProvider !== "codebase"}>
            Codebase
          </option>
        </select>
      </Field>
      {provider === "codebase" && (
        <Field label="Codebase MR number">
          <input
            autoFocus
            className={inputCls}
            value={externalId}
            onChange={(event) => setExternalId(event.target.value)}
            placeholder="12345"
          />
        </Field>
      )}
      <Field
        label={provider === "codebase" ? "MR URL（optional）" : "MR / PR URL"}
      >
        <input
          autoFocus
          className={inputCls}
          value={changeUrl}
          onChange={(event) => setChangeUrl(event.target.value)}
          placeholder="https://github.com/org/repo/pull/123"
        />
      </Field>
      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 hover:bg-bg/60">
        <input
          className="mt-0.5 h-4 w-4 accent-accent"
          type="checkbox"
          checked={deploymentRequired}
          onChange={(event) => setDeploymentRequired(event.target.checked)}
        />
        <span>
          <span className="block text-xs font-semibold text-ink">
            Merge 后需要部署
          </span>
          <span className="mt-1 block text-[11px] leading-5 text-dim">
            开启后，Harbor 会在 merged 领域事件上触发匹配的部署 Automation，部署 Run 成功才推进 Done；关闭则合并即完成。
          </span>
        </span>
      </label>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button
          className={btnPrimary}
          disabled={
            busy ||
            (provider === "codebase"
              ? !/^\d+$/.test(externalId.trim())
              : !changeUrl.trim())
          }
          onClick={() =>
            onSubmit({
              provider,
              ...(changeUrl.trim() ? { changeUrl: changeUrl.trim() } : {}),
              ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
              deploymentRequired,
            })
          }
        >
          {busy ? "Creating…" : "Create delivery"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function IssueRunComment({
  run,
  index,
  agents,
}: {
  run: RunWithResult;
  index: number;
  agents: HarborAgent[];
}) {
  const active = run.status === "queued" || run.status === "running";
  const [expanded, setExpanded] = useState(active);
  const agent = agents.find((candidate) => candidate.id === run.agentId);
  const elapsed = runDuration(run);
  const showPrompt = index > 0 || run.purpose === "review";

  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  return (
    <article>
      {showPrompt && (
        <div className="mb-6 ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-bg px-4 py-3 text-sm leading-6 text-ink/82">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-dim">
            {run.purpose === "review"
              ? "AI review requested"
              : "Changes requested"}
          </div>
          {run.prompt}
        </div>
      )}
      <div className="flex gap-3">
        <AgentAvatar name={agent?.name ?? run.agentId} />
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold">
              {agent?.name ?? run.agentId}
            </span>
            {run.purpose === "review" && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-review">
                Reviewer
              </span>
            )}
            <button
              className="inline-flex items-center gap-1 text-[11px] text-dim hover:text-ink"
              onClick={() => setExpanded((value) => !value)}
            >
              {active ? "Working" : `Worked for ${elapsed}`}{" "}
              <span
                className={`text-[9px] transition ${expanded ? "rotate-90" : ""}`}
              >
                ›
              </span>
            </button>
            <span className="ml-auto text-[10px] text-dim">
              {ago(run.queuedAt)}
            </span>
          </div>
          {expanded ? (
            <RunTrace runId={run.id} />
          ) : run.resultText ? (
            <Markdown
              text={run.resultText}
              className="text-[14px] leading-7 text-ink/88"
            />
          ) : run.error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {run.error}
            </div>
          ) : (
            <div className="text-sm text-dim">
              {active ? "Agent is working…" : "执行正文已过期"}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 text-[9px] text-dim/75">
            <span className="font-mono">{run.id}</span>
            {run.cost?.usd != null && <span>· {fmtUsd(run.cost.usd)}</span>}
            <span>· {run.status}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function runDuration(run: Run): string {
  if (!run.startedAt) return "0s";
  const ms = Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function ActionModal({
  action,
  agents,
  onlineDeviceIds,
  agent,
  prompt,
  busy,
  onAgent,
  onPrompt,
  onClose,
  onSubmit,
}: {
  action: IssueAction;
  agents: HarborAgent[];
  onlineDeviceIds: Set<string>;
  agent: string;
  prompt: string;
  busy: boolean;
  onAgent: (v: string) => void;
  onPrompt: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const meta =
    action === "dispatch"
      ? {
          title: "Assign & Run",
          label: "Execution prompt",
          placeholder: "留空则使用 Issue description",
          button: "Start implementation",
        }
      : action === "changes"
        ? {
            title: "Request changes",
            label: "Required feedback",
            placeholder: "具体说明哪里不符合验收标准、需要怎么修改",
            button: "Send back to Agent",
          }
        : {
            title: "AI Review",
            label: "Review focus",
            placeholder: "留空则执行默认独立代码审查",
            button: "Start reviewer",
          };
  return (
    <Modal title={meta.title} onClose={onClose}>
      <Field
        label={action === "review" ? "Reviewer Agent" : "Implementation Agent"}
      >
        <select
          autoFocus
          className={inputCls}
          value={agent}
          onChange={(e) => onAgent(e.target.value)}
        >
          <option value="">Select an Agent…</option>
          {sortAgentsByAvailability(agents, onlineDeviceIds).map((a) => (
            <option key={a.id} value={a.id}>
              {agentOptionLabel(a, onlineDeviceIds)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={meta.label}>
        <textarea
          className={`${inputCls} min-h-32 resize-y leading-6`}
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          placeholder={meta.placeholder}
        />
      </Field>
      {action === "review" && (
        <p className="mt-3 text-xs leading-5 text-dim">
          Reviewer Run 不覆盖实现 Assignee，Issue 会继续停留在
          Review，最终仍由你验收。
        </p>
      )}
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button
          className={btnPrimary}
          disabled={busy || !agent || (action === "changes" && !prompt.trim())}
          onClick={onSubmit}
        >
          {busy ? "排队中…" : meta.button}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function sortAgentsByAvailability(
  agents: HarborAgent[],
  onlineDeviceIds: Set<string>,
): HarborAgent[] {
  return [...agents].sort(
    (a, b) =>
      Number(onlineDeviceIds.has(b.deviceId)) -
        Number(onlineDeviceIds.has(a.deviceId)) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
}

function agentOptionLabel(
  agent: HarborAgent,
  onlineDeviceIds: Set<string>,
): string {
  return `${agent.name} · ${onlineDeviceIds.has(agent.deviceId) ? "online" : "offline · queues"}`;
}
