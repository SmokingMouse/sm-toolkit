---
name: harbor
description: Operate Harbor's control plane for Issues, Runs, Deliveries, reviews, routing, merge gates, and deployment handoff. Use whenever work is executed inside Harbor or when follow-up work must be created or routed.
---

# Harbor control plane

Use Harbor as the source of truth for workflow state. A Run performs one bounded piece of work; Harbor owns the Issue, Delivery, Automation, and deployment lifecycle around it.

## Mental model

- **Workspace** scopes Agents, repositories, Skills, Automations, Issues, and Chats.
- **Agent** fixes the runtime, Device, repository set, permissions, role instruction, and Skills used by a Run.
- **Device** is only the execution host. A Device being online does not imply that every Agent belongs to it.
- **Conversation** is an Issue or Chat. An Issue carries durable workflow state; a Chat is conversational context.
- **Run** is one execution attempt with a purpose such as triage, implementation, review, or automation.
- **Delivery** records the external change, review, CI, merge, and deployment facts. Agent claims never replace those facts.
- **Automation** consumes events or schedules and starts Runs. It coordinates work; it is not the workflow database.

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
- `HARBOR_AGENT_ACTION_TOKEN` authenticates those actions.

Send `Authorization: Bearer $HARBOR_AGENT_ACTION_TOKEN` and JSON content. Never print, log, persist, echo, or include the token in output. Never copy these credentials into repository files, commands whose tracing is enabled, or Issue text.

If a URL or token is absent, this is not an action-capable Harbor Run. Do not invent an endpoint, fall back to the owner token, edit SQLite, or call an arbitrary private REST route.

Only call the endpoint appropriate to the current Run purpose. Treat a rejected action as a control-plane decision; report it instead of bypassing it.

### Route work

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
  "body": "Summary and verification",
  "deploymentRequired": true
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

Approve only the reviewed head revision. Harbor re-syncs provider facts and enforces head-SHA, CI, merge, and deployment gates. On `request_changes`, identify reproducible blockers and route the repair back to a Developer; do not merge.

## Role playbooks

### Orchestrator

- Classify the request as answer, clarification, tracked Issue, implementation dispatch, or review dispatch.
- Preserve the user's wording and acceptance boundary when creating an Issue.
- Choose an Agent whose repository, Device runtime, permissions, and Skills fit the task.
- Do not perform implementation or independent review merely to keep the flow moving.

### Developer

- Confirm the current Issue, repository, execution root, and acceptance criteria.
- Work only on `harbor/<Issue ID>` in the assigned worktree.
- Inspect before editing, preserve unrelated user changes, and verify in proportion to risk.
- Commit only the Issue's changes, then register the Delivery. Never approve, merge, or claim deployment success.

### Reviewer

- Review the submitted head revision independently against the Issue and repository policy.
- Inspect the diff and tests; reproduce important failure modes instead of trusting a summary.
- Use `request_changes` for real blockers and `approve` only when the exact revision is acceptable.
- Request merge through the review action. Do not call SCM merge directly and do not deploy.

## Lifecycle and gates

A typical path is:

`Inbox/backlog -> todo -> doing -> review -> Delivery gates -> done`

Harbor may return an Issue to `todo` after a failed or interrupted Run. A review request for changes queues new implementation work. Approval does not mean merged; merge does not mean deployed; deployment success must come from the configured Deployment Provider's durable result.

Before requesting merge, expect Harbor to re-check the current head revision and CI state. If checks are pending, approval may be stored while merge remains deferred. A manual Delivery may require a human to perform the external merge even after approval.

Never mutate the current Issue status or Delivery metadata from the shell. Never report remote acceptance, merge, or deployment as successful unless Harbor or the external provider has verified it.

## Completion report

In the final answer, state the outcome, verification performed, Delivery/Issue action taken, and any real blocker. Do not create a separate Issue message merely to announce completion.

## Known failure modes

- Missing `HARBOR_AGENT_*` variables: the Run has no action capability; stop at a clear completion report.
- `manual` Delivery merge: approval can succeed while merge remains human-owned.
- CI pending or failed: Harbor defers merge even if review is approved.
- Head changed after review: the old approval is not authority for the new revision; re-review it.
- Device/Agent mismatch: fix the Agent's Device/repository binding in Harbor. A Skill cannot repair execution placement.
- Action rejected: do not retry through owner credentials, direct database writes, or a different endpoint.
