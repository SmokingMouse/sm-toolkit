export interface InboundTask {
  externalId: string
  prompt: string
  attachments?: string[]
  context?: Record<string, unknown>
}

export interface OutboundEvent {
  type: string
  data: unknown
}

export interface Channel {
  source: string
  subscribe(handler: (task: InboundTask) => void): Promise<void>
  emit(externalId: string, event: OutboundEvent): Promise<void>
  close?(): Promise<void>
}
