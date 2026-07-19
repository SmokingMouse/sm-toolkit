# ADR: Harbor Agent Skills are control-plane scoped

## Context

Harbor persisted Workspace Skills and composed only the Agent instruction plus current bindings into each Run system prompt. That controlled prompt assembly, but not the child Runtime: Claude Code and Codex independently discover Skills from the Device user home, checkout ancestors, plugins, and bundled installations. An Agent could therefore see or explicitly invoke a Skill that was never assigned in Harbor, making Agent configuration descriptive rather than authoritative.

## Decision

Every Harbor Run disables environment-provided Skills while retaining the control-plane system prompt.

- `@sm/agent` gains an opt-in `environmentSkills=false` boundary; its default remains compatible for non-Harbor callers.
- Claude runs with `--safe-mode --disable-slash-commands`. Harbor-provided instruction and Skill text still enters through `--system-prompt`.
- Codex runs with `--ignore-user-config`, `--ignore-rules`, plugins disabled, and `skills.include_instructions=false`. At Run start the daemon scans the bounded Runtime roots and passes name-based `skills.config` disable rules so an Issue containing an explicit `$skill` cannot inject it.
- The scan covers the Device user roots, Codex bundled/admin roots, and `.agents/.codex` Skill roots between the checkout and filesystem root. Bad, unreadable, or oversized Skills are not advertised as usable.
- Do not set `skills.bundled.enabled=false`: current Codex removes the shared `$CODEX_HOME/skills/.system` cache under that setting, creating a cross-process side effect outside Harbor.

## Rationale

Agent Skills are an allowlist. A Device is an execution host and credential source, not an implicit capability grant. Keeping the canonical Harbor Skill and imported Workspace snapshots in the system prompt makes Runs reproducible across Devices and prevents a developer's personal setup from changing production Agent behavior.

## Alternatives

- **Rely on the system prompt to say “ignore other Skills”**: rejected because the Runtime still advertises and can inject those Skills.
- **Use only Claude `--setting-sources=` / Codex `--ignore-user-config`**: rejected because neither alone prevents all Skill discovery or explicit invocation.
- **Run with an empty HOME/CODEX_HOME**: rejected because Runtime auth, Git identity, shell tools, and Device credentials intentionally remain host capabilities.
- **Copy assigned Skills into Runtime directories**: rejected because it creates mutable per-Device state and duplicates Harbor's versioned Workspace snapshot.

## Consequences

- Device-local Skills remain discoverable for import/sync in the control plane but are inert until explicitly bound to an Agent.
- Old resumed session transcripts may contain historical instructions from before this release; the boundary is guaranteed for newly constructed Run context and all fresh sessions, not retroactive transcript rewriting.
- Older Runtime versions without the required isolation flags fail loudly instead of silently inheriting host Skills.
- New Runtime Skill roots must be added to the bounded scanner and covered by tests before Harbor may claim support for them.
