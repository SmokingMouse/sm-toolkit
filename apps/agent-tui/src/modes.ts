import type { Thread } from "@smokingmouse/agent-server/protocol";
import { ErrorCode } from "@smokingmouse/agent-server/protocol";

export type Permission = NonNullable<Thread["permission"]>;
export function nativePermission(mode: Permission = "default"): Permission {
  return mode === "full" ? "bypassPermissions" : mode === "auto-edit" ? "acceptEdits" : mode;
}
export function permissionModes(bypass: boolean): Permission[] {
  return ["default", "acceptEdits", "plan", ...(bypass ? ["bypassPermissions" as const] : [])];
}
export function nextPermission(mode: Permission | undefined, bypass: boolean): Permission {
  const modes = permissionModes(bypass);
  if (mode === "readonly") return "readonly";
  return modes[(modes.indexOf(nativePermission(mode)) + 1) % modes.length];
}
// UI budget presets, not a claim that native --effort labels have this mapping.
export const effortBudgets = { low: 1024, medium: 8192, high: 32768, max: 65536 } as const;
export type Effort = keyof typeof effortBudgets;
export const efforts = Object.keys(effortBudgets) as Effort[];
export function nextEffort(effort?: Effort): Effort { return efforts[(efforts.indexOf(effort!) + 1) % efforts.length]; }

// Display estimates only; actual windows vary with model versions/account settings.
export const contextWindowEstimates: ReadonlyArray<readonly [RegExp, number]> = [
  [/\[1m\]$/i, 1_000_000], [/^gpt-5(?:$|-)/i, 400_000],
  [/^(?:claude-|sonnet|opus|haiku)/i, 200_000],
];
export function estimatedContextWindow(model = ""): number {
  return contextWindowEstimates.find(([pattern]) => pattern.test(model))?.[1] ?? 200_000;
}

export function contextUsage(tokens: number | null | undefined, window: number, width = 10): { bar: string; percent?: number; warning: boolean } {
  const size = Math.max(1, Math.floor(width));
  if (tokens == null || !Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(window) || window <= 0) return { bar: "?".repeat(size), warning: false };
  const ratio = tokens / window, filled = Math.min(size, Math.max(0, Math.round(ratio * size)));
  return { bar: "█".repeat(filled) + "░".repeat(size - filled), percent: Math.round(ratio * 100), warning: ratio > 0.8 };
}

export function controlSuccess(value: unknown): void {
  const response = (value as { response?: { subtype?: string; error?: unknown } } | null)?.response;
  if (response?.subtype !== "success") throw new Error(`引擎拒绝控制请求：${String(response?.error ?? "未收到 success 确认")}`);
}
export function controlError(error: unknown, leaseOperation = false): string {
  const e = error as { code?: number; message?: string; data?: { reason?: string; holder?: { label?: string; clientId?: string } } };
  const holder = e?.data?.holder;
  if (e?.code === ErrorCode.already_resolved) return "审批已被处理，请查看当前审批状态";
  if (leaseOperation && e?.code === ErrorCode.unauthorized && e.data?.reason === "lease_required") return "权限提升需要有效控制租约；租约可能已过期，请重试操作";
  return e?.code === ErrorCode.lease_held
    ? `另一客户端持有控制权${holder ? `（${holder.label || holder.clientId || "未知"}）` : ""}；待其释放/断线/到期后 /takeover 重试`
    : error instanceof Error ? error.message : String(error);
}
