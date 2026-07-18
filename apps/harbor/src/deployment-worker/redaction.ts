import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { DeploymentTargetConfig } from "../config.js";

const PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)(?:bearer|basic)?\s*[^\s,;]+/gi,
  /(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /((?:token|password|passwd|secret|credential)\s*[:=]\s*)[^\s,;]+/gi,
  /([?&](?:access_token|token|password|secret)=)[^&#\s]+/gi,
  /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi,
];

const CREDENTIAL_ARG = /(?:^|[-_])(?:authorization|auth|token|password|passwd|secret|credential)(?:$|[-_:=])/i;

export function targetSensitiveValues(target: DeploymentTargetConfig): string[] {
  return [
    target.repositoryPath,
    target.releasesPath,
    target.currentSymlinkPath,
    target.sqlitePath,
    target.statePath,
    target.health.url,
    target.source.remoteUrl,
    ...target.services.flatMap((service) => [service.plistPath, service.templatePath]),
    ...Object.values(target.health.headers),
  ].filter(Boolean).sort((left, right) => right.length - left.length);
}

export function redactStructured(value: string, configuredSecrets: string[] = []): string {
  let redacted = value;
  for (const secret of configuredSecrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(secret, "[redacted]");
  }
  for (const pattern of PATTERNS) redacted = redacted.replace(pattern, "$1[redacted]");
  return redacted;
}

export function assertSafeArgv(argv: string[], configuredSecrets: string[] = []): void {
  for (const argument of argv) {
    if (configuredSecrets.some((secret) => secret && argument.includes(secret))
      || CREDENTIAL_ARG.test(argument)
      || /^(?:bearer|basic)$/i.test(argument.trim())
      || PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(argument);
      })) {
      throw new Error("command argv 包含 credential-like value；secret 禁止进入 argv");
    }
  }
}

/** launchd template也不能成为绕过secret reference模型的credential持久化通道。 */
export function assertNoCredentialMaterial(value: string, configuredSecrets: string[] = []): void {
  if (configuredSecrets.some((secret) => secret && value.includes(secret))) {
    throw new Error("launchd template 包含配置 secret；health credential 只能保留在 worker 内存");
  }
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) throw new Error("launchd template 包含 credential-like material");
  }
  if (/<(?:key|string)>\s*(?:--?[A-Za-z0-9_-]*(?:authorization|auth|token|password|passwd|secret|credential)[A-Za-z0-9_-]*|(?:HARBOR|GITHUB)_[A-Z0-9_]*(?:AUTH|TOKEN|PASSWORD|SECRET|CREDENTIAL)[A-Z0-9_]*)\s*<\/(?:key|string)>/i.test(value)) {
    throw new Error("launchd template 包含 credential-like key/argument");
  }
}

/** audit 只保留 executable、argc 与不可逆 hash，不保存任何 argv value。 */
export function safeArgvAudit(argv: string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 16);
  return `$ ${basename(argv[0] ?? "unknown")} argc=${Math.max(0, argv.length - 1)} argv_sha256=${hash}`;
}
