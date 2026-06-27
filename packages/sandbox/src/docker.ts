import { spawn, execSync } from 'node:child_process'
import type { Sandbox, ExecOpts, ExecResult, DockerOpts } from './interface.js'

export async function createDockerSandbox(
  image: string,
  opts?: DockerOpts,
): Promise<Sandbox> {
  const args = ['run', '-d', '--rm']

  if (opts?.mounts) {
    for (const m of opts.mounts) {
      const ro = m.readonly ? ':ro' : ''
      args.push('-v', `${m.host}:${m.container}${ro}`)
    }
  }
  if (opts?.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`)
    }
  }
  if (opts?.network) {
    args.push('--network', opts.network)
  }

  args.push(image, 'tail', '-f', '/dev/null')

  const containerId = execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf-8',
  }).trim()

  return {
    async exec(cmd, execOpts) {
      const execArgs = ['exec']
      if (execOpts?.cwd) execArgs.push('-w', execOpts.cwd)
      if (execOpts?.env) {
        for (const [k, v] of Object.entries(execOpts.env)) {
          execArgs.push('-e', `${k}=${v}`)
        }
      }
      execArgs.push(containerId, 'sh', '-c', cmd)

      return new Promise<ExecResult>((resolve) => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const proc = spawn('docker', execArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

        proc.stdout.on('data', (d) => stdout.push(d))
        proc.stderr.on('data', (d) => stderr.push(d))

        const timer = execOpts?.timeout
          ? setTimeout(() => proc.kill('SIGTERM'), execOpts.timeout)
          : null

        proc.on('close', (code) => {
          if (timer) clearTimeout(timer)
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          })
        })
      })
    },

    async writeFile(path, content) {
      const data =
        typeof content === 'string'
          ? content
          : Buffer.from(content).toString('base64')
      const isBase64 = typeof content !== 'string'

      if (isBase64) {
        execSync(
          `echo '${data}' | docker exec -i ${containerId} sh -c 'base64 -d > ${path}'`,
        )
      } else {
        const proc = spawn(
          'docker',
          ['exec', '-i', containerId, 'sh', '-c', `cat > ${path}`],
          { stdio: ['pipe', 'ignore', 'ignore'] },
        )
        proc.stdin.write(data)
        proc.stdin.end()
        await new Promise<void>((r) => proc.on('close', () => r()))
      }
    },

    async readFile(path) {
      const out = execSync(`docker exec ${containerId} cat ${path}`)
      return new Uint8Array(out)
    },

    async destroy() {
      try {
        execSync(`docker kill ${containerId}`, { stdio: 'ignore' })
      } catch {
        // container may already be gone
      }
    },
  }
}
