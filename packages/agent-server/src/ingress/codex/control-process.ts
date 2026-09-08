import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sessionEnvironment } from "../../engines/session.js";
import { ProtocolError, ErrorCode } from "../../protocol/index.js";
import { NATIVE_METHOD_POLICY } from "./method-policy.js";

export type NativeObject = Record<string, any>;
export interface ControlClient {
  initialize(): Promise<NativeObject>;
  request(method: string, params?: NativeObject): Promise<NativeObject>;
  close(): Promise<void>;
}
export const CONTROL_METHODS = new Set(Object.keys(NATIVE_METHOD_POLICY).filter(method => NATIVE_METHOD_POLICY[method] === "control-read"));

/** Ingress-owned process: no thread is ever started here. */
export class ControlProcess implements ControlClient {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<NativeObject>;
  private dead = false;
  private sequence = 0;
  private buffer = "";
  private pending = new Map<string, { resolve: (value: NativeObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly options: { executable?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {}
  initialize(): Promise<NativeObject> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.dead) throw new Error("control process closed");
      const child = this.child = spawn(this.options.executable ?? "codex", ["app-server", "--listen", "stdio://"], {
        cwd: this.options.cwd, env: sessionEnvironment({}, this.options.env ?? process.env), stdio: "pipe",
      });
      child.stdout.setEncoding("utf8"); child.stderr.resume();
      child.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > 128 * 1024 * 1024) { this.fail(new Error("control frame exceeds 128 MiB")); return; }
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const frame = JSON.parse(line);
            if (frame.method) {
              if (frame.id != null) child.stdin.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: "as-ingress: control server requests are unsupported" } }) + "\n");
              continue;
            }
            const call = this.pending.get(frame.id);
            if (!call) continue;
            this.pending.delete(frame.id); clearTimeout(call.timer);
            if (frame.error) call.reject(new ProtocolError(frame.error.code, frame.error.message));
            else call.resolve(frame.result);
          } catch { this.fail(new Error("invalid control process JSON")); }
        }
      });
      child.on("error", error => this.fail(error)); child.stdin.on("error", error => this.fail(error));
      child.on("close", () => this.fail(new Error("control process exited")));
      const result = await this.call("initialize", { clientInfo: { name: "codex-tui", title: "AS Codex Ingress", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      return result;
    })();
    return this.starting;
  }
  async request(method: string, params: NativeObject = {}): Promise<NativeObject> {
    if (!CONTROL_METHODS.has(method)) throw new ProtocolError(-32601, `as-ingress: unsupported control method ${method}`);
    await this.initialize(); return this.call(method, params);
  }
  private call(method: string, params: NativeObject): Promise<NativeObject> {
    if (this.dead || !this.child) return Promise.reject(new ProtocolError(ErrorCode.engine_unavailable, "as-ingress: control process unavailable"));
    const id = `control_${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`control ${method} timed out`)); }, this.options.timeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  private fail(error: Error): void {
    this.dead = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear(); this.child?.kill("SIGTERM");
  }
  async close(): Promise<void> {
    const child = this.child;
    this.fail(new Error("control process closed"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end(); child.kill("SIGTERM");
    });
  }
}
