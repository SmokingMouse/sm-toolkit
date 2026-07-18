import { Database } from "bun:sqlite";
import { copyFile, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeploymentTargetConfig } from "../config.js";
import { openDb } from "../server/db.js";
import { HarborStore } from "../server/store.js";
import type { DeploymentJobStore } from "./worker.js";
import type {
  DeploymentClock,
  DeploymentFileSystem,
  DeploymentProcess,
  HealthClient,
  LaunchdControl,
  SqliteBackupControl,
} from "./executor.js";

export class EphemeralDeploymentJobStore implements DeploymentJobStore {
  constructor(private readonly databasePath: string) {}

  claimDeploymentJob(targetIds: string[], now: number, leaseMs: number) {
    return this.use((store) => store.claimDeploymentJob(targetIds, now, leaseMs));
  }
  renewDeploymentJob(id: string, leaseToken: string, now: number, leaseMs: number) {
    return this.use((store) => store.renewDeploymentJob(id, leaseToken, now, leaseMs));
  }
  updateDeploymentCheckpoint(id: string, leaseToken: string, checkpoint: string, now: number) {
    return this.use((store) => store.updateDeploymentCheckpoint(id, leaseToken, checkpoint, now));
  }
  completeDeploymentJob(id: string, leaseToken: string, result: Parameters<HarborStore["completeDeploymentJob"]>[2], now: number) {
    return this.use((store) => store.completeDeploymentJob(id, leaseToken, result, now));
  }

  private use<T>(action: (store: HarborStore) => T): T {
    const db = openDb(this.databasePath);
    try {
      return action(new HarborStore(db));
    } finally {
      db.close();
    }
  }
}

export class HostFileSystem implements DeploymentFileSystem {
  async mkdir(path: string) { await mkdir(path, { recursive: true }); }
  async readText(path: string) { return readFile(path, "utf8"); }
  async writeText(path: string, content: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  async rename(from: string, to: string) { await rename(from, to); }
  async exists(path: string) { try { await lstat(path); return true; } catch { return false; } }
  async readLink(path: string) { try { return await readlink(path); } catch { return null; } }
  async symlink(target: string, path: string) { await symlink(target, path); }
  async remove(path: string) { try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export class HostProcess implements DeploymentProcess {
  async run(argv: string[], options: { cwd?: string; env: Record<string, string> }) {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }
}

export class HostLaunchd implements LaunchdControl {
  constructor(private readonly process: DeploymentProcess) {}
  async bootout(domain: string, label: string) { await required(this.process, ["launchctl", "bootout", `${domain}/${label}`]); }
  async bootstrap(domain: string, plistPath: string) { await required(this.process, ["launchctl", "bootstrap", domain, plistPath]); }
}

export class HostSqliteBackup implements SqliteBackupControl {
  async backup(databasePath: string, backupPath: string): Promise<void> {
    await mkdir(dirname(backupPath), { recursive: true });
    try { await unlink(backupPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const db = new Database(databasePath);
    try {
      db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
  }

  async restore(backupPath: string, databasePath: string): Promise<void> {
    const temp = `${databasePath}.restore-${process.pid}`;
    await copyFile(backupPath, temp);
    for (const suffix of ["-wal", "-shm"]) {
      try { await unlink(`${databasePath}${suffix}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await rename(temp, databasePath);
  }
}

export class FetchHealthClient implements HealthClient {
  async get(url: string, headers: Record<string, string>) {
    const response = await fetch(url, { redirect: "error", headers });
    return { status: response.status };
  }
}

export const hostClock: DeploymentClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export function targetRegistrations(targets: DeploymentTargetConfig[]) {
  return targets.map(({ id, name, provider, repositoryId }) => ({ id, name, provider, repositoryId }));
}

async function required(process: DeploymentProcess, argv: string[]): Promise<void> {
  const result = await process.run(argv, { env: {} });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} ${argv[1]} failed: ${result.stderr || result.stdout}`);
}
