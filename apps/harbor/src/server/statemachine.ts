/**
 * Issue 状态机：backlog → doing → review → done/canceled，允许任意回退，转换全记 status_log。
 * doing/review 由系统自动流转（run 启动/完成），done/canceled/回退由人工。
 * chat 恒为 open —— 任何转换请求都拒绝。
 */

import type { Conversation, ConversationStatus } from "../protocol.js";
import { ISSUE_STATUSES } from "../protocol.js";
import type { HarborStore } from "./store.js";

export type Actor = "human" | "system" | "agent";

export function transitionConversation(
  store: HarborStore,
  conv: Conversation,
  to: ConversationStatus,
  actor: Actor,
  now: number,
): void {
  if (conv.kind === "chat") {
    throw new Error(`chat conversation 状态恒为 open，不接受转换（${conv.id}）`);
  }
  if (!ISSUE_STATUSES.includes(to)) {
    throw new Error(`非法 issue 状态 "${to}"（可选：${ISSUE_STATUSES.join("/")}）`);
  }
  if (conv.status === to) return; // 幂等：同状态不记日志
  store.setConversationStatus(conv.id, to, now);
  store.appendStatusLog(conv.id, conv.status, to, actor, now);
}
