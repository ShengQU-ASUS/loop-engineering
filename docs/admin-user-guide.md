# Loop Engineering Admin User Guide

This guide is for the person starting and supervising work. It explains how to
create a task, launch real execution, see what is happening, and respond when a
run needs attention.

For API payloads, runner integrations, and server configuration, use the
[Admin setup and integration reference](../apps/admin/README.md).

## Five-minute path

1. Run `npm run admin` and open <http://127.0.0.1:8787>.
2. Select **New run**.
3. Enter the project, repository path, objective, and testable acceptance
   requirements, then select **Create queued run**.
4. On Run Detail, copy the command under **Attach real execution telemetry**.
5. Run that command in a second terminal after replacing its final `npm test`
   with the real command or agent you want to execute.
6. Return to Run Detail. Watch **Stage progression**, **Current observable
   work**, **Activity & logs**, and **Verification & evidence**.

When a successful maker run reaches **WAITING**, read the waiting callout. It
normally means an independent checker must review the candidate.

## What the Admin does

The Admin creates an explicit execution contract for each task and shows its
observable progress. It records stages, command output, attempts, evidence,
independent checker decisions, approvals, budgets, circuit breakers, and audit
history.

The current release does not automatically launch Codex, Claude, or an
independent checker when you click **New run**. Creating a run and launching a
process are two separate steps. The bundled runner manages real work through
the maker stage and then stops at the independent checker gate.

The browser is an operational control plane, not a complete in-browser runner:

| Available in the browser | Requires a terminal or integration |
| --- | --- |
| Create a run and define its requirements and budgets | Launch the maker command |
| View stages, current work, logs, attempts, evidence, agents, and artifacts | Register a separate checker and submit its verdict |
| Pause, resume, cancel, retry, or override a breaker | Advance post-maker workflow stages |
| Approve or reject a pending human decision | Create the approval request at the human stage |
| Search history and inspect the audit trail | Submit the final `succeeded` transition |

## 1. Start the Admin

From the cloned `loop-engineering` repository:

```bash
npm run admin
```

Leave that terminal open and visit <http://127.0.0.1:8787>.

Confirm two things before starting work:

1. The lower-left corner says **Control plane connected**.
2. The page does not show **Sample workspace**. Sample mode is read-only and is
   intended only for exploring the interface.

A new operational workspace is intentionally empty. Seeing zero runs, agents,
or approvals is normal.

## 2. Create a task

1. Open **Overview** or **Runs**.
2. Select **New run**.
3. Complete the form.
4. Select **Create queued run**.

The most important fields are:

| Field | What to enter |
| --- | --- |
| Project name | A short name shown on Run Detail to identify the project context. |
| Repository path | The absolute local path to the repository where work will run. |
| Objective | The observable outcome you want, not a general instruction to "improve" something. |
| Loop template | The reusable workflow and policy for this task. **General development** is the normal default. |
| Automation | The intended autonomy level: report only, approval gated, or autonomous. |
| Risk | The impact if the work or decision is wrong. |
| Agent runtime and model | Labels describing the process you plan to attach. These fields do not launch it. |
| Acceptance requirements | Specific conditions that must have evidence before the task can pass. |
| Run budget | Token, cost, and iteration ceilings, plus the warning threshold. |

Write requirements so another person can verify them without guessing. For
example:

```text
Objective
Add retry-safe webhook delivery.

Requirement
Duplicate deliveries do not execute the handler twice.

Acceptance criteria
A test sends at least 20 concurrent deliveries with the same idempotency key
and records exactly one handler execution.
```

After creation, the Admin opens the Run Detail page. The initial status is
**QUEUED**, which means the tracking record exists but no process is running.

## 3. Start real execution

On the Run Detail page, find **Attach real execution telemetry**.

1. Select the copy icon beside the generated runner command.
2. Paste the command into a second terminal at the cloned Admin repository.
3. Replace the final `npm test` with the command that should perform the work.
4. Run it.

A typical command looks like this:

```bash
npm run admin:run -- \
  --run <run-id> \
  --cwd /absolute/path/to/project \
  -- npm test
```

The final command can be a test suite, build, script, Codex CLI command, Claude
Code command, or any other local executable. For example, when Codex CLI is
installed and configured, replace the placeholders with the Objective and
Acceptance requirements shown on Run Detail:

```bash
npm run admin:run -- \
  --run <run-id> \
  --cwd /absolute/path/to/project \
  -- codex exec "Implement <objective>. Acceptance requirements: <requirement 1>; <requirement 2>. Run the relevant checks and report the observable results."
```

The wrapper automatically:

- changes a queued run to running;
- advances the setup stages to the maker stage;
- registers the maker session and attempt;
- streams observable stdout and stderr;
- records the command result, repository candidate, digest, and requirement
  evidence;
- stops at the independent checker gate after a successful command.

The **Mark running** button only changes tracking state. It does not launch a
process. Normally, use the generated runner command instead.

## 4. See what is happening

Use **Overview** to scan all current work:

- **Active runs** shows work currently executing.
- **Waiting** shows runs that need an event, checker, or other input.
- **Approvals** shows human decisions waiting for you.
- **Open breakers** shows execution stopped by a safety limit.
- **Stale agents** shows sessions whose heartbeat is overdue.
- **Needs attention** puts the highest-impact blockers first.

Use **Runs** to search and filter the most recent 100 runs loaded by the local
API. Select a run title or its arrow to open Run Detail.

The Run Detail page answers different questions in different sections:

| Section | What it tells you |
| --- | --- |
| Stage progression | Which workflow stage is active, passed, waiting, blocked, or failed. |
| Current observable work | The latest action reported by the active runtime. |
| Activity & logs | Timestamped commands, output, state changes, and human actions. Expand an event to inspect its payload. |
| Attempts | Every maker attempt, retry lineage, checker status, branch, and artifact binding. Old attempts are never replaced. |
| Verification & evidence | Which requirements pass or fail, the cited evidence, deterministic checks, and artifact digests. |
| Run state | Status, current stage, requirement count, runtime, event sequence, and last telemetry time. |
| Budget | Tokens, cost, and iterations used against their limits. |
| Circuit breaker | Repeated-error and consecutive-failure counts, plus the stop reason. |
| Approval gate | The current human decision, when one is required. |

Open **Agents & Worktrees** when you need to confirm which agent session is
working, its latest observable action, heartbeat age, checkout, branch, and
dirty state.

The Admin displays observable facts and tool output. It does not request or
display an agent's private chain-of-thought.

## 5. Understand run status

| Status | Meaning |
| --- | --- |
| `queued` | The task exists, but execution has not started. |
| `running` | Work or a managed stage is active. |
| `waiting` | Progress needs a checker verdict, approval, external event, or other recorded input. Read the waiting reason. |
| `paused` | An operator paused this run. |
| `blocked` | A named owner or condition must resolve a blocker. |
| `capped` | A hard budget or safety limit ended the run. |
| `succeeded` | All completion guards and required stages passed. |
| `failed` | The run ended unsuccessfully. |
| `timed_out` | The allowed execution time expired. |
| `cancelled` | An operator intentionally ended the run. |

Do not infer health from status alone. Also check **Current stage**, **Last
telemetry**, the latest event, and requirement evidence.

## 6. Handle an independent checker gate

When the maker command succeeds, the run changes to **WAITING** and the page
shows **Awaiting independent checker**.

The checker must use a different agent identity and session from the maker. It
should review:

1. **Objective & acceptance requirements**.
2. **Verification & evidence** for every requirement.
3. The current artifact digest under **Attempts** or **Active binding**.
4. The actual diff, files, and test results in the project repository.

Verdict submission is currently a CLI or integration action, not a one-click UI
action. The waiting callout shows the command:

```bash
npm run admin:cli -- show --run <run-id>
npm run admin:cli -- verdict --run <run-id> --file checker-verdict.json
```

The checker session must first be registered with a fresh checker heartbeat,
and its verdict must cite current evidence for every requirement and match the
artifact digest. See [Structured runtime facts](../apps/admin/README.md#structured-runtime-facts)
for the integration contract.

A human approval is separate from the checker verdict. It does not
automatically launch or pretend to be an independent checker.

After a checker approval, select **Resume** on Run Detail and record why the run
can continue. A workflow integration can then advance the remaining stages.
The UI will display those changes, but it does not advance checker, human,
apply, final-verification, or persistence stages on its own.

## 7. Make a human approval decision

The default workflow includes a human gate. A workflow integration must first
advance to that stage and create a digest-bound approval request. When
**Approvals** shows a count:

1. Open **Approvals** and stay on **Pending**.
2. Select **Review run evidence** to inspect the associated run.
3. Confirm the requested action, target, independent checker summary, evidence
   digest, risk, and expiry.
4. Return to the approval and select **Review decision**.
5. Choose **Approve** or **Reject**.
6. Enter a concrete reason, then select **Approve action** or **Reject action**.

Approve only the displayed action and digest. If the artifact changes, the old
approval is no longer valid for the new candidate.

## 8. Respond to common blockers

### The run says waiting

Read the yellow waiting callout and the current stage. Most successful maker
runs wait for an independent checker. Other runs may wait for a human approval
or external event.

### The circuit breaker is open

Read its trigger and error signature before taking action. Select **Override
breaker** only after the underlying condition changed, record the reason, then
resume the run. The original trigger remains in Audit.

### An agent is stale

Open **Agents & Worktrees** and check the heartbeat and current action. Confirm
whether the local process is still running. A stale active session can submit a
fresh heartbeat. A `finished` or `error` session is terminal and must be
replaced by a new agent and session identity.

### The command failed

Open **Activity & logs** for stderr and **Verification & evidence** for the
failed command. A failed attached command normally leaves the run running with
a failed immutable attempt. Fix the cause, then run the generated runner command
again to create the next attempt. **Retry** appears only after the run itself is
terminally failed, timed out, cancelled, or capped; it creates a new queued
retry run while the original run remains in history.

### Workspace dispatch is paused

**Pause dispatch** stops new run creation, starts, and resumes. It does not kill
already running processes. Use **Resume dispatch** from Overview when it is safe
to allow new execution.

## 9. Pause, resume, cancel, or retry

Run controls appear beside the status on Run Detail:

- **Pause** changes the control-plane state and blocks new managed progress. It
  does not kill an already running external process, which may still emit
  output.
- **Resume** allows a paused or waiting run to continue when its prerequisite is
  satisfied.
- **Cancel** terminally ends the run and stops the bundled runner when attached.
- **Retry** creates a new queued retry run after an unsuccessful terminal run.
  Launch its runner command separately when you are ready.
- **Override breaker** is an exceptional, audited admin action.

Every control action requires a reason and is written to Audit.

## 10. Know when work is complete

An agent saying "done" is not completion. A run can become **SUCCEEDED** only
when:

- every current acceptance requirement has passing evidence;
- an independent checker approved the exact artifact digest;
- every required human approval is current and unexpired;
- every required workflow stage passed or was explicitly skipped;
- no budget or circuit-breaker rule prevents completion.

The bundled command runner intentionally ends at the checker gate. A separate
checker must submit the verdict, and a workflow integration must advance the
remaining stages, create any required approval request, and ask for the final
transition. The server refuses a forced success when completion evidence is
incomplete.

## 11. Find past decisions and outputs

- **Artifacts** lists immutable outputs, producers, integrity state, sensitivity,
  and digest.
- **Audit** records operator and runtime mutations with actor, target, reason,
  run, and metadata.
- **Policies & Budgets** shows enforced rules, rejected mutation classes, active
  budgets, and loop policy assignments.
- **Runs** retains terminal and retried work for later search.

## Troubleshooting

### New run is disabled

Check whether you are in **Sample workspace**, workspace dispatch is paused, or
there is no enabled loop template.

### The page is connected but nothing appears

An empty operational database is normal. Create the first run. The Admin does
not fabricate activity.

### A run receives no telemetry

Confirm that the Admin terminal is still running and that the actual command is
inside `npm run admin:run`. A command launched directly cannot report progress
unless it has its own Admin integration.

### The Admin uses a non-default port

Point CLI and runner commands to the same server:

```bash
LOOP_ADMIN_URL=http://127.0.0.1:9000 \
  npm run admin:run -- --run <run-id> --cwd /path/to/project -- npm test
```

### Port 8787 is already in use

Start on another port:

```bash
npm run admin -- --port 9000
```

## Quick reference

| Goal | Where to go |
| --- | --- |
| Start a task | **Overview** or **Runs** > **New run** |
| Launch work | Run Detail > **Attach real execution telemetry** |
| See current activity | Run Detail > **Current observable work** and **Activity & logs** |
| See the current stage | Run Detail > **Stage progression** |
| See recent tasks | **Runs** |
| Find blockers | **Overview** > **Needs attention** |
| Inspect agent activity | **Agents & Worktrees** |
| Review proof | Run Detail > **Verification & evidence** |
| Approve an action | **Approvals** > **Review decision** |
| Inspect limits | Run Detail > **Budget** and **Circuit breaker** |
| Review history | **Audit** |
