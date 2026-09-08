# SM-Toolkit Progress

> 指针：session log → `sessions/`（一条一文件，最新在后；旧 log 在 `sessions/0000-legacy.md`） · 已验证事实 → `facts.md` · 旧 log + 已完成 goals → `archive.md`

## Current Focus

agent-server native ingress 已补 Unix WebSocket、完整方法治理与中断收尾，正在合并多线程切片并执行升级回归。

## Goals

- [x] agent-server v1：协议 + 核心 + 传输/daemon + codex 引擎 + TUI 客户端（设计见 `docs/agent-server/`）
- [ ] Trellis 迁移到 agent-server（`docs/agent-server/trellis-migration.md` 三步走，等用户拍板）
