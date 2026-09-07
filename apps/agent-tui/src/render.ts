import type { Item } from "@smokingmouse/agent-server/protocol";
import type { RequestCard, TuiModel } from "./model.js";

/** Strip terminal control sequences from untrusted engine/user text before drawing. */
export function plain(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
}
const json = (v: unknown) => v === undefined ? "" : JSON.stringify(v);
export function renderItem(item: Item, expanded = false): string[] {
  const state = item.status === "inProgress" ? " …" : item.status === "failed" || item.status === "rejected" ? ` [${item.status}]` : "";
  let body: string;
  switch (item.type) {
    case "userMessage": body = `You: ${item.payload.content.map(c => c.type === "text" ? c.text : `[${c.type}] ${c.path}`).join("\n")}`; break;
    case "agentMessage": body = `Agent${state}: ${item.payload.text}`; break;
    case "reasoning": body = expanded ? `Reasoning${state}: ${[item.payload.summary, item.payload.text].filter(Boolean).join("\n")}` : `Reasoning${state}: [折叠 · Tab 展开]`; break;
    case "commandExecution": body = `$ ${item.payload.command}${state}\n  cwd: ${item.payload.cwd}\n${plain(item.payload.aggregatedOutput ?? "").split("\n").slice(-6).join("\n")}${item.payload.exitCode != null ? `\n  exit: ${item.payload.exitCode}` : ""}`; break;
    case "fileChange": body = `Files${state}:\n${item.payload.changes.map(c => `  ${c.kind} ${c.path}`).join("\n")}`; break;
    case "toolCall": body = `Tool ${item.payload.namespace ? item.payload.namespace + "/" : ""}${item.payload.name}${state}${item.payload.isError ? " [error]" : ""}\n  ${json(item.payload.input)}\n  ${json(item.payload.output)}`; break;
    case "mcpToolCall": body = `MCP ${item.payload.server}/${item.payload.tool}${state}\n  ${json(item.payload.arguments)}\n  ${json(item.payload.error ?? item.payload.result)}`; break;
    case "subAgent": body = `SubAgent ${item.payload.kind}: ${item.payload.phase}${state}\n  ${json(item.payload.progress)}\n  ${json(item.payload.report)}`; break;
    case "error": body = `Error${item.payload.code ? ` (${item.payload.code})` : ""}: ${item.payload.message}`; break;
    case "webSearch": body = `Search: ${item.payload.query}\n${json(item.payload.results)}`; break;
    case "imageOutput": body = `Images: ${item.payload.paths.join(", ")}`; break;
    case "plan": body = `Plan: ${item.payload.text ?? ""}\n${item.payload.steps?.map(s => `  [${s.status}] ${s.step}`).join("\n") ?? ""}`; break;
    case "contextCompaction": body = "Context compacted"; break;
  }
  return plain(body).split("\n");
}

export function renderCard(card: RequestCard): string[] {
  const r = card.request;
  if (!["pending", "sending"].includes(card.state)) return [plain(`[${r.params.requestId}] ${card.note ?? (card.state === "offline" ? "连接中断，重连后恢复" : card.state)}`)];
  const lines = [`[${r.params.requestId}] Action Required${card.state === "sending" ? " · 等待服务器确认" : ""}`];
  switch (r.method) {
    case "item/commandExecution/requestApproval": lines.push(`Command: ${r.params.command}`, `cwd: ${r.params.cwd}`); break;
    case "item/fileChange/requestApproval": lines.push(...r.params.changes.map(c => `${c.kind} ${c.path}`), ...(r.params.grantRoot ? [`grantRoot: ${r.params.grantRoot}`] : [])); break;
    case "item/permissions/requestApproval": lines.push(`Permissions: ${json(r.params.permissions)}`, `cwd: ${r.params.cwd}`); break;
    case "item/tool/requestUserInput": {
      const q = r.params.questions[card.question];
      if (q) {
        lines.push(`问题 ${card.question + 1}/${r.params.questions.length}: ${q.header ?? ""} ${q.question}`);
        const selected = card.answers[q.id]?.answers ?? [];
        q.options?.forEach((o, i) => lines.push(`${i + 1}. [${selected.includes(o.label) ? "x" : " "}] ${o.label}${o.description ? ` — ${o.description}` : ""}`));
        lines.push(q.multiSelect ? "数字切换多选 · Enter 下一题/提交" : "数字选择 · Enter 下一题/提交");
        if ((q.options?.length ?? 0) > 9) lines.push("输入选项编号后按 Space 选择/切换");
        lines.push(`自由回答: ${card.draft}`);
      }
      lines.push("Enter to confirm · Esc to cancel");
      return lines.flatMap(line => plain(line).split("\n"));
    }
  }
  if ("reason" in r.params && r.params.reason) lines.push(`Reason: ${r.params.reason}`);
  lines.push("y 允许 · s 本会话允许 · n 拒绝 · a 中止", "Enter to confirm · Esc to cancel");
  return lines.flatMap(line => plain(line).split("\n"));
}

// Bun.stringWidth handles CJK/emoji terminal cell widths; leave the last column unused.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function wrap(line: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = []; let current = "", used = 0;
  for (const { segment } of segmenter.segment(plain(line))) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > width && current) { lines.push(current); current = ""; used = 0; }
    if (cells <= width) { current += segment; used += cells; }
  }
  lines.push(current); return lines;
}
export function render(model: TuiModel, columns = 100, rows = 30): string {
  const width = Math.max(1, columns - 1), height = Math.max(4, rows);
  const thread = model.thread, usage = model.usage;
  const header = plain(`${thread?.backend ?? "agent"} ${thread?.status.type ?? "unknown"} | queue ${model.queue.length} | tokens ${usage ? `${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cachedTokens} cached` : "—"} | ${model.connection} | ${thread?.id ?? "connecting"}`);
  const body = [...model.items.values()].sort((a, b) => a.seq - b.seq).flatMap(i => [...renderItem(i, model.expandedReasoning), ""]);
  for (const q of model.queue) body.push(`排队 #${q.position + 1}: ${q.preview}`);
  for (const c of model.cards.values()) if (c !== model.activeCard) body.push(...renderCard(c));
  const content = body.flatMap(line => wrap(line, width));
  const card = model.activeCard ? renderCard(model.activeCard).flatMap(line => wrap(line, width)) : [];
  const footer = model.activeCard ? "审批/问题卡优先 · Ctrl-C 中断 · PgUp/PgDn 滚动卡片" : "Enter 发送/排队 · /steer 插话 · Tab 推理 · PgUp/PgDn 历史 · Ctrl-C 两次退出";
  const available = height - 4;
  let middle: string[];
  if (card.length) {
    const cardRows = Math.min(card.length, available);
    const offset = Math.min(model.scroll, Math.max(0, card.length - cardRows));
    middle = [...content.slice(-Math.max(0, available - cardRows)).slice(0, available - cardRows), ...card.slice(offset, offset + cardRows)];
  } else {
    const end = Math.max(Math.min(content.length, available), content.length - model.scroll);
    middle = content.slice(Math.max(0, end - available), end);
  }
  while (middle.length < available) middle.push("");
  const input = model.activeCard ? model.activeCard.draft : model.input;
  const inputTail = wrap(`> ${input}`, width).at(-1) ?? "> ";
  return [wrap(header, width)[0], ...middle, wrap(model.message, width)[0], wrap(footer, width)[0], inputTail].join("\n");
}
