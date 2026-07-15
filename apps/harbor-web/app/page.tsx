"use client";

import { useEffect, useState } from "react";
import {
  createConversation,
  createRun,
  getConversation,
  ISSUE_STATUSES,
  listAgents,
  listConversations,
  setConversationStatus,
  type ConversationStatus,
  type ConversationWithAgent,
  type HarborAgent,
} from "../lib/api";
import { ago, fmtUsd, usePoll } from "../lib/hooks";
import { useToast } from "../components/toast";
import { btnDanger, btnGhost, btnPrimary, Empty, Field, inputCls, Modal, ModalFooter, StatusBadge } from "../components/ui";
import { EventLog } from "../components/run-stream";

const COL_BAR: Record<string, string> = {
  backlog: "bg-backlog",
  doing: "bg-doing",
  review: "bg-review",
  done: "bg-done",
  canceled: "bg-canceled",
};

export default function IssuesPage() {
  const convs = usePoll(() => listConversations({ kind: "issue" }), 10_000);
  const agents = usePoll(listAgents, 30_000);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const byStatus = new Map<string, ConversationWithAgent[]>(ISSUE_STATUSES.map((s) => [s, []]));
  for (const c of convs.data ?? []) byStatus.get(c.status)?.push(c);

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Issues</h1>
        <button className={btnPrimary} onClick={() => setCreating(true)}>
          + New
        </button>
      </div>
      {convs.error && <div className="mb-3 text-sm text-canceled">{convs.error}</div>}
      <div className="grid min-h-0 flex-1 auto-cols-[minmax(230px,1fr)] grid-flow-col gap-3 overflow-x-auto">
        {ISSUE_STATUSES.map((s) => {
          const cards = byStatus.get(s) ?? [];
          return (
            <div key={s} className="flex min-h-[120px] flex-col rounded-xl border border-line bg-panel">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
                  <span className={`inline-block h-2 w-2 rounded-full ${COL_BAR[s]}`} />
                  {s}
                </span>
                <span className="text-xs text-dim">{cards.length}</span>
              </div>
              <div className="flex flex-col gap-2 overflow-y-auto p-2">
                {cards.map((c) => (
                  <button
                    key={c.id}
                    className="rounded-lg border border-line bg-bg p-2.5 text-left hover:border-accent"
                    onClick={() => setOpenId(c.id)}
                  >
                    <div className="mb-1 break-all text-[13px]">{c.title || "(无标题)"}</div>
                    <div className="flex flex-wrap gap-x-2 text-[11px] text-dim">
                      <span>{c.agentName}</span>
                      <span>{ago(c.updatedAt)}</span>
                    </div>
                  </button>
                ))}
                {cards.length === 0 && <div className="px-1 py-2 text-xs text-dim">—</div>}
              </div>
            </div>
          );
        })}
      </div>
      {creating && (
        <NewIssueModal
          agents={agents.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            convs.reload();
            setOpenId(id);
          }}
        />
      )}
      {openId && (
        <IssueDrawer
          id={openId}
          onClose={() => {
            setOpenId(null);
            convs.reload();
          }}
        />
      )}
    </div>
  );
}

function NewIssueModal({
  agents,
  onClose,
  onCreated,
}: {
  agents: HarborAgent[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [agent, setAgent] = useState(agents[0]?.name ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const conv = await createConversation({
        kind: "issue",
        agent,
        title: title.trim() || prompt.trim().slice(0, 60),
        origin: "web",
      });
      await createRun(conv.id, prompt.trim());
      toast("issue 已派活", "success");
      onCreated(conv.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setBusy(false);
    }
  };

  return (
    <Modal title="New Issue" onClose={onClose}>
      <Field label="agent">
        <select className={inputCls} value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="title（可空，缺省取 prompt 前 60 字）">
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="prompt">
        <textarea
          className={`${inputCls} h-32 resize-y`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="要做什么"
        />
      </Field>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button className={btnPrimary} disabled={busy || !agent || !prompt.trim()} onClick={submit}>
          {busy ? "派活中…" : "创建并派活"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function IssueDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const detail = usePoll(() => getConversation(id), 5_000);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [continuePrompt, setContinuePrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const conv = detail.data?.conversation;
  const runs = detail.data?.runs ?? [];
  const latestRun = runs[runs.length - 1];

  // 默认跟随最新 run（新一轮 continue 后自动切到直播）；手动点历史 run 则停跟随
  useEffect(() => {
    if (followLatest && latestRun && latestRun.id !== selectedRun) setSelectedRun(latestRun.id);
  }, [followLatest, latestRun, selectedRun]);

  const patchStatus = async (to: ConversationStatus, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await setConversationStatus(id, to);
      detail.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const submitContinue = async () => {
    if (!continuePrompt.trim()) return;
    setBusy(true);
    try {
      await createRun(id, continuePrompt.trim());
      setContinuePrompt("");
      setFollowLatest(true);
      detail.reload();
    } catch (e) {
      // 串行闸 400：server 消息已是人话（「上一轮还在跑」）
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute bottom-0 right-0 top-0 flex w-[720px] max-w-full flex-col overflow-y-auto border-l border-line bg-bg p-5">
        {!conv ? (
          <div className="text-sm text-dim">{detail.error ?? "加载中…"}</div>
        ) : (
          <>
            <div className="mb-1 flex items-start justify-between gap-3">
              <h2 className="break-all text-base font-semibold">{conv.title || "(无标题)"}</h2>
              <button className="text-lg text-dim hover:text-ink" onClick={onClose}>
                ✕
              </button>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
              <span className="font-mono">{conv.id}</span>
              <StatusBadge status={conv.status} />
              <span>agent {detail.data?.agent?.name ?? conv.agentId}</span>
              {conv.worktreePath && (
                <span className="break-all font-mono" title={conv.worktreePath}>
                  worktree
                </span>
              )}
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-2">
              {conv.status !== "done" && (
                <button className={btnGhost} onClick={() => patchStatus("done")}>
                  ✓ done
                </button>
              )}
              {conv.status !== "canceled" && conv.status !== "done" && (
                <button
                  className={btnDanger}
                  onClick={() => patchStatus("canceled", "取消 issue？进行中的 run 会被级联终止（破坏性操作）。")}
                >
                  cancel
                </button>
              )}
              <select
                className="rounded-md border border-line bg-panel px-2 py-1.5 text-sm"
                value=""
                onChange={(e) => {
                  if (e.target.value) patchStatus(e.target.value as ConversationStatus);
                }}
              >
                <option value="">状态调整…</option>
                {ISSUE_STATUSES.filter((s) => s !== conv.status).map((s) => (
                  <option key={s} value={s}>
                    → {s}
                  </option>
                ))}
              </select>
            </div>

            {detail.data && detail.data.statusLog.length > 0 && (
              <div className="mb-4 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-dim">
                {detail.data.statusLog.map((l, i) => (
                  <div key={i}>
                    {l.fromStatus ?? "·"} → {l.toStatus}
                    <span className="ml-1">
                      （{l.actor}，{ago(l.ts)}）
                    </span>
                  </div>
                ))}
              </div>
            )}

            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-dim">
              Runs（点击回放事件流）
            </h3>
            <div className="mb-3 flex flex-col gap-1.5">
              {runs.map((r) => (
                <button
                  key={r.id}
                  className={`rounded-lg border p-2 text-left text-xs ${
                    selectedRun === r.id ? "border-accent bg-panel" : "border-line bg-panel hover:border-accent"
                  }`}
                  onClick={() => {
                    setSelectedRun(r.id);
                    setFollowLatest(r.id === latestRun?.id);
                  }}
                >
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-mono text-dim">{r.id.slice(0, 12)}</span>
                    <StatusBadge status={r.status} />
                    <span className="text-dim">{ago(r.queuedAt)}</span>
                    <span className="font-mono text-dim">{fmtUsd(r.cost?.usd)}</span>
                  </div>
                  <div className="mt-1 break-all text-dim">▸ {r.prompt.slice(0, 120)}</div>
                  {r.status === "succeeded" && (
                    <div className="mt-1 break-all">
                      {r.resultText != null ? r.resultText.slice(0, 160) : "（记录已过期）"}
                    </div>
                  )}
                  {r.error && <div className="mt-1 break-all text-canceled">{r.error}</div>}
                </button>
              ))}
              {runs.length === 0 && <Empty text="还没有 run" />}
            </div>

            <EventLog runId={selectedRun} />

            <div className="mt-auto pt-4">
              <div className="flex gap-2">
                <textarea
                  className={`${inputCls} h-16 resize-y`}
                  placeholder="continue —— 在同一上下文追加一轮（上一轮进行中会被拒绝）"
                  value={continuePrompt}
                  onChange={(e) => setContinuePrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitContinue();
                  }}
                />
                <button
                  className={`${btnPrimary} self-end`}
                  disabled={busy || !continuePrompt.trim()}
                  onClick={submitContinue}
                >
                  发送
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
