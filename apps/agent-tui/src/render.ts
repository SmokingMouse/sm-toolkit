import type { Item } from "@smokingmouse/agent-server/protocol";
import { canResume, type RequestCard, type TuiModel } from "./model.js";
import { shortId } from "./sessions.js";
import { contextUsage, nativePermission, permissionModes } from "./modes.js";
import { object } from "./observations.js";

/** Strip terminal control sequences from untrusted engine/user text before drawing. */
export function plain(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
}
const json = (v: unknown) => v === undefined ? "" : JSON.stringify(v);
export function renderItem(item: Item, expanded = false, expandedPlan = true): string[] {
  const state = item.status === "inProgress" ? " …" : item.status === "failed" || item.status === "rejected" ? ` [${item.status}]` : "";
  let body: string;
  switch (item.type) {
    case "userMessage": body = `You: ${item.payload.content.map(c => c.type === "text" ? c.text : c.type === "bash" ? c.command : `[${c.type}] ${c.path}`).join("\n")}`; break;
    case "agentMessage": body = `Agent${state}: ${item.payload.text}`; break;
    case "reasoning": body = expanded ? `Reasoning${state}: ${[item.payload.summary, item.payload.text].filter(Boolean).join("\n")}` : `Reasoning${state}: [折叠 · Ctrl-R 展开]`; break;
    case "commandExecution": body = `$ ${item.payload.command}${state}\n  cwd: ${item.payload.cwd}\n${plain(item.payload.aggregatedOutput ?? "").split("\n").slice(-6).join("\n")}${item.payload.exitCode != null ? `\n  exit: ${item.payload.exitCode}` : ""}`; break;
    case "fileChange": body = `Files${state}:\n${item.payload.changes.map(c => `  ${c.kind} ${c.path}`).join("\n")}`; break;
    case "toolCall": body = `Tool ${item.payload.namespace ? item.payload.namespace + "/" : ""}${item.payload.name}${state}${item.payload.isError ? " [error]" : ""}\n  ${json(item.payload.input)}\n  ${json(item.payload.output)}`; break;
    case "mcpToolCall": body = `MCP ${item.payload.server}/${item.payload.tool}${state}\n  ${json(item.payload.arguments)}\n  ${json(item.payload.error ?? item.payload.result)}`; break;
    case "subAgent": body = `SubAgent ${item.payload.kind}: ${item.payload.phase}${state}\n  ${json(item.payload.progress)}\n  ${json(item.payload.report)}`; break;
    case "error": body = `Error${item.payload.code ? ` (${item.payload.code})` : ""}: ${item.payload.message}`; break;
    case "webSearch": body = `Search: ${item.payload.query}\n${json(item.payload.results)}`; break;
    case "imageOutput": body = `Images: ${item.payload.paths.join(", ")}`; break;
    case "plan": body = expandedPlan ? `Plan: ${item.payload.text ?? ""}\n${item.payload.steps?.map(s => `  [${s.status}] ${s.step}`).join("\n") ?? ""}` : `Plan: [折叠 · ${item.payload.steps?.length ?? 0} steps · Ctrl-P 展开]`; break;
    case "contextCompaction": body = "── Context compacted · compact_boundary ──"; break;
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
    case "item/permissions/requestApproval":
      if (r.params.permissions.toolName === "ExitPlanMode") lines.push("退出 Plan mode 审批 · 同意后切换 default");
      lines.push(`Permissions: ${json(r.params.permissions)}`, `cwd: ${r.params.cwd}`); break;
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
  return plain(line).split("\n").flatMap(part => wrapLine(part, width));
}
function wrapLine(line: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = []; let current = "", used = 0;
  for (const { segment } of segmenter.segment(line)) {
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
    } else lines = renderItem(item, model.expandedReasoning, model.expandedPlan);
    return [...lines.map(l => indent + plain(l)), ...(children.get(item.id) ?? []).flatMap(child => visit(child, depth + 1)), ""];
  };
  const ids = new Set(items.map(i => i.id));
  return [...items.filter(i => i.type !== "subAgent" || !ids.has(i.payload.parentItemId)).flatMap(i => visit(i, 0)), ...items.flatMap(i => visit(i, 0))];
}

function frameLayout(model: TuiModel, columns: number, rows: number) {
  const width = Math.max(1, columns - 1), height = Math.max(4, rows);
  const thread = model.thread, usage = model.usage;
  const status = `${thread ? shortId(thread.id) : "connecting"} | cwd ${thread?.cwd ?? "—"} | model ${thread?.model ?? "unknown"}`;
  const header = plain(`${thread?.backend ?? "agent"} ${thread?.status.type ?? "unknown"}${canResume(thread) ? "（可恢复 · /resume）" : ""} | 待处理 ${model.pendingCount}${model.connection !== "connected" ? "（离线待确认）" : ""} | 租约:${model.leaseLabel} | queue ${model.queue.length} | tokens ${usage ? `${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cachedTokens} cached` : "—"} | ${model.connection}`);
  const context = contextUsage(usage?.contextTokens, model.contextWindow);
  const modeStatus = wrap(`mode ${nativePermission(thread?.permission)} | effort ${model.effort ? `${model.effort}（本端设置）` : "—"} | model ${thread?.model ?? "—"} | ctx [${context.bar}] ${context.percent ?? "?"}% / ${model.contextWindowEstimated ? "~" : ""}${model.contextWindow}${model.launchPermission === undefined ? " | bypass 上限未知，已隐藏" : ""}`, width).slice(0, height - 4);
  if (model.leaseExpiresAt > Date.now()) modeStatus.splice(0, modeStatus.length, ...wrap(`${modeStatus.join("")} | 持有控制权至 ${new Date(model.leaseExpiresAt).toLocaleTimeString()} · /release`, width).slice(0, height - 4));
  const notices = model.discardNote ? [wrap(model.discardNote, width)[0]] : [];
  const headers = [...wrap(status, width), ...wrap(header, width), ...modeStatus.map(line => context.warning ? `\x1b[33m${line}\x1b[0m` : line)].slice(0, Math.max(1, height - 4 - notices.length));
  const baseAvailable = Math.max(0, height - headers.length - 3 - notices.length);
  const input = model.activeCard?.state === "pending" && !model.activeCard.replying && model.activeCard.request.method === "item/tool/requestUserInput" ? model.activeCard.draft : model.input;
  const inputLines = input.split("\n").flatMap((line, i) => wrap(`${i ? "  " : "> "}${line}`, width));
  const inputRows = inputLines.slice(-Math.max(1, Math.min(6, height - 4)));
  const completion = !model.activeCard && model.permissionPicker === undefined && !model.picker && !model.forkPicker && !model.sessionOperation && model.completion;
  const menu = completion ? completion.candidates.slice(Math.max(0, completion.selected - 3), Math.max(0, completion.selected - 3) + 6)
    .map(c => wrap(`${c === completion.candidates[completion.selected] ? "❯" : " "} ${completion.prefix}${c.name} — ${c.description}`, width)[0]) : [];
  const attached = !model.activeCard ? model.attachments.map(i => wrap(`[image] ${i.path}`, width)[0]) : [];
  const extraRows = Math.max(0, baseAvailable - inputRows.length + 1);
  const extras = extraRows ? [...attached, ...menu].slice(-extraRows) : [];
  return { width, height, headers, notices, inputRows, extras, available: Math.max(0, baseAvailable + 1 - inputRows.length - extras.length) };
}
function pickerLines(model: TuiModel, width: number): string[][] {
  if (model.forkPicker) return model.forkPicker.entries.map((e, i) => wrap(`${i === model.forkPicker!.index ? ">" : " "} ${e.seq === undefined ? "" : `#${e.seq} ${shortId(e.itemId!)} | `}${e.type} | ${e.summary}`, width));
  return model.picker?.entries.map((e, i) => wrap(`${i === model.picker!.index ? ">" : " "} ${shortId(e.thread.id)} | ${e.title} | ${e.thread.status.type}${e.thread.forkedFrom ? ` | forkedFrom ${shortId(e.thread.forkedFrom.threadId)} / ${e.thread.forkedFrom.itemId ? shortId(e.thread.forkedFrom.itemId) : "空起点"}` : ""} | ${e.thread.cwd} | ${new Date(e.updatedAtMs).toISOString()}`, width)) ?? [];
}
/** Pure measurement, applied by the controller on input/model/terminal-size changes. */
export function pickerOffset(model: TuiModel, columns: number, rows: number): number {
  const { width, available } = frameLayout(model, columns, rows), lines = pickerLines(model, width);
  const index = (model.forkPicker ?? model.picker)?.index ?? 0;
  const top = lines.slice(0, index).reduce((n, l) => n + l.length, 0);
  const bottom = top + (lines[index]?.length ?? 0), total = lines.reduce((n, l) => n + l.length, 0);
  let offset = (model.forkPicker ?? model.picker)?.offset ?? 0;
  if (top < offset) offset = top;
  else if (bottom > offset + available) offset = Math.min(top, bottom - available);
  return Math.max(0, Math.min(offset, total - available));
}
export function render(model: TuiModel, columns = 100, rows = 30, color = false): string {
  const { width, height, headers, notices, inputRows, extras, available: frameAvailable } = frameLayout(model, columns, rows);
  const body = renderTimeline(model);
  for (const q of model.queue) body.push(`排队 #${q.position + 1}: ${q.preview}`);
  for (const c of model.cards.values()) if (c !== model.activeCard) body.push(...renderCard(c));
  const content = body.flatMap(line => wrap(line, width));
  const picker = model.permissionPicker === undefined ? [] : ["权限模式 · ↑↓/数字选择 · Enter 确认 · Esc 取消", ...model.permissionChoices.map((p, i) => `${i === model.permissionPicker ? ">" : " "} ${i + 1}. ${p}${p === nativePermission(model.thread?.permission) ? " (当前)" : ""}`)];
  const card = (model.activeCard ? renderCard(model.activeCard) : picker).flatMap(line => wrap(line, width));
  const scanCard = model.sessionOperation === "/threads" && !!model.activeCard;
const footer = scanCard ? "/threads 加载中 · 审批/问题卡可操作 · Ctrl-C 中断" : model.sessionOperation ? `${model.sessionOperation} 进行中 · 按键将丢弃 · Esc 不取消在途操作` : model.resumeConfirmation ? "恢复已关闭会话？[y/N] · Enter/n/Esc 取消" : model.picker ? "会话选择 · ↑/↓ 选择 · Enter 切换 · Esc 取消" : model.activeCard && (model.activeCard.replying || model.activeCard.state === "sending") ? "审批确认中 · 按键暂不受理 · Ctrl-C 中断" : model.activeCard ? "审批/问题卡优先 · Ctrl-C 中断 · PgUp/PgDn 滚动卡片" : model.permissionPicker !== undefined ? "权限模式 · ↑↓/数字选择 · Enter 确认 · Esc 取消" : model.completion && !model.picker ? "↑↓ 选择 · Tab/Enter 插入 · Esc 关闭补全" : "Ctrl-N 新建 · Ctrl-T 会话 · Enter 发送 · Tab effort · Shift-Tab 权限 · Ctrl-R 推理 · Ctrl-C 两次退出";
  const panels: string[] = [];
  const budget = model.picker || model.forkPicker || model.permissionPicker !== undefined || model.sessionOperation ? 0 : Math.max(0, frameAvailable - 1);
  const logHeader = `系统日志 ${model.logs.length} 条${model.logs.dropped ? ` · 已丢弃 ${model.logs.dropped} 条` : ""}${model.logsMayBeMissing ? " · 重连后可能缺失" : model.logsStartAtAttach ? " · 仅显示接入后事件" : ""} · ${model.logExpanded ? "展开" : "折叠"} · Ctrl-L /log${model.panelFocus === "log" ? " [焦点]" : ""}`;
  if (budget > 0) panels.push(wrap(logHeader, width)[0]);
  const tail = (lines: string[], count: number, scroll: number) => { const end = Math.max(Math.min(lines.length, count), lines.length - scroll); return lines.slice(Math.max(0, end - count), end); };
  if (!model.activeCard && model.logExpanded) {
    const count = Math.min(Math.floor(budget / 3), Math.max(0, budget - panels.length - (model.tasksVisible ? 1 : 0)));
    let lines: string[] = [];
    // Scroll by events, lay out only the entries needed to fill this viewport.
    const end = model.logWindowEnd(count);
    let index = end - 1;
    for (; index >= 0 && lines.length < count && !model.logViewportLost; index--) {
      const entry = model.logs.at(index)!;
      const entryLines = wrap(`${new Date(entry.time).toISOString().slice(11, 23)} ${entry.error ? "[!] " : ""}${entry.subtype}: ${entry.summary.replace(/\r?\n/g, " ↵ ")}`, width);
      lines = [...entryLines.map(line => color && entry.error ? `\x1b[31m${line}\x1b[0m` : line), ...lines];
    }
    if (model.logViewportLost) panels.push(...wrap("已滚出保留窗口 · PgUp/PgDn 重新定位", width).slice(0, count));
    else {
      if (count > 0) model.rememberLogWindowStart(index + 1);
      panels.push(...lines.slice(Math.max(0, lines.length - count)));
    }
  }
  if (!model.activeCard && model.tasksVisible && panels.length < budget) {
    const tasks = [...model.tasks.values()];
    panels.push(wrap(`Tasks ${tasks.length} · /tasks${model.panelFocus === "tasks" ? " [焦点]" : ""}`, width)[0]);
    const lines = tasks.flatMap(t => wrap(`[${t.status}] #${t.id}${t.inferred ? "?" : ""} ${t.title}`, width));
    panels.push(...tail(lines.length ? lines : wrap("暂无已观测任务", width), Math.min(Math.floor(budget / 3), budget - panels.length), model.taskScroll));
  }
  const available = frameAvailable - panels.length;
  let middle: string[];
  if ((model.picker || model.forkPicker) && !scanCard && !(model.forkPicker && model.activeCard)) {
    const { entries, offset = 0 } = (model.forkPicker ?? model.picker)!;
    middle = entries.length ? pickerLines(model, width).flat().slice(offset, offset + available) : ["（daemon 中没有会话）"].slice(0, available);
  } else if (card.length) {
    const cardRows = Math.min(card.length, available);
    const offset = Math.min(model.scroll, Math.max(0, card.length - cardRows));
    middle = [...content.slice(-Math.max(0, available - cardRows)).slice(0, available - cardRows), ...card.slice(offset, offset + cardRows)];
  } else {
    const end = Math.max(Math.min(content.length, available), content.length - model.scroll);
    middle = content.slice(Math.max(0, end - available), end);
  }
  while (middle.length < available) middle.push("");
  const status = [model.message, model.leaseWarning].filter(Boolean).join(" · ");
  const forkFooter = model.forkPicker && !model.sessionOperation && !model.activeCard ? "分叉 item 选择 · ↑/↓ 选择 · Enter 分叉 · Esc 取消" : footer;
  return [...headers, ...middle, ...panels, ...extras, wrap(status, width)[0], ...notices, wrap(forkFooter, width)[0], ...inputRows].slice(-height).join("\n");
}
