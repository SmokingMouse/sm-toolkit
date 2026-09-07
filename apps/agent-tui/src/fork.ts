import type { Item } from "@smokingmouse/agent-server/protocol";
import { plain, renderItem } from "./render.js";

export interface ForkEntry { itemId?: string; seq?: number; type: string; summary: string }
export function itemSummary(item: Item, limit = 80): string {
  const text = plain(renderItem(item, true, true).join(" ")).replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, Math.max(0, limit - 1)).join("") + "…" : text;
}
export function forkEntries(items: Iterable<Item>): ForkEntry[] {
  return [...items].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map(item => ({ itemId: item.id, seq: item.seq, type: item.type, summary: itemSummary(item) }));
}
