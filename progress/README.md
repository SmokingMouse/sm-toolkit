# SM-Toolkit Progress

> 指针：session log → `sessions/`（一条一文件，最新在后；旧 log 在 `sessions/0000-legacy.md`） · 已验证事实 → `facts.md` · 旧 log + 已完成 goals → `archive.md`

## Current Focus

agent-server（分支 feat/agent-server）：daemon 独占引擎、item 日志广播、turn 排队、审批反向请求，多前端 attach，配薄 TUI；设计已定稿，核心包实现中。

## Goals

- [ ] agent-server v1：协议 + 核心 + 传输/daemon + codex 引擎 + TUI 客户端，可被 Trellis 与手机 attach（设计见 `docs/agent-server/`）
