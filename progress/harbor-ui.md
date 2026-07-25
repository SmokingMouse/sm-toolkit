# Harbor 控制台 UI 重塑

## 目标

让 Harbor 从“功能已齐的管理后台”变成一眼能读懂运行态的个人多设备控制台；只调整视觉、信息层级和交互反馈，不改 API 与领域行为。

## 视觉语言

- **隐喻**：港口调度台。深海墨色侧栏承载导航，暖灰画布降低长时间使用疲劳，航标绿只指向当前操作与健康状态。
- **层级**：页面标题和关键数字先于容器；卡片用细边界、短阴影和留白分层，不靠堆叠纯白矩形。
- **状态**：所有运行态使用“色点 + 文本”胶囊；在线、等待、失败不只依赖颜色。
- **密度**：桌面保持控制台的信息密度，表单按语义分组；窄屏侧栏收成图标轨道，避免主内容被挤没。

## 范围

1. 全局颜色、字体、focus、动画、按钮、表单、Modal、Toast。
2. 侧边导航加图标、分组、连接态与待审批提醒。
3. Devices：运行概览、接入命令、provider / agent / endpoint 事实重排。
4. Agents：设备健康与执行配置卡片；创建表单从长列表改成分组网格。
5. Settings：连接配置与 Prompt wrapper 形成左右工作台。
6. Issues / Chats 等存量页面复用新骨架，并修正卡片、列、消息区的层级。

## 验收

- 1280×720 下核心操作可见、无横向页面溢出，Modal footer 可达。
- Devices / Agents / Settings / Issues / Chats 的视觉语言一致，状态可扫读。
- 键盘 focus 明确，`prefers-reduced-motion` 下关闭入场动画。
- `bunx tsc --noEmit` 与 Next static build 通过；真实浏览器逐页截图人工检查。

## 结果（2026-07-16）

- 八页与全局壳已按上述视觉语言完成，API 与领域行为未改。
- `tsc --noEmit`、Next 15 static build 通过。
- agent-browser 在 1280×720 验收 Devices / Agents / Agent Modal / Settings / Issues / Chats / Automations / Approvals / Usage；Issues 五列全显，表格页无 document 横溢。
- 760×720 验收 Devices：侧栏收为 76px 图标轨，`document.scrollWidth === innerWidth`，核心设备事实可读。
