import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { geminiNative } from './gemini.js'
import { withRetry, categorizeHttpError } from './retry.js'
import type { ConfigFile } from './types.js'

export interface ImageOptions {
  prompt: string
  /** imagen（默认，快/可控）或 codex（GPT-Image-1 via codex exec，支持参考图） */
  backend?: 'imagen' | 'codex'
  /** imagen: 1:1 / 16:9 / 9:16 / 4:3 / 3:4 */
  aspect?: string
  /** imagen: 1-4 */
  count?: number
  /** imagen: 负面提示词 */
  negative?: string
  /** codex: 参考图路径 */
  ref?: string
  /** codex: sips -z N N 正方形缩放（横竖图勿传，会压回方形） */
  targetSize?: number
  /** 输出目录，默认 cwd */
  output?: string
  onProgress?: (msg: string) => void
}

const IMAGEN_MODEL = 'imagen-4.0-fast-generate-001'
const IMG_RE = /\.(png|jpe?g|webp)$/i

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function outDir(output?: string): string {
  const dir = resolve((output ?? '.').replace(/^~/, homedir()))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 同秒并发时避免文件名互踩 */
function uniquePath(dir: string, base: string): string {
  let p = join(dir, `${base}.png`)
  for (let i = 2; existsSync(p); i++) p = join(dir, `${base}-${i}.png`)
  return p
}

/** 生图。返回图片绝对路径（imagen 可多张，codex 恒一张）。 */
export async function generateImage(
  config: ConfigFile,
  opts: ImageOptions,
): Promise<string[]> {
  return (opts.backend ?? 'imagen') === 'codex'
    ? codexImage(opts)
    : imagenImage(config, opts)
}

async function imagenImage(
  config: ConfigFile,
  opts: ImageOptions,
): Promise<string[]> {
  const { root, key } = geminiNative(config)
  const parameters: Record<string, unknown> = {
    sampleCount: opts.count ?? 1,
    aspectRatio: opts.aspect ?? '1:1',
  }
  if (opts.negative) parameters.negativePrompt = opts.negative

  opts.onProgress?.(`imagen generating (${parameters.sampleCount} × ${parameters.aspectRatio}) …`)
  const json: any = await withRetry(async () => {
    const resp = await fetch(`${root}/v1beta/models/${IMAGEN_MODEL}:predict`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt: opts.prompt }], parameters }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw categorizeHttpError(resp.status, body)
    }
    return resp.json()
  })
  const preds: any[] = json?.predictions ?? []
  if (preds.length === 0 || !preds[0]?.bytesBase64Encoded) {
    throw new Error(
      `Imagen returned no image (prompt 可能触发安全过滤): ${JSON.stringify(json).slice(0, 300)}`,
    )
  }
  const dir = outDir(opts.output)
  return preds.map((p, i) => {
    const file = uniquePath(
      dir,
      preds.length === 1 ? `imagen-${stamp()}` : `imagen-${stamp()}-${i + 1}`,
    )
    writeFileSync(file, Buffer.from(p.bytesBase64Encoded, 'base64'))
    return file
  })
}

/**
 * codex exec 生图：临时子目录做工作区（并发安全——每次调用独占目录，
 * 不靠快照差集猜归属），产出移回输出目录。
 */
function codexImage(opts: ImageOptions): string[] {
  const dir = outDir(opts.output)
  const work = mkdtempSync(join(dir, '.codex-'))
  try {
    const wrapped = [
      `Use the built-in image_gen tool to generate exactly ONE image: ${opts.prompt}`,
      opts.ref
        ? 'Use the attached image as the style/content reference for the generation.'
        : '',
      'When done, copy the final image into the current working directory as a .png file, then stop. Do not create any other files.',
    ]
      .filter(Boolean)
      .join('\n')

    const argv = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-C',
      work,
    ]
    if (opts.ref) argv.push('-i', resolve(opts.ref))
    argv.push(wrapped)

    opts.onProgress?.('codex exec generating (~2 min) …')
    const proc = spawnSync('codex', argv, {
      encoding: 'utf-8',
      timeout: 900_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (proc.error) throw new Error(`codex spawn failed: ${proc.error.message}`)

    const created = readdirSync(work).filter((f) => IMG_RE.test(f))
    if (created.length === 0) {
      throw new Error(
        `codex exited (${proc.status}) but produced no image\n--- codex stderr tail ---\n${(proc.stderr ?? '').slice(-2000)}`,
      )
    }
    const dst = uniquePath(dir, `codex-${stamp()}`)
    renameSync(join(work, created.sort().at(-1)!), dst)

    if (opts.targetSize) {
      const s = spawnSync(
        'sips',
        ['-z', String(opts.targetSize), String(opts.targetSize), dst],
        { encoding: 'utf-8' },
      )
      if (s.status !== 0) throw new Error(`sips resize failed: ${s.stderr}`)
    }
    return [dst]
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
