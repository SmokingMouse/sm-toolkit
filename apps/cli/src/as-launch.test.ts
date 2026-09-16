import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsTransportError } from './as-client.js'
import {
  assertIngressUrl,
  buildCodexArgv,
  endpointJsonPath,
  isPermission,
  NATIVE_TOKEN_ENV,
  nativeIdFromThreadId,
  permissionToCodexFlags,
  readAsEndpoint,
  resolveCodexBin,
} from './as-launch.js'

const INGRESS = 'ws://127.0.0.1:61378'
const NATIVE = 'e6654c29-b7c7-4e2b-a52d-9e5e25b3b558'
const BIN = '/opt/bin/codex'

// ── 四种 permission 各一条期望 argv ────────────────────────────

test('permission=readonly → read-only / never', () => {
  expect(buildCodexArgv({ codexBin: BIN, ingressUrl: INGRESS, nativeId: NATIVE, permission: 'readonly' })).toEqual([
    BIN,
    '--remote',
    INGRESS,
    '--remote-auth-token-env',
    'AS_NATIVE_TOKEN',
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    'resume',
    NATIVE,
  ])
})

test('permission=default → workspace-write / untrusted', () => {
  expect(buildCodexArgv({ codexBin: BIN, ingressUrl: INGRESS, nativeId: NATIVE, permission: 'default' })).toEqual([
    BIN,
    '--remote',
    INGRESS,
    '--remote-auth-token-env',
    'AS_NATIVE_TOKEN',
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'untrusted',
    'resume',
    NATIVE,
  ])
})

test('permission=auto-edit → workspace-write / on-request', () => {
  expect(buildCodexArgv({ codexBin: BIN, ingressUrl: INGRESS, nativeId: NATIVE, permission: 'auto-edit' })).toEqual([
    BIN,
    '--remote',
    INGRESS,
    '--remote-auth-token-env',
    'AS_NATIVE_TOKEN',
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'on-request',
    'resume',
    NATIVE,
  ])
})

test('permission=full → danger-full-access / never（对齐 --dangerously-skip-permissions）', () => {
  expect(buildCodexArgv({ codexBin: BIN, ingressUrl: INGRESS, nativeId: NATIVE, permission: 'full' })).toEqual([
    BIN,
    '--remote',
    INGRESS,
    '--remote-auth-token-env',
    'AS_NATIVE_TOKEN',
    '--sandbox',
    'danger-full-access',
    '--ask-for-approval',
    'never',
    'resume',
    NATIVE,
  ])
})

test('映射表与调研报告 §2.A 一致', () => {
  expect(permissionToCodexFlags('readonly')).toEqual({ sandbox: 'read-only', approval: 'never' })
  expect(permissionToCodexFlags('full')).toEqual({ sandbox: 'danger-full-access', approval: 'never' })
  expect(permissionToCodexFlags('auto-edit')).toEqual({ sandbox: 'workspace-write', approval: 'on-request' })
  expect(permissionToCodexFlags('default')).toEqual({ sandbox: 'workspace-write', approval: 'untrusted' })
})

test('token env 名可覆盖，默认是 AS_NATIVE_TOKEN', () => {
  expect(NATIVE_TOKEN_ENV).toBe('AS_NATIVE_TOKEN')
  const argv = buildCodexArgv({
    codexBin: BIN,
    ingressUrl: INGRESS,
    nativeId: NATIVE,
    permission: 'full',
    tokenEnv: 'OTHER_TOKEN',
  })
  expect(argv[argv.indexOf('--remote-auth-token-env') + 1]).toBe('OTHER_TOKEN')
})

test('isPermission 只认四个值', () => {
  expect(isPermission('full')).toBe(true)
  expect(isPermission('auto-edit')).toBe(true)
  expect(isPermission('bypassPermissions')).toBe(false)
})

// ── nativeId ────────────────────────────────────────────────

test('nativeId = thread.id 去掉 th_ 前缀', () => {
  expect(nativeIdFromThreadId(`th_${NATIVE}`)).toBe(NATIVE)
  expect(nativeIdFromThreadId(NATIVE)).toBe(NATIVE)
  expect(() => nativeIdFromThreadId('th_not-a-uuid')).toThrow(AsTransportError)
})

// ── endpoint 文件 ────────────────────────────────────────────

test('endpointJsonPath：SM_AS_ENDPOINT_JSON 优先，否则 HOME 下默认路径', () => {
  expect(endpointJsonPath({ HOME: '/Users/x' } as NodeJS.ProcessEnv)).toBe(
    '/Users/x/.sm-toolkit/agent-server.sock.endpoint.json',
  )
  expect(
    endpointJsonPath({ HOME: '/Users/x', SM_AS_ENDPOINT_JSON: '/tmp/ep.json' } as NodeJS.ProcessEnv),
  ).toBe('/tmp/ep.json')
})

test('readAsEndpoint 每次重读文件，端口变了就跟着变（不缓存）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-as-ep-'))
  const p = join(dir, 'ep.json')
  const env = { SM_AS_ENDPOINT_JSON: p } as NodeJS.ProcessEnv

  writeFileSync(p, JSON.stringify({ pid: 1, socketPath: '/s.sock', codexIngressUrl: 'ws://127.0.0.1:1111' }))
  expect(readAsEndpoint(env).codexIngressUrl).toBe('ws://127.0.0.1:1111')

  writeFileSync(p, JSON.stringify({ pid: 2, socketPath: '/s.sock', codexIngressUrl: 'ws://127.0.0.1:2222' }))
  expect(readAsEndpoint(env).codexIngressUrl).toBe('ws://127.0.0.1:2222')

  rmSync(dir, { recursive: true, force: true })
})

test('endpoint 文件缺失 / 坏 JSON / 缺 socketPath 都抛 AsTransportError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-as-ep-'))
  const p = join(dir, 'ep.json')
  const env = { SM_AS_ENDPOINT_JSON: p } as NodeJS.ProcessEnv

  expect(() => readAsEndpoint(env)).toThrow(AsTransportError)
  writeFileSync(p, 'not json')
  expect(() => readAsEndpoint(env)).toThrow(AsTransportError)
  writeFileSync(p, JSON.stringify({ pid: 1 }))
  expect(() => readAsEndpoint(env)).toThrow(AsTransportError)

  rmSync(dir, { recursive: true, force: true })
})

test('assertIngressUrl 只收 ws/wss 且禁止内嵌凭证', () => {
  expect(assertIngressUrl(INGRESS)).toBe(INGRESS)
  expect(() => assertIngressUrl(undefined)).toThrow(AsTransportError)
  expect(() => assertIngressUrl('http://127.0.0.1:1')).toThrow(AsTransportError)
  expect(() => assertIngressUrl('ws://u:p@127.0.0.1:1')).toThrow(AsTransportError)
})

// ── codex bin 解析 ──────────────────────────────────────────

test('resolveCodexBin：SM_AS_CODEX_BIN 覆盖，否则按 PATH 找', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-as-bin-'))
  const fake = join(dir, 'codex')
  writeFileSync(fake, '#!/bin/sh\n')
  chmodSync(fake, 0o755)

  expect(resolveCodexBin({ SM_AS_CODEX_BIN: fake, PATH: '' } as NodeJS.ProcessEnv)).toBe(fake)
  expect(resolveCodexBin({ PATH: dir } as NodeJS.ProcessEnv)).toBe(fake)
  expect(() => resolveCodexBin({ PATH: '/nonexistent-dir-xyz' } as NodeJS.ProcessEnv)).toThrow(
    AsTransportError,
  )

  rmSync(dir, { recursive: true, force: true })
})
