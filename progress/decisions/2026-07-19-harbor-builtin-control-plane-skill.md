# ADR: Harbor control-plane protocol is a required built-in Skill

## Context

Harbor previously appended Issue/Delivery/Review action schemas directly to every Run while Agent instructions separately described Orchestrator, Developer, and Reviewer behavior. That made the control-plane protocol invisible in Skills, duplicated workflow knowledge across role prompts, and left no versioned capability that could evolve like Mew's `mew` Skill. Runtime Skills could not fill this role because they belong to one Device, while Harbor lifecycle actions are Workspace/server capabilities.

## Decision

Ship a canonical `apps/harbor/skills/harbor/SKILL.md` and materialize it in every Workspace as `source=builtin`.

- The Skill contains the Run/Conversation/Delivery/Automation model, role playbooks, Run-scoped action schemas, lifecycle gates, secret rules, completion behavior, and known failure modes.
- `builtin` Skills are Device-independent, compatible with Claude and Codex, versioned by the Harbor release, visible in the Skills UI, and immutable through REST/UI.
- Startup creates or upgrades the Skill and binds it to every active Agent. New Agent create/update always retains it; the UI marks it `built-in · required`.
- Scheduler keeps only the unconditional token/lifecycle safety boundary. The detailed action protocol lives in the Skill, avoiding two independently maintained copies.
- SQLite v20 adds the `builtin` source without changing existing Skill ids, bundles, dependencies, or Agent bindings.

## Rationale

The protocol belongs to Harbor, not a Device and not any one role. A required built-in Skill gives it one inspectable and versioned source of truth while preserving role-specific Agent instructions for judgment and responsibility. Physical Workspace/Agent bindings keep the capability visible in the same model users already use for Skills instead of introducing a hidden second injection path.

## Alternatives

- **Keep the full protocol in scheduler prompt glue**: rejected because it is hidden, not reusable/auditable in the Skills product, and drifts from role prompts.
- **Create a normal manual Skill**: rejected because users could edit/archive it and upgrades could silently keep stale safety/action schemas.
- **Import it as a runtime Skill**: rejected because that incorrectly couples a server control-plane capability to one Device and recreates Device/Agent mismatch semantics.
- **Make it optional**: rejected because every Harbor Agent receives Run-scoped lifecycle capabilities and must share the same non-bypass and credential rules even when its role rarely invokes actions.

## Consequences

- `harbor` is now a reserved Skill name; an existing non-built-in collision stops startup rather than being overwritten.
- Every Agent gains the Skill's prompt footprint. Role instructions should stay small and avoid restating its protocol.
- Future action schema or lifecycle changes must update this Skill and its contract tests in the same release.
- Runtime-local Skills are import sources only; Harbor Runs isolate them and execute solely from the Agent instruction plus bound Workspace Skill snapshots. See `2026-07-19-harbor-agent-skill-runtime-isolation.md`.
