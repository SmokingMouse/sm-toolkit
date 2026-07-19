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

import type {
  Channel,
  Content,
  IncomingAction,
  IncomingMessage,
} from "@sm/agent";
import type {
  Approval,
  Conversation,
  HarborAgent,
  LarkWorkspaceBinding,
  Run,
  RunAttachment,
} from "../protocol.js";
import type { FeishuConfig } from "../config.js";
import type { HarborStore } from "./store.js";
import type { RunCoordinator } from "./scheduler.js";
import type { ApprovalService, ApprovalSink } from "./approvals.js";
import { transitionConversation } from "./statemachine.js";

/** FeishuChannel 的能力面（Channel + 群发送）。抽接口是为了 e2e 可用 mock 替身 */
export interface FeishuPort extends Channel {
  sendToChat(chatId: string, content: Content): Promise<string | null>;
  downloadResource?(
    messageId: string,
    resource: NonNullable<IncomingMessage["resources"]>[number],
  ): Promise<RunAttachment>;
}

const HELP = [
  {
    command: "<workspace/agent> <指令>",
    description: "派新 issue 给该 agent（agent 名全局唯一时可省 workspace/）",
  },
  {
    command: "（话题内回复）<指令>",
    description: "续该 issue 多轮（resume 上下文）",
  },
  {
    command: "/chat <workspace/agent> <指令>",
    description: "临时对话（不留 issue）",
  },
  {
    command: "/bind <workspace/agent>",
    description: "绑定本群默认 agent（此后裸指令直接派活）",
  },
  { command: "/status", description: "（话题内）看 issue 状态与 run 流水" },
  {
    command: "/review <agent名> [要求]",
    description: "（Review 中）派独立 Reviewer Agent",
  },
  {
    command: "/done · /cancel",
    description: "（话题内）人工验收 / 取消 issue",
  },
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
    private scope: {
      botMode: LarkWorkspaceBinding["botMode"];
      workspaceId?: string;
    } = { botMode: "global" },
    private readonly maintenanceActive: () => boolean = () => false,
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
    if (this.maintenanceActive()) return;
    const text = this.messageText(msg);
    if (!text) return;
    const binding =
      msg.chatType === "group"
        ? this.store.getLarkWorkspaceBinding(msg.chatId)
        : null;
    if (binding && !this.ownsBinding(binding)) return;
    const conv = this.resolveConversation(msg);

    // Mew 边界：DM 不是执行入口；绑定群成员可以触发 Agent，但不会因此获得 Workspace/API 权限。
    if (msg.chatType === "dm") {
      if (this.isAdmin(msg))
        await this.respond(msg, {
          type: "result",
          text: "私聊不作为 Agent 执行入口；请在已绑定的 Workspace 群中发起。",
        });
      return;
    }
    if (!binding?.enabled) {
      if (!msg.mentionedBot && !text.startsWith("/bind")) return;
      if (!this.isAdmin(msg)) {
        await this.respond(msg, {
          type: "error",
          message: "该群尚未绑定 Harbor Workspace；请联系管理员。",
        });
        return;
      }
    } else if (binding.listenMode === "mention" && !msg.mentionedBot && !conv) {
      return;
    }
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
      const parsed =
        this.parseAgentPrefix(text, binding?.workspaceId) ??
        this.boundAgent(msg.chatId, text);
      if (!parsed) {
        await this.respond(msg, {
          type: "error",
          message:
            "未识别 agent。用 `<agent名> <指令>` 派活，`/agents` 看可用列表，或 `/bind <agent名>` 绑定本群默认。",
        });
        return;
      }
      await this.createAndDispatch(msg, parsed.agent, parsed.prompt, "chat");
    } catch (e) {
      await this.respond(msg, {
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async handleCommand(
    msg: IncomingMessage,
    conv: Conversation | null,
    text: string,
  ): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    const restText = rest.join(" ");

    switch ((cmd ?? "").toLowerCase()) {
      case "/help":
      case "/帮助":
        await this.respond(msg, { type: "help", commands: HELP }, conv);
        return;

      case "/agents": {
        const binding = this.store.getLarkWorkspaceBinding(msg.chatId);
        const agents = this.store.listAgents(
          false,
          binding?.workspaceId ?? this.scope.workspaceId,
        );
        const devices = new Map(
          this.store.listDevices(new Set()).map((d) => [d.id, d.name]),
        );
        const workspaces = new Map(
          this.store
            .listWorkspaces()
            .map((workspace) => [workspace.id, workspace.slug]),
        );
        const lines = agents.length
          ? agents.map(
              (a) =>
                `**${workspaces.get(a.workspaceId) ?? a.workspaceId}/${a.name}** @ ${devices.get(a.deviceId) ?? a.deviceId} · ${a.backend}/${a.model ?? "默认"} · ${a.permission}${a.isolation === "worktree" ? " · worktree" : ""}`,
            )
          : ["（还没有 agent，先在 CLI 上 `harbor agent create`）"];
        await this.respond(
          msg,
          { type: "result", text: lines.join("\n") },
          conv,
        );
        return;
      }

      case "/bind": {
        if (!this.isAdmin(msg)) throw new Error("只有 Harbor 管理员可以绑定群");
        const agent = this.resolveAgentRef(restText, this.scope.workspaceId);
        if (!agent)
          throw new Error(`agent "${restText}" 不存在（/agents 查看）`);
        if (
          this.scope.workspaceId &&
          agent.workspaceId !== this.scope.workspaceId
        )
          throw new Error("Custom Bot 只能绑定其配置的 Workspace");
        this.store.upsertLarkWorkspaceBinding(
          {
            workspaceId: agent.workspaceId,
            chatId: msg.chatId,
            defaultAgentId: agent.id,
            botMode: this.scope.botMode,
          },
          Date.now(),
        );
        await this.respond(msg, {
          type: "result",
          text: `✓ 本群默认 agent 已绑定为 **${agent.name}**，裸指令将直接派给它。`,
        });
        return;
      }

      case "/chat":
      case "/issue": {
        const kind =
          cmd!.toLowerCase() === "/chat"
            ? ("chat" as const)
            : ("issue" as const);
        const binding = this.store.getLarkWorkspaceBinding(msg.chatId);
        const parsed =
          this.parseAgentPrefix(restText, binding?.workspaceId) ??
          this.boundAgent(msg.chatId, restText);
        if (!parsed)
          throw new Error(
            "用法：`" + cmd + " <agent名> <指令>`（或先 /bind 绑定默认 agent）",
          );
        await this.createAndDispatch(msg, parsed.agent, parsed.prompt, kind);
        return;
      }

      case "/status": {
        if (!conv)
          throw new Error(
            "本话题未关联 conversation（在派过活的话题里用 /status）",
          );
        const runs = this.store.listRunsByConversation(conv.id);
        const agent = conv.agentId ? this.store.getAgent(conv.agentId) : null;
        const lines = [
          `**${conv.title ?? "(无标题)"}**`,
          `\`${conv.id}\` · ${conv.kind} · **${conv.status}** · agent=${agent?.name ?? "?"}`,
          ...runs.slice(-5).map((r) => {
            const cost =
              r.cost?.usd != null ? ` · $${r.cost.usd.toFixed(4)}` : "";
            return `· \`${r.id}\` ${r.status}${cost}${r.error ? ` — ${r.error.slice(0, 80)}` : ""}`;
          }),
        ];
        await this.respond(
          msg,
          { type: "result", text: lines.join("\n") },
          conv,
        );
        return;
      }

      case "/done":
      case "/cancel": {
        if (!this.isAdmin(msg))
          throw new Error("只有 Harbor 管理员可以完成或取消 Issue");
        if (!conv) throw new Error("本话题未关联 conversation");
        if (conv.kind !== "issue") throw new Error("chat 会话没有状态可转换");
        const to =
          cmd!.toLowerCase() === "/done"
            ? ("done" as const)
            : ("canceled" as const);
        if (to === "done" && conv.status !== "review")
          throw new Error("只有 Review 中的 Issue 可以验收完成");
        const active = this.store.activeRunForConversation(conv.id);
        if (to === "done" && active)
          throw new Error("仍有 Run 进行中，不能完成验收");
        if (to === "canceled") {
          if (active) this.coordinator.cancelRun(active.id);
        }
        transitionConversation(
          this.store,
          this.store.getConversation(conv.id)!,
          to,
          "human",
          Date.now(),
        );
        const fresh = this.store.getConversation(conv.id)!;
        this.coordinator.requestWorktreeCleanup(fresh);
        await this.respond(
          msg,
          { type: "result", text: `✓ issue ${conv.id} → **${to}**` },
          conv,
        );
        return;
      }

      case "/review": {
        if (!conv || conv.kind !== "issue" || conv.status !== "review") {
          throw new Error("/review 只能在 Review 阶段使用");
        }
        const [agentName, ...promptParts] = rest;
        const reviewer = agentName
          ? this.resolveAgentRef(agentName, conv.workspaceId)
          : null;
        if (!reviewer) throw new Error("用法：/review <agent名> [审查要求]");
        if (reviewer.archivedAt)
          throw new Error(`Reviewer Agent "${reviewer.name}" 已归档`);
        const prompt =
          promptParts.join(" ").trim() ||
          "请独立审查本 Issue 的实现、代码改动和测试证据，给出阻塞问题与改进建议；不要直接宣告 Issue 完成。";
        const run = this.coordinator.enqueueRun(
          conv,
          reviewer,
          prompt,
          "review",
        );
        const ackId = await this.respond(
          msg,
          {
            type: "result",
            text: `⏳ 已派给 Reviewer **${reviewer.name}**（run \`${run.id}\`，Issue 保持 Review）`,
          },
          conv,
        );
        if (ackId) this.ackCards.set(run.id, ackId);
        return;
      }

      default:
        await this.respond(msg, { type: "help", commands: HELP }, conv);
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
        workspaceId: agent.workspaceId,
        kind,
        title: kind === "issue" ? prompt.slice(0, 60) : null,
        description: kind === "issue" ? prompt : null,
        agentId: agent.id,
        origin: "feishu",
        originRef: `${msg.chatId}|${anchor}`,
      },
      Date.now(),
    );
    this.store.appendConversationMessage(
      conv.id,
      {
        authorType: "external",
        authorId: msg.senderId,
        authorName: msg.senderName ?? msg.senderId,
        body: prompt,
        externalId: msg.id,
      },
      Date.now(),
    );
    this.replyAnchors.set(conv.id, msg.id);
    await this.dispatchRun(msg, conv, prompt);
  }

  private async dispatchRun(
    msg: IncomingMessage,
    conv: Conversation,
    prompt: string,
  ): Promise<void> {
    const agent = conv.agentId ? this.store.getAgent(conv.agentId) : null;
    if (!agent) throw new Error("Issue 尚未指派 Agent");
    if (
      !this.store
        .listConversationMessages(conv.id)
        .some((message) => message.externalId === msg.id)
    ) {
      this.store.appendConversationMessage(
        conv.id,
        {
          authorType: "external",
          authorId: msg.senderId,
          authorName: msg.senderName ?? msg.senderId,
          body: prompt,
          externalId: msg.id,
        },
        Date.now(),
      );
    }
    const purpose =
      conv.kind === "issue" && conv.status === "review"
        ? "review"
        : "implementation";
    const event =
      conv.kind === "chat"
        ? "event.chat.message_created"
        : msg.mentionedBot
          ? "event.issue.mentioned"
          : "event.issue.message_created";
    const attachments = await this.downloadAttachments(msg);
    const run = this.coordinator.enqueueRun(
      conv,
      agent,
      prompt,
      purpose,
      event,
      msg.id,
      { attachments },
    );
    const ackId = await this.respond(
      msg,
      {
        type: "result",
        text: `⏳ 已派给 **${agent.name}**（run \`${run.id}\`${conv.kind === "issue" ? ` · issue \`${conv.id}\`` : ""}）`,
        metadata:
          run.status === "queued"
            ? "排队中（设备离线或并发已满也不丢）"
            : undefined,
      },
      conv,
    );
    if (ackId) this.ackCards.set(run.id, ackId);
  }

  // ── run 完成回报（coordinator hook） ──────────────────

  notifyRunDone(run: Run, conv: Conversation | null): void {
    if (this.maintenanceActive()) return;
    void this.notifyRunDoneAsync(run, conv).catch((e) =>
      console.error(
        "[feishu] 结果回报失败：",
        e instanceof Error ? e.message : e,
      ),
    );
  }

  private async notifyRunDoneAsync(
    run: Run,
    conv: Conversation | null,
  ): Promise<void> {
    this.assertOutboundAllowed();
    if (!conv) {
      const text =
        run.status === "succeeded"
          ? (this.store.getRunResultText(run.id) ?? "（完成，无文本输出）")
          : run.status === "canceled"
            ? `⊘ automation run \`${run.id}\` 已取消`
            : `automation run \`${run.id}\` 失败：${run.error ?? "（无 error 信息）"}`;
      if (run.status === "failed" && this.config.adminUserId) {
        this.assertOutboundAllowed();
        await this.channel.send(this.config.adminUserId, {
          type: "error",
          message: text,
        });
      }
      return;
    }
    if (conv.origin === "feishu" && !this.ownsConversation(conv)) return;
    if (conv.origin !== "feishu" && this.scope.botMode !== "global") return;
    const content = this.runDoneContent(run, conv);

    if (conv.origin === "feishu") {
      const ackId = this.ackCards.get(run.id);
      this.ackCards.delete(run.id);
      if (ackId) {
        this.assertOutboundAllowed();
        await this.channel.update(ackId, content);
      } else {
        await this.replyToConversation(conv, content);
      }
      return;
    }

    // 无静默失败：非飞书入口的 failed run → admin DM 告警（P5 终验第 4 条）
    // （feishu 入口已在上面 return，走到这里的都是 cli/web/automation 来源）
    if (run.status === "failed" && this.config.adminUserId) {
      this.assertOutboundAllowed();
      await this.channel.send(this.config.adminUserId, {
        type: "error",
        message: `run \`${run.id}\` 失败（${conv.kind} \`${conv.id}\`，来源 ${conv.origin}）\n${run.error ?? "（无 error 信息）"}\n\n▶︎ \`harbor issue continue ${conv.id} "<指令>"\` 可基于上一轮上下文重试`,
      });
    }
  }

  private runDoneContent(run: Run, conv: Conversation): Content {
    if (run.status === "succeeded") {
      const text =
        this.store.getRunResultText(run.id) ?? "（完成，无文本输出）";
      const parts: string[] = [];
      if (run.startedAt && run.finishedAt)
        parts.push(`${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`);
      if (run.cost?.usd != null) parts.push(`$${run.cost.usd.toFixed(4)}`);
      if (conv.kind === "issue")
        parts.push(
          `issue → ${this.store.getConversation(conv.id)?.status ?? "?"}`,
        );
      parts.push(`run ${run.id}`);
      return { type: "result", text, metadata: parts.join(" · ") };
    }
    if (run.status === "canceled") {
      return {
        type: "result",
        text: `⊘ run \`${run.id}\` 已取消`,
        metadata:
          conv.kind === "issue"
            ? `issue → ${this.store.getConversation(conv.id)?.status}`
            : undefined,
      };
    }
    return {
      type: "error",
      message: `run \`${run.id}\` 失败：${run.error ?? "（无 error 信息）"}${conv.kind === "issue" ? `\n\nissue 已回 todo，话题里直接回复新指令可基于上一轮上下文续跑。` : ""}`,
    };
  }

  // ── 审批卡片（ApprovalSink） ──────────────────────────

  onApprovalCreated(
    approval: Approval,
    _run: Run,
    conv: Conversation | null,
  ): void {
    if (this.maintenanceActive()) return;
    void this.sendApprovalCard(approval, conv).catch((e) =>
      console.error(
        "[feishu] 审批卡片发送失败：",
        e instanceof Error ? e.message : e,
      ),
    );
  }

  private async sendApprovalCard(
    approval: Approval,
    conv: Conversation | null,
  ): Promise<void> {
    this.assertOutboundAllowed();
    if (conv?.origin === "feishu" && !this.ownsConversation(conv)) return;
    if (conv?.origin !== "feishu" && this.scope.botMode !== "global") return;
    const content = this.approvalContent(approval, conv);
    let messageId: string | null = null;
    if (conv?.origin === "feishu") {
      messageId = await this.replyToConversation(conv, content);
    } else if (this.config.adminUserId) {
      // CLI/automation 发起的审批：DM 用户本人（场景②），手机上也能批
      this.assertOutboundAllowed();
      messageId = await this.channel.send(this.config.adminUserId, content);
    }
    if (messageId) {
      this.assertOutboundAllowed();
      this.store.setApprovalFeishuMessageId(approval.id, messageId);
      // 竞态补渲染：卡片发送期间已被 CLI 决议 → onApprovalDecided 当时拿不到
      // messageId，没法改卡；这里发现已非 pending 就立即补一次决议态。
      const fresh = this.store.getApproval(approval.id);
      if (fresh && fresh.status !== "pending") {
        this.assertOutboundAllowed();
        await this.channel.update(messageId, this.approvalContent(fresh, conv));
      }
    }
  }

  onApprovalDecided(approval: Approval): void {
    if (this.maintenanceActive()) return;
    const messageId = this.store.getApprovalFeishuMessageId(approval.id);
    if (!messageId) return;
    const conv = this.convOfRun(approval.runId);
    void Promise.resolve()
      .then(() => {
        this.assertOutboundAllowed();
        return this.channel.update(
          messageId,
          this.approvalContent(approval, conv),
        );
      })
      .catch((e) =>
        console.error(
          "[feishu] 审批卡片更新失败：",
          e instanceof Error ? e.message : e,
        ),
      );
  }

  private approvalContent(
    approval: Approval,
    conv: Conversation | null,
  ): Content {
    // Review Run 的执行者不等于 Issue Assignee；审批卡必须展示真正触发工具的 Agent。
    const run = this.store.getRun(approval.runId);
    const agent = run ? this.store.getAgent(run.agentId) : null;
    const inputPreview = JSON.stringify(approval.input ?? {}, null, 2).slice(
      0,
      800,
    );
    const decidedNote =
      approval.status === "allowed" || approval.status === "denied"
        ? `by ${approval.decidedBy ?? "?"}`
        : approval.status === "expired"
          ? `超 30min 未批`
          : undefined;
    return {
      type: "tool_approval",
      agentName: agent?.name ?? run?.agentId ?? conv?.agentId ?? "?",
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
                value: JSON.stringify({
                  cmd: "harbor_tool_approval",
                  id: approval.id,
                  behavior: "allow",
                }),
              },
              {
                label: "拒绝",
                style: "danger",
                value: JSON.stringify({
                  cmd: "harbor_tool_approval",
                  id: approval.id,
                  behavior: "deny",
                }),
              },
            ]
          : [],
    };
  }

  // ── 卡片按钮回调 ──────────────────────────────────────

  async handleAction(action: IncomingAction): Promise<void> {
    if (this.maintenanceActive()) return;
    let value: { cmd?: string; id?: string; behavior?: string };
    try {
      const parsed = JSON.parse(action.value) as unknown;
      value = (
        typeof parsed === "string" ? JSON.parse(parsed) : parsed
      ) as typeof value;
    } catch {
      return;
    }
    if (value.cmd !== "harbor_tool_approval" || !value.id) return;
    if (
      this.config.adminUserId &&
      action.operatorId !== this.config.adminUserId
    ) {
      console.warn(`[feishu] 非 admin 点击审批卡片被拒：${action.operatorId}`);
      return;
    }
    // decide 幂等（重复点击/CLI 竞态返回既有决议），卡片更新走 onApprovalDecided sink
    this.approvals.decide(
      value.id,
      value.behavior === "allow" ? "allow" : "deny",
      "feishu",
    );
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
    if (msg.replyToMessageId) {
      const linked = this.store.getConversationForLarkMessage(
        msg.replyToMessageId,
      );
      if (linked) return linked;
    }
    const anchor = this.anchorOf(msg, false);
    const conv = this.store.getConversationByOrigin(
      "feishu",
      `${msg.chatId}|${anchor}`,
    );
    if (conv) return conv;
    // DM 话题内回复 → 回退滚动会话锚
    if (msg.chatType === "dm" && anchor !== msg.chatId) {
      return this.store.getConversationByOrigin(
        "feishu",
        `${msg.chatId}|${msg.chatId}`,
      );
    }
    return null;
  }

  private parseAgentPrefix(
    text: string,
    workspaceId?: string,
  ): { agent: HarborAgent; prompt: string } | null {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(text.trim());
    if (!m) return null;
    const agent = this.resolveAgentRef(m[1]!, workspaceId);
    if (!agent || agent.archivedAt) return null;
    return { agent, prompt: m[2]! };
  }

  private resolveAgentRef(
    ref: string,
    workspaceId?: string,
  ): HarborAgent | null {
    if (workspaceId) {
      const separator = ref.indexOf("/");
      if (separator > 0) {
        const workspace = this.store.resolveWorkspace(ref.slice(0, separator));
        if (!workspace || workspace.id !== workspaceId) return null;
        return this.store.getAgentByNameInWorkspace(
          workspaceId,
          ref.slice(separator + 1),
        );
      }
      const direct = this.store.getAgent(ref);
      if (direct && direct.workspaceId === workspaceId) return direct;
      return this.store.getAgentByNameInWorkspace(workspaceId, ref);
    }
    const separator = ref.indexOf("/");
    if (separator > 0) {
      const workspace = this.store.resolveWorkspace(ref.slice(0, separator));
      if (!workspace || workspace.archivedAt) return null;
      return this.store.getAgentByNameInWorkspace(
        workspace.id,
        ref.slice(separator + 1),
      );
    }
    try {
      return this.store.getAgent(ref) ?? this.store.getAgentByName(ref);
    } catch {
      throw new Error(
        `agent "${ref}" 存在于多个 Workspace，请使用 <workspace/agent>（/agents 查看）`,
      );
    }
  }

  private boundAgent(
    chatId: string,
    text: string,
  ): { agent: HarborAgent; prompt: string } | null {
    const binding = this.store.getLarkWorkspaceBinding(chatId);
    if (!binding?.enabled) return null;
    const agent = this.store.getAgent(binding.defaultAgentId);
    if (!agent || agent.archivedAt) return null;
    return { agent, prompt: text.trim() };
  }

  private convOfRun(runId: string): Conversation | null {
    const run = this.store.getRun(runId);
    return run?.conversationId
      ? this.store.getConversation(run.conversationId)
      : null;
  }

  /** 回话题（内存锚点）→ 退化为直发群（server 重启后锚点丢失） */
  private async replyToConversation(
    conv: Conversation,
    content: Content,
  ): Promise<string | null> {
    this.assertOutboundAllowed();
    const chatId = conv.originRef?.split("|")[0];
    const binding = chatId ? this.store.getLarkWorkspaceBinding(chatId) : null;
    if (chatId && binding?.responseMode === "message") {
      this.assertOutboundAllowed();
      const messageId = await this.channel.sendToChat(chatId, content);
      if (messageId) this.store.linkLarkMessage(messageId, conv.id, Date.now());
      return messageId;
    }
    const anchor = this.replyAnchors.get(conv.id);
    if (anchor) {
      try {
        this.assertOutboundAllowed();
        const messageId = await this.channel.reply(anchor, content);
        if (messageId)
          this.store.linkLarkMessage(messageId, conv.id, Date.now());
        return messageId;
      } catch {
        // 锚点消息不可回复（被删等）→ 落到 sendToChat
      }
    }
    if (!chatId) return null;
    this.assertOutboundAllowed();
    const messageId = await this.channel.sendToChat(chatId, content);
    if (messageId) this.store.linkLarkMessage(messageId, conv.id, Date.now());
    return messageId;
  }

  private isAdmin(msg: IncomingMessage): boolean {
    return !this.config.adminUserId || msg.senderId === this.config.adminUserId;
  }

  private ownsBinding(binding: LarkWorkspaceBinding): boolean {
    return (
      binding.botMode === this.scope.botMode &&
      (!this.scope.workspaceId ||
        binding.workspaceId === this.scope.workspaceId)
    );
  }

  private ownsConversation(conv: Conversation): boolean {
    const chatId = conv.originRef?.split("|")[0];
    const binding = chatId ? this.store.getLarkWorkspaceBinding(chatId) : null;
    return !!binding && this.ownsBinding(binding);
  }

  private messageText(msg: IncomingMessage): string {
    const text = msg.text.trim();
    const resources = msg.resources ?? [];
    if (!resources.length) return text;
    const lines = resources.map(
      (resource) =>
        `- ${resource.type}: ${resource.fileName ?? resource.fileKey} (Lark file_key=${resource.fileKey})`,
    );
    return `${text}\n\n## Lark attachments\n${lines.join("\n")}`.trim();
  }

  private async downloadAttachments(
    msg: IncomingMessage,
  ): Promise<RunAttachment[]> {
    const resources = (msg.resources ?? [])
      .filter((resource) => resource.type !== "sticker")
      .slice(0, 8);
    if (!resources.length || !this.channel.downloadResource) return [];
    const attachments: RunAttachment[] = [];
    let totalBytes = 0;
    for (const resource of resources) {
      const attachment = await this.channel.downloadResource(msg.id, resource);
      const bytes = Buffer.byteLength(attachment.dataBase64, "base64");
      totalBytes += bytes;
      if (totalBytes > 20 * 1024 * 1024)
        throw new Error("单条消息附件总量超过 Harbor 20MB 上限");
      attachments.push(attachment);
    }
    return attachments;
  }

  private async respond(
    msg: IncomingMessage,
    content: Content,
    conv?: Conversation | null,
  ): Promise<string | null> {
    this.assertOutboundAllowed();
    const binding = this.store.getLarkWorkspaceBinding(msg.chatId);
    const messageId =
      binding?.responseMode === "message"
        ? await this.channel.sendToChat(msg.chatId, content)
        : await this.channel.reply(msg.id, content);
    if (messageId && conv)
      this.store.linkLarkMessage(messageId, conv.id, Date.now());
    return messageId;
  }

  private assertOutboundAllowed(): void {
    if (this.maintenanceActive()) throw new Error("deployment maintenance 期间禁止 Feishu outbound");
  }
}
