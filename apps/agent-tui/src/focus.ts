import type { TuiModel } from "./model.js";

export type Focus = "card" | "rewind" | "resume" | "busy" | "threads" | "fork" | "permissions" | "completion" | "input";

/** Top first. Rendering and key dispatch must consume the same stack. */
export function focusStack(model: TuiModel): Focus[] {
  return [
    ...(model.activeCard ? ["card" as const] : []),
    ...(model.rewindConfirmation ? ["rewind" as const] : []),
    ...(model.resumeConfirmation ? ["resume" as const] : []),
    ...(model.sessionOperation ? ["busy" as const] : []),
    ...(model.picker ? ["threads" as const] : []),
    ...(model.forkPicker ? ["fork" as const] : []),
    ...(model.permissionPicker !== undefined ? ["permissions" as const] : []),
    ...(model.completion ? ["completion" as const] : []),
    "input",
  ];
}

export function focusFooter(model: TuiModel): string {
  switch (focusStack(model)[0]) {
    case "card": return model.activeCard!.replying || model.activeCard!.state === "sending"
      ? "审批确认中 · 卡片草稿保留 · Enter 暂不受理 · Ctrl-C 中断"
      : model.sessionOperation === "/threads" ? "/threads 加载中 · 审批/问题卡可操作 · Ctrl-C 中断"
      : `审批/问题卡优先 · Ctrl-C 中断 · PgUp/PgDn 滚动${model.panelFocus === "history" ? "卡片" : model.panelFocus === "log" ? "日志" : "任务"}`;
    case "rewind": return "回滚会话？[y/N] · Enter/n/Esc 取消 · 仅实体 y 确认";
    case "resume": return "恢复已关闭会话？[y/N] · Enter/n/Esc 取消 · 仅实体 y 确认";
    case "busy": return `${model.sessionOperation} 进行中 · 按键将丢弃 · Esc 不取消在途操作`;
    case "threads": return "会话选择 · ↑/↓ 选择 · Enter 切换 · Esc 取消";
    case "fork": return "分叉 item 选择 · ↑/↓ 选择 · Enter 分叉 · Esc 取消";
    case "permissions": return "权限模式 · ↑↓/数字选择 · Enter 确认 · Esc 取消";
    case "completion": return "↑↓ 选择 · Tab/Enter 插入 · Esc 关闭补全";
    case "input": return "Ctrl-N 新建 · Ctrl-T 会话 · Enter 发送 · Tab effort · Shift-Tab 权限 · Ctrl-R 推理 · Ctrl-C 两次退出";
  }
}
