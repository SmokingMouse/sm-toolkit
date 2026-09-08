# fj 受限上下文实现

契约 fj-dogfood-impl-2bba。thread/start 增加 fjContext/serviceTier，root 受 allowed_roots 与目录校验，身份持久化进 options/meta，resume 不允许覆盖。两引擎清除继承的 HERDR/FENJUE 身份，只映射当前 thread 的 root/cid/seat。close 尊重输入 lease。

验证：`bun test`（packages/agent-server）268 pass / 0 fail；新增 fj-context.test.ts 覆盖非法输入、两个 root/cid 子进程路由、resume 和首轮重试。后续补充的 close lease 与 meta 身份校验随最终全量复跑。

Next：TUI 就绪交接与 LaunchAgent 模板完成后，由主控独立复跑并启动真实试点；本次不运行真实引擎或安装服务。
