/**
 * Agent environment 只能配置业务变量，不能改写 Runtime 身份或配置根。
 * 这些变量会改变实际启动的 CLI / Skill discovery roots；允许覆盖会让 server 侧
 * 校验与 daemon 真实执行产生分叉。
 */
export const RESERVED_AGENT_ENVIRONMENT_KEYS = new Set([
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "PATH",
]);

export function assertAgentEnvironmentSafe(environment: Record<string, string>): void {
  const blocked = Object.keys(environment)
    .filter((key) => RESERVED_AGENT_ENVIRONMENT_KEYS.has(key.toUpperCase()))
    .sort();
  if (blocked.length > 0) {
    throw new Error(
      `Agent environment 不能覆盖 Runtime 保留变量：${blocked.join(", ")}`,
    );
  }
}
