import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
}

export function getCurrentVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    const raw = readFileSync(pkgUrl, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function getLatestVersion(
  registryUrl?: string,
): Promise<string | null> {
  const base =
    registryUrl ||
    process.env.NPM_CONFIG_REGISTRY ||
    'https://registry.npmjs.org'
  const url = `${base.replace(/\/$/, '')}/@smokingmouse/cli/latest`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { version?: string }
    return data.version ?? null
  } catch {
    return null
  }
}

/** 比较 semver 版本，若 v2 > v1 返回 true */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v.replace(/^[^\d]*/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [c1 = 0, c2 = 0, c3 = 0] = parse(current)
  const [l1 = 0, l2 = 0, l3 = 0] = parse(latest)

  if (l1 > c1) return true
  if (l1 < c1) return false
  if (l2 > c2) return true
  if (l2 < c2) return false
  return l3 > c3
}

export async function cmdUpdate(argv: string[]): Promise<void> {
  let checkOnly = false
  let registry: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') checkOnly = true
    else if (a === '--registry') registry = argv[++i]
    else if (a === '-h' || a === '--help' || a === 'help') {
      console.log(`llm update — 检查并升级 @smokingmouse/cli 到最新版本

用法:
  llm update              检查并自动执行升级
  llm update --check      仅检查是否有新版本，不执行升级

选项:
  --registry <url>   指定 npm registry 地址
  -h, --help         帮助
`)
      return
    }
  }

  const current = getCurrentVersion()
  console.log(`正在检查 @smokingmouse/cli 更新 (当前: v${current})...`)

  const latest = await getLatestVersion(registry)
  if (!latest) {
    console.error(`${c.red}✗ 获取远端版本失败，请检查网络或 npm registry 配置${c.reset}`)
    process.exit(1)
  }

  const hasUpdate = isNewerVersion(current, latest)

  if (!hasUpdate) {
    console.log(`${c.green}✓ 当前已是最新版本 (v${current})${c.reset}`)
    return
  }

  console.log(
    `\n发现新版本: ${c.yellow}v${current}${c.reset} → ${c.green}v${latest}${c.reset}`,
  )

  if (checkOnly) {
    console.log(`\n运行 ${c.cyan}llm update${c.reset} 或 ${c.cyan}bun install -g @smokingmouse/cli@latest${c.reset} 即可升级`)
    return
  }

  console.log(`\n开始升级...`)

  // 检测使用 bun 还是 npm
  const isBunAvailable = typeof (globalThis as any).Bun !== 'undefined'
  const cmd = isBunAvailable ? 'bun' : 'npm'
  const args = isBunAvailable
    ? ['install', '-g', `@smokingmouse/cli@latest`]
    : ['install', '-g', `@smokingmouse/cli@latest`]

  if (registry) {
    args.push('--registry', registry)
  }

  console.log(`→ 执行: ${cmd} ${args.join(' ')}\n`)

  const child = spawn(cmd, args, {
    stdio: 'inherit',
    env: process.env,
  })

  const code = await new Promise<number>((resolve) => {
    child.on('close', (c) => resolve(c ?? 1))
  })

  if (code === 0) {
    console.log(`\n${c.green}✓ 升级成功！当前版本: v${latest}${c.reset}\n`)
  } else {
    console.error(`\n${c.red}✗ 升级命令执行失败 (exit code ${code})${c.reset}`)
    console.error(`您可以尝试手动执行: ${cmd} ${args.join(' ')}`)
    process.exit(code)
  }
}
