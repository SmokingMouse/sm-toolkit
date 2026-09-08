# SM-Toolkit Progress

> 指针：session log → `sessions/`（一条一文件，最新在后；旧 log 在 `sessions/0000-legacy.md`） · 已验证事实 → `facts.md` · 旧 log + 已完成 goals → `archive.md`

## Current Focus

agent-server native ingress 多线程、fork、历史分页和断线恢复已通过双后端各三次冒烟与全量测试，待主控独立验收。

## Goals

- [x] agent-server v1：协议 + 核心 + 传输/daemon + codex 引擎 + TUI 客户端（设计见 `docs/agent-server/`）
- [ ] Trellis 迁移到 agent-server（`docs/agent-server/trellis-migration.md` 三步走，等用户拍板）
