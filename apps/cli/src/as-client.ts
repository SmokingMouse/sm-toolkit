/**
 * as/1 客户端 —— unix socket + NDJSON 的最小实现，只覆盖 `llm --as` 起线程要用到的
 * 那几个方法（握手 / 健康 / 配置 / thread 生命周期）。
 *
 * 协议见 docs/agent-server/protocol.md：JSON-RPC 2.0，一条消息一行 NDJSON；
 * 连接的第一条消息必须是 `initialize`，随后发 `initialized` 通知才能发别的方法。
 */
import { createConnection, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const AS_PROTOCOL_VERSION = 'as/1'

/** 默认单请求超时；thread/start 要 spawn 引擎，单独放宽。 */
export const DEFAULT_TIMEOUT_MS = 5000
export const THREAD_START_TIMEOUT_MS = 15000

export type Permission = 'readonly' | 'default' | 'auto-edit' | 'full'

export interface ThreadStatus {
  type: 'spawning' | 'idle' | 'running' | 'interrupted' | 'systemError' | 'closed'
  error?: unknown
}

export interface Thread {
  id: string
  backend: 'claude' | 'codex' | 'external'
  engineThreadId: string | null
  status: ThreadStatus
  cwd: string
  model?: string
  title?: string
  permission?: Permission
  createdAtMs: number
}

export interface ServerConfig {
  allowed_roots: string[]
  [k: string]: unknown
}

export interface ThreadStartParams {
  backend: 'claude' | 'codex'
  cwd: string
  model: string
  permission: Permission
  effort?: string
  meta?: Record<string, unknown>
}

/** 一条 as/1 的 JSON-RPC error，带上足够翻译成人话的上下文。 */
export class AsRpcError extends Error {
  readonly code: number
  readonly data: any
  readonly method: string

  constructor(method: string, code: number, message: string, data?: any) {
    super(message)
    this.name = 'AsRpcError'
    this.code = code
    this.data = data
    this.method = method
  }

  /** `error.data.reason`，协议 §7 约定的机读原因（不解析文案）。 */
  get reason(): string | undefined {
    const r = this.data?.reason
    return typeof r === 'string' ? r : undefined
  }
}

/** 连接 / 超时 / 帧层面的失败（不是服务端给的 JSON-RPC error）。 */
export class AsTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AsTransportError'
  }
}

// ── 错误翻译 ────────────────────────────────────────────────

/**
 * `environment` = 环境类失败，调用方应静默回落本地；
 * `policy` = 策略类拒绝，调用方必须报错退出（用户明确要上 daemon 却被策略拒了，
 * 不能悄悄换路线）。
 */
export type AsFailureKind = 'environment' | 'policy'

export interface AsFailure {
  kind: AsFailureKind
  /** 给用户看的中文一句话。 */
  message: string
  code?: number
  reason?: string
}

export function translateAsError(e: unknown): AsFailure {
  if (e instanceof AsRpcError) {
    const detail = e.data?.detail ?? {}
    if (e.code === -32602 && e.reason === 'model_denied') {
      const model = detail.resolvedModel ?? detail.model ?? '该模型'
      const pattern = detail.pattern ?? '?'
      return {
        kind: 'policy',
        code: e.code,
        reason: e.reason,
        message: `${model} 被 agent-server 的 denied_models 拒绝（pattern: ${pattern}）。改用别的模型，或加 --local 走本地 claude 进程。`,
      }
    }
    if (e.code === -32602 && e.reason === 'model_required') {
      return {
        kind: 'policy',
        code: e.code,
        reason: e.reason,
        message: `agent-server 要求显式模型：${e.message}。给 llm 指定一个模型，或加 --local 走本地 claude 进程。`,
      }
    }
    if (e.code === -32005) {
      const isCwd = /allowed_roots/i.test(e.message)
      return {
        kind: 'environment',
        code: e.code,
        reason: e.reason,
        message: isCwd
          ? `当前目录不在 daemon 的 allowed_roots 内（${e.message}）`
          : `agent-server 拒绝授权（-32005 unauthorized）：${e.message}`,
      }
    }
    if (e.code === -32004) {
      const stderr = typeof e.data?.stderr === 'string' ? e.data.stderr.trim().slice(-200) : ''
      return {
        kind: 'environment',
        code: e.code,
        reason: e.reason,
        message: `agent-server 起不来引擎（-32004 engine_unavailable）：${e.message}${stderr ? ` / ${stderr}` : ''}`,
      }
    }
    return {
      kind: 'environment',
      code: e.code,
      reason: e.reason,
      message: `as/1 ${e.method} 失败（${e.code}）：${e.message}`,
    }
  }
  if (e instanceof AsTransportError) {
    return { kind: 'environment', message: e.message }
  }
  return { kind: 'environment', message: String((e as any)?.message ?? e) }
}

// ── 路径 ────────────────────────────────────────────────────

export interface AsPaths {
  socketPath: string
  tokenPath: string
}

/** 与 fj / agent-server 一致的默认 socket / token 位置。 */
export function asPaths(env: NodeJS.ProcessEnv = process.env): AsPaths {
  const home = env.HOME || homedir()
  const state =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : undefined
  const runtime =
    env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : undefined
  const base = runtime || state
  return {
    socketPath: resolve(
      env.AGENT_SERVER_SOCKET_PATH ||
        (base
          ? join(base, 'sm-toolkit', 'agent-server.sock')
          : join(home, '.sm-toolkit', 'agent-server.sock')),
    ),
    tokenPath: state
      ? join(state, 'sm-toolkit', 'agent-server', 'token')
      : join(home, '.agent-server', 'token'),
  }
}

export function readAsToken(tokenPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = tokenPath ?? asPaths(env).tokenPath
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (e: any) {
    throw new AsTransportError(`读不到 agent-server token（${path}）：${e?.message ?? e}`)
  }
  const token = raw.trim()
  if (!token) throw new AsTransportError(`agent-server token 文件为空（${path}）`)
  return token
}

// ── 客户端 ──────────────────────────────────────────────────

interface Pending {
  resolve: (v: any) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

const MAX_BUFFER = 32 * 1024 * 1024

export interface AsClientOptions {
  socketPath: string
  tokenPath?: string
  env?: NodeJS.ProcessEnv
  connectTimeoutMs?: number
  clientLabel?: string
}

export class AsClient {
  #socket: Socket
  #buffer = ''
  #seq = 0
  #pending = new Map<number, Pending>()
  #closed = false
  #closeReason: unknown = null

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.setEncoding('utf-8')
    socket.on('error', (e) => this.#fail(new AsTransportError(`AS 连接错误：${e.message}`)))
    socket.on('close', () =>
      this.#fail(new AsTransportError('AS 连接已关闭')),
    )
    socket.on('data', (chunk: string) => this.#onData(chunk))
  }

  #fail(e: unknown) {
    this.#closed = true
    this.#closeReason ??= e
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer)
      p.reject(e)
    }
    this.#pending.clear()
  }

  #onData(chunk: string) {
    this.#buffer += chunk
    if (this.#buffer.length > MAX_BUFFER) {
      this.#fail(new AsTransportError('AS 帧过大'))
      this.#socket.destroy()
      return
    }
    let end: number
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      if (!line.trim()) continue
      let frame: any
      try {
        frame = JSON.parse(line)
      } catch {
        this.#fail(new AsTransportError('AS 返回了非 JSON 帧'))
        this.#socket.destroy()
        return
      }
      if (frame.id == null) continue // 通知，本客户端不订阅
      const p = this.#pending.get(frame.id)
      if (!p) continue
      this.#pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.error) {
        p.reject(
          new AsRpcError(
            p.method,
            frame.error.code ?? -32603,
            String(frame.error.message ?? 'unknown error'),
            frame.error.data,
          ),
        )
      } else {
        p.resolve(frame.result)
      }
    }
  }

  request<T = any>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((res, rej) => {
      if (this.#closed || this.#socket.destroyed) {
        rej(this.#closeReason ?? new AsTransportError('AS 连接已关闭'))
        return
      }
      const id = ++this.#seq
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rej(new AsTransportError(`as/1 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, { resolve: res, reject: rej, timer, method })
      this.#socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method: string, params: unknown): void {
    if (this.#closed || this.#socket.destroyed) return
    this.#socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** 连接 + initialize + initialized，返回可用的客户端。 */
  static async connect(opts: AsClientOptions): Promise<AsClient> {
    const token = readAsToken(opts.tokenPath, opts.env)
    const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS
    const socket = createConnection({ path: opts.socketPath })
    try {
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => {
          socket.destroy()
          rej(new AsTransportError(`连不上 agent-server socket（${opts.socketPath}，超时）`))
        }, connectTimeoutMs)
        socket.once('connect', () => {
          clearTimeout(timer)
          res()
        })
        socket.once('error', (e: any) => {
          clearTimeout(timer)
          rej(new AsTransportError(`连不上 agent-server socket（${opts.socketPath}）：${e?.message ?? e}`))
        })
      })
    } catch (e) {
      socket.destroy()
      throw e
    }

    const client = new AsClient(socket)
    try {
      await client.request('initialize', {
        protocolVersion: AS_PROTOCOL_VERSION,
        token,
        client: {
          name: 'llm',
          version: '1',
          kind: 'cli',
          label: opts.clientLabel ?? 'llm --as launcher',
        },
        // 只起线程，不渲染审批；审批由 Codex TUI 那条连接接手。
        capabilities: { pendingRequests: false, serverRequests: [] },
      })
    } catch (e) {
      client.close()
      throw e
    }
    client.notify('initialized', {})
    return client
  }

  // ── 方法门面 ──────────────────────────────────────────────

  health(): Promise<any> {
    return this.request('server/health', {})
  }

  configRead(): Promise<ServerConfig> {
    return this.request<ServerConfig>('server/config/read', {})
  }

  async threadStart(params: ThreadStartParams): Promise<Thread> {
    const r = await this.request<{ thread: Thread }>(
      'thread/start',
      params,
      THREAD_START_TIMEOUT_MS,
    )
    return r.thread
  }

  async threadRead(threadId: string): Promise<Thread> {
    const r = await this.request<{ thread: Thread }>('thread/read', { threadId })
    return r.thread
  }

  async threadClose(threadId: string, reason?: string): Promise<void> {
    await this.request('thread/close', reason ? { threadId, reason } : { threadId })
  }

  close(): void {
    this.#closed = true
    for (const p of this.#pending.values()) clearTimeout(p.timer)
    this.#pending.clear()
    this.#socket.removeAllListeners('close')
    this.#socket.removeAllListeners('error')
    this.#socket.on('error', () => {})
    this.#socket.destroy()
  }
}

/** cwd 是否落在 daemon 的 allowed_roots 里（与 fj 的判据一致）。 */
export function isCwdAllowed(cwd: string, allowedRoots: string[] | undefined): boolean {
  if (!allowedRoots || allowedRoots.length === 0) return false
  return allowedRoots.some((r) => cwd === r || cwd.startsWith(r.replace(/\/$/, '') + '/'))
}
