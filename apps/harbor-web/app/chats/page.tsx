"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createConversation,
  createRun,
  getConversation,
  listAgents,
  listConversations,
  type HarborAgent,
  type RunWithResult,
} from "../../lib/api";
import { ago, usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Empty, Field, inputCls, Modal, ModalFooter } from "../../components/ui";
import { foldFrames, useRunFrames } from "../../components/run-stream";

export default function ChatsPage() {
  const convs = usePoll(() => listConversations({ kind: "chat" }), 10_000);
  const agents = usePoll(listAgents, 30_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftAgent, setDraftAgent] = useState<string | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);

  return (
    <div className="page-enter flex h-full">
      <aside className="flex w-[292px] shrink-0 flex-col border-r border-line bg-panel/80 max-lg:w-[250px] max-sm:w-[210px]">
        <div className="flex items-end justify-between border-b border-line px-4 py-4">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[0.17em] text-accent">Conversations</div>
            <span className="mt-1 block text-lg font-semibold tracking-tight">Chats</span>
          </div>
          <button className={btnGhost} onClick={() => setNewChatOpen(true)}>
            ＋ New
          </button>
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
          {(convs.data ?? []).map((c) => (
            <button
              key={c.id}
              className={`mb-1.5 w-full rounded-xl border px-3 py-2.5 text-left ${
                selected === c.id ? "border-accent/30 bg-accent-soft/55 shadow-[inset_3px_0_0_var(--color-accent)]" : "border-transparent hover:border-line hover:bg-white/70"
              }`}
              onClick={() => {
                setSelected(c.id);
              }}
            >
              <div className="truncate text-[13px] font-medium">{c.title || "(无标题)"}</div>
              <div className="mt-1 flex gap-2 text-[10px] text-dim">
                <span>{c.agentName}</span>
                <span>{ago(c.updatedAt)}</span>
              </div>
            </button>
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
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-dim"><span className="h-1.5 w-1.5 rounded-full bg-done" /> Agent · {agentName}</div>
        </div>
        <div className="rounded-full border border-line bg-white/60 px-2.5 py-1 font-mono text-[10px] text-dim">{runs.length} runs</div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-3xl">
          {runs.filter((r) => r.id !== liveRunId).map((r) => <HistoryBubbles key={r.id} run={r} />)}
          {liveRunId && <>{livePrompt && <UserBubble text={livePrompt} />}<LiveAssistantBubble frames={frames} streaming={streaming} /></>}
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
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            className={`${inputCls} h-[58px] resize-none bg-white`}
            placeholder={sending ? "上一轮还在跑…（串行闸）" : "输入消息，⌘/Ctrl+Enter 发送"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
            disabled={sending}
          />
          <button className={`${btnPrimary} self-end`} disabled={sending || !input.trim()} onClick={send}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="mb-3 flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-accent-strong px-4 py-2.5 text-sm leading-6 text-white shadow-[0_5px_16px_rgba(5,100,87,.12)]">
        {text}
      </div>
    </div>
  );
}

function AssistantShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex justify-start">
      <div className="surface-shadow max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-line bg-panel px-4 py-2.5 text-sm leading-6">
        {children}
      </div>
    </div>
  );
}

function HistoryBubbles({ run }: { run: RunWithResult }) {
  return (
    <>
      <UserBubble text={run.prompt} />
      <AssistantShell>
        {run.status === "queued" || run.status === "running" ? (
          <span className="text-dim">（进行中…）</span>
        ) : run.error ? (
          <span className="text-canceled">✗ {run.error}</span>
        ) : run.resultText != null ? (
          run.resultText
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
}: {
  frames: Parameters<typeof foldFrames>[0];
  streaming: boolean;
}) {
  const items = useMemo(() => foldFrames(frames), [frames]);
  return (
    <AssistantShell>
      {items.map((it, i) => {
        switch (it.kind) {
          case "text":
            return <span key={i}>{it.text}</span>;
          case "thinking":
            return (
              <details key={i} className="my-1 text-xs italic text-dim">
                <summary className="cursor-pointer not-italic">思考过程</summary>
                <div className="whitespace-pre-wrap">{it.text}</div>
              </details>
            );
          case "tool":
            return (
              <div key={i} className="my-0.5 font-mono text-xs text-dim">
                ⚙ {it.name} {it.summary}
              </div>
            );
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
