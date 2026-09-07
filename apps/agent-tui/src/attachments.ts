import { access, mkdtemp, stat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { UserInput } from "@smokingmouse/agent-server/protocol";

const mimes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export type ImageInput = Extract<UserInput, { type: "image" }>;

export async function imageInput(path: string, cwd: string): Promise<ImageInput> {
  path = resolve(cwd, path);
  const mime = mimes[extname(path).toLowerCase()];
  if (!mime) throw new Error("图片格式须为 png/jpg/jpeg/gif/webp");
  if (!(await stat(path)).isFile()) throw new Error(`不是图片文件：${path}`);
  await access(path, constants.R_OK);
  return { type: "image", path, mime };
}

export function unquote(path: string): string {
  return /^(["']).*\1$/s.test(path) ? path.slice(1, -1) : path;
}

/** Keep ordinary @ references as text; only image references become attachments. */
export async function messageInput(text: string, cwd: string, attached: ImageInput[] = []): Promise<UserInput[]> {
  const images = [...attached];
  const pattern = /(^|\s)@("[^"\n]+"|'[^'\n]+'|[^\s]+)/g;
  let body = "", end = 0;
  for (const match of text.matchAll(pattern)) {
    const path = unquote(match[2]);
    if (!mimes[extname(path).toLowerCase()]) continue;
    images.push(await imageInput(path, cwd));
    body += text.slice(end, match.index) + match[1]; end = match.index + match[0].length;
  }
  body += text.slice(end);
  const unique = [...new Map(images.map(i => [i.path, i])).values()];
  return [...(body.trim() ? [{ type: "text" as const, text: body }] : []), ...unique];
}

export async function pasteImage(platform = process.platform, executable = Bun.which("pngpaste")): Promise<ImageInput> {
  if (platform !== "darwin") throw new Error("/paste-image 仅支持 macOS；请用 /image <path>");
  if (!executable) throw new Error("请先安装 pngpaste：brew install pngpaste");
  const dir = await mkdtemp(join(tmpdir(), "agent-tui-image-"));
  const path = join(dir, "clipboard.png");
  try {
    const proc = Bun.spawn([executable, path], { stdout: "ignore", stderr: "pipe" });
    const error = await new Response(proc.stderr).text();
    if (await proc.exited !== 0) throw new Error(`剪贴板没有可用图片：${error.trim()}`);
    return await imageInput(path, dir);
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  // Keep successful files: queued turns and retries can read them after this TUI exits.
}
