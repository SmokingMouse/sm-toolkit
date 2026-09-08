# codex-ingress 集成

- 契约：fj-tui-ingress-integrate-a848；三份最新复核均通过，无未收口 P0/P1。
- 依序合并 s3 `78316bb`、s4 `2cc88c7`、readonly `8a120e4`；合并提交为 `d3036c8`、`91ea453`、`0f54bf3`。
- 冲突处理：smoke 保留 s3 粘性模型覆盖与 schema 判据，并合入 s4 Unix/显示端断连；ThreadManagerOptions 同时保留 interruptTimeoutMs/allowedRoots；progress 保留各轮已结案记录。
- 升级脚本加入最新 s3 的 cross_backend_model_override_tolerated/wire_schema_clean 必测项。协议统一 Unix 与模型覆盖口径，补齐只读已知限制；新增快速上手，README 引用协议并更新路线。
- 实测：bun install exit 0；agent-server 1209 pass/0 fail；typecheck exit 0；D4/D5 原样命令均 exit 0；只读真机 find 免审、git brace 待审批且未落盘。
- 升级回归 17/17 exit 0，Codex/Claude × WS/Unix 各三轮通过，schema.diff 0 字节。原始报告 `/tmp/fj-ingress-integrate-upgrade/report.json`；持久证据见契约 out/result.md 与 out/proof/。
- Next：主控独立验收本分支；本单不 push、不合 main。
