import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { GitHubUserTokenBundle } from "./github-app.js";

export interface GitHubUserCredentialStore {
  write(ref: string, bundle: GitHubUserTokenBundle): void;
  read(ref: string): GitHubUserTokenBundle;
  delete(ref: string): void;
}

function credentialRef(ref: string): string {
  if (!/^github-user-[a-zA-Z0-9_-]+$/.test(ref)) throw new Error("GitHub credentialRef 格式不正确");
  return ref;
}

function tokenBundle(value: unknown): GitHubUserTokenBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub credential 内容无效");
  const item = value as Record<string, unknown>;
  if (typeof item.accessToken !== "string" || !item.accessToken.trim()) throw new Error("GitHub credential 缺少 access token");
  if (typeof item.tokenType !== "string" || !item.tokenType.trim()) throw new Error("GitHub credential 缺少 token type");
  if (!Array.isArray(item.scopes) || item.scopes.some((scope) => typeof scope !== "string")) {
    throw new Error("GitHub credential scopes 无效");
  }
  for (const key of ["accessExpiresAt", "refreshExpiresAt"] as const) {
    if (item[key] !== null && (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]))) {
      throw new Error(`GitHub credential ${key} 无效`);
    }
  }
  if (item.refreshToken !== null && typeof item.refreshToken !== "string") {
    throw new Error("GitHub credential refresh token 无效");
  }
  return {
    accessToken: item.accessToken,
    tokenType: item.tokenType,
    scopes: [...new Set(item.scopes as string[])],
    accessExpiresAt: item.accessExpiresAt as number | null,
    refreshToken: item.refreshToken as string | null,
    refreshExpiresAt: item.refreshExpiresAt as number | null,
  };
}

/** Production credential vault：SQLite 只存 opaque ref，token bundle 落当前 uid 的 0600 文件。 */
export class FileGitHubUserCredentialStore implements GitHubUserCredentialStore {
  constructor(private readonly root: string) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error("GitHub credential directory 必须是 canonical 绝对路径");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(root);
    const uid = process.getuid?.();
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (uid !== undefined && metadata.uid !== uid)) {
      throw new Error("GitHub credential directory 必须是当前 uid 拥有的 non-symlink directory");
    }
    chmodSync(root, 0o700);
    if (realpathSync(root) !== root) throw new Error("GitHub credential directory 路径不能包含 symlink");
  }

  write(ref: string, bundle: GitHubUserTokenBundle): void {
    const path = this.path(ref);
    const serialized = JSON.stringify(tokenBundle(bundle));
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(temporary, flags, 0o600);
    let closed = false;
    try {
      writeFileSync(fd, serialized, { encoding: "utf8" });
      fsyncSync(fd);
      closeSync(fd);
      closed = true;
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } catch (error) {
      if (!closed) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }

  read(ref: string): GitHubUserTokenBundle {
    const path = this.path(ref);
    const metadata = lstatSync(path);
    const uid = process.getuid?.();
    if (metadata.isSymbolicLink() || !metadata.isFile() || (uid !== undefined && metadata.uid !== uid)
      || (metadata.mode & 0o777) !== 0o600 || realpathSync(path) !== path) {
      throw new Error("GitHub credential file owner/type/mode 不可信");
    }
    try {
      return tokenBundle(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("GitHub credential JSON 无效");
      throw error;
    }
  }

  delete(ref: string): void {
    const path = this.path(ref);
    if (!existsSync(path)) return;
    const metadata = lstatSync(path);
    const uid = process.getuid?.();
    if (metadata.isSymbolicLink() || !metadata.isFile() || (uid !== undefined && metadata.uid !== uid)) {
      throw new Error("GitHub credential file 删除目标不可信");
    }
    unlinkSync(path);
  }

  private path(ref: string): string {
    return resolve(this.root, `${credentialRef(ref)}.json`);
  }
}

/** Tests/ephemeral server only；仍做 defensive copy，避免调用方原地篡改 token bundle。 */
export class MemoryGitHubUserCredentialStore implements GitHubUserCredentialStore {
  private readonly entries = new Map<string, GitHubUserTokenBundle>();

  write(ref: string, bundle: GitHubUserTokenBundle): void {
    this.entries.set(credentialRef(ref), structuredClone(tokenBundle(bundle)));
  }

  read(ref: string): GitHubUserTokenBundle {
    const bundle = this.entries.get(credentialRef(ref));
    if (!bundle) throw new Error("GitHub Account credential 不存在");
    return structuredClone(bundle);
  }

  delete(ref: string): void {
    this.entries.delete(credentialRef(ref));
  }
}
