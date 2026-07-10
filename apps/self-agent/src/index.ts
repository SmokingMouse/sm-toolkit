import { FeishuChannel } from '@sm/channel-feishu'
import { loadConfig } from './config.js'
import { registerHandlers } from './bot.js'
import { runSetup } from './setup.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'start'

async function start() {
  const config = loadConfig()

  console.log(`\n  Self Agent`)
  console.log(`  ─────────────────────────`)
  console.log(`  Harness:  ${process.env.HARNESS ?? 'assistant'}`)
  console.log(`  Endpoint: ${config.harness.endpoint}`)
  console.log(`  Admin:    ${config.server.admin.feishu_user_id || '(开放模式)'}`)
  console.log()

  const setupOk = await runSetup(false)
  if (!setupOk) {
    console.log(`  Run \x1b[36mbun run setup\x1b[0m to configure.\n`)
    process.exit(1)
  }

  const { app_id, app_secret } = config.server.feishu
  const channel = new FeishuChannel({
    appId: app_id,
    appSecret: app_secret,
    botName: 'Self Agent',
    requireMention: true,
  })

  registerHandlers(channel)
  await channel.connect()
  console.log(`  Self Agent is running.\n`)
}

switch (command) {
  case 'start':
    start().catch((err) => {
      console.error('Failed to start:', err)
      process.exit(1)
    })
    break

  case 'setup':
    runSetup(true).then((ok) => {
      process.exit(ok ? 0 : 1)
    }).catch((err) => {
      console.error('Failed to run setup:', err)
      process.exit(1)
    })
    break

  default:
    console.log(`
  Usage:
    bun run start              启动（已配置时直接运行）
    bun run setup              交互式配置
    bun run dev                开发模式（watch）

  Environment:
    HARNESS=<name>             使用的 harness（default: assistant）
`)
    break
}
