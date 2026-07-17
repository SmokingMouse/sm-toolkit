"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createConversation,
  createRun,
  getConversation,
  listAgents,
  listConversations,
  type ConversationWithAgent,
  type HarborAgent,
  type RunWithResult,
} from "../../lib/api";
import { ago, usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Empty, Field, inputCls, Modal, ModalFooter } from "../../components/ui";
import { foldFrames, ToolCard, useRunFrames } from "../../components/run-stream";
import { Markdown } from "../../components/markdown";

export default function ChatsPage() {
  const convs = usePoll(() => listConversations({ kind: "chat" }), 10_000);
  const agents = usePoll(listAgents, 30_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftAgent, setDraftAgent] = useState<string | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupByAgent, setGroupByAgent] = useState(false);
  const grouped = useMemo(() => {
    const groups = new Map<string, ConversationWithAgent[]>();
    for (const conversation of convs.data ?? []) {
      const agentName = conversation.agentName ?? "Unknown Agent";
      const rows = groups.get(agentName) ?? [];
      rows.push(conversation);
      groups.set(agentName, rows);
    }
    return [...groups.entries()];
  }, [convs.data]);
  const displayGroups = groupByAgent ? grouped : [["", convs.data ?? []] as const];

  return (
    <div className="page-enter flex h-full">
      <aside className="flex w-[316px] shrink-0 flex-col border-r border-line bg-panel/80 max-lg:w-[260px] max-sm:w-[210px]">
        <div className="flex items-end justify-between gap-2 border-b border-line px-4 py-4">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[0.17em] text-accent">Conversations</div>
            <span className="mt-1 block text-lg font-semibold tracking-tight">Chats</span>
          </div>
          <div className="flex gap-1.5">
            <button className={`${btnGhost} min-h-9 px-2.5 ${groupByAgent ? "border-accent/35 bg-accent-soft/60 text-accent-strong" : ""}`} aria-pressed={groupByAgent} title="按 Agent 分组" onClick={() => setGroupByAgent((value) => !value)}>◎</button>
            <button className={btnGhost} onClick={() => setNewChatOpen(true)}>＋ New</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2.5 py-3">
          {draftAgent && (
            <button
              className={`mb-1.5 w-full rounded-xl border px-3 py-2.5 text-left text-sm ${
                selected === null ? "border-accent/30 bg-accent-soft/55" : "border-line bg-white/55"
              }`}
              onClick={() => setSelected(null)}
            >
              <div className="text-[13px] italic text-dim">新聊天（未发送）</div>
              <div className="text-[11px] text-dim">agent {draftAgent}</div>
            </button>
          )}
          {displayGroups.map(([agentName, conversations]) => (
            <section key={agentName} className="mb-3">
              {groupByAgent && <div className="mb-1.5 flex items-center gap-2 px-2 text-[9px] font-bold uppercase tracking-[0.14em] text-dim">
                <span className="grid h-4 w-4 place-items-center rounded bg-accent-soft text-[8px] text-accent-strong">{agentName.slice(0, 1).toUpperCase()}</span>
                <span className="truncate">{agentName}</span>
                <span className="ml-auto font-mono font-normal">{conversations?.length ?? 0}</span>
              </div>}
              {conversations?.map((c) => (
                <button
                  key={c.id}
                  className={`mb-1 w-full rounded-xl border px-3 py-2.5 text-left ${
                    selected === c.id ? "border-accent/30 bg-accent-soft/55 shadow-[inset_3px_0_0_var(--color-accent)]" : "border-transparent hover:border-line hover:bg-white/70"
                  }`}
                  onClick={() => setSelected(c.id)}
                >
                  <div className="truncate text-[13px] font-medium">{c.title || "(无标题)"}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-dim">
                    <span className="truncate font-mono">{c.id.slice(0, 8)}</span>
                    <span className="shrink-0">{ago(c.updatedAt)}</span>
                  </div>
                </button>
              ))}
            </section>
          ))}
          {(convs.data ?? []).length === 0 && !draftAgent && (
            <div className="px-2 py-6 text-center text-xs text-dim">还没有聊天</div>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {selected || draftAgent ? (
          <ChatView
            key={selected ?? `draft:${draftAgent}`}
            conversationId={selected}
            draftAgent={draftAgent}
            onConversationCreated={(id) => {
              setDraftAgent(null);
              setSelected(id);
              convs.reload();
            }}
          />
        ) : (
          <div className="p-7"><Empty text="选择左侧会话，或创建一段新对话" /></div>
        )}
      </div>

      {newChatOpen && (
        <NewChatModal
          agents={agents.data ?? []}
          onClose={() => setNewChatOpen(false)}
          onPick={(agent) => {
            setNewChatOpen(false);
            setDraftAgent(agent);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function NewChatModal({
  agents,
  onClose,
  onPick,
}: {
  agents: HarborAgent[];
  onClose: () => void;
  onPick: (agent: string) => void;
}) {
  const [agent, setAgent] = useState(agents[0]?.name ?? "");
  return (
    <Modal title="New Chat" onClose={onClose}>
      <Field label="agent">
        <select className={inputCls} value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <ModalFooter>
        <button className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button className={btnPrimary} disabled={!agent} onClick={() => onPick(agent)}>
          开始
        </button>
      </ModalFooter>
    </Modal>
  );
}

function ChatView({
  conversationId,
  draftAgent,
  onConversationCreated,
}: {
  conversationId: string | null;
  draftAgent: string | null;
  onConversationCreated: (id: string) => void;
}) {
  const toast = useToast();
  const detail = usePoll(
    () => (conversationId ? getConversation(conversationId) : Promise.resolve(null)),
    5_000,
  );
  const [input, setInput] = useState("");
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const { frames, streaming, doneRun } = useRunFrames(liveRunId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const runs = useMemo(() => detail.data?.runs ?? [], [detail.data]);

  // 打开会话时如有活跃 run（CLI/automation 派的，或 remount 前刚发的）→ 自动接直播
  const activeRun = runs.find((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!liveRunId && activeRun) setLiveRunId(activeRun.id);
  }, [liveRunId, activeRun]);

  // 自动滚底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs.length, frames.length]);

  const sending = busy || (liveRunId !== null && doneRun === null && streaming);
  const livePrompt = runs.find((r) => r.id === liveRunId)?.prompt ?? pendingPrompt;
  const agentName = detail.data?.agent?.name ?? draftAgent ?? "Agent";
  const chatTitle = detail.data?.conversation.title || (conversationId ? "Untitled chat" : "New conversation");

  const send = async () => {
    const prompt = input.trim();
    if (!prompt) return;
    setBusy(true);
    try {
      let convId = conversationId;
      if (!convId) {
        // 草稿态：首条消息时才真正建会话，title 取 prompt 前 60 字
        const conv = await createConversation({
          kind: "chat",
          agent: draftAgent!,
          title: prompt.slice(0, 60),
          origin: "web",
        });
        convId = conv.id;
      }
      const run = await createRun(convId, prompt);
      setPendingPrompt(prompt);
      setInput("");
      setLiveRunId(run.id);
      if (!conversationId) onConversationCreated(convId);
      else detail.reload();
    } catch (e) {
      // 串行闸 400 文案直接展示（已是人话）
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[72px] shrink-0 items-center justify-between border-b border-line bg-panel/70 px-5 backdrop-blur">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{chatTitle}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-dim"><span className="h-1.5 w-1.5 rounded-full bg-done" /> Conversation context is preserved</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-full border border-line bg-white/70 px-3 py-1.5 text-[11px] font-semibold text-ink/80"><span className="mr-1.5 text-accent">◆</span>{agentName}</div>
          <div className="rounded-full border border-line bg-white/60 px-2.5 py-1.5 font-mono text-[10px] text-dim">{runs.length} runs</div>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-3xl">
          {runs.filter((r) => r.id !== liveRunId).map((r) => <HistoryBubbles key={r.id} run={r} agentName={agentName} />)}
          {liveRunId && <>{livePrompt && <UserBubble text={livePrompt} />}<LiveAssistantBubble frames={frames} streaming={streaming} agentName={agentName} /></>}
          {runs.length === 0 && !liveRunId && (
            <div className="grid min-h-56 place-items-center text-center">
              <div>
                <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl border border-line bg-panel font-semibold text-accent">H</div>
                <div className="text-sm font-medium">Start with {agentName}</div>
                <div className="mt-1 text-xs text-dim">输入第一条消息，Harbor 会创建并保存这段会话。</div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-line bg-panel/90 p-4 backdrop-blur">
        <div className="surface-shadow mx-auto max-w-3xl overflow-hidden rounded-2xl border border-line bg-white focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/10">
          <textarea
            className="h-[62px] w-full resize-none border-0 bg-transparent px-4 pt-3 text-sm leading-5 text-ink outline-none placeholder:text-zinc-400 disabled:bg-bg/70"
            placeholder={sending ? "上一轮还在跑…（串行闸）" : `Message ${agentName}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
            disabled={sending}
          />
          <div className="flex items-center justify-between border-t border-line/70 px-3 py-2">
            <div className="text-[10px] text-dim">同一会话串行执行 · <span className="font-mono">⌘↵</span> 发送</div>
            <button className={`${btnPrimary} min-h-8 px-3 py-1.5 text-xs`} disabled={sending || !input.trim()} onClick={send}>发送</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="mb-5 flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[#e9eeeb] px-4 py-2.5 text-sm leading-6 text-ink shadow-[0_1px_2px_rgba(20,35,30,.04)]">
        {text}
      </div>
    </div>
  );
}

function AssistantShell({ children, agentName, state }: { children: React.ReactNode; agentName: string; state?: string }) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-harbor text-[10px] font-bold text-white">H</div>
      <div className="min-w-0 max-w-[88%] flex-1">
        <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold text-dim">
          <span className="text-ink/80">{agentName}</span>
          {state && <span className="font-normal">{state}</span>}
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-ink/90">{children}</div>
      </div>
    </div>
  );
}

function HistoryBubbles({ run, agentName }: { run: RunWithResult; agentName: string }) {
  const duration = run.startedAt && run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) : null;
  return (
    <>
      <UserBubble text={run.prompt} />
      <AssistantShell agentName={agentName} state={duration ? `Worked for ${duration}s` : run.status === "running" ? "Working…" : undefined}>
        {run.status === "queued" || run.status === "running" ? (
          <span className="text-dim">（进行中…）</span>
        ) : run.error ? (
          <span className="text-canceled">✗ {run.error}</span>
        ) : run.resultText != null ? (
          <Markdown text={run.resultText} />
        ) : (
          <span className="text-dim">（记录已过期）</span>
        )}
      </AssistantShell>
    </>
  );
}

function LiveAssistantBubble({
  frames,
  streaming,
  agentName,
}: {
  frames: Parameters<typeof foldFrames>[0];
  streaming: boolean;
  agentName: string;
}) {
  const items = useMemo(() => foldFrames(frames), [frames]);
  return (
    <AssistantShell agentName={agentName} state={streaming ? "Working…" : "Completed"}>
      {items.map((it, i) => {
        switch (it.kind) {
          case "text":
            return <Markdown key={i} text={it.text} />;
          case "thinking":
            return (
              <details key={i} className="my-1 text-xs italic text-dim">
                <summary className="cursor-pointer not-italic">思考过程</summary>
                <div className="whitespace-pre-wrap">{it.text}</div>
              </details>
            );
          case "tool":
            return <ToolCard key={i} item={it} />;
          case "error":
            return (
              <div key={i} className="text-canceled">
                ✗ {it.text}
              </div>
            );
          case "approval":
            return (
              <div key={i} className="text-review">
                {it.text}
              </div>
            );
          case "done":
            return it.ok ? null : (
              <div key={i} className="text-xs text-review">
                {it.text}
              </div>
            );
          case "session":
            return null;
        }
      })}
      {streaming && <span className="animate-pulse text-dim">▍</span>}
      {!streaming && items.length === 0 && <span className="text-dim">（等待响应…）</span>}
    </AssistantShell>
  );
}
