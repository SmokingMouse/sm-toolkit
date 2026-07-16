"use client";

import { useEffect, useState } from "react";
import { getToken, health, promptWrapperSettings, resetPromptWrapper, savePromptWrapper, setToken, type PromptSource, type PromptWrapperConfig } from "../../lib/api";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Field, inputCls, PageHeader } from "../../components/ui";

const SOURCE_COPY: Record<PromptSource, { title: string; description: string }> = {
  issue: { title: "Issue runs", description: "为有明确交付目标的任务补充执行上下文。" },
  chat: { title: "Chat runs", description: "保持对话自然，同时注入设备与 Agent 事实。" },
  automation: { title: "Automation runs", description: "为无人值守执行补充时间与来源约束。" },
};

export default function SettingsPage() {
  const toast = useToast();
  const [tok, setTok] = useState("");
  const [origin, setOrigin] = useState("");
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [wrappers, setWrappers] = useState<PromptWrapperConfig[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [source, setSource] = useState<PromptSource>("issue");
  const [enabled, setEnabled] = useState(true);
  const [template, setTemplate] = useState("");
  const [savingWrapper, setSavingWrapper] = useState(false);
  const [wrapperError, setWrapperError] = useState("");

  useEffect(() => {
    setTok(getToken());
    setOrigin(location.origin);
    if (getToken()) {
      promptWrapperSettings().then((data) => {
        setWrappers(data.wrappers);
        setVariables(data.variables);
        const initial = data.wrappers.find((w) => w.source === "issue");
        if (initial) { setEnabled(initial.enabled); setTemplate(initial.template); }
      }).catch((e) => setWrapperError(e instanceof Error ? e.message : String(e)));
      health().then(() => setConnected(true), () => setConnected(false));
    }
  }, []);

  const chooseSource = (next: PromptSource) => {
    setSource(next);
    const config = wrappers.find((w) => w.source === next);
    if (config) { setEnabled(config.enabled); setTemplate(config.template); }
  };

  const replaceWrapper = (config: PromptWrapperConfig) => {
    setWrappers((current) => current.map((item) => item.source === config.source ? config : item));
    setEnabled(config.enabled);
    setTemplate(config.template);
  };

  const saveWrapper = async () => {
    setSavingWrapper(true);
    try {
      const config = await savePromptWrapper({ source, enabled, template });
      replaceWrapper(config);
      toast(`${source} Prompt wrapper 已保存`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSavingWrapper(false); }
  };

  const resetWrapper = async () => {
    if (!confirm(`恢复 ${source} 的默认 Prompt wrapper？`)) return;
    setSavingWrapper(true);
    try {
      const config = await resetPromptWrapper(source);
      replaceWrapper(config);
      toast(`${source} 已恢复默认`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSavingWrapper(false); }
  };

  const save = () => {
    setToken(tok.trim());
    toast("token 已保存，仅存于浏览器 localStorage", "success");
    setTimeout(() => location.reload(), 600);
  };

  const check = async () => {
    setChecking(true);
    try { await health(); setConnected(true); toast("连接正常", "success"); }
    catch (e) { setConnected(false); toast(`连接失败：${e instanceof Error ? e.message : e}`, "error"); }
    finally { setChecking(false); }
  };

  const current = wrappers.find((w) => w.source === source);

  return (
    <div className="page-enter mx-auto max-w-[1240px] p-7 max-sm:p-4">
      <PageHeader eyebrow="Control plane" title="Settings" description="管理浏览器到 Harbor Server 的连接，以及每类任务在派发前采用的 Prompt 外壳。" />

      <div className="grid items-start gap-5 lg:grid-cols-[330px_1fr]">
        <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel lg:sticky lg:top-7">
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
              <input type="password" className={inputCls} value={tok} onChange={(e) => setTok(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} placeholder="shared secret" />
            </Field>
            <p className="mt-2 text-[11px] leading-4 text-dim">仅保存在当前浏览器 localStorage，不会被写回 Server。</p>
            <div className="mt-5 flex gap-2">
              <button className={btnPrimary} onClick={save}>保存 Token</button>
              <button className={btnGhost} onClick={check} disabled={checking}>{checking ? "检查中…" : "连接自检"}</button>
            </div>
          </div>
        </section>

        <section className="surface-shadow overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.17em] text-accent">Prompt pipeline</div>
              <h2 className="mt-1 text-base font-semibold">Wrappers</h2>
              <p className="mt-1 text-xs text-dim">只在 dispatch 时渲染；历史里的原始 prompt 保持不变。</p>
            </div>
            {current && <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${current.isDefault ? "border-line bg-bg text-dim" : "border-emerald-200 bg-emerald-50 text-done"}`}>{current.isDefault ? "System default" : "Customized"}</span>}
          </div>

          {wrapperError && <div className="m-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-canceled">加载失败：{wrapperError}</div>}
          {wrappers.length === 0 ? (
            <div className="m-5 rounded-xl border border-dashed border-line p-8 text-center text-sm text-dim">保存 token 并连接 Server 后可编辑模板。</div>
          ) : (
            <>
              <div className="grid grid-cols-3 border-b border-line bg-bg/55 px-3 pt-3">
                {(["issue", "chat", "automation"] as PromptSource[]).map((item) => (
                  <button key={item} className={`relative px-3 py-3 text-left ${source === item ? "text-ink" : "text-dim hover:text-ink"}`} onClick={() => chooseSource(item)}>
                    <div className="text-xs font-semibold capitalize">{item}</div>
                    <div className="mt-0.5 hidden text-[10px] text-dim sm:block">{SOURCE_COPY[item].title}</div>
                    {source === item && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" />}
                  </button>
                ))}
              </div>
              <div className="p-5">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold">{SOURCE_COPY[source].title}</h3>
                    <p className="mt-1 text-xs text-dim">{SOURCE_COPY[source].description}</p>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
                    <button type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled(!enabled)} className={`relative h-5 w-9 rounded-full ${enabled ? "bg-accent" : "bg-zinc-300"}`}>
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "left-4.5" : "left-0.5"}`} />
                    </button>
                    {enabled ? "Enabled" : "Disabled"}
                  </label>
                </div>
                <textarea className={`${inputCls} h-72 resize-y font-mono text-[11px] leading-5`} value={template} onChange={(e) => setTemplate(e.target.value)} spellCheck={false} />
                <div className="mt-4">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.13em] text-dim">Available variables</div>
                  <div className="flex flex-wrap gap-1.5">
                    {variables.map((variable) => <code key={variable} className="rounded-md border border-line bg-bg px-2 py-1 text-[10px] text-dim">{`{{${variable}}}`}</code>)}
                  </div>
                </div>
                <div className="mt-5 flex gap-2 border-t border-line pt-4">
                  <button className={btnPrimary} onClick={saveWrapper} disabled={savingWrapper}>{savingWrapper ? "保存中…" : "保存模板"}</button>
                  <button className={btnGhost} onClick={resetWrapper} disabled={savingWrapper}>恢复默认</button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
