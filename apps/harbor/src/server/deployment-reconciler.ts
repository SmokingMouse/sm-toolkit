import type { Conversation } from "../protocol.js";
import type { HarborStore } from "./store.js";
import { transitionConversation } from "./statemachine.js";

export interface DeploymentCleanupSink {
  requestWorktreeCleanup(conversation: Conversation): void;
}

/** worker result 已先持久化；server 当前在线或重启后都用同一确定性收尾。 */
export function reconcileCompletedDeployments(
  store: HarborStore,
  cleanup: DeploymentCleanupSink,
  now = Date.now(),
): string[] {
  const finalized: string[] = [];
  for (const delivery of store.listDeliveriesReadyToFinalize()) {
    const conv = store.getConversation(delivery.conversationId);
    if (!conv || conv.status !== "review") continue;
    transitionConversation(store, conv, "done", "system", now);
    cleanup.requestWorktreeCleanup(store.getConversation(conv.id)!);
    finalized.push(delivery.id);
  }
  return finalized;
}
