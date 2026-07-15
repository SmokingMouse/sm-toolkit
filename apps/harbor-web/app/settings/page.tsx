"use client";

import { useEffect, useState } from "react";
import { getToken, health, setToken } from "../../lib/api";
import { useToast } from "../../components/toast";
import { btnGhost, btnPrimary, Field, inputCls } from "../../components/ui";

export default function SettingsPage() {
  const toast = useToast();
  const [tok, setTok] = useState("");
  const [origin, setOrigin] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setTok(getToken());
    setOrigin(location.origin);
  }, []);

  const save = () => {
    setToken(tok.trim());
    toast("token 已保存（仅存浏览器 localStorage）", "success");
    // 让 Shell 的连接状态/红点轮询立即用新 token 重拉
    setTimeout(() => location.reload(), 600);
  };

  const check = async () => {
    setChecking(true);
    try {
      await health();
      toast("连接正常 ✓", "success");
    } catch (e) {
      toast(`连接失败：${e instanceof Error ? e.message : e}`, "error");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-lg font-semibold">Settings</h1>
      <div className="rounded-xl border border-line bg-panel p-5">
        <Field label="HARBOR_TOKEN">
          <input
            type="password"
            className={inputCls}
            value={tok}
            onChange={(e) => setTok(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder="server 与 daemon 共享的 secret"
          />
        </Field>
        <Field label="Server 地址">
          <div className="rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-dim">
            {origin || "…"}
            <span className="ml-2">（同源；dev 模式下 /api 代理到 127.0.0.1:7777）</span>
          </div>
        </Field>
        <div className="mt-4 flex gap-2">
          <button className={btnPrimary} onClick={save}>
            保存
          </button>
          <button className={btnGhost} onClick={check} disabled={checking}>
            {checking ? "自检中…" : "连接自检"}
          </button>
        </div>
      </div>
    </div>
  );
}
