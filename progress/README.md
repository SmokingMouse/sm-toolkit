# SM-Toolkit Progress

> 指针：session log → `sessions/`（一条一文件，最新在后；旧 log 在 `sessions/0000-legacy.md`） · 已验证事实 → `facts.md` · 旧 log + 已完成 goals → `archive.md`

## Current Focus

agent-server Codex native ingress 首个切片已实现并通过隔离 PTY 冒烟，交主控验收；Trellis 迁移与后续 TUI 切片待推进。

## Goals

- [x] agent-server v1：协议 + 核心 + 传输/daemon + codex 引擎 + TUI 客户端（设计见 `docs/agent-server/`）
- [ ] Trellis 迁移到 agent-server（`docs/agent-server/trellis-migration.md` 三步走，等用户拍板）
