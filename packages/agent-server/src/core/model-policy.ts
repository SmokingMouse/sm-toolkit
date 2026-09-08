import { ErrorCode, ProtocolError, type Thread } from "../protocol/index.js";

export interface ModelPolicyOptions { defaultModel?: string }

/** Resolve only the daemon's explicit default; never defer to engine/environment defaults. */
export function executionModel(value: unknown, backend: Thread["backend"], options: ModelPolicyOptions, threadId: string): string {
  const model = value == null || value === "default" ? options.defaultModel : value;
  if (typeof model !== "string" || !model.trim() || model.trim().toLowerCase() === "default") {
    throw new ProtocolError(ErrorCode.invalid_params, "an explicit execution model is required", {
      threadId, reason: "model_required",
      detail: { backend, hint: "Pass a nonempty model, inherit a saved explicit model on resume/fork, or configure daemon default_model. Engine/environment defaults are disabled." },
    });
  }
  return model.trim();
}
