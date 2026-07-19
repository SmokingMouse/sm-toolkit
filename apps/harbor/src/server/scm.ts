/**
 * 外部 SCM 入口：Webhook 先落幂等事件，再投影为 ExternalObject / Conversation / Delivery。
 * run_event 仍是 Agent 执行真相；SCM event 是外部协作真相，两者通过 Conversation 关联。
 */

import { createHash } from "node:crypto";
import type { CodebaseAutomationEvent, Conversation, Run, ScmObjectKind } from "../protocol.js";
import type { CodebaseCommandRunner } from "./codebase.js";
import { BitsCodebaseRunner } from "./codebase.js";
import type { DeliveryProviderSnapshot, DeliveryService } from "./delivery.js";
import type { RunCoordinator } from "./scheduler.js";
import type { HarborStore } from "./store.js";
import { transitionConversation } from "./statemachine.js";

export interface ScmWebhookInput {
  eventId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

interface NormalizedScmEvent {
  eventType: string;
  action: string | null;
  kind: ScmObjectKind | null;
  externalId: string | null;
  title: string;
  description: string | null;
  url: string | null;
  state: string;
  authorId: string | null;
  authorName: string | null;
  headBranch: string | null;
  baseBranch: string | null;
  latestHeadSha: string | null;
  commentId: string | null;
  commentBody: string | null;
  explicitDispatch: boolean;
  reviewStatus: "pending" | "approved" | null;
  checkStatus: "unknown" | "pending" | "passed" | "failed" | null;
  mergeStatus: "open" | "merged" | null;
}

export interface ScmAutomationEventInput {
  workspaceId: string;
  repositoryId: string;
  eventType: CodebaseAutomationEvent;
  eventId: string;
  payload: Record<string, unknown>;
  occurredAt: number;
}

export class ScmService {
  private automationListener: ((input: ScmAutomationEventInput) => boolean) | null = null;

  constructor(
    private readonly store: HarborStore,
    private readonly coordinator: RunCoordinator,
    private readonly deliveries: DeliveryService,
    private readonly runner: CodebaseCommandRunner = new BitsCodebaseRunner(),
  ) {}

  setAutomationListener(listener: (input: ScmAutomationEventInput) => boolean): void {
    this.automationListener = listener;
  }

  receiveCodebase(repositoryId: string, input: ScmWebhookInput, now = Date.now()): {
    status: "applied" | "ignored" | "duplicate";
    eventId: string;
    conversationId?: string;
    deliveryId?: string;
    automationEvent?: CodebaseAutomationEvent;
  } {
    const repository = this.store.getRepository(repositoryId);
    if (!repository || repository.scmProvider !== "codebase" || !repository.scmRepository) {
      throw new Error("Codebase webhook 指向的 Repository 不存在或未启用 Codebase");
    }
    const normalized = normalizeCodebaseEvent(input.eventType, input.payload);
    const eventId = input.eventId?.trim() || `codebase:${sha256(JSON.stringify({
      repositoryId,
      eventType: input.eventType,
      payload: input.payload,
    }))}`;
    const inserted = this.store.insertScmEvent({
      id: eventId,
      provider: "codebase",
      workspaceId: repository.workspaceId,
      repositoryId,
      eventType: normalized.eventType,
      action: normalized.action,
      objectKind: normalized.kind,
      externalId: normalized.externalId,
      payload: input.payload,
    }, now);
    if (!inserted) {
      const existing = this.store.getScmEvent(eventId);
      if (existing?.outcome === "applied" || existing?.outcome === "ignored") {
        return { status: "duplicate", eventId };
      }
    }

    try {
      if (!normalized.kind || !normalized.externalId) {
        this.store.finishScmEvent(eventId, "ignored", null, now);
        return { status: "ignored", eventId };
      }
      const external = this.store.upsertScmExternalObject({
        workspaceId: repository.workspaceId,
        repositoryId,
        provider: "codebase",
        kind: normalized.kind,
        externalId: normalized.externalId,
        url: normalized.url,
        title: normalized.title || `${normalized.kind} ${normalized.externalId}`,
        description: normalized.description,
        authorId: normalized.authorId,
        authorName: normalized.authorName,
        state: normalized.state,
        payload: input.payload,
      }, now);
      let conversation = external.conversationId ? this.store.getConversation(external.conversationId) : null;
      const createdConversation = !conversation;
      if (!conversation) {
        conversation = this.store.createConversation({
          workspaceId: repository.workspaceId,
          kind: "issue",
          title: normalized.title || `${normalized.kind} ${normalized.externalId}`,
          description: normalized.description,
          agentId: repository.scmAgentId,
          repositoryId,
          origin: "codebase",
          originRef: external.id,
        }, now);
        if (normalized.kind === "change") {
          transitionConversation(this.store, conversation, "review", "system", now);
          conversation = this.store.getConversation(conversation.id)!;
        } else {
          this.applyIssueState(conversation, normalized.state, now);
          conversation = this.store.getConversation(conversation.id)!;
        }
        this.store.linkScmExternalObject(external.id, { conversationId: conversation.id }, now);
      } else {
        this.store.updateConversation(conversation.id, {
          title: normalized.title || conversation.title,
          description: normalized.description ?? conversation.description,
        }, now);
        if (normalized.kind === "issue") this.applyIssueState(conversation, normalized.state, now);
        conversation = this.store.getConversation(conversation.id)!;
      }

      if (normalized.commentBody) {
        this.store.appendConversationMessage(conversation.id, {
          authorType: "external",
          authorId: normalized.authorId,
          authorName: normalized.authorName,
          body: normalized.commentBody,
          externalId: normalized.commentId ?? eventId,
        }, now);
      }

      let deliveryId: string | undefined;
      if (normalized.kind === "change") {
        let delivery = this.store.getDeliveryForConversation(conversation.id);
        if (!delivery) {
          delivery = this.deliveries.create(conversation, {
            provider: "codebase",
            changeUrl: normalized.url,
            externalId: normalized.externalId,
            headBranch: normalized.headBranch,
            baseBranch: normalized.baseBranch,
            latestHeadSha: normalized.latestHeadSha,
          }, now);
        }
        const snapshot: DeliveryProviderSnapshot = {
          changeUrl: normalized.url,
          externalId: normalized.externalId,
          headBranch: normalized.headBranch,
          baseBranch: normalized.baseBranch,
          latestHeadSha: normalized.latestHeadSha,
          ...(normalized.reviewStatus ? { reviewStatus: normalized.reviewStatus } : {}),
          ...(normalized.checkStatus ? { checkStatus: normalized.checkStatus } : {}),
          ...(normalized.mergeStatus ? { mergeStatus: normalized.mergeStatus } : {}),
          providerData: { eventId, eventType: normalized.eventType, action: normalized.action },
        };
        delivery = this.deliveries.applyProviderSnapshot(delivery, snapshot, now);
        deliveryId = delivery.id;
        this.store.linkScmExternalObject(external.id, { deliveryId: delivery.id }, now);
        if (delivery.status === "succeeded" && conversation.status !== "done" && conversation.status !== "canceled") {
          transitionConversation(this.store, conversation, "done", "system", now);
          conversation = this.store.getConversation(conversation.id)!;
        } else if (isClosedUnmerged(normalized) && conversation.status !== "done" && conversation.status !== "canceled") {
          transitionConversation(this.store, conversation, "canceled", "system", now);
          conversation = this.store.getConversation(conversation.id)!;
        }
      }

      const automationEvent = classifyCodebaseAutomationEvent(normalized, createdConversation);
      const handledByAutomation = automationEvent
        ? this.automationListener?.({
            workspaceId: repository.workspaceId,
            repositoryId,
            eventType: automationEvent,
            eventId,
            payload: input.payload,
            occurredAt: now,
          }) ?? false
        : false;
      if (!handledByAutomation) this.maybeDispatch(repository, conversation, normalized, eventId);
      this.store.finishScmEvent(eventId, "applied", null, now);
      return {
        status: "applied",
        eventId,
        conversationId: conversation.id,
        ...(deliveryId ? { deliveryId } : {}),
        ...(automationEvent ? { automationEvent } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.finishScmEvent(eventId, "failed", message, now);
      throw error;
    }
  }

  async notifyRunDone(run: Run, conversation: Conversation | null): Promise<void> {
    if (!conversation || conversation.origin !== "codebase") return;
    const external = this.store.getScmExternalObjectForConversation(conversation.id);
    const repository = external ? this.store.getRepository(external.repositoryId) : null;
    if (!external || !repository?.scmRepository) return;
    const result = run.status === "succeeded"
      ? this.store.getRunResultText(run.id) ?? "完成，无文本输出。"
      : run.status === "canceled"
        ? `Harbor run ${run.id} 已取消。`
        : `Harbor run ${run.id} 失败：${run.error ?? "未知错误"}`;
    const body = `${result}\n\n---\nHarbor run \`${run.id}\` · ${run.status}`;
    const resource = external.kind === "issue" ? "issue" : "mr";
    const command = [resource, "comment", "create", "-N", external.externalId, "-R", repository.scmRepository, "--body", body];
    const response = await this.runner.run(command, 60_000);
    if (response.exitCode !== 0) {
      throw new Error(response.stderr.trim() || response.stdout.trim() || "Codebase comment 回写失败");
    }
  }

  private maybeDispatch(
    repository: NonNullable<ReturnType<HarborStore["getRepository"]>>,
    conversation: Conversation,
    event: NormalizedScmEvent,
    eventId: string,
  ): void {
    if (!repository.scmAutoDispatch || !repository.scmAgentId) return;
    if (conversation.status === "done" || conversation.status === "canceled") return;
    const agent = this.store.getAgent(repository.scmAgentId);
    if (!agent || agent.archivedAt || !agent.repositoryIds.includes(repository.id)) return;
    const firstRun = this.store.listRunsByConversation(conversation.id).length === 0;
    if (!firstRun && !event.explicitDispatch) return;
    if (this.store.activeRunForConversation(conversation.id)) return;
    const prompt = event.commentBody?.trim()
      || conversation.description?.trim()
      || `处理外部 ${event.kind} ${event.externalId}`;
    const purpose = event.kind === "change" ? "review" : "implementation";
    this.coordinator.enqueueRun(
      this.store.getConversation(conversation.id)!,
      agent,
      prompt,
      purpose,
      event.commentBody ? "event.issue.mentioned" : "event.issue.assigned",
      eventId,
      { triggerContext: { scm: { provider: "codebase", eventId, externalId: event.externalId } } },
    );
  }

  private applyIssueState(conversation: Conversation, state: string, now: number): void {
    const normalized = state.toLowerCase();
    const target = normalized === "done" || normalized === "closed" || normalized === "resolved"
      ? "done"
      : normalized === "canceled" || normalized === "cancelled"
        ? "canceled"
        : normalized === "in_progress" || normalized === "doing"
          ? "doing"
          : normalized === "todo" || normalized === "open"
            ? "todo"
            : "backlog";
    if (conversation.status !== target) transitionConversation(this.store, conversation, target, "system", now);
  }
}

function classifyCodebaseAutomationEvent(
  event: NormalizedScmEvent,
  createdConversation: boolean,
): CodebaseAutomationEvent | null {
  const action = `${event.eventType} ${event.action ?? ""}`.toLowerCase();
  if (event.kind === "change") {
    if (event.mergeStatus === "merged" || /\bmerged\b/.test(action)) return "merge_request_merged";
    return createdConversation || /\b(opened|created|open)\b/.test(action)
      ? "merge_request_opened"
      : "merge_request_updated";
  }
  if (event.kind === "issue") {
    const explicitComment = !createdConversation && !!event.commentBody && (
      !!event.commentId || /\b(comment|note|reply)\b/.test(action)
    );
    if (explicitComment) return "issue_commented";
    return createdConversation || /\b(opened|created|open)\b/.test(action)
      ? "issue_opened"
      : "issue_updated";
  }
  return null;
}

export function normalizeCodebaseEvent(eventType: string, payload: Record<string, unknown>): NormalizedScmEvent {
  const type = eventType.trim().toLowerCase();
  const action = scalar(payload, ["action", "Action", "event.action", "object_attributes.action"]);
  const kind: ScmObjectKind | null = /merge.?request|\bmr\b|pull.?request|review|check|pipeline|ci/.test(type)
    ? "change"
    : /issue/.test(type)
      ? "issue"
      : scalar(payload, ["object_kind", "ObjectKind"]) === "merge_request"
        ? "change"
        : scalar(payload, ["object_kind", "ObjectKind"]) === "issue"
          ? "issue"
          : null;
  const prefix = kind === "change" ? ["merge_request", "MergeRequest", "object_attributes"] : ["issue", "Issue", "object_attributes"];
  const paths = (field: string[]) => [...prefix.flatMap((root) => field.map((key) => `${root}.${key}`)), ...field];
  const externalId = scalar(payload, paths(["number", "Number", "iid", "id"]));
  const title = scalar(payload, paths(["title", "Title"])) ?? "";
  const description = scalar(payload, paths(["description", "Description", "body", "Body"]));
  const url = scalar(payload, paths(["url", "URL", "web_url", "WebURL"]));
  const state = scalar(payload, paths(["state", "State", "status", "Status"])) ?? action ?? "open";
  const authorId = scalar(payload, ["user.id", "user.UserId", "author.id", "author.UserId", "CreatedBy.UserId"]);
  const authorName = scalar(payload, ["user.username", "user.name", "author.username", "author.name", "CreatedBy.Username"]);
  const commentBody = scalar(payload, ["comment.body", "comment.Body", "note.body", "object_attributes.note", "body"]);
  const commentId = scalar(payload, ["comment.id", "comment.Id", "note.id", "object_attributes.id"]);
  const reviewValue = `${action ?? ""} ${scalar(payload, ["review.status", "ReviewStatus", "status"]) ?? ""}`.toLowerCase();
  const reviewStatus = /disapprove|dismiss|pending|request.?change/.test(reviewValue)
    ? "pending" as const
    : /approve|passed/.test(reviewValue)
      ? "approved" as const
      : null;
  const checkValue = `${action ?? ""} ${scalar(payload, ["check.status", "check.conclusion", "pipeline.status", "status", "conclusion"]) ?? ""}`.toLowerCase();
  const checkStatus = /fail|error|cancel|timeout/.test(checkValue)
    ? "failed" as const
    : /success|succeed|passed/.test(checkValue)
      ? "passed" as const
      : /pending|running|created|queued/.test(checkValue) && /check|pipeline|ci/.test(type)
        ? "pending" as const
        : null;
  const merged = /merged/.test(`${state} ${action ?? ""}`.toLowerCase());
  const mergeStatus = merged ? "merged" as const : /merge.?request|\bmr\b/.test(type) ? "open" as const : null;
  const explicitFlag = valueAt(payload, "harbor_dispatch") === true;
  return {
    eventType: type || "unknown",
    action,
    kind,
    externalId,
    title,
    description,
    url,
    state,
    authorId,
    authorName,
    headBranch: scalar(payload, paths(["source_branch", "SourceBranchName", "head_branch"])),
    baseBranch: scalar(payload, paths(["target_branch", "TargetBranchName", "base_branch"])),
    latestHeadSha: scalar(payload, paths([
      "last_commit_id",
      "LastCommitID",
      "last_commit_sha",
      "source_commit_id",
      "head_sha",
      "sha",
    ])),
    commentId,
    commentBody,
    explicitDispatch: explicitFlag || /assigned|mentioned/.test(action ?? "") || /@(harbor|mew)\b/i.test(commentBody ?? ""),
    reviewStatus,
    checkStatus,
    mergeStatus,
  };
}

function isClosedUnmerged(event: NormalizedScmEvent): boolean {
  return event.mergeStatus !== "merged" && /closed|canceled|cancelled/.test(`${event.state} ${event.action ?? ""}`.toLowerCase());
}

function scalar(value: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const current = valueAt(value, path);
    if (typeof current === "string" && current.trim()) return current.trim();
    if (typeof current === "number" && Number.isFinite(current)) return String(current);
  }
  return null;
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) current = isRecord(current) ? current[part] : undefined;
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
