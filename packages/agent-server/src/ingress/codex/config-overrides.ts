import { ErrorCode, ProtocolError } from "../../protocol/index.js";
import type { NativeObject } from "./control-process.js";

// Native config is per-request input, never a config/write passthrough.
export const THREAD_CONFIG_FIELDS: Record<string, string> = {
  model: "model", model_reasoning_effort: "effort", reasoningEffort: "effort",
  sandbox_mode: "sandbox", sandbox: "sandbox", approval_policy: "approvalPolicy",
  approvalPolicy: "approvalPolicy", cwd: "cwd", personality: "personality",
  web_search: "webSearch",
  service_tier: "serviceTier", serviceTier: "serviceTier", approvals_reviewer: "approvalsReviewer",
};
export const LOCAL_CONFIG_FIELDS = new Set([
  "tui", "history", "desktop", "check_for_update_on_startup", "hide_agent_reasoning",
  "show_raw_agent_reasoning", "model_reasoning_summary", "model_verbosity",
  "file_opener", "preferred_auth_method", "feedback", "suppress_unstable_features_warning",
]);

export function splitConfigOverrides(input: NativeObject): { params: NativeObject; ignored: string[] } {
  const params = { ...input }, ignored: string[] = [];
  delete params.config;
  if (input.config == null) return { params, ignored };
  if (typeof input.config !== "object" || Array.isArray(input.config))
    throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: config must be an object");
  for (const [key, value] of Object.entries(input.config)) {
    const target = Object.hasOwn(THREAD_CONFIG_FIELDS, key) ? THREAD_CONFIG_FIELDS[key]! : undefined;
    if (target) {
      // Explicit native fields take precedence over config defaults, as in the TUI.
      if (params[target] == null) params[target] = value;
      // A non-default service tier/reviewer cannot be concealed by a top-level value.
      if (value != null && ((target === "serviceTier" && value !== "default") || (target === "approvalsReviewer" && value !== "user")))
        throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: unsupported config.${key}`);
    } else if (LOCAL_CONFIG_FIELDS.has(key) || ["tui.", "history.", "desktop."].some(prefix => key.startsWith(prefix))) {
      ignored.push(key);
    } else {
      throw new ProtocolError(ErrorCode.unsupported_capability, `as-ingress: unsupported config.${key}`);
    }
  }
  return { params, ignored };
}
