import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("wire schema gate rejects malformed responses, notifications and permission cards", () => {
  const result = spawnSync("uv", ["run", `${import.meta.dir}/codex-wire-schema-test.py`], { encoding: "utf8", timeout: 60_000 });
  expect({ status: result.status, error: result.error?.message, output: result.status === 0 ? "" : result.stdout + result.stderr }).toEqual({ status: 0, error: undefined, output: "" });
}, 65_000);
