# Loop Engineering Admin Control Plane

The Admin control plane turns Loop Engineering's operating discipline into an
observable, enforceable runtime contract. It does not infer live state from an
agent's prose or expose private chain-of-thought. Every live claim must be
backed by a timestamped event, and every derived claim must disclose its
provenance and freshness.

## Product principles

1. **Observable facts only.** Tool calls, checkpoints, logs, file changes,
   deterministic checks, verdicts, approvals, and breaker decisions are
   observable. Hidden reasoning is not.
2. **Separate state domains.** Run, stage, attempt, checker, approval, breaker,
   agent, and worktree state must never be collapsed into one generic status.
3. **Independent verification.** A maker cannot approve its own attempt. A
   checker verdict is bound to a specific attempt and artifact digest.
4. **Append-only evidence.** Events, completed attempts, decisions, and audit
   records are immutable. Corrections append new records.
5. **Human gates are scoped.** Approval names the requested action, target,
   evidence digest, risk, expiry, and approving identity.
6. **Failure stops the loop.** Budget exhaustion, repeated errors, consecutive
   failures, stale telemetry, and policy violations can open the breaker.
7. **Snapshots are not live telemetry.** `STATE.md`, `loop-run-log.md`, budget,
   constraints, ledger, and worktree manifests can be imported with
   `source=snapshot`; the UI must show their age and read-only nature.

## Runtime model

```text
Loop definition
  -> Run
      -> immutable Objective
      -> versioned Requirements and acceptance criteria
      -> ordered Stages
          -> Attempts
              -> Maker evidence
              -> Deterministic checks
              -> Independent checker verdict
              -> Requirement-level evidence citations
      -> Approval requests and decisions
      -> Artifacts and immutable digests
      -> Breaker observations and decisions
      -> Audit events
```

Default stage template:

```text
Trigger -> Intake -> Triage -> Load state and constraints -> Budget guard
-> Worktree -> Maker -> Deterministic verify -> Checker -> Human gate
-> Apply or PR -> Final verify -> Persist state
```

Patterns may skip stages, but skipped stages remain visible with a reason.

## Status domains

| Domain | Values |
| --- | --- |
| Run | `queued`, `running`, `waiting`, `paused`, `blocked`, `capped`, `succeeded`, `failed`, `timed_out`, `cancelled` |
| Stage | `pending`, `active`, `waiting`, `passed`, `rejected`, `failed`, `skipped`, `blocked` |
| Attempt | `running`, `success`, `failure`, `noop`, `rejected`, `escalated`, `cancelled` |
| Checker | `pending`, `running`, `approve`, `reject`, `escalate_human`, `error` |
| Approval | `pending`, `approved`, `rejected`, `expired`, `revoked` |
| Breaker | `closed`, `warning`, `open`, `overridden` |
| Agent | `starting`, `running`, `waiting`, `finished`, `error`, `stale` |
| Worktree | `active`, `rejected`, `escalated`, `merged`, `stale` |

`waiting` requires a reason. `blocked` requires an owner and an explicit
unblock condition. Terminal records cannot transition back to an active state.
Retry creates a new attempt or run and never rewrites old evidence.

## Event contract

Events are the source of truth. Each event includes:

- globally unique ID and per-run monotonically increasing sequence;
- run, stage, attempt, agent, and worktree references when applicable;
- type, timestamp, severity, public message, and structured payload;
- provenance: `runtime`, `agent_reported`, `derived`, `snapshot`, or `human`;
- redaction metadata and optional artifact digest;
- actor identity and correlation ID.

The API rejects duplicate event IDs, sequence regressions, invalid state
transitions, self-verification, verdicts without evidence digests, and stale
approval decisions. Server-sent events resume from `Last-Event-ID` and report a
sequence gap instead of silently presenting an incomplete stream.

## Admin information architecture

- **Overview:** attention queue, active runs, freshness, loop health, budget,
  recent outcomes, and global pause state.
- **Loops:** definitions, automation level, schedule, owner, readiness, and
  current policy version.
- **Runs:** filterable history with saved operational views.
- **Run Detail:** stage rail, observable current action, activity stream,
  attempts, verification, changes, logs, artifacts, budget, breaker, and audit.
- **Approvals:** scoped action, risk, target, evidence, checker verdict, expiry,
  and concurrency-safe decision controls.
- **Agents & Worktrees:** role, session, heartbeat, permissions, isolation, and
  stale resource cleanup.
- **Artifacts:** lineage, checksum, access state, producer, checker binding, and
  retention.
- **Policies & Budgets:** constraints, deny rules, thresholds, kill switch, and
  version history.
- **Audit:** append-only operator and runtime actions with export.

## Security baseline

- Bind to loopback unless an explicit public host is configured.
- Redact secrets before persistence and again before display.
- Support `viewer`, `operator`, and `admin` roles consistently in UI and API.
- Require reasons for reject, request changes, breaker override, resume, and
  global pause changes.
- Do not grant the Admin process agent filesystem or production credentials by
  default. Runners send constrained telemetry over the API.
- Treat artifact downloads as separately authorized resources.

## Delivery gates

The feature is not complete until all of the following have evidence:

1. Full run progression and immutable retry history are covered by integration
   tests.
2. A run cannot succeed until every current requirement has non-expired passing
   evidence and an independent checker approval bound to the same digest.
3. Maker/checker separation, digest binding, breaker thresholds, budget limits,
   approval expiry/concurrency, and terminal-state rules are enforced server
   side.
4. SSE reconnect, de-duplication, sequence gaps, and stale freshness labels are
   tested.
5. Desktop, tablet, 390 px, and 320 px layouts have no overlap or hidden
   critical state.
6. Viewer, operator, and admin permissions match between visible controls and
   direct API requests.
7. Keyboard navigation, reduced motion, contrast, and automated accessibility
   checks pass.
8. A documented comparison against Agent Canvas, Mission Control, Windmill,
   and Prefect identifies remaining gaps without marketing claims.
