import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileGitHubUserCredentialStore } from "./github-user-credentials.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("GitHub user credential store", () => {
  test("keeps token bundles outside SQLite-style metadata in an owner-only atomic file", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "harbor-github-credentials-")));
    roots.push(parent);
    const root = join(parent, "github");
    const store = new FileGitHubUserCredentialStore(root);
    const ref = "github-user-fixture_ref";
    store.write(ref, {
      accessToken: "ghu_secret",
      tokenType: "bearer",
      scopes: ["repo"],
      accessExpiresAt: 2_000,
      refreshToken: "ghr_secret",
      refreshExpiresAt: 3_000,
    });
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    const files = readdirSync(root);
    expect(files).toEqual([`${ref}.json`]);
    expect(lstatSync(join(root, files[0]!)).mode & 0o777).toBe(0o600);
    expect(store.read(ref)).toEqual(expect.objectContaining({
      accessToken: "ghu_secret",
      refreshToken: "ghr_secret",
    }));
    store.delete(ref);
    expect(readdirSync(root)).toEqual([]);
  });
});
