import type { Conversation } from "../protocol.js";
import type { HarborStore } from "./store.js";
import { transitionConversation } from "./statemachine.js";

export interface DeliveryCleanupSink {
  requestWorktreeCleanup(conversation: Conversation): void;
}

/** Delivery facts are already durable; startup and the live server use the same deterministic Issue finalizer. */
export function reconcileCompletedDeliveries(
  store: HarborStore,
  cleanup: DeliveryCleanupSink,
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
