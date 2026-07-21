import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface GitPushCredential {
  token: string;
  remoteUrl: string;
  refspec: string;
}

export interface GitPushResult {
  ok: boolean;
  authenticationFailed: boolean;
  message: string;
}

function gitFact(cwd: string, args: string[], label: string): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  if (!value) throw new Error(`Git push ${label} 解析失败`);
  return value;
}

/**
 * 不直接从 Agent 可写的 worktree 执行 authenticated push：local config 的 url rewrite、
 * hooks 或 credential helper 都可能窃取 token。临时 bare transport 只借用 object database。
 */
export function prepareGitPushTransport(cwd: string, directory: string): { gitDir: string; sourceRef: string } {
  const head = gitFact(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], "HEAD").toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Git push HEAD 不是完整 commit id");
  const rawCommonDir = gitFact(cwd, ["rev-parse", "--git-common-dir"], "common dir");
  if (/[\r\n]/.test(rawCommonDir)) throw new Error("Git push common dir 路径无效");
  const commonDir = realpathSync(resolve(cwd, rawCommonDir));
  const objectDir = realpathSync(join(commonDir, "objects"));
  if (/[\r\n]/.test(objectDir)) throw new Error("Git push object directory 路径无效");

  const gitDir = join(directory, "transport.git");
  mkdirSync(join(gitDir, "objects/info"), { recursive: true, mode: 0o700 });
  mkdirSync(join(gitDir, "refs/heads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n", { mode: 0o600 });
  writeFileSync(join(gitDir, "objects/info/alternates"), `${objectDir}\n`, { mode: 0o600 });
  const sourceRef = "refs/heads/harbor-source";
  writeFileSync(join(gitDir, sourceRef), `${head}\n`, { mode: 0o600 });
  // Git uses HEAD as part of repository discovery even when push names an explicit source ref.
  // Without it the directory merely resembles a bare repository and `git --git-dir=... push`
  // fails before authentication with "not a git repository".
  writeFileSync(join(gitDir, "HEAD"), `ref: ${sourceRef}\n`, { mode: 0o600 });
  return { gitDir, sourceRef };
}

/** token 只进入 daemon-owned git child env；不进 argv、repository config、Agent env 或输出。 */
export async function pushGitHead(
  cwd: string,
  credential: GitPushCredential,
  timeoutMs = 120_000,
): Promise<GitPushResult> {
  if (!credential.token.trim()) throw new Error("Git push credential 为空");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(credential.remoteUrl)) {
    throw new Error("Git push remoteUrl 不是 canonical GitHub HTTPS URL");
  }
  if (!/^HEAD:refs\/heads\/harbor\/[A-Za-z0-9._/-]+$/.test(credential.refspec)
    || credential.refspec.includes("..") || credential.refspec.endsWith("/")) {
    throw new Error("Git push refspec 不在 Harbor branch namespace");
  }
  const directory = mkdtempSync(join(tmpdir(), "harbor-git-askpass-"));
  chmodSync(directory, 0o700);
  const transport = prepareGitPushTransport(cwd, directory);
  const askpass = join(directory, "askpass.sh");
  writeFileSync(askpass, `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$HARBOR_GIT_PUSH_TOKEN" ;;
esac
`, { mode: 0o700 });
  try {
    return await new Promise<GitPushResult>((resolve, reject) => {
      const destination = credential.refspec.slice("HEAD:".length);
      const child = spawn("git", [
        `--git-dir=${transport.gitDir}`,
        "push",
        "--porcelain",
        "--no-verify",
        credential.remoteUrl,
        `${transport.sourceRef}:${destination}`,
      ], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: directory,
          XDG_CONFIG_HOME: directory,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: "0",
          HARBOR_GIT_PUSH_TOKEN: credential.token,
          ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
          ...(process.env.SSL_CERT_DIR ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR } : {}),
          ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
          ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const append = (chunk: unknown) => {
        output = `${output}${String(chunk)}`.slice(-16 * 1024).replaceAll(credential.token, "[redacted]");
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`git push 启动失败：${error.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const safe = output
          .replaceAll(credential.token, "[redacted]")
          .replace(/https:\/\/[^\s@]+@github\.com/gi, "https://[redacted]@github.com")
          .trim();
        const authenticationFailed = /authentication failed|bad credentials|could not read username|403|401/i.test(safe);
        resolve({
          ok: code === 0,
          authenticationFailed,
          message: code === 0
            ? "GitHub branch push succeeded"
            : `git push failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}): ${safe.slice(-4_000)}`,
        });
      });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
