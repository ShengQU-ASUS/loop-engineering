# Admin Control Plane Competitive Benchmark

Research snapshot: 2026-07-15. This comparison is an engineering acceptance
baseline, not a marketing scorecard. Links point to the source or official docs
used to verify each claim.

## What each project teaches us

| Project | Strong reference | Gap the Loop Engineering Admin must close |
| --- | --- | --- |
| [OpenHands Agent Canvas](https://github.com/OpenHands/agent-canvas) | Goal iterations, a separate goal-judge pass, stop/resume, and observable conversation/tool events | A separate judge pass does not by itself enforce a different agent identity or model. The OSS automation permission hook is all-or-nothing, and the product does not expose this Admin's requirement-level evidence contract |
| [Mission Control](https://github.com/builderz-labs/mission-control) | Fleet and task views, heartbeat, cost, RBAC/user management, execution approvals, audit surfaces, API, SSE run streaming, and post-run Aegis review tasks with recorded resolutions and retry after rejection | Aegis review is not bound to requirement-level evidence and an immutable artifact digest, nor does it enforce this Admin's distinct maker/checker identity contract. Pipeline steps may be operator-advanced, and activity, task state, and audit surfaces still need reconciliation when used as execution truth |
| [Windmill](https://github.com/windmill-labs/windmill) | Durable jobs, step logs, retries, explicit progress, approval flows, execution isolation options, and audit logs, including 14-day retention in Community Edition | It does not natively model objective, requirements, maker/checker identity separation, requirement evidence, or Loop Engineering circuit breakers |
| [Prefect](https://github.com/PrefectHQ/prefect) | Explicit orchestration states, retries, pause/resume input, artifacts, and recovery semantics | Loop Engineering's independent review, requirement evidence, immutable candidate digest, and scoped approval rules must be authored by the application |

Primary evidence:

- Agent Canvas [goal status UI](https://github.com/OpenHands/agent-canvas/blob/main/src/components/features/chat/goal-status-content.tsx), [automation status](https://github.com/OpenHands/agent-canvas/blob/main/src/types/automation.ts), and [OSS permission hook](https://github.com/OpenHands/agent-canvas/blob/main/src/hooks/use-has-permission.ts).
- OpenHands SDK [goal judge](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/goal/judge.py) and [controller](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/goal/controller.py).
- Mission Control [task dispatch and Aegis](https://github.com/builderz-labs/mission-control/blob/main/src/lib/task-dispatch.ts), [pipeline runtime](https://github.com/builderz-labs/mission-control/blob/main/src/app/api/pipelines/run/route.ts), [execution approvals](https://github.com/builderz-labs/mission-control/blob/main/src/app/api/exec-approvals/route.ts), [audit API](https://github.com/builderz-labs/mission-control/blob/main/src/app/api/audit/route.ts), [run SSE](https://github.com/builderz-labs/mission-control/blob/main/src/app/api/v1/runs/stream/route.ts), and [user management](https://github.com/builderz-labs/mission-control/blob/main/src/app/api/auth/users/route.ts).
- Windmill [jobs](https://www.windmill.dev/docs/core_concepts/jobs), [run monitoring](https://www.windmill.dev/docs/core_concepts/monitor_past_and_future_runs), [approvals](https://www.windmill.dev/docs/flows/flow_approval), and [audit](https://www.windmill.dev/docs/core_concepts/audit_logs).
- Prefect [states](https://github.com/PrefectHQ/prefect/blob/main/docs/v3/concepts/states.mdx), [human input](https://github.com/PrefectHQ/prefect/blob/main/docs/v3/advanced/interactive.mdx), and [artifacts](https://github.com/PrefectHQ/prefect/blob/main/docs/v3/concepts/artifacts.mdx).

## Required product advantage

The Admin is only meaningfully Loop Engineering-native if it is visibly and
enforceably stronger in these areas:

1. The immutable objective is decomposed into versioned requirements with
   acceptance criteria and hashes.
2. Deterministic evidence records the command, exit code, timestamps, raw-log
   reference, producer, and artifact digest. Agent prose is not evidence.
3. Maker and checker use different roles and sessions. Checker verdicts cite
   evidence for every requirement and bind to the exact artifact digest.
4. Rejection creates a new immutable attempt linked to the previous feedback.
5. Time, token, cost, iteration, same-error, and consecutive-failure budgets can
   cap or block a run without rewriting its history.
6. Approval binds to an immutable action and evidence hash, has an expiry and
   reason, and cannot survive an artifact change.
7. The activity stream exposes public actions, tool results, and logs without
   requesting or storing hidden chain-of-thought.
8. Every mutation, transition, retry, verdict, approval, and override appends an
   actor-attributed audit record.

## Release acceptance matrix

| ID | Scenario | Required evidence | Current evidence and boundary |
| --- | --- | --- | --- |
| A01 | Illegal state jump | API integration and state-machine tests reject it | Verified by state-machine and API transition tests, including terminal and same-state immutability |
| A02 | Agent says done without passing checks | Run remains in verify/check and requirements remain non-pass | Verified by completion-guard and managed-run integration tests |
| A03 | Maker submits checker verdict | API denies it and records the rejected action | Verified by maker/checker identity and digest-binding API tests |
| A04 | Checker rejects an attempt | A new attempt retains the old digest, logs, verdict, and feedback lineage | Verified by structured-runtime lifecycle and immutable retry-history tests |
| A05 | Budget or repeated error is exhausted | Breaker opens and scheduling stops with `capped` or `blocked` | Verified by cumulative-budget and repeated-failure breaker tests |
| A06 | Duplicate event or reconnect | Event IDs and sequences remain idempotent; SSE resumes without silent gaps | Verified by duplicate/regression checks and SSE replay tests covering more than 2,000 events |
| A07 | Approval target changes | Old decision becomes invalid; expiry and optimistic concurrency are enforced | Verified by digest-bound completion guards and approval compare-and-swap tests |
| A08 | Unauthorized mutation | Viewer/operator/admin API and UI permissions agree | Scoped verification only: API and UI permission profiles are tested, but this local single-user release has no login, user directory, or multi-user RBAC |
| A09 | Secret appears in an event | Stored, streamed, displayed, and exported forms are redacted | Verified by recursive redaction contract tests and event-persistence API tests |
| A10 | Audit reconciliation | Mutations and state transitions reconcile to append-only audit rows | Verified for structured facts, transitions, rejected actions, approvals, breaker overrides, and global pause in API tests |
| A11 | Operator locates a blocker | Dashboard to run evidence/log/approval journey completes in under 30 seconds | Run-detail and approval journeys are covered by browser tests and manual QA; the 30-second target is not separately performance-instrumented |
| A12 | Mobile and keyboard operation | 390/320 px screenshots, keyboard approval journey, and axe checks pass | Verified by Playwright overflow checks at 390 and 320 px, keyboard-only approval, and serious/critical axe checks |
| A13 | Metrics are displayed | Counts and rates recompute exactly from deterministic seed data | Seeded overview metrics and outcome views are covered by API/component rendering tests; no external analytics backend is involved |
| A14 | Clone and start | A clean checkout starts locally with one documented command and no container | Verified from a clean source-only checkout with `npm run admin`; Node.js 22.13+ is the only prerequisite |
| A15 | Competitor parity | Live goal/action, fleet/inbox, truthful run/approval/audit, and state history are all represented | Implemented across Overview, Runs, Run Detail, Approvals, Agents & Worktrees, Artifacts, Policies & Budgets, and Audit; parity remains a qualitative product review |

Completion requires every row above to have current test, API, rendered UI, or
runtime evidence. A screenshot alone does not prove execution or security
behavior.
