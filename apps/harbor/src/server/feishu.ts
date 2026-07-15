/**
 * FeishuEntry —— 飞书入口（P2）。Channel 薄（I/O + 卡片渲染在 @sm/channel-feishu）、
 * 这里厚（命令路由 / 话题↔Conversation 映射 / 审批卡片 / 结果回报 / send-gate ACL）。
 *
 * send-gate 三场景准入（harbor.md §7，全局 rules 双保险）：
 *   ① 回复被 @ 的消息（requireMention，且 admin ACL）
 *   ② 自己发起的卡片回调（审批卡）与 admin DM（告警/审批，收件人=用户本人）
 *   ③ automation 播报仅白名单群（默认空清单）
 * 除此之外不发一条消息。
 *
 * 话题映射：origin_ref = `${chatId}|${anchor}`。
 *   群聊：话题/回复消息 anchor=threadId（续同一 issue）；新消息 anchor=消息自身 id（开新 issue，
 *         后续 thread 回复的 rootId 即它）。
 *   DM：anchor=chatId（滚动会话，agent 前缀=开新会话、裸文本=续最新）。
 */

import type { Channel, Content, IncomingAction, IncomingMessage } from "@sm/agent";
import type { Approval, Conversation, HarborAgent, Run } from "../protocol.js";
import type { FeishuConfig } from "../config.js";
import type { HarborStore } from "./store.js";
import type { RunCoordinator } from "./scheduler.js";
import type { ApprovalService, ApprovalSink } from "./approvals.js";
import { transitionConversation } from "./statemachine.js";

/** FeishuChannel 的能力面（Channel + 群发送）。抽接口是为了 e2e 可用 mock 替身 */
export interface FeishuPort extends Channel {
  sendToChat(chatId: string, content: Content): Promise<string | null>;
}

const HELP = [
  { command: "<agent名> <指令>", description: "派新 issue 给该 agent（本条消息即话题锚点）" },
  { command: "（话题内回复）<指令>", description: "续该 issue 多轮（resume 上下文）" },
  { command: "/chat <agent名> <指令>", description: "临时对话（不留 issue）" },
  { command: "/bind <agent名>", description: "绑定本群默认 agent（此后裸指令直接派活）" },
  { command: "/status", description: "（话题内）看 issue 状态与 run 流水" },
  { command: "/done · /cancel", description: "（话题内）人工验收 / 取消 issue" },
  { command: "/agents", description: "列出可用 agent" },
  { command: "/help", description: "本帮助" },
];

export class FeishuEntry implements ApprovalSink {
  /** run → 派活确认卡（run 完成时原地更新为结果；重启丢失则退化为新回复） */
  private ackCards = new Map<string, string>();
  /** conversation → 最近一条来件消息 id（回复锚点；重启丢失则退化为 sendToChat） */
  private replyAnchors = new Map<string, string>();

  constructor(
    private store: HarborStore,
    private coordinator: RunCoordinator,
    private approvals: ApprovalService,
    private config: FeishuConfig,
    private channel: FeishuPort,
  ) {}

  async start(): Promise<void> {
    this.channel.onMessage((msg) => this.handleMessage(msg));
    this.channel.onAction((action) => this.handleAction(action));
    await this.channel.connect();
    console.log(
      `[feishu] 入口已启动（admin=${this.config.adminUserId || "(开放，不建议)"} 白名单群=${this.config.allowedChats.length}）`,
    );
  }

  // ── 消息路由 ──────────────────────────────────────────

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const text = msg.text.trim();
    if (!text) return;

    // ACL：仅 admin 可指挥（场景①的回复也只对 admin 发）
    if (this.config.adminUserId && msg.senderId !== this.config.adminUserId) {
      await this.channel.reply(msg.id, { type: "error", message: "仅管理员可使用 Harbor bot。" });
      return;
    }

    const conv = this.resolveConversation(msg);
    if (conv) this.replyAnchors.set(conv.id, msg.id);

    try {
      if (text.startsWith("/")) {
        await this.handleCommand(msg, conv, text);
        return;
      }
      // 已映射话题 → 续多轮
      if (conv) {
        await this.dispatchRun(msg, conv, text);
        return;
      }
      // 未映射 → `<agent> <prompt>` 或绑定的默认 agent
      const parsed = this.parseAgentPrefix(text) ?? this.boundAgent(msg.chatId, text);
      if (!parsed) {
        await this.channel.reply(msg.id, {
          type: "error",
          message: "未识别 agent。用 `<agent名> <指令>` 派活，`/agents` 看可用列表，或 `/bind <agent名>` 绑定本群默认。",
        });
        return;
      }
      await this.createAndDispatch(msg, parsed.agent, parsed.prompt, "issue");
    } catch (e) {
      await this.channel.reply(msg.id, {
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async handleCommand(msg: IncomingMessage, conv: Conversation | null, text: string): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    const restText = rest.join(" ");

    switch ((cmd ?? "").toLowerCase()) {
      case "/help":
      case "/帮助":
        await this.channel.reply(msg.id, { type: "help", commands: HELP });
        return;

      case "/agents": {
        const agents = this.store.listAgents();
        const devices = new Map(this.store.listDevices(new Set()).map((d) => [d.id, d.name]));
        const lines = agents.length
          ? agents.map(
              (a) =>
                `**${a.name}** @ ${devices.get(a.deviceId) ?? a.deviceId} · ${a.backend}/${a.model ?? "默认"} · ${a.permission}${a.isolation === "worktree" ? " · worktree" : ""}`,
            )
          : ["（还没有 agent，先在 CLI 上 `harbor agent create`）"];
        await this.channel.reply(msg.id, { type: "result", text: lines.join("\n") });
        return;
      }

      case "/bind": {
        const agent = this.store.getAgentByName(restText);
        if (!agent) throw new Error(`agent "${restText}" 不存在（/agents 查看）`);
        this.store.setChatBinding(msg.chatId, agent.id, Date.now());
        await this.channel.reply(msg.id, {
          type: "result",
          text: `✓ 本群默认 agent 已绑定为 **${agent.name}**，裸指令将直接派给它。`,
        });
        return;
      }

      case "/chat":
      case "/issue": {
        const kind = cmd!.toLowerCase() === "/chat" ? ("chat" as const) : ("issue" as const);
        const parsed = this.parseAgentPrefix(restText) ?? this.boundAgent(msg.chatId, restText);
        if (!parsed) throw new Error("用法：`" + cmd + " <agent名> <指令>`（或先 /bind 绑定默认 agent）");
        await this.createAndDispatch(msg, parsed.agent, parsed.prompt, kind);
        return;
      }

      case "/status": {
        if (!conv) throw new Error("本话题未关联 conversation（在派过活的话题里用 /status）");
        const runs = this.store.listRunsByConversation(conv.id);
        const agent = this.store.getAgent(conv.agentId);
        const lines = [
          `**${conv.title ?? "(无标题)"}**`,
          `\`${conv.id}\` · ${conv.kind} · **${conv.status}** · agent=${agent?.name ?? "?"}`,
          ...runs.slice(-5).map((r) => {
            const cost = r.cost?.usd != null ? ` · $${r.cost.usd.toFixed(4)}` : "";
            return `· \`${r.id}\` ${r.status}${cost}${r.error ? ` — ${r.error.slice(0, 80)}` : ""}`;
          }),
        ];
        await this.channel.reply(msg.id, { type: "result", text: lines.join("\n") });
        return;
      }

      case "/done":
      case "/cancel": {
        if (!conv) throw new Error("本话题未关联 conversation");
        if (conv.kind !== "issue") throw new Error("chat 会话没有状态可转换");
        const to = cmd!.toLowerCase() === "/done" ? ("done" as const) : ("canceled" as const);
        if (to === "canceled") {
          const active = this.store.activeRunForConversation(conv.id);
          if (active) this.coordinator.cancelRun(active.id);
        }
        transitionConversation(this.store, conv, to, "human", Date.now());
        const fresh = this.store.getConversation(conv.id)!;
        this.coordinator.requestWorktreeCleanup(fresh);
        await this.channel.reply(msg.id, { type: "result", text: `✓ issue ${conv.id} → **${to}**` });
        return;
      }

      default:
        await this.channel.reply(msg.id, { type: "help", commands: HELP });
    }
  }

  private async createAndDispatch(
    msg: IncomingMessage,
    agent: HarborAgent,
    prompt: string,
    kind: "chat" | "issue",
  ): Promise<void> {
    if (!prompt.trim()) throw new Error("指令为空");
    // 群聊新消息锚定消息自身（后续话题回复 rootId=它）；DM 锚定 chatId（滚动会话）
    const anchor = this.anchorOf(msg, true);
    const conv = this.store.createConversation(
      {
        kind,
        title: kind === "issue" ? prompt.slice(0, 60) : null,
        agentId: agent.id,
        origin: "feishu",
        originRef: `${msg.chatId}|${anchor}`,
      },
      Date.now(),
    );
    this.replyAnchors.set(conv.id, msg.id);
    await this.dispatchRun(msg, conv, prompt);
  }

  private async dispatchRun(msg: IncomingMessage, conv: Conversation, prompt: string): Promise<void> {
    const agent = this.store.getAgent(conv.agentId);
    if (!agent) throw new Error("conversation 绑定的 agent 已不存在");
    const run = this.coordinator.enqueueRun(conv, agent, prompt);
    const ackId = await this.channel.reply(msg.id, {
      type: "result",
      text: `⏳ 已派给 **${agent.name}**（run \`${run.id}\`${conv.kind === "issue" ? ` · issue \`${conv.id}\`` : ""}）`,
      metadata: run.status === "queued" ? "排队中（设备离线或并发已满也不丢）" : undefined,
    });
    if (ackId) this.ackCards.set(run.id, ackId);
  }

  // ── run 完成回报（coordinator hook） ──────────────────

  notifyRunDone(run: Run, conv: Conversation | null): void {
    void this.notifyRunDoneAsync(run, conv).catch((e) =>
      console.error("[feishu] 结果回报失败：", e instanceof Error ? e.message : e),
    );
  }

  private async notifyRunDoneAsync(run: Run, conv: Conversation | null): Promise<void> {
    if (!conv) return;
    const content = this.runDoneContent(run, conv);

    if (conv.origin === "feishu") {
      const ackId = this.ackCards.get(run.id);
      this.ackCards.delete(run.id);
      if (ackId) {
        await this.channel.update(ackId, content);
      } else {
        await this.replyToConversation(conv, content);
      }
      return;
    }

    // automation 播报：仅白名单群（send-gate 场景③）
    if (conv.origin === "automation" && conv.originRef) {
      const auto = this.store.getAutomation(conv.originRef);
      if (auto?.notifyChatId) {
        if (this.config.allowedChats.includes(auto.notifyChatId)) {
          await this.channel.sendToChat(auto.notifyChatId, content);
        } else {
          console.warn(
            `[feishu] automation "${auto.name}" 的播报群 ${auto.notifyChatId} 不在白名单，已拦（allowed_chats 配置）`,
          );
        }
      }
    }

    // 无静默失败：非飞书入口的 failed run → admin DM 告警（P5 终验第 4 条）
    // （feishu 入口已在上面 return，走到这里的都是 cli/web/automation 来源）
    if (run.status === "failed" && this.config.adminUserId) {
      await this.channel.send(this.config.adminUserId, {
        type: "error",
        message: `run \`${run.id}\` 失败（${conv.kind} \`${conv.id}\`，来源 ${conv.origin}）\n${run.error ?? "（无 error 信息）"}\n\n▶︎ \`harbor issue continue ${conv.id} "<指令>"\` 可基于上一轮上下文重试`,
      });
    }
  }

  private runDoneContent(run: Run, conv: Conversation): Content {
    if (run.status === "succeeded") {
      const text = this.store.getRunResultText(run.id) ?? "（完成，无文本输出）";
      const parts: string[] = [];
      if (run.startedAt && run.finishedAt) parts.push(`${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`);
      if (run.cost?.usd != null) parts.push(`$${run.cost.usd.toFixed(4)}`);
      if (conv.kind === "issue") parts.push(`issue → ${this.store.getConversation(conv.id)?.status ?? "?"}`);
      parts.push(`run ${run.id}`);
      return { type: "result", text, metadata: parts.join(" · ") };
    }
    if (run.status === "canceled") {
      return { type: "result", text: `⊘ run \`${run.id}\` 已取消`, metadata: conv.kind === "issue" ? `issue → ${this.store.getConversation(conv.id)?.status}` : undefined };
    }
    return {
      type: "error",
      message: `run \`${run.id}\` 失败：${run.error ?? "（无 error 信息）"}${conv.kind === "issue" ? `\n\nissue 已回 backlog，话题里直接回复新指令可基于上一轮上下文续跑。` : ""}`,
    };
  }

  // ── 审批卡片（ApprovalSink） ──────────────────────────

  onApprovalCreated(approval: Approval, _run: Run, conv: Conversation | null): void {
    void this.sendApprovalCard(approval, conv).catch((e) =>
      console.error("[feishu] 审批卡片发送失败：", e instanceof Error ? e.message : e),
    );
  }

  private async sendApprovalCard(approval: Approval, conv: Conversation | null): Promise<void> {
    const content = this.approvalContent(approval, conv);
    let messageId: string | null = null;
    if (conv?.origin === "feishu") {
      messageId = await this.replyToConversation(conv, content);
    } else if (this.config.adminUserId) {
      // CLI/automation 发起的审批：DM 用户本人（场景②），手机上也能批
      messageId = await this.channel.send(this.config.adminUserId, content);
    }
    if (messageId) {
      this.store.setApprovalFeishuMessageId(approval.id, messageId);
      // 竞态补渲染：卡片发送期间已被 CLI 决议 → onApprovalDecided 当时拿不到
      // messageId，没法改卡；这里发现已非 pending 就立即补一次决议态。
      const fresh = this.store.getApproval(approval.id);
      if (fresh && fresh.status !== "pending") {
        await this.channel.update(messageId, this.approvalContent(fresh, conv));
      }
    }
  }

  onApprovalDecided(approval: Approval): void {
    const messageId = this.store.getApprovalFeishuMessageId(approval.id);
    if (!messageId) return;
    const conv = this.convOfRun(approval.runId);
    void this.channel
      .update(messageId, this.approvalContent(approval, conv))
      .catch((e) => console.error("[feishu] 审批卡片更新失败：", e instanceof Error ? e.message : e));
  }

  private approvalContent(approval: Approval, conv: Conversation | null): Content {
    const agent = conv ? this.store.getAgent(conv.agentId) : null;
    const inputPreview = JSON.stringify(approval.input ?? {}, null, 2).slice(0, 800);
    const decidedNote =
      approval.status === "allowed" || approval.status === "denied"
        ? `by ${approval.decidedBy ?? "?"}`
        : approval.status === "expired"
          ? `超 30min 未批`
          : undefined;
    return {
      type: "tool_approval",
      agentName: agent?.name ?? conv?.agentId ?? "?",
      toolName: approval.toolName,
      inputPreview,
      status: approval.status,
      note: decidedNote,
      actions:
        approval.status === "pending"
          ? [
              {
                label: "批准",
                style: "primary",
                value: JSON.stringify({ cmd: "harbor_tool_approval", id: approval.id, behavior: "allow" }),
              },
              {
                label: "拒绝",
                style: "danger",
                value: JSON.stringify({ cmd: "harbor_tool_approval", id: approval.id, behavior: "deny" }),
              },
            ]
          : [],
    };
  }

  // ── 卡片按钮回调 ──────────────────────────────────────

  async handleAction(action: IncomingAction): Promise<void> {
    let value: { cmd?: string; id?: string; behavior?: string };
    try {
      const parsed = JSON.parse(action.value) as unknown;
      value = (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as typeof value;
    } catch {
      return;
    }
    if (value.cmd !== "harbor_tool_approval" || !value.id) return;
    if (this.config.adminUserId && action.operatorId !== this.config.adminUserId) {
      console.warn(`[feishu] 非 admin 点击审批卡片被拒：${action.operatorId}`);
      return;
    }
    // decide 幂等（重复点击/CLI 竞态返回既有决议），卡片更新走 onApprovalDecided sink
    this.approvals.decide(value.id, value.behavior === "allow" ? "allow" : "deny", "feishu");
  }

  // ── 内部 ──────────────────────────────────────────────

  /** threadId 与 chatId 相同 = 非话题新消息（channel 的 fallback 链所致） */
  private anchorOf(msg: IncomingMessage, forCreate: boolean): string {
    if (msg.chatType === "dm") return msg.chatId;
    const threaded = msg.threadId !== msg.chatId;
    if (threaded) return msg.threadId;
    return forCreate ? msg.id : msg.threadId;
  }

  private resolveConversation(msg: IncomingMessage): Conversation | null {
    const anchor = this.anchorOf(msg, false);
    const conv = this.store.getConversationByOrigin("feishu", `${msg.chatId}|${anchor}`);
    if (conv) return conv;
    // DM 话题内回复 → 回退滚动会话锚
    if (msg.chatType === "dm" && anchor !== msg.chatId) {
      return this.store.getConversationByOrigin("feishu", `${msg.chatId}|${msg.chatId}`);
    }
    return null;
  }

  private parseAgentPrefix(text: string): { agent: HarborAgent; prompt: string } | null {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(text.trim());
    if (!m) return null;
    const agent = this.store.getAgentByName(m[1]!);
    if (!agent || agent.archivedAt) return null;
    return { agent, prompt: m[2]! };
  }

  private boundAgent(chatId: string, text: string): { agent: HarborAgent; prompt: string } | null {
    const agentId = this.store.getChatBinding(chatId);
    if (!agentId) return null;
    const agent = this.store.getAgent(agentId);
    if (!agent || agent.archivedAt) return null;
    return { agent, prompt: text.trim() };
  }

  private convOfRun(runId: string): Conversation | null {
    const run = this.store.getRun(runId);
    return run ? this.store.getConversation(run.conversationId) : null;
  }

  /** 回话题（内存锚点）→ 退化为直发群（server 重启后锚点丢失） */
  private async replyToConversation(conv: Conversation, content: Content): Promise<string | null> {
    const anchor = this.replyAnchors.get(conv.id);
    if (anchor) {
      try {
        return await this.channel.reply(anchor, content);
      } catch {
        // 锚点消息不可回复（被删等）→ 落到 sendToChat
      }
    }
    const chatId = conv.originRef?.split("|")[0];
    if (!chatId) return null;
    return this.channel.sendToChat(chatId, content);
  }
}
