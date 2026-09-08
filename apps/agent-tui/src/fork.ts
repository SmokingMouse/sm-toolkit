import type { Item } from "@smokingmouse/agent-server/protocol";
import { plain, renderItem } from "./render.js";

export interface ForkEntry { itemId?: string; seq?: number; type: string; summary: string }
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function itemSummary(item: Item, limit = 80): string {
  const text = plain(renderItem(item, true, true).join(" ")).replace(/\s+/g, " ").trim();
  if (limit <= 0) return "";
  if (Bun.stringWidth(text) <= limit) return text;
  let summary = "", used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > limit - 1) break;
    summary += segment; used += cells;
  }
  return summary + "…";
}
export function forkEntries(items: Iterable<Item>): ForkEntry[] {
  return [...items].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map(item => ({ itemId: item.id, seq: item.seq, type: item.type, summary: itemSummary(item) }));
}
