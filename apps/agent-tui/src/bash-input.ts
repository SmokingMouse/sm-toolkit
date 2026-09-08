import type { UserInput } from "@smokingmouse/agent-server/protocol";

/** Shell input is standalone: never interpret @paths or expand attachments here. */
export function bashInput(text: string, attachments: readonly unknown[]): UserInput[] | undefined {
  if (!text.startsWith("!")) return;
  const command = text.slice(1);
  if (!command.trim()) throw new Error("用法：!<shell command>");
  if (attachments.length) throw new Error("Shell 模式不能携带图片；Ctrl-U 清除附件后重试");
  return [{ type: "bash", command }];
}
