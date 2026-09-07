import { renameSync, writeFileSync } from "node:fs";
import type { StartThreadParams, Thread } from "@smokingmouse/agent-server/protocol";
import type { Options } from "./options.js";

export function threadStartParams(o: Options): StartThreadParams {
  return { backend: o.backend!, cwd: o.cwd, permission: o.permission, model: o.model, serviceTier: o.serviceTier, fjContext: o.fjContext, clientThreadId: o.clientThreadId };
}
export function publishReady(o: Options, thread: Thread | undefined): void {
  if (!o.readyFile) return;
  if (!thread || !["idle", "running"].includes(thread.status.type)) throw new Error("Thread requires explicit resume; ready not published");
  if (thread.clientThreadId !== o.clientThreadId || thread.backend !== o.backend || thread.cwd !== o.cwd) throw new Error("Thread identity does not match ready request");
  const tmp = `${o.readyFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ nonce: o.readyNonce, threadId: thread.id, clientThreadId: o.clientThreadId, backend: thread.backend, cwd: thread.cwd }), { mode: 0o600, flag: "wx" });
  renameSync(tmp, o.readyFile);
}
