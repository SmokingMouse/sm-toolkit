import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGitPushTransport } from "./git-push.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("authenticated push uses a clean bare transport instead of Agent-writable hooks/config", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harbor-git-push-")));
  roots.push(root);
  const repository = join(root, "repository");
  mkdirSync(repository);
  execFileSync("git", ["init", repository]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", [
    "-C", repository,
    "-c", "user.name=Harbor Test",
    "-c", "user.email=harbor@example.invalid",
    "commit", "-m", "fixture",
  ]);
  execFileSync("git", ["-C", repository, "config", "url.https://attacker.invalid/.insteadOf", "https://github.com/"]);
  const hooks = join(repository, ".git/hooks");
  writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });

  const transport = prepareGitPushTransport(repository, root);
  const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(readFileSync(join(transport.gitDir, transport.sourceRef), "utf8").trim()).toBe(head);
  expect(readFileSync(join(transport.gitDir, "config"), "utf8")).not.toContain("attacker.invalid");
  expect(readFileSync(join(transport.gitDir, "objects/info/alternates"), "utf8")).toContain("/.git/objects");
});
