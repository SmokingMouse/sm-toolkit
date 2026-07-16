import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { getApiKey } from './config.js'
import { geminiNative } from './gemini.js'
import { withRetry, categorizeHttpError } from './retry.js'
import type { ConfigFile, EndpointConfig } from './types.js'

// 图片走 openai-compat inline base64；视频/音频体积大、须走 Gemini 原生
// Files API（上传 → 轮询 ACTIVE → generateContent 引用 file_uri）。
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.flv': 'video/x-flv',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
}

export type VisionProgress = (msg: string) => void

export function mediaKind(file: string): 'image' | 'media' {
  const ext = extname(file).toLowerCase()
  if (IMAGE_MIME[ext]) return 'image'
  if (MEDIA_MIME[ext]) return 'media'
  throw new Error(
    `unsupported media type "${ext}" — images: ${Object.keys(IMAGE_MIME).join(' ')}; video/audio: ${Object.keys(MEDIA_MIME).join(' ')}`,
  )
}

/** 图片理解：openai 协议 chat/completions + image_url data URL */
export async function analyzeImage(
  ep: EndpointConfig,
  file: string,
  prompt: string,
): Promise<string> {
  const ext = extname(file).toLowerCase()
  const b64 = readFileSync(file).toString('base64')
  const url =
    (ep.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, '') +
    '/chat/completions'
  const payload = {
    model: ep.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${IMAGE_MIME[ext]};base64,${b64}` },
          },
        ],
      },
    ],
  }
  return withRetry(async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey(ep)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw categorizeHttpError(resp.status, body)
    }
    const json: any = await resp.json()
    return json?.choices?.[0]?.message?.content ?? ''
  })
}

/** 视频/音频理解：Gemini Files API 上传 + 轮询 + generateContent */
export async function analyzeMedia(
  config: ConfigFile,
  file: string,
  prompt: string,
  model?: string,
  onProgress?: VisionProgress,
): Promise<string> {
  const { root, key, models } = geminiNative(config)
  const m = model ?? models[0]!
  const mime = MEDIA_MIME[extname(file).toLowerCase()]!
  const bytes = readFileSync(file)

  onProgress?.(
    `uploading ${basename(file)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) …`,
  )
  const start = await fetch(`${root}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: basename(file) } }),
  })
  if (!start.ok) {
    const body = await start.text().catch(() => '')
    throw new Error(`Files API start failed: HTTP ${start.status} ${body.slice(0, 200)}`)
  }
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (!uploadUrl) throw new Error('Files API start: no X-Goog-Upload-URL in response')

  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    body: bytes,
  })
  if (!up.ok) throw new Error(`Files API upload failed: HTTP ${up.status}`)
  const meta: any = await up.json()
  const name: string = meta?.file?.name
  const uri: string = meta?.file?.uri
  let state: string = meta?.file?.state

  const deadline = Date.now() + 300_000
  while (state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('Files API: processing timeout (5 min)')
    onProgress?.('processing …')
    await new Promise((r) => setTimeout(r, 3000))
    const poll = await fetch(`${root}/v1beta/${name}`, {
      headers: { 'x-goog-api-key': key },
    })
    if (!poll.ok) throw new Error(`Files API poll failed: HTTP ${poll.status}`)
    state = ((await poll.json()) as any)?.state
  }
  if (state !== 'ACTIVE') throw new Error(`Files API: file state is ${state}, expected ACTIVE`)

  onProgress?.(`analyzing with ${m} …`)
  const gen = await fetch(`${root}/v1beta/models/${m}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { file_data: { mime_type: mime, file_uri: uri } },
            { text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(600_000),
  })
  if (!gen.ok) {
    const body = await gen.text().catch(() => '')
    throw new Error(`generateContent failed: HTTP ${gen.status} ${body.slice(0, 200)}`)
  }
  const out: any = await gen.json()
  const parts: any[] = out?.candidates?.[0]?.content?.parts ?? []
  const text = parts.map((p) => p?.text ?? '').join('')
  if (!text) throw new Error(`generateContent returned no text: ${JSON.stringify(out).slice(0, 300)}`)
  return text
}
