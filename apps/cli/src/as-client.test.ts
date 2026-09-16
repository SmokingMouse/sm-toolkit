import { test, expect, afterEach } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AsClient,
  AsRpcError,
  AsTransportError,
  isCwdAllowed,
  readAsToken,
  translateAsError,
} from './as-client.js'

// ── fixture: 一个假的 as/1 server（NDJSON over unix socket） ──────────────

type Handler = (method: string, params: any) => any

interface Fixture {
  socketPath: string
  tokenPath: string
  server: Server
  seen: { method: string; params: any }[]
  close: () => void
}

const fixtures: Fixture[] = []

afterEach(() => {
  while (fixtures.length) fixtures.pop()!.close()
})

function startFixture(handler: Handler, token = 'fixture-token'): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'llm-as-test-'))
  const socketPath = join(dir, 'as.sock')
  const tokenPath = join(dir, 'token')
  writeFileSync(tokenPath, `${token}\n`)
  const seen: { method: string; params: any }[] = []
  const sockets: Socket[] = []

  const server = createServer((socket) => {
    sockets.push(socket)
    socket.setEncoding('utf-8')
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        const frame = JSON.parse(line)
        seen.push({ method: frame.method, params: frame.params })
        if (frame.id == null) continue // 通知
        let out: any
        try {
          out = { jsonrpc: '2.0', id: frame.id, result: handler(frame.method, frame.params) }
        } catch (e: any) {
          if (e?.__rpcError) out = { jsonrpc: '2.0', id: frame.id, error: e.__rpcError }
          else throw e
        }
        if (out.result === undefined && !out.error) continue // 故意不回（测超时）
        socket.write(JSON.stringify(out) + '\n')
      }
    })
  })

  const fixture: Fixture = {
    socketPath,
    tokenPath,
    server,
    seen,
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  fixtures.push(fixture)

  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve(fixture))
  })
}

function rpcError(code: number, message: string, data?: any): never {
  const e: any = new Error(message)
  e.__rpcError = { code, message, data }
  throw e
}

const THREAD = {
  id: 'th_e6654c29-b7c7-4e2b-a52d-9e5e25b3b558',
  backend: 'claude' as const,
  engineThreadId: null,
  status: { type: 'idle' as const },
  cwd: '/Users/someone/repo',
  model: 'claude-sonnet-5',
  permission: 'full' as const,
  createdAtMs: 1,
}

const okHandler: Handler = (method, params) => {
  switch (method) {
    case 'initialize':
      if (params?.protocolVersion !== 'as/1') rpcError(-32003, 'unsupported_protocol_version')
      if (params?.token !== 'fixture-token') rpcError(-32005, 'bad token')
      return {
        protocolVersion: 'as/1',
        server: { name: 'agent-server', version: '0.1.0' },
        clientId: 'c_test',
        capabilities: { backends: ['claude', 'codex'] },
      }
    case 'server/health':
      return { uptimeMs: 1234, threads: { running: 0, idle: 1, closed: 0 }, engines: [] }
    case 'server/config/read':
      return { allowed_roots: ['/Users/someone'] }
    case 'thread/start':
      return { thread: { ...THREAD, ...params } }
    case 'thread/read':
      return { thread: THREAD }
    case 'thread/close':
      return {}
    default:
      rpcError(-32601, `method not found: ${method}`)
  }
}

// ── 握手 + 四个方法 ───────────────────────────────────────────

test('握手后 health / config/read / thread start-read-close 都跑通', async () => {
  const fx = await startFixture(okHandler)
  const client = await AsClient.connect({ socketPath: fx.socketPath, tokenPath: fx.tokenPath })

  expect(fx.seen[0]!.method).toBe('initialize')
  expect(fx.seen[0]!.params.protocolVersion).toBe('as/1')

  const health = await client.health()
  expect(health.uptimeMs).toBe(1234)

  const config = await client.configRead()
  expect(config.allowed_roots).toEqual(['/Users/someone'])

  const thread = await client.threadStart({
    backend: 'claude',
    cwd: '/Users/someone/repo',
    model: 'claude-sonnet-5',
    permission: 'full',
  })
  expect(thread.id).toBe(THREAD.id)
  expect(thread.backend).toBe('claude')

  const read = await client.threadRead(thread.id)
  expect(read.id).toBe(THREAD.id)

  await client.threadClose(thread.id, 'test')
  expect(fx.seen.map((s) => s.method)).toEqual([
    'initialize',
    'initialized',
    'server/health',
    'server/config/read',
    'thread/start',
    'thread/read',
    'thread/close',
  ])
  client.close()
})

test('token 不对时 initialize 抛 AsRpcError', async () => {
  const fx = await startFixture(okHandler, 'wrong-token')
  await expect(
    AsClient.connect({ socketPath: fx.socketPath, tokenPath: fx.tokenPath }),
  ).rejects.toThrow(AsRpcError)
})

test('连不上 socket 时抛 AsTransportError 而不是裸 ENOENT', async () => {
  await expect(
    AsClient.connect({
      socketPath: join(tmpdir(), 'llm-as-test-does-not-exist.sock'),
      tokenPath: writeThrowawayToken(),
    }),
  ).rejects.toThrow(AsTransportError)
})

function writeThrowawayToken(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-as-tok-'))
  const p = join(dir, 'token')
  writeFileSync(p, 'fixture-token')
  return p
}

test('请求超时被翻成 environment 类失败', async () => {
  const fx = await startFixture((method, params) => {
    if (method === 'initialize') return okHandler(method, params)
    return undefined // 故意不回
  })
  const client = await AsClient.connect({ socketPath: fx.socketPath, tokenPath: fx.tokenPath })
  const err = await client.request('server/health', {}, 80).catch((e) => e)
  expect(err).toBeInstanceOf(AsTransportError)
  expect(translateAsError(err).kind).toBe('environment')
  client.close()
})

// ── 四种错误码翻译（都走真 socket，不是造对象） ────────────────

async function failingStart(error: { code: number; message: string; data?: any }) {
  const fx = await startFixture((method, params) => {
    if (method === 'thread/start') rpcError(error.code, error.message, error.data)
    return okHandler(method, params)
  })
  const client = await AsClient.connect({ socketPath: fx.socketPath, tokenPath: fx.tokenPath })
  const e = await client
    .threadStart({ backend: 'claude', cwd: '/tmp', model: 'm', permission: 'full' })
    .catch((x) => x)
  client.close()
  return translateAsError(e)
}

test('-32005 cwd 不在 allowed_roots → environment，原因含 allowed_roots', async () => {
  const f = await failingStart({ code: -32005, message: 'cwd is outside allowed_roots' })
  expect(f.kind).toBe('environment')
  expect(f.code).toBe(-32005)
  expect(f.message).toContain('allowed_roots')
})

test('-32602 model_denied → policy，含 denied 与 pattern 与 --local 提示', async () => {
  const f = await failingStart({
    code: -32602,
    message: 'execution model is denied',
    data: {
      reason: 'model_denied',
      detail: {
        backend: 'claude',
        model: 'claude-fable-5',
        resolvedModel: 'claude-fable-5',
        pattern: 'claude-fable*',
        hint: 'Choose a model permitted by daemon denied_models.',
      },
    },
  })
  expect(f.kind).toBe('policy')
  expect(f.reason).toBe('model_denied')
  expect(f.message).toContain('denied_models')
  expect(f.message).toContain('claude-fable*')
  expect(f.message).toContain('--local')
})

test('-32602 model_required → policy', async () => {
  const f = await failingStart({
    code: -32602,
    message: 'an explicit execution model is required',
    data: { reason: 'model_required', detail: { hint: 'set default_model' } },
  })
  expect(f.kind).toBe('policy')
  expect(f.reason).toBe('model_required')
  expect(f.message).toContain('--local')
})

test('-32004 engine_unavailable → environment，带 stderr 尾部', async () => {
  const f = await failingStart({
    code: -32004,
    message: 'engine spawn failed',
    data: { reason: 'engine_unavailable', stderr: 'claude: command not found' },
  })
  expect(f.kind).toBe('environment')
  expect(f.code).toBe(-32004)
  expect(f.message).toContain('engine_unavailable')
  expect(f.message).toContain('command not found')
})

// ── 辅助 ────────────────────────────────────────────────────

test('isCwdAllowed 只认根本身与其子路径', () => {
  expect(isCwdAllowed('/Users/someone', ['/Users/someone'])).toBe(true)
  expect(isCwdAllowed('/Users/someone/repo', ['/Users/someone'])).toBe(true)
  expect(isCwdAllowed('/Users/someone-evil', ['/Users/someone'])).toBe(false)
  expect(isCwdAllowed('/private/tmp', ['/Users/someone'])).toBe(false)
  expect(isCwdAllowed('/Users/someone', [])).toBe(false)
  expect(isCwdAllowed('/Users/someone', undefined)).toBe(false)
})

test('readAsToken 去掉尾部换行；空文件报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-as-tok-'))
  const good = join(dir, 'token')
  writeFileSync(good, '  abc123\n')
  expect(readAsToken(good)).toBe('abc123')
  const empty = join(dir, 'empty')
  writeFileSync(empty, '\n')
  expect(() => readAsToken(empty)).toThrow(AsTransportError)
  expect(() => readAsToken(join(dir, 'nope'))).toThrow(AsTransportError)
  rmSync(dir, { recursive: true, force: true })
})
