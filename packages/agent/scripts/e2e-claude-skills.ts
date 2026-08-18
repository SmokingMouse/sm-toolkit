import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeBackend, EventType, type AgentEvent } from "../src/index.js";

const configDir = mkdtempSync(join(tmpdir(), "sm-agent-skills-"));
copyFileSync(join(homedir(), ".claude", ".credentials.json"), join(configDir, ".credentials.json"));

for (const name of ["e2e-alpha-7391", "e2e-beta-7391"]) {
  const skillDir = join(configDir, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: E2E visibility canary ${name}\n---\n\n# ${name}\n`,
  );
}

const prompt = [
  "List every available skill whose name starts with e2e-.",
  "If none are available, reply exactly NONE.",
  "Otherwise reply with only those skill names, sorted and separated by commas.",
  "Do not call tools.",
].join(" ");

async function run(skills?: string[]): Promise<{ text: string; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  for await (const event of new ClaudeBackend().run(prompt, {
    ...(skills !== undefined ? { skills } : {}),
    cwd: configDir,
    persistence: false,
    partialMessages: false,
    env: { CLAUDE_CONFIG_DIR: configDir },
  })) {
    events.push(event);
  }
  const text = events
    .filter((event) => event.type === EventType.Result)
    .map((event) => String(event.data.text ?? "").trim())
    .join("")
    .replace(/\s*,\s*/g, ",");
  if (!events.some((event) => event.type === EventType.SessionStart)) {
    throw new Error(`skills E2E produced no SessionStart: ${JSON.stringify(events)}`);
  }
  if (events.some((event) => event.type === EventType.ToolCall)) {
    throw new Error(`skills E2E unexpectedly called a tool: ${JSON.stringify(events)}`);
  }
  return { text, events };
}

try {
  const omitted = await run();
  const empty = await run([]);
  const one = await run(["e2e-alpha-7391"]);

  const expected = {
    omitted: "e2e-alpha-7391,e2e-beta-7391",
    empty: "NONE",
    one: "e2e-alpha-7391",
  };
  const actual = { omitted: omitted.text, empty: empty.text, one: one.text };
  if (actual.omitted !== expected.omitted || actual.empty !== expected.empty || actual.one !== expected.one) {
    console.error(JSON.stringify({ actual, omitted: omitted.events, empty: empty.events, one: one.events }, null, 2));
    throw new Error(`skills E2E mismatch: ${JSON.stringify({ expected, actual })}`);
  }

  console.log(JSON.stringify({ ok: true, ...actual }));
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
