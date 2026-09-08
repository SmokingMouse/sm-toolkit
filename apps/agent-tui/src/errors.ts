export function errorCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : undefined;
}
export function leaseHolder(error: unknown): string | undefined {
  const holder = (error as { data?: { holder?: { label?: string; clientId?: string } } } | null)?.data?.holder;
  return holder?.label || holder?.clientId;
}
export function errorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case -32016: return `当前后端不支持此操作：${error instanceof Error ? error.message : String(error)}`;
    case -32008: return `当前引擎不支持或未开放此操作：${error instanceof Error ? error.message : String(error)}`;
    case -32012: return `另一客户端持有控制权${leaseHolder(error) ? `：${leaseHolder(error)}` : ""}；请其释放或等待租约到期，再 /takeover 重试`;
    case -32014: return "该请求已由其他客户端处理";
    // unauthorized also covers authentication and policy refusals; do not call all of them lease failures.
    case -32005: return `未获授权：${error instanceof Error ? error.message : String(error)}`;
    default: return error instanceof Error ? error.message : String(error);
  }
}
