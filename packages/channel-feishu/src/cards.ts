import type { Content, ModelGroup, ContentAction, CommandInfo } from '@sm/agent'

const MAX_TEXT_LENGTH = 4000

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text
  return text.slice(0, MAX_TEXT_LENGTH - 20) + '\n\n...(输出已截断)'
}

function card(
  title: string,
  template: string,
  elements: unknown[],
) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements,
  }
}

function buildPendingCard(botName: string) {
  return card(botName, 'turquoise', [
    { tag: 'div', text: { tag: 'lark_md', content: '⏳ 正在处理中...' } },
  ])
}

function buildResultCard(
  botName: string,
  text: string,
  metadata?: string,
) {
  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: truncate(text || '(empty response)') } },
  ]
  if (metadata) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: metadata }],
    })
  }
  return card(botName, 'blue', elements)
}

function buildErrorCard(botName: string, message: string) {
  return card(`${botName} - Error`, 'red', [
    { tag: 'div', text: { tag: 'lark_md', content: message } },
  ])
}

function buildModelSelectorCard(
  current: string | undefined,
  groups: ModelGroup[],
) {
  const buttons = groups.flatMap((g) =>
    g.models.map((m) => ({
      tag: 'button' as const,
      text: {
        tag: 'plain_text' as const,
        content: `${m.isCurrent ? '● ' : ''}${g.provider} / ${m.name}`,
      },
      type: (m.isCurrent ? 'primary' : 'default') as 'primary' | 'default',
      value: m.actionValue,
    })),
  )

  return card('选择模型', 'indigo', [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `当前: **${current ?? 'default'}**\n选择后对当前会话生效`,
      },
    },
    { tag: 'action', actions: buttons },
  ])
}

function buildApprovalCard(
  userName: string,
  source: string,
  originalMessage: string,
  actions: ContentAction[],
) {
  const snippet =
    originalMessage.length > 200
      ? originalMessage.slice(0, 200) + '...'
      : originalMessage

  const buttons = actions.map((a) => ({
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: a.label },
    type: (a.style === 'danger' ? 'danger' : 'primary') as
      | 'primary'
      | 'danger',
    value: a.value,
  }))

  return card('新用户请求使用 Agent', 'orange', [
    {
      tag: 'div',
      fields: [
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**用户**\n${userName}` },
        },
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**来源**\n${source}` },
        },
      ],
    },
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**首条消息**\n${snippet}` },
    },
    { tag: 'action', actions: buttons },
  ])
}

function buildHelpCard(botName: string, commands: CommandInfo[]) {
  const lines = ['**可用命令：**', '']
  for (const c of commands) {
    lines.push(`\`${c.command}\` — ${c.description}`)
  }
  return card(botName, 'blue', [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
  ])
}

export function renderContent(
  botName: string,
  content: Content,
): unknown {
  switch (content.type) {
    case 'pending':
      return buildPendingCard(botName)
    case 'result':
      return buildResultCard(botName, content.text, content.metadata)
    case 'error':
      return buildErrorCard(botName, content.message)
    case 'model_selector':
      return buildModelSelectorCard(content.current, content.groups)
    case 'approval_request':
      return buildApprovalCard(
        content.userName,
        content.source,
        content.originalMessage,
        content.actions,
      )
    case 'help':
      return buildHelpCard(botName, content.commands)
  }
}
