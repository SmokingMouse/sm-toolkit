---
name: harbor
description: Operate Harbor's Run-scoped control-plane capabilities for context, explicit Agent dispatch, Issues, Deliveries, reviews, merge gates, and Harbor self-deployment. Use whenever work runs inside Harbor, an Agent needs to inspect its source, or follow-up work must be created or routed.
---

# Harbor control plane

Use Harbor as the source of truth for workflow state. A Run performs one bounded piece of work; Harbor owns Issue, Delivery, Automation, and Run state. Agents own project-native deployment decisions.

## Mental model

- **Workspace** scopes Agents, repositories, Skills, Automations, Issues, and Chats.
- **Agent** fixes the runtime, Device, repository set, permissions, role instruction, and Skills used by a Run.
- **Device** is only the execution host. A Device being online does not imply that every Agent belongs to it.
- **Conversation** is an Issue or Chat. An Issue carries durable workflow state; a Chat is conversational context.
- **Run** is one bounded execution attempt. `coordination` is a neutral purpose for inspection/routing; it does not imply a built-in Orchestrator role.
- **Delivery** records the external change, review, CI, and merge facts. A merged, approved change with passing checks completes Delivery.
- **Automation** consumes durable Harbor events, webhooks, or schedules and starts a user-selected Agent. It does not choose Agents or own workflow state.

Harbor exposes mechanisms, not a mandatory team topology. Do not assume an Orchestrator exists, infer a Reviewer Pool, or ask the control plane to choose “the best Agent.” A user may wire direct Automations, a custom routing Agent, manual dispatch, or any combination. Every dispatch still names the target Agent explicitly.

The current request has higher priority than Issue history, older messages, or a resumed session. Read local context first. If it is incomplete, inspect the Issue and recent discussion before acting.

## Choose the smallest correct action

1. Answer directly when the request is informational and no tracked work is needed.
2. Create a follow-up Issue only when the work needs an owner, durable state, or another Run.
3. Implement only in an implementation Run and inside the assigned repository/worktree.
4. Review independently in a review Run; do not repair the change while judging it.
5. Let Harbor advance lifecycle state from accepted control-plane actions and verified external facts.

Do not create Issues as progress messages. Report progress through normal Run output and put the completion report in the final answer.

## Run-scoped actions

Harbor exposes capability URLs and a short-lived token through the Run environment:

- `HARBOR_AGENT_ISSUE_URL` routes durable follow-up work.
- `HARBOR_AGENT_DELIVERY_URL` registers or opens the implementation Delivery.
- `HARBOR_AGENT_REVIEW_URL` submits an independent review decision.
- `HARBOR_AGENT_CONTEXT_URL` reads a safe snapshot of the current Run source, Delivery, candidate Agents, and lineage.
- `HARBOR_AGENT_DISPATCH_URL` creates an explicitly targeted child Run on the current source.
- `HARBOR_AGENT_SELF_DEPLOY_URL` lets the Harbor Release Agent enqueue the trusted merged revision for the Harbor-only self-deployer.
- `HARBOR_AGENT_SELF_DEPLOY_REQUEST_PATH` is the preferred Run-scoped self-deploy outbox. It works when the Runtime sandbox cannot access Harbor over loopback; the daemon submits it outside the sandbox with the short-lived Run token.
- `HARBOR_AGENT_TRIGGER_EVENT_TYPE`, `HARBOR_AGENT_TRIGGER_EVENT_ID`, `HARBOR_AGENT_TRIGGER_REPOSITORY_ID`, and `HARBOR_AGENT_TRIGGER_REVISION` expose the non-sensitive trigger facts already frozen on the Run.
- `HARBOR_AGENT_ACTION_TOKEN` authenticates those actions.

Send `Authorization: Bearer $HARBOR_AGENT_ACTION_TOKEN` and JSON content. Never print, log, persist, echo, or include the token in output. Never copy these credentials into repository files, commands whose tracing is enabled, or Issue text.

If a URL or token is absent, this is not an action-capable Harbor Run. Do not invent an endpoint, fall back to the owner token, edit SQLite, or call an arbitrary private REST route.

Treat a rejected action as a control-plane decision; report it instead of bypassing it. The context endpoint is read-only. Delivery and review actions remain purpose-gated; dispatch cannot bypass lifecycle, Repository mount, exact-revision Review, or Workspace boundaries.

### Inspect the current source

GET `HARBOR_AGENT_CONTEXT_URL` before routing when the prompt does not already identify the exact target Agent. The response includes the current Run lineage, Conversation/Delivery, safe Repository metadata, same-Workspace candidate Agents, and prior Runs on this source. It deliberately excludes tokens, Agent environment, owner credentials, and private instructions.

Use that evidence to apply the routing policy supplied by the user or by this Agent's own instruction. Harbor itself has no routing policy.

### Dispatch an explicit child Run

POST to `HARBOR_AGENT_DISPATCH_URL`:

```json
{
  "agent": "<exact Agent id/name>",
  "purpose": "implementation|review|verification|coordination",
  "prompt": "Bounded request with relevant acceptance context",
  "idempotencyKey": "stable-key-for-this-routing-decision"
}
```

The child stays on the current source, is serialized with other Conversation work, and records `parentRunId`, `rootRunId`, and dispatch depth. Reusing the same key under one root Run returns the existing child. Use a stable semantic key such as `review-after-<implementation-run-id>`, not a timestamp. Dispatch depth is bounded, so design routing as a finite workflow rather than recursive self-replication.

### Create durable follow-up work

POST to `HARBOR_AGENT_ISSUE_URL`:

```json
{
  "title": "Outcome-oriented title",
  "description": "Context, scope, acceptance criteria, and real risks",
  "priority": "none|low|medium|high|urgent",
  "assignee": "unassigned|self|<Agent id/name>",
  "dispatch": true,
  "prompt": "Optional first Run request",
  "labels": ["existing-label"]
}
```

Use `dispatch: true` only when the chosen Agent can start immediately with enough context. Otherwise create the Issue without dispatch.

### Register a Delivery

After implementation is tested and committed, POST to `HARBOR_AGENT_DELIVERY_URL`:

```json
{
  "provider": "github|codebase|manual",
  "changeUrl": "optional existing PR/MR URL",
  "headBranch": "harbor/<current Issue ID>",
  "baseBranch": "main",
  "title": "Change title",
  "body": "Summary and verification"
}
```

The implementation branch must be `harbor/<current Issue ID>`. Test, commit, and push when the provider requires it before registering the Delivery. This action cannot approve or merge its own change.

### Submit a review

After inspecting the exact diff and running risk-proportionate verification, POST to `HARBOR_AGENT_REVIEW_URL`:

```json
{
  "decision": "approve|request_changes",
  "feedback": "Evidence-backed findings or approval rationale",
  "merge": true,
  "developer": "optional Agent id/name"
}
```

Approve only the reviewed head revision. Harbor re-syncs provider facts and enforces head-SHA, CI, and merge gates. On `request_changes`, identify reproducible blockers and route the repair back to a Developer; do not merge.

### Deploy Harbor after a trusted merge

Only a `coordination` Run started by a Codebase `merge_request_merged` Automation may request Harbor self-deployment. Require `HARBOR_AGENT_TRIGGER_EVENT_TYPE=merge_request_merged` and a full 40–64 hex `HARBOR_AGENT_TRIGGER_REVISION`; never infer the revision from the checkout or payload text.

When `HARBOR_AGENT_SELF_DEPLOY_REQUEST_PATH` is present, write exactly this JSON object to that path and finish the Run. Harbor gives a Codex Release Run an isolated one-Run writable cwd containing only this outbox; the Repository remains outside its writable roots. Do not call loopback HTTP as well; the daemon validates the file and submits it before marking the Run successful:

```json
{
  "revision": "<exact merged commit from trigger.context.revision>",
  "idempotencyKey": "deploy-<Codebase event id>"
}
```

Use `HARBOR_AGENT_TRIGGER_REVISION` as `revision` and `deploy-$HARBOR_AGENT_TRIGGER_EVENT_ID` as the idempotency key. If the outbox path is absent, a network-capable Runtime may POST the same object to `HARBOR_AGENT_SELF_DEPLOY_URL` with the bearer token. Harbor selects its single host target and freezes paths, commands, service definitions, health policy, backup, and rollback; the Agent cannot override them. Other repositories must deploy through their own project Skill/CLI and must not call this Harbor-only action.

## Composition patterns

Choose the pattern encoded by the user's Automation and Agent instructions; none is privileged by Harbor:

- **Direct Automation**: an event such as `issue.ready` or `issue.review_ready` targets the final implementation/review Agent directly.
- **Custom routing Agent**: an Automation starts a `coordination` Run; that Agent reads context, applies the user's routing policy, and dispatches an explicit target.
- **Manual dispatch**: a person selects the Agent and purpose from the Issue or review action.
- **Hybrid**: automate routine paths and leave exceptional or high-risk selection to a person.

When implementing, work only in the assigned Repository/worktree, preserve unrelated changes, verify proportionately, commit the bounded change, and register its Delivery. Never approve your own implementation.

When reviewing, judge independently against the Issue and Repository policy. Harbor may create a detached per-Run checkout of the Provider-proven head revision on any compatible Device. Review that exact checkout; do not switch branches or repair code while judging it. Use `request_changes` for reproducible blockers and `approve` only when the bound revision is acceptable.

## Lifecycle and gates

A typical path is:

`Inbox/backlog -> todo -> doing -> review -> Delivery gates -> done`

Harbor may return an Issue to `todo` after a failed or interrupted Run. A review request for changes queues new implementation work. Approval does not mean merged. Deployment is a later Agent-owned workflow and is not part of Delivery completion.

Before requesting merge, expect Harbor to re-check the current head revision and CI state. If checks are pending, approval may be stored while merge remains deferred. A manual Delivery may require a human to perform the external merge even after approval.

Never mutate the current Issue status or Delivery metadata from the shell. Never report remote acceptance, merge, or deployment as successful unless Harbor or the external provider has verified it.

## Completion report

In the final answer, state the outcome, verification performed, Delivery/Issue action taken, and any real blocker. Do not create a separate Issue message merely to announce completion.

## Known failure modes

- Missing `HARBOR_AGENT_*` variables: the Run has no action capability; stop at a clear completion report.
- Loopback unavailable inside a Runtime sandbox: use the Run-scoped self-deploy outbox when present; do not weaken the Agent permission sandbox.
- `manual` Delivery merge: approval can succeed while merge remains human-owned.
- CI pending or failed: Harbor defers merge even if review is approved.
- Head changed after review: the old approval is not authority for the new revision; re-review it.
- Review remote/ref mismatch: the target Device does not prove the configured Repository identity or exact Provider head; fix the mount/provider fact rather than reviewing a nearby branch.
- Dispatch depth/idempotency rejection: inspect Run lineage and reuse a stable key; do not generate recursive routing Runs.
- Device/Agent mismatch: fix the Agent's Device/repository binding in Harbor. A Skill cannot repair execution placement.
- Action rejected: do not retry through owner credentials, direct database writes, or a different endpoint.
