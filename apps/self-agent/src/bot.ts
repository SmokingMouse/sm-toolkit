import {
  CLIRunner,
  type Channel,
  type IncomingMessage,
  type IncomingAction,
  type CLIEvent,
  type Cost,
  type Content,
  type ContentAction,
  type ModelGroup,
} from '@sm/agent'
import { loadConfig, listAvailableModels } from './config.js'
import { getSession, saveSession, touchSession } from './store.js'

const runner = new CLIRunner()

const NATIVE_KEY = '__native__'
const STREAM_INTERVAL_MS = 800
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude 原生',
  'ark-coding': '方舟 Coding Plan',
  deepseek: 'DeepSeek 直连',
  gemini: 'Gemini',
}

// ── per-thread endpoint override (in-memory) ───────────

const threadEndpoints = new Map<string, string>()
const operatorEndpoints = new Map<string, string>()

// ── pending approvals ──────────────────────────────────

interface PendingApproval {
  userId: string
  threadId: string
  resolve: (approved: boolean) => void
}

const pendingApprovals = new Map<string, PendingApproval>()

// ── public API ─────────────────────────────────────────

export function registerHandlers(channel: Channel): void {
  channel.onMessage((msg) => handleMessage(channel, msg))
  channel.onAction((action) => handleAction(channel, action))
}

// ── message handler ────────────────────────────────────

async function handleMessage(channel: Channel, msg: IncomingMessage): Promise<void> {
  const { text, senderId, threadId } = msg
  if (!text.trim()) return

  const config = loadConfig()
  const adminId = config.server.admin.feishu_user_id
  console.log(`[bot] ${msg.chatType} from=${senderId} thread=${threadId} text="${text.slice(0, 50)}"`)

  // apply pending endpoint from card callback
  const pendingEndpoint = operatorEndpoints.get(senderId)
  if (pendingEndpoint) {
    if (pendingEndpoint === NATIVE_KEY) {
      threadEndpoints.delete(threadId)
    } else {
      threadEndpoints.set(threadId, pendingEndpoint)
    }
    operatorEndpoints.delete(senderId)
  }

  // ── ACL ──────────────────────────────────────────────
  if (msg.chatType === 'dm') {
    if (adminId && senderId !== adminId) {
      await channel.reply(msg.id, { type: 'error', message: '仅管理员可私聊使用。' })
      return
    }
  }

  if (msg.chatType === 'group') {
    if (adminId && senderId !== adminId) {
      const session = getSession(threadId)
      if (!session) {
        const approved = await requestThreadApproval(channel, adminId, senderId, threadId, text)
        if (!approved) {
          await channel.reply(msg.id, { type: 'error', message: '管理员未批准此请求。' })
          return
        }
      }
    }
  }

  // ── commands ─────────────────────────────────────────
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0]!.toLowerCase()

    if (cmd === '/model' || cmd === '/模型') {
      const existing = getSession(threadId)
      const currentEndpoint = threadEndpoints.get(threadId) ?? existing?.endpoint
      const content = buildModelSelectorContent(currentEndpoint)
      await channel.reply(msg.id, content)
      return
    }

    if (cmd === '/help' || cmd === '/帮助') {
      await channel.reply(msg.id, {
        type: 'help',
        commands: [
          { command: '/model', description: '切换模型' },
          { command: '/new', description: '开始新对话' },
          { command: '/help', description: '显示帮助' },
        ],
      })
      return
    }

    if (cmd === '/new' || cmd === '/新对话') {
      const endpoint = threadEndpoints.get(threadId) ?? config.harness.endpoint
      saveSession(threadId, '', endpoint)
      await channel.reply(msg.id, { type: 'result', text: '已开始新对话。' })
      return
    }
  }

  // ── execute with streaming ───────────────────────────
  const pendingMsgId = await channel.reply(msg.id, { type: 'pending' })

  try {
    let lastUpdateTime = 0
    let pendingFlush: ReturnType<typeof setTimeout> | null = null
    let lastFlushedText = ''

    const flushUpdate = (text: string) => {
      if (!pendingMsgId || text === lastFlushedText) return
      lastFlushedText = text
      channel.update(pendingMsgId, { type: 'result', text, metadata: '⏳ 生成中...' }).catch(() => {})
    }

    const result = await chat(threadId, text, {
      onText: (_delta, accumulated) => {
        const now = Date.now()
        if (pendingFlush) clearTimeout(pendingFlush)

        if (now - lastUpdateTime >= STREAM_INTERVAL_MS) {
          lastUpdateTime = now
          flushUpdate(accumulated)
        } else {
          pendingFlush = setTimeout(() => {
            lastUpdateTime = Date.now()
            flushUpdate(accumulated)
          }, STREAM_INTERVAL_MS - (now - lastUpdateTime))
        }
      },
    })

    if (pendingFlush) clearTimeout(pendingFlush)

    const metadata = formatMetadata(result.cost, result.durationMs)
    const content: Content = { type: 'result', text: result.text, metadata }

    if (pendingMsgId) {
      await channel.update(pendingMsgId, content)
    } else {
      await channel.reply(msg.id, content)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const content: Content = { type: 'error', message: `处理失败: ${message}` }

    if (pendingMsgId) {
      await channel.update(pendingMsgId, content)
    } else {
      await channel.reply(msg.id, content)
    }
  }
}

// ── action handler ─────────────────────────────────────

async function handleAction(channel: Channel, action: IncomingAction): Promise<void> {
  let value: Record<string, string>
  try {
    const parsed = JSON.parse(action.value)
    value = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
  } catch {
    return
  }

  if (value.cmd === 'set_endpoint') {
    const endpoint = value.endpoint!
    operatorEndpoints.set(action.operatorId, endpoint)
    const label = endpoint === NATIVE_KEY ? 'Claude 原生' : endpoint
    console.log(`[bot] user ${action.operatorId} selected endpoint: ${label}`)

    const updatedContent = buildModelSelectorContent(
      endpoint === NATIVE_KEY ? undefined : endpoint,
    )
    await channel.update(action.messageId, updatedContent)
    return
  }

  if (value.cmd === 'thread_approval') {
    const pending = pendingApprovals.get(value.id!)
    if (!pending) return

    const config = loadConfig()
    if (action.operatorId !== config.server.admin.feishu_user_id) return

    pendingApprovals.delete(value.id!)
    pending.resolve(value.action === 'approve')
  }
}

// ── model selector ─────────────────────────────────────

function buildModelSelectorContent(currentEndpoint?: string): Content {
  const rawGroups = listAvailableModels()

  const groups: ModelGroup[] = rawGroups.map((g) => ({
    provider: PROVIDER_LABELS[g.provider] ?? g.provider,
    models: g.isNative
      ? [{
          name: '原生 Harness',
          isCurrent: !currentEndpoint,
          actionValue: JSON.stringify({ cmd: 'set_endpoint', endpoint: NATIVE_KEY }),
        }]
      : g.models.map((m) => ({
          name: m,
          isCurrent: m === currentEndpoint,
          actionValue: JSON.stringify({ cmd: 'set_endpoint', endpoint: m }),
        })),
  }))

  return {
    type: 'model_selector',
    current: currentEndpoint ?? 'Claude 原生',
    groups,
  }
}

// ── thread approval ────────────────────────────────────

async function requestThreadApproval(
  channel: Channel,
  adminId: string,
  userId: string,
  threadId: string,
  originalMessage: string,
): Promise<boolean> {
  const approvalId = crypto.randomUUID()
  const actions: ContentAction[] = [
    {
      label: '批准',
      style: 'primary',
      value: JSON.stringify({ cmd: 'thread_approval', id: approvalId, action: 'approve' }),
    },
    {
      label: '拒绝',
      style: 'danger',
      value: JSON.stringify({ cmd: 'thread_approval', id: approvalId, action: 'deny' }),
    },
  ]

  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(approvalId, { userId, threadId, resolve })

    setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId)
        resolve(false)
      }
    }, 5 * 60 * 1000)

    channel
      .send(adminId, {
        type: 'approval_request',
        userName: `user:${userId}`,
        source: `thread:${threadId}`,
        originalMessage,
        actions,
      })
      .catch(() => {
        pendingApprovals.delete(approvalId)
        resolve(false)
      })
  })
}

// ── chat ───────────────────────────────────────────────

interface ChatResult {
  text: string
  sessionId: string | null
  cost: Cost | null
  durationMs: number
}

interface ChatCallbacks {
  onText?: (delta: string, accumulated: string) => void
}

async function chat(
  threadId: string,
  prompt: string,
  callbacks?: ChatCallbacks,
): Promise<ChatResult> {
  const config = loadConfig()
  const existing = getSession(threadId)
  const endpoint = threadEndpoints.get(threadId) ?? existing?.endpoint ?? config.harness.endpoint

  const events: CLIEvent[] = []
  const startTime = Date.now()
  let accumulated = ''

  for await (const event of runner.run(prompt, {
    endpoint,
    workspace: config.harnessDir,
    permission: config.harness.permission,
    sessionId: existing?.sessionId,
  })) {
    events.push(event)

    if (event.type === 'text') {
      accumulated += event.text
      callbacks?.onText?.(event.text, accumulated)
    }
  }

  const durationMs = Date.now() - startTime
  const resultEvent = events.find((e) => e.type === 'result')
  const text = resultEvent?.type === 'result' ? resultEvent.text : accumulated || collectText(events)
  const sessionId = resultEvent?.type === 'result' ? resultEvent.sessionId : null
  const cost = resultEvent?.type === 'result' ? resultEvent.cost : null

  if (sessionId) {
    saveSession(threadId, sessionId, endpoint)
  } else if (existing) {
    touchSession(threadId)
  }

  return { text, sessionId, cost, durationMs }
}

function collectText(events: CLIEvent[]): string {
  return events
    .filter((e) => e.type === 'text')
    .map((e) => (e as Extract<CLIEvent, { type: 'text' }>).text)
    .join('')
}

function formatMetadata(cost: Cost | null, durationMs: number): string | undefined {
  const parts: string[] = []
  if (durationMs > 0) parts.push(`${(durationMs / 1000).toFixed(1)}s`)
  if (cost) {
    if (cost.usd != null) parts.push(`$${cost.usd.toFixed(4)}`)
    parts.push(`${cost.inputTokens}→${cost.outputTokens} tokens`)
  }
  return parts.length > 0 ? parts.join(' | ') : undefined
}
