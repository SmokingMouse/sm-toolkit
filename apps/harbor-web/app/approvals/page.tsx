"use client";

import { useState } from "react";
import { decideApproval, listApprovals, type Approval } from "../../lib/api";
import { ago, usePoll } from "../../lib/hooks";
import { useToast } from "../../components/toast";
import { btnDanger, btnPrimary, Empty, StatusBadge } from "../../components/ui";

const TTL_MS = 30 * 60 * 1000; // = protocol.APPROVAL_TTL_MS

export default function ApprovalsPage() {
  const all = usePoll(() => listApprovals(), 10_000);
  const pending = (all.data ?? []).filter((a) => a.status === "pending");
  const decided = (all.data ?? []).filter((a) => a.status !== "pending");

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-lg font-semibold">Approvals</h1>
      {all.error && <div className="mb-3 text-sm text-canceled">{all.error}</div>}

      <div className="flex flex-col gap-3">
        {pending.map((a) => (
          <PendingCard key={a.id} approval={a} onDecided={all.reload} />
        ))}
        {pending.length === 0 && <Empty text="没有待审批的工具授权请求" />}
      </div>

      {decided.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-dim">历史（{decided.length}）</summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {decided.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-x-3 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
                <span className="font-mono text-dim">{a.id.slice(0, 12)}</span>
                <span className="font-medium">{a.toolName}</span>
                <StatusBadge status={a.status} />
                <span className="text-dim">
                  {a.decidedBy ? `by ${a.decidedBy}` : ""} · {ago(a.decidedAt ?? a.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PendingCard({ approval: a, onDecided }: { approval: Approval; onDecided: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const leftMs = Math.max(0, a.createdAt + TTL_MS - Date.now());
  const leftMin = Math.ceil(leftMs / 60_000);
  const inputStr = JSON.stringify(a.input ?? null, null, 2);

  const decide = async (behavior: "allow" | "deny") => {
    setBusy(true);
    try {
      const res = await decideApproval(a.id, behavior);
      // 双通道先到先得，幂等：已被决议则展示现状
      if (res.status !== (behavior === "allow" ? "allowed" : "denied")) {
        toast(`该请求已是 ${res.status}${res.decidedBy ? `（by ${res.decidedBy}）` : ""}`, "info");
      } else {
        toast(behavior === "allow" ? "已批准，run 续跑" : "已拒绝", "success");
      }
      onDecided();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-review/40 bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold">⏸ {a.toolName}</span>
        <span className="font-mono text-xs text-dim">run {a.runId.slice(0, 12)}</span>
        <span className="text-xs text-dim">等待 {ago(a.createdAt)}</span>
        <span className={`text-xs ${leftMin <= 5 ? "text-canceled" : "text-review"}`}>
          剩 {leftMin}min 过期自动拒绝
        </span>
      </div>
      <details className="mb-3">
        <summary className="cursor-pointer break-all font-mono text-xs text-dim">
          {inputStr.replace(/\s+/g, " ").slice(0, 160)}
        </summary>
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg p-2 font-mono text-xs">
          {inputStr}
        </pre>
      </details>
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={busy} onClick={() => decide("allow")}>
          批准
        </button>
        <button className={btnDanger} disabled={busy} onClick={() => decide("deny")}>
          拒绝
        </button>
      </div>
    </div>
  );
}
