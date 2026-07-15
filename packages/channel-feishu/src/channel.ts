import {
  createLarkChannel,
  LoggerLevel,
  type LarkChannel,
  type NormalizedMessage,
  type CardActionEvent,
} from '@larksuiteoapi/node-sdk'
import type {
  Channel,
  IncomingMessage,
  IncomingAction,
  Content,
} from '@sm/agent'
import type { FeishuChannelConfig } from './types.js'
import { renderContent } from './cards.js'

export class FeishuChannel implements Channel {
  readonly source = 'feishu'

  #config: FeishuChannelConfig
  #botName: string
  #lark!: LarkChannel
  #messageHandler?: (msg: IncomingMessage) => Promise<void>
  #actionHandler?: (action: IncomingAction) => void | Promise<void>

  constructor(config: FeishuChannelConfig) {
    this.#config = config
    this.#botName = config.botName ?? 'SM Agent'
  }

  async connect(): Promise<void> {
    this.#lark = createLarkChannel({
      appId: this.#config.appId,
      appSecret: this.#config.appSecret,
      transport: 'websocket',
      loggerLevel: this.#config.loggerLevel ?? LoggerLevel.info,
      policy: {
        requireMention: this.#config.requireMention ?? false,
        dmMode: 'open',
      },
    })

    this.#lark.on('message', (msg) => {
      this.#onLarkMessage(msg).catch((err) => {
        console.error('[feishu] Error handling message:', err)
      })
    })

    this.#lark.on('cardAction', (evt) => {
      this.#onLarkCardAction(evt)
    })

    await this.#lark.connect()
    console.log('[feishu] Connected via WebSocket')
  }

  async close(): Promise<void> {}

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.#messageHandler = handler
  }

  onAction(handler: (action: IncomingAction) => void | Promise<void>): void {
    this.#actionHandler = handler
  }

  async reply(
    toMessageId: string,
    content: Content,
  ): Promise<string | null> {
    const card = renderContent(this.#botName, content)
    const resp = await this.#lark.rawClient.im.message.reply({
      path: { message_id: toMessageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        reply_in_thread: true,
      },
    })
    return (resp?.data as { message_id?: string })?.message_id ?? null
  }

  async update(messageId: string, content: Content): Promise<void> {
    const card = renderContent(this.#botName, content) as object
    await this.#lark.updateCard(messageId, card)
  }

  async send(
    userId: string,
    content: Content,
  ): Promise<string | null> {
    const card = renderContent(this.#botName, content)
    const resp = await this.#lark.rawClient.im.message.create({
      data: {
        receive_id: userId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      params: { receive_id_type: 'user_id' },
    })
    return (resp?.data as { message_id?: string })?.message_id ?? null
  }

  /** 群维度发送（automation 播报等）。Channel 接口之外的飞书专有能力，调用方持有具体类型时使用 */
  async sendToChat(chatId: string, content: Content): Promise<string | null> {
    const card = renderContent(this.#botName, content)
    const resp = await this.#lark.rawClient.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      params: { receive_id_type: 'chat_id' },
    })
    return (resp?.data as { message_id?: string })?.message_id ?? null
  }

  // ── internal adapters ─────────────────────────────────

  async #onLarkMessage(msg: NormalizedMessage): Promise<void> {
    if (!this.#messageHandler) return

    const text = msg.content?.trim()
    if (!text) return

    // rootId 优先：话题内回复的 rootId 始终指向原始消息，和第一条消息的 messageId 一致
    const threadId = msg.rootId ?? msg.threadId ?? msg.chatId ?? msg.messageId

    await this.#messageHandler({
      id: msg.messageId,
      threadId,
      chatId: msg.chatId ?? '',
      senderId: msg.senderId,
      text,
      chatType: msg.chatType === 'p2p' ? 'dm' : 'group',
    })
  }

  #onLarkCardAction(evt: CardActionEvent): void {
    if (!this.#actionHandler) return

    const operatorId = evt.operator.userId ?? evt.operator.openId
    const valueStr =
      typeof evt.action.value === 'string'
        ? evt.action.value
        : JSON.stringify(evt.action.value)

    try {
      const result = this.#actionHandler({ operatorId, messageId: evt.messageId, value: valueStr })
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error('[feishu] Error handling card action:', err)
        })
      }
    } catch (err) {
      console.error('[feishu] Error handling card action:', err)
    }
  }
}
