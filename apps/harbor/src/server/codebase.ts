/**
 * Codebase Delivery Provider。
 *
 * 领域 policy 仍由 DeliveryService 决定；这里仅把已经获准的动作翻译成
 * `bitscli codebase` 命令，并把外部 JSON 投影为 Harbor 的正交交付事实。
 * 命令不经 shell，仓库/MR 参数不会发生注入；凭证只由 bitscli 自己管理。
 */

import { spawn } from "node:child_process";
import type { Delivery, DeliveryCheckStatus } from "../protocol.js";
import type {
  DeliveryProvider,
  DeliveryProviderAction,
  DeliveryProviderResult,
  DeliveryProviderSnapshot,
} from "./delivery.js";
import type { HarborStore } from "./store.js";

export interface CodebaseCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CodebaseCommandRunner {
  run(args: string[], timeoutMs?: number): Promise<CodebaseCommandResult>;
}

export class BitsCodebaseRunner implements CodebaseCommandRunner {
  private static readonly MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

  constructor(
    private readonly binary = process.env.HARBOR_BITSCLI_BIN ?? "bitscli",
  ) {}

  run(args: string[], timeoutMs = 60_000): Promise<CodebaseCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["codebase", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        reject(
          new Error(`bitscli codebase ${args.slice(0, 3).join(" ")} 超时`),
        );
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const append = (target: "stdout" | "stderr", chunk: string) => {
        if (settled) return;
        if (target === "stdout") stdout += chunk;
        else stderr += chunk;
        if (
          Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
          BitsCodebaseRunner.MAX_OUTPUT_BYTES
        ) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          reject(new Error("bitscli Codebase 输出超过 5MB 安全上限"));
        }
      };
      child.stdout.on("data", (chunk) => append("stdout", chunk));
      child.stderr.on("data", (chunk) => append("stderr", chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "未找到 bitscli；请安装 @byted/bits-cli 并完成 `bitscli codebase auth login`"
              : `bitscli 启动失败：${error.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }
}

export class CodebaseDeliveryProvider implements DeliveryProvider {
  readonly kind = "codebase" as const;
  readonly mode = "automatic" as const;

  constructor(
    private readonly store: HarborStore,
    private readonly runner: CodebaseCommandRunner = new BitsCodebaseRunner(),
  ) {}

  async merge(
    delivery: Delivery,
    input: DeliveryProviderAction,
  ): Promise<DeliveryProviderResult> {
    if (input.confirmed !== true) {
      throw new Error(
        "Codebase 合并会修改远端仓库，需要在确认对话框中明确同意",
      );
    }
    const target = this.target(delivery);
    const result = await this.command(
      ["mr", "merge", "-N", target.number, "-R", target.repository, "--yes"],
      120_000,
    );
    return { message: `Codebase MR !${target.number} 已合并`, data: result };
  }

  async startDeployment(
    _delivery: Delivery,
    input: DeliveryProviderAction,
  ): Promise<DeliveryProviderResult> {
    if (input.confirmed !== true) throw new Error("开始部署需要显式确认");
    return { message: "Codebase 只管理 SCM；已确认由外部部署系统接管" };
  }

  async refresh(delivery: Delivery): Promise<DeliveryProviderSnapshot> {
    const target = this.target(delivery);
    const [view, status, checks] = await Promise.all([
      this.command([
        "mr",
        "view",
        "-N",
        target.number,
        "-R",
        target.repository,
      ]),
      this.command([
        "mr",
        "status",
        "-N",
        target.number,
        "-R",
        target.repository,
      ]),
      this.command([
        "mr",
        "checks",
        "list",
        "-N",
        target.number,
        "-R",
        target.repository,
      ]),
    ]);
    return codebaseSnapshot(
      { view, status, checks },
      target.number,
      target.repository,
    );
  }

  private target(delivery: Delivery): { repository: string; number: string } {
    const conversation = this.store.getConversation(delivery.conversationId);
    const repository = conversation?.repositoryId
      ? this.store.getRepository(conversation.repositoryId)
      : null;
    if (
      !repository ||
      repository.scmProvider !== "codebase" ||
      !repository.scmRepository
    ) {
      throw new Error(
        "Delivery 所属 Repository 尚未配置 Codebase repository path",
      );
    }
    const number =
      delivery.externalId?.trim() ||
      /\/merge_requests\/(\d+)/.exec(delivery.changeUrl ?? "")?.[1];
    if (!number || !/^\d+$/.test(number))
      throw new Error("Codebase Delivery 缺少合法 MR number（externalId）");
    return { repository: repository.scmRepository, number };
  }

  private async command(args: string[], timeoutMs?: number): Promise<unknown> {
    const result = await this.runner.run(args, timeoutMs);
    if (result.exitCode !== 0) {
      const reason =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit ${result.exitCode}`;
      throw new Error(
        `bitscli codebase ${args.slice(0, 3).join(" ")} 失败：${reason.slice(0, 1200)}`,
      );
    }
    const output = result.stdout.trim();
    if (!output) return {};
    try {
      return JSON.parse(output) as unknown;
    } catch {
      return { text: output };
    }
  }
}

export function codebaseSnapshot(
  raw: { view: unknown; status: unknown; checks: unknown },
  fallbackNumber: string,
  repository: string,
): DeliveryProviderSnapshot {
  const number =
    scalar(raw.view, [
      "Number",
      "number",
      "MergeRequest.Number",
      "merge_request.number",
    ]) ?? fallbackNumber;
  const mrStatus = (
    scalar(raw.view, [
      "Status",
      "status",
      "MergeRequest.Status",
      "merge_request.status",
    ]) ?? ""
  ).toLowerCase();
  const reviewStatus = scalar(raw.status, [
    "ReviewStatus",
    "review_status",
    "Review.Status",
    "review.status",
  ]);
  const reviewPassed =
    bool(raw.status, [
      "MeetReviewRules",
      "meet_review_rules",
      "Review.Approved",
      "review.approved",
    ]) ||
    ["approved", "passed", "succeeded"].includes(
      (reviewStatus ?? "").toLowerCase(),
    );
  const url =
    scalar(raw.view, ["URL", "Url", "url", "WebURL", "web_url"]) ??
    `https://code.byted.org/${repository}/merge_requests/${number}`;
  return {
    externalId: number,
    changeUrl: url,
    headBranch: scalar(raw.view, [
      "SourceBranchName",
      "source_branch_name",
      "SourceBranch",
      "source_branch",
    ]),
    baseBranch: scalar(raw.view, [
      "TargetBranchName",
      "target_branch_name",
      "TargetBranch",
      "target_branch",
    ]),
    reviewStatus: reviewPassed ? "approved" : "pending",
    checkStatus: codebaseCheckStatus(raw.checks),
    mergeStatus: mrStatus === "merged" ? "merged" : "open",
    providerData: raw,
  };
}

export function codebaseCheckStatus(value: unknown): DeliveryCheckStatus {
  const records = collectRecords(value, [
    "CheckRuns",
    "check_runs",
    "Checks",
    "checks",
    "Items",
    "items",
  ]);
  if (records.length === 0) return "unknown";
  const states = records.map((record) => ({
    status: (
      field(record, ["Status", "status", "State", "state"]) ?? ""
    ).toLowerCase(),
    conclusion: (
      field(record, ["Conclusion", "conclusion", "Result", "result"]) ?? ""
    ).toLowerCase(),
  }));
  const failed = new Set([
    "failed",
    "failure",
    "error",
    "canceled",
    "cancelled",
    "timed_out",
    "timeout",
  ]);
  if (
    states.some(
      (state) => failed.has(state.conclusion) || failed.has(state.status),
    )
  )
    return "failed";
  const success = new Set([
    "succeeded",
    "success",
    "passed",
    "skipped",
    "neutral",
  ]);
  const completed = new Set(["completed", "complete", "finished", "done"]);
  if (
    states.every(
      (state) => success.has(state.conclusion) || completed.has(state.status),
    )
  )
    return "passed";
  return "pending";
}

function collectRecords(
  value: unknown,
  containerKeys: string[],
): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of containerKeys) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [];
}

function scalar(value: unknown, paths: string[]): string | null {
  for (const path of paths) {
    let current: unknown = value;
    for (const part of path.split("."))
      current = isRecord(current) ? current[part] : undefined;
    if (typeof current === "string" && current.trim()) return current.trim();
    if (typeof current === "number" && Number.isFinite(current))
      return String(current);
  }
  return null;
}

function bool(value: unknown, paths: string[]): boolean {
  return paths.some((path) => {
    let current: unknown = value;
    for (const part of path.split("."))
      current = isRecord(current) ? current[part] : undefined;
    return current === true || current === 1 || current === "true";
  });
}

function field(
  record: Record<string, unknown>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
