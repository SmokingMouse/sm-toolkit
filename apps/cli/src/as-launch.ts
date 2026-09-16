/**
 * `llm --as` 的启动侧：读 daemon endpoint 文件、探测 codex 二进制、把 AS 的
 * permission 映射成 Codex TUI 的 sandbox / approval，并拼出最终 argv。
 *
 * 形状参照 fj 的 codex-tui runner（skills/herdr-leader/scripts/fj.js 的
 * codexRemoteConfig / codexRemoteCommand）。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { AsTransportError, type Permission } from './as-client.js'

/** codex 侧读 token 的环境变量名（`--remote-auth-token-env` 的实参）。 */
export const NATIVE_TOKEN_ENV = 'AS_NATIVE_TOKEN'

export const PERMISSIONS: readonly Permission[] = ['readonly', 'default', 'auto-edit', 'full']

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v)
}

export interface AsEndpoint {
  pid?: number
  socketPath: string
  codexIngressUrl?: string
  codexIngressUnixUrl?: string
}

/** endpoint 文件路径：`SM_AS_ENDPOINT_JSON` 优先，否则 `~/.sm-toolkit/agent-server.sock.endpoint.json`。 */
export function endpointJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SM_AS_ENDPOINT_JSON?.trim()
  if (override) return override
  const home = env.HOME || homedir()
  return join(home, '.sm-toolkit', 'agent-server.sock.endpoint.json')
}

/**
 * 每次都重读——ingress 端口每次 daemon 重启都会变，缓存等于埋雷
 * （调研报告 §2.A 边界条件最后一条）。
 */
export function readAsEndpoint(env: NodeJS.ProcessEnv = process.env): AsEndpoint {
  const path = endpointJsonPath(env)
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (e: any) {
    throw new AsTransportError(`读不到 agent-server endpoint 文件（${path}）：${e?.code ?? e?.message ?? e}`)
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new AsTransportError(`agent-server endpoint 文件不是合法 JSON（${path}）：${e?.message ?? e}`)
  }
  if (!parsed || typeof parsed.socketPath !== 'string' || !parsed.socketPath) {
    throw new AsTransportError(`agent-server endpoint 文件缺 socketPath（${path}）`)
  }
  return parsed as AsEndpoint
}

export interface CodexFlags {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval: 'never' | 'on-request' | 'untrusted'
}

/** 权限映射表，抄调研报告 §2.A（= fj.js codexRemoteCommand 的判据）。 */
export function permissionToCodexFlags(permission: Permission): CodexFlags {
  switch (permission) {
    case 'readonly':
      return { sandbox: 'read-only', approval: 'never' }
    case 'full':
      return { sandbox: 'danger-full-access', approval: 'never' }
    case 'auto-edit':
      return { sandbox: 'workspace-write', approval: 'on-request' }
    case 'default':
      return { sandbox: 'workspace-write', approval: 'untrusted' }
  }
}

/** 在 PATH 上找 codex；`SM_AS_CODEX_BIN` 可覆盖（可以是绝对路径或命令名）。 */
export function resolveCodexBin(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.SM_AS_CODEX_BIN?.trim() || 'codex'
  const found = whichSync(requested, env)
  if (!found) {
    throw new AsTransportError(
      `找不到 codex 可执行文件：${requested}（设 SM_AS_CODEX_BIN 或把 codex 放进 PATH）`,
    )
  }
  return found
}

function whichSync(cmd: string, env: NodeJS.ProcessEnv): string | null {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (cmd.includes('/')) return isFile(cmd) ? cmd : null
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, cmd)
    if (isFile(p)) return p
  }
  return null
}

/**
 * 能力探测：`codex --help` 里必须有 `--remote-auth-token-env`，否则这条路走不通
 * （fj.js checkCodexRemote 同款判据）。
 */
export function checkCodexRemoteSupport(codexBin: string): void {
  const help = spawnSync(codexBin, ['--help'], { encoding: 'utf-8', timeout: 10000 })
  const text = `${help.stdout ?? ''}${help.stderr ?? ''}`
  if (help.status !== 0 || !text.includes('--remote-auth-token-env')) {
    throw new AsTransportError(
      `codex 版本不支持 --remote/--remote-auth-token-env（${codexBin}）`,
    )
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude 线程的 native UUID = thread.id 去掉 `th_` 前缀（protocol.md §846）。 */
export function nativeIdFromThreadId(threadId: string): string {
  const id = threadId.startsWith('th_') ? threadId.slice(3) : threadId
  if (!UUID_RE.test(id)) {
    throw new AsTransportError(`AS 未返回可用于 Codex TUI resume 的 native UUID：${threadId}`)
  }
  return id
}

export interface CodexArgvInput {
  codexBin: string
  ingressUrl: string
  nativeId: string
  permission: Permission
  tokenEnv?: string
}

export function buildCodexArgv(input: CodexArgvInput): string[] {
  const { sandbox, approval } = permissionToCodexFlags(input.permission)
  return [
    input.codexBin,
    '--remote',
    input.ingressUrl,
    '--remote-auth-token-env',
    input.tokenEnv ?? NATIVE_TOKEN_ENV,
    '--sandbox',
    sandbox,
    '--ask-for-approval',
    approval,
    'resume',
    input.nativeId,
  ]
}

/** ingress URL 必须是 ws/wss 且不内嵌凭证（fj.js codexRemoteConfig 同款校验）。 */
export function assertIngressUrl(url: string | undefined): string {
  if (!url || !/^wss?:\/\//.test(url)) {
    throw new AsTransportError('endpoint 文件缺 codexIngressUrl（daemon 未启用 codex_ingress？）')
  }
  const parsed = new URL(url)
  if (parsed.username || parsed.password) {
    throw new AsTransportError('ingress URL 禁止内嵌凭证')
  }
  return url
}
