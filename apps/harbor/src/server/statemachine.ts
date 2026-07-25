/**
 * Issue 状态机：backlog → todo → doing → review → done/canceled。
 * doing/review 由 implementation run 自动流转；裸状态 API 只允许人工分诊/验收/取消。
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
  if (conv.kind !== "issue") {
    throw new Error(`${conv.kind} conversation 状态恒为 open，不接受转换（${conv.id}）`);
  }
  if (!ISSUE_STATUSES.includes(to)) {
    throw new Error(`非法 issue 状态 "${to}"（可选：${ISSUE_STATUSES.join("/")}）`);
  }
  if (conv.status === to) return; // 幂等：同状态不记日志
  store.setConversationStatus(conv.id, to, now);
  store.appendStatusLog(conv.id, conv.status, to, actor, now);
}
