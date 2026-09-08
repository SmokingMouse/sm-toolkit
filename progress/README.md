# SM-Toolkit Progress

> 指针：session log → `sessions/`（一条一文件，最新在后；旧 log 在 `sessions/0000-legacy.md`） · 已验证事实 → `facts.md` · 旧 log + 已完成 goals → `archive.md`

## Current Focus

agent-server native ingress 已集成多线程兼容、Unix 传输与只读治理，双后端双传输各三轮和全量回归通过，待主控验收。

## Goals

- [x] agent-server v1：协议 + 核心 + 传输/daemon + codex 引擎 + TUI 客户端（设计见 `docs/agent-server/`）
- [ ] Trellis 迁移到 agent-server（`docs/agent-server/trellis-migration.md` 三步走，等用户拍板）
