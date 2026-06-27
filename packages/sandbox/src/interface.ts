export interface ExecOpts {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface Sandbox {
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  destroy(): Promise<void>
}

export interface DockerOpts {
  mounts?: Array<{ host: string; container: string; readonly?: boolean }>
  env?: Record<string, string>
  network?: string
}
