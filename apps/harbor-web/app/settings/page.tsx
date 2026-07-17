"use client";

import { useEffect, useState } from "react";
import {
  getToken,
  health,
  promptBlockSettings,
  resetPromptBlock,
  savePromptBlock,
  setToken,
  type PromptBlockConfig,
  type PromptBlockKey,
  type PromptSource,
} from "../../lib/api";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Field, inputCls, PageHeader } from "../../components/ui";

const SOURCE_ORDER: PromptSource[] = ["issue", "chat", "automation"];
const SOURCE_COPY: Record<PromptSource, { title: string; description: string }> = {
  issue: { title: "Issue", description: "稳定上下文 + 指派、@ 提及和新消息。" },
  chat: { title: "Chat", description: "会话上下文 + 每轮当前消息。" },
  automation: { title: "Automation", description: "定时与人工执行使用不同边界。" },
};

export default function SettingsPage() {
  const toast = useToast();
  const [tok, setTok] = useState("");
  const [origin, setOrigin] = useState("");
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [blocks, setBlocks] = useState<PromptBlockConfig[]>([]);
  const [blockKey, setBlockKey] = useState<PromptBlockKey>("session.issue.context");
  const [enabled, setEnabled] = useState(true);
  const [template, setTemplate] = useState("");
  const [savingBlock, setSavingBlock] = useState(false);
  const [blockError, setBlockError] = useState("");

  useEffect(() => {
    setTok(getToken());
    setOrigin(location.origin);
    if (!getToken()) return;
    promptBlockSettings()
      .then((data) => {
        setBlocks(data.blocks);
        const initial = data.blocks.find((block) => block.key === "session.issue.context") ?? data.blocks[0];
        if (initial) {
          setBlockKey(initial.key);
          setEnabled(initial.enabled);
          setTemplate(initial.template);
        }
      })
      .catch((error) => setBlockError(error instanceof Error ? error.message : String(error)));
    health().then(() => setConnected(true), () => setConnected(false));
  }, []);

  const current = blocks.find((block) => block.key === blockKey);

  const chooseBlock = (next: PromptBlockConfig) => {
    setBlockKey(next.key);
    setEnabled(next.enabled);
    setTemplate(next.template);
  };

  const replaceBlock = (config: PromptBlockConfig) => {
    setBlocks((existing) => existing.map((block) => (block.key === config.key ? config : block)));
    setBlockKey(config.key);
    setEnabled(config.enabled);
    setTemplate(config.template);
  };

  const saveBlock = async () => {
    setSavingBlock(true);
    try {
      const config = await savePromptBlock({ key: blockKey, enabled, template });
      replaceBlock(config);
      toast(`${config.label} Prompt block 已保存`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSavingBlock(false);
    }
  };

  const restoreBlock = async () => {
    if (!confirm(`恢复 ${current?.label ?? blockKey} 的默认 Prompt block？`)) return;
    setSavingBlock(true);
    try {
      const config = await resetPromptBlock(blockKey);
      replaceBlock(config);
      toast(`${config.label} 已恢复默认`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSavingBlock(false);
    }
  };

  const saveConnection = () => {
    setToken(tok.trim());
    toast("token 已保存，仅存于浏览器 localStorage", "success");
    setTimeout(() => location.reload(), 600);
  };

  const check = async () => {
    setChecking(true);
    try {
      await health();
      setConnected(true);
      toast("连接正常", "success");
    } catch (error) {
      setConnected(false);
      toast(`连接失败：${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setChecking(false);
    }
  };

  const copyVariable = async (name: string) => {
    await navigator.clipboard.writeText(`{{${name}}}`);
    toast(`已复制 {{${name}}}`, "success");
  };

  return (
    <div className="page-enter mx-auto max-w-[1440px] p-7 max-sm:p-4">
      <PageHeader
        eyebrow="Control plane"
        title="Settings"
        description="管理浏览器连接，以及 Run 在派发时组合的 context 与 event Prompt blocks。"
      />

      <div className="grid items-start gap-5 xl:grid-cols-[330px_1fr]">
        <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel xl:sticky xl:top-7">
          <div className="border-b border-line bg-harbor p-5 text-white">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.17em] text-white/40">Server connection</div>
                <h2 className="mt-1 text-base font-semibold">Harbor Control Plane</h2>
              </div>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold uppercase ${connected === true ? "border-emerald-300/20 bg-emerald-300/10 text-[#82d8c5]" : connected === false ? "border-red-300/20 bg-red-300/10 text-red-200" : "border-white/10 text-white/40"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${connected === true ? "bg-[#62cfb6]" : connected === false ? "bg-red-300" : "bg-white/30"}`} />
                {connected === true ? "Online" : connected === false ? "Offline" : "Unknown"}
              </span>
            </div>
            <div className="mt-4 truncate rounded-lg border border-white/8 bg-black/15 px-3 py-2 font-mono text-[10px] text-white/55" title={origin}>{origin || "…"}</div>
          </div>
          <div className="p-5">
            <Field label="HARBOR_TOKEN">
              <input type="password" className={inputCls} value={tok} onChange={(event) => setTok(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveConnection(); }} placeholder="shared secret" />
            </Field>
            <p className="mt-2 text-[11px] leading-4 text-dim">仅保存在当前浏览器 localStorage，不会被写回 Server。</p>
            <div className="mt-5 flex gap-2">
              <button className={btnPrimary} onClick={saveConnection}>保存 Token</button>
              <button className={btnGhost} onClick={check} disabled={checking}>{checking ? "检查中…" : "连接自检"}</button>
            </div>
          </div>
        </section>

        <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.17em] text-accent">Prompt pipeline</div>
              <h2 className="mt-1 text-base font-semibold">Context + event blocks</h2>
              <p className="mt-1 text-xs text-dim">原始 prompt 原样落库；dispatch 时按触发原因选择 event，并在 Issue / Chat 前拼接 context。</p>
            </div>
            {current && <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${current.isDefault ? "border-line bg-bg text-dim" : "border-emerald-200 bg-emerald-50 text-done"}`}>{current.isDefault ? "System default" : "Customized"}</span>}
          </div>

          {blockError && <div className="m-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-canceled">加载失败：{blockError}</div>}
          {blocks.length === 0 ? (
            <div className="m-5 rounded-xl border border-dashed border-line p-8 text-center text-sm text-dim">保存 token 并连接 Server 后可编辑 Prompt blocks。</div>
          ) : (
            <>
              <div className="grid gap-3 border-b border-line bg-bg/55 p-4 md:grid-cols-3">
                {SOURCE_ORDER.map((source) => (
                  <div key={source} className="rounded-xl border border-line bg-panel p-2">
                    <div className="px-1 pb-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.13em] text-dim">{SOURCE_COPY[source].title}</div>
                      <div className="mt-0.5 text-[10px] leading-4 text-dim">{SOURCE_COPY[source].description}</div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {blocks.filter((block) => block.source === source).map((block) => (
                        <button
                          key={block.key}
                          type="button"
                          onClick={() => chooseBlock(block)}
                          className={`inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition ${block.key === blockKey ? "border-harbor bg-harbor text-white" : "border-line bg-bg text-dim hover:text-ink"}`}
                        >
                          {block.label}
                          {!block.isDefault && <span className={`h-1.5 w-1.5 rounded-full ${block.key === blockKey ? "bg-white/75" : "bg-done"}`} />}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {current && (
                <div className="p-5">
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold">{current.label} prompt</h3>
                        <code className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-dim">{current.key}</code>
                      </div>
                      <p className="mt-1 text-xs text-dim">{current.description}</p>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
                      <button type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled(!enabled)} className={`relative h-5 w-9 rounded-full ${enabled ? "bg-accent" : "bg-zinc-300"}`}>
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "left-4.5" : "left-0.5"}`} />
                      </button>
                      {enabled ? "Enabled" : current.phase === "event" ? "Raw request" : "Omitted"}
                    </label>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_290px]">
                    <textarea className={`${inputCls} min-h-[520px] resize-y font-mono text-[11px] leading-5`} value={template} onChange={(event) => setTemplate(event.target.value)} spellCheck={false} />
                    <aside className="min-w-0">
                      <div className="text-xs font-semibold">Variables</div>
                      <div className="mt-3 max-h-[520px] space-y-2 overflow-y-auto pr-1">
                        {current.variables.map((variable) => (
                          <button key={variable.name} type="button" onClick={() => void copyVariable(variable.name)} className="block w-full rounded-lg border border-line bg-bg px-3 py-2 text-left hover:border-accent/40">
                            <code className="break-all text-[11px] text-ink">{`{{${variable.name}}}`}</code>
                            <span className="mt-1 block text-[10px] leading-4 text-dim">{variable.description}</span>
                          </button>
                        ))}
                      </div>
                    </aside>
                  </div>

                  <div className="mt-5 flex gap-2 border-t border-line pt-4">
                    <button className={btnPrimary} onClick={saveBlock} disabled={savingBlock}>{savingBlock ? "保存中…" : "保存 Block"}</button>
                    <button className={btnGhost} onClick={restoreBlock} disabled={savingBlock || current.isDefault}>恢复默认</button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
