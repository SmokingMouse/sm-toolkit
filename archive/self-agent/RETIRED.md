# self-agent 已退役（2026-07-15，Harbor P2）

按 `progress/harbor.md` §0/§7 决策：Harbor 飞书入口是 self-agent 的超集，不留双版本。
本目录移出 `apps/*`（不再进 workspaces / tsconfig references / bun install），仅作历史留档。

## 能力去向

| self-agent 能力 | Harbor 对应 |
|---|---|
| 飞书 bot 对话（thread↔session，resume 多轮） | FeishuEntry：话题↔Conversation 映射，issue/chat 双态 |
| ACL（admin 私聊限制 + 陌生人审批） | admin-only ACL（`feishu.admin_user_id`；个人平台简化掉陌生人准入流） |
| /model 线程级切换 | 模型是 HarborAgent 的配置属性——换模型 = 派给不同 agent |
| /new /help | DM 下 `<agent> <prompt>` 即开新会话；/help 在 bot 内 |
| 卡片渲染（@sm/channel-feishu） | 同一包，Harbor 新增 tool_approval 卡 |

## 切换步骤（用户执行）

1. 停 self-agent 进程（launchd/前台均可；bot 双连会重复响应）。
2. 把 `archive/self-agent/config/server.yaml` 里的 `feishu.app_id/app_secret` 和
   `admin.feishu_user_id` 迁到 server 机的 `~/.harbor.yaml`：
   ```yaml
   feishu:
     app_id: cli_xxx
     app_secret: xxx
     admin_user_id: ou_xxx      # 原 admin.feishu_user_id
     bot_name: Harbor
     allowed_chats: []          # automation 播报白名单，默认空
   ```
3. 启动 `harbor-server`（飞书入口自动挂载），群里 @bot `/help` 验证。

回滚：`git revert` 本次归档 commit 或直接从本目录 `bun run src/index.ts start`（需自行恢复依赖：
目录已不在 workspaces，`@sm/*` 解析不到——这是退役的硬性体现，回滚建议走 git revert）。
