import { exec as execCb } from 'node:child_process'
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Sandbox, ExecOpts, ExecResult } from './interface.js'

export function createLocalSandbox(root: string): Sandbox {
  return {
    async exec(cmd, opts) {
      const cwd = opts?.cwd ? resolve(root, opts.cwd) : root
      return new Promise<ExecResult>((res, rej) => {
        const child = execCb(
          cmd,
          {
            cwd,
            timeout: opts?.timeout ?? 30_000,
            env: opts?.env ? { ...process.env, ...opts.env } : undefined,
            maxBuffer: 10 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            res({
              exitCode: err?.code !== undefined ? (typeof err.code === 'number' ? err.code : 1) : 0,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
            })
          },
        )
      })
    },

    async writeFile(path, content) {
      const full = resolve(root, path)
      await mkdir(dirname(full), { recursive: true })
      await fsWriteFile(
        full,
        typeof content === 'string' ? content : Buffer.from(content),
      )
    },

    async readFile(path) {
      const full = resolve(root, path)
      const buf = await fsReadFile(full)
      return new Uint8Array(buf)
    },

    async destroy() {
      // local sandbox: no-op (caller manages root dir lifecycle)
    },
  }
}
