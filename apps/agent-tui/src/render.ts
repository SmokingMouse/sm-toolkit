import type { Item } from "@smokingmouse/agent-server/protocol";
import type { RequestCard, TuiModel } from "./model.js";
import { object } from "./observations.js";

/** Strip terminal control sequences from untrusted engine/user text before drawing. */
export function plain(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
}
const json = (v: unknown) => v === undefined ? "" : JSON.stringify(v);
export function renderItem(item: Item, expanded = false): string[] {
  const state = item.status === "inProgress" ? " …" : item.status === "failed" || item.status === "rejected" ? ` [${item.status}]` : "";
  let body: string;
  switch (item.type) {
    case "userMessage": body = `You: ${item.payload.content.map(c => c.type === "text" ? c.text : c.type === "bash" ? c.command : `[${c.type}] ${c.path}`).join("\n")}`; break;
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
export function renderTimeline(model: TuiModel): string[] {
  const items = [...model.items.values()].sort((a, b) => a.seq - b.seq), seen = new Set<string>();
  const children = new Map<string, Item[]>();
  for (const item of items) if (item.type === "subAgent") children.set(item.payload.parentItemId, [...children.get(item.payload.parentItemId) ?? [], item]);
  const visit = (item: Item, depth: number): string[] => {
    if (seen.has(item.id)) return []; seen.add(item.id);
    const indent = "  ".repeat(Math.min(depth, 8));
    let lines: string[];
    if (item.type === "subAgent") {
      const p = item.payload, collapsed = model.collapsedAgents.has(item.id), progress = object(p.progress);
      lines = [`${collapsed ? "▸" : "▾"} SubAgent ${item.id} [${item.status}] ${p.phase} · parent ${p.parentItemId}`];
      if (!collapsed) lines.push(...[p.text ?? progress.text, model.expandedReasoning ? p.thinking ?? progress.thinking : undefined, p.report === undefined ? undefined : json(p.report)].filter(v => typeof v === "string" && v.length > 0).flatMap(v => plain(String(v)).split("\n")).map(line => `  ${line}`));
      if (collapsed) { const hide = (id: string) => { for (const child of children.get(id) ?? []) if (!seen.has(child.id)) { seen.add(child.id); hide(child.id); } }; hide(item.id); return lines.map(l => indent + plain(l)); }
    } else lines = renderItem(item, model.expandedReasoning);
    return [...lines.map(l => indent + plain(l)), ...(children.get(item.id) ?? []).flatMap(child => visit(child, depth + 1)), ""];
  };
  return [...items.filter(i => i.type !== "subAgent").flatMap(i => visit(i, 0)), ...items.flatMap(i => visit(i, 0))];
}

export function render(model: TuiModel, columns = 100, rows = 30, color = false): string {
  const width = Math.max(1, columns - 1), height = Math.max(4, rows);
  const thread = model.thread, usage = model.usage;
  const header = plain(`${thread?.backend ?? "agent"} ${thread?.status.type ?? "unknown"} | queue ${model.queue.length} | tokens ${usage ? `${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cachedTokens} cached` : "—"} | ${model.connection} | ${thread?.id ?? "connecting"}`);
  const body = renderTimeline(model);
  for (const q of model.queue) body.push(`排队 #${q.position + 1}: ${q.preview}`);
  for (const c of model.cards.values()) if (c !== model.activeCard) body.push(...renderCard(c));
  const content = body.flatMap(line => wrap(line, width));
  const card = model.activeCard ? renderCard(model.activeCard).flatMap(line => wrap(line, width)) : [];
  const footer = model.activeCard ? "审批/问题卡优先 · Ctrl-C 中断 · PgUp/PgDn 滚动卡片" : "Enter 发送 · Ctrl-L 日志 · /tasks · /agents · F6 焦点 · PgUp/PgDn 滚动 · Ctrl-C 两次退出";
  const panels: string[] = [];
  const budget = Math.max(0, height - 5);
  const logHeader = `系统日志 ${model.logs.length} 条${model.logsMayBeMissing ? " · 重连后可能缺失" : ""} · ${model.logExpanded ? "展开" : "折叠"} · Ctrl-L /log${model.panelFocus === "log" ? " [焦点]" : ""}`;
  if (budget > 0) panels.push(wrap(logHeader, width)[0]);
  const tail = (lines: string[], count: number, scroll: number) => { const end = Math.max(Math.min(lines.length, count), lines.length - scroll); return lines.slice(Math.max(0, end - count), end); };
  if (!model.activeCard && model.logExpanded) {
    const lines = model.logs.flatMap(entry => wrap(`${new Date(entry.time).toISOString().slice(11, 23)} ${entry.error ? "[!] " : ""}${entry.subtype}: ${entry.summary.replace(/\r?\n/g, " ↵ ")}`, width).map(line => color && entry.error ? `\x1b[31m${line}\x1b[0m` : line));
    panels.push(...tail(lines, Math.min(Math.floor(budget / 3), Math.max(0, budget - panels.length - (model.tasksVisible ? 1 : 0))), model.logScroll));
  }
  if (!model.activeCard && model.tasksVisible && panels.length < budget) {
    const tasks = [...model.tasks.values()];
    panels.push(wrap(`Tasks ${tasks.length} · /tasks${model.panelFocus === "tasks" ? " [焦点]" : ""}`, width)[0]);
    const lines = tasks.flatMap(t => wrap(`[${t.status}] #${t.id}${t.inferred ? "?" : ""} ${t.title}`, width));
    panels.push(...tail(lines.length ? lines : wrap("暂无已观测任务", width), Math.min(Math.floor(budget / 3), budget - panels.length), model.taskScroll));
  }
  const available = height - 4 - panels.length;
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
  return [wrap(header, width)[0], ...middle, ...panels, wrap(model.message, width)[0], wrap(footer, width)[0], inputTail].join("\n");
}
