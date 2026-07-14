# Loop Engineering Admin

A local-first operational control plane for any Loop Engineering workflow. It
shows what observable action an agent is performing, which stage and attempt is
active, what deterministic evidence exists, why a checker accepted or rejected
the work, which approvals are waiting, and whether budget or circuit-breaker
limits have stopped the loop.

## Quick start

From the repository root:

```bash
npm run admin
```

The first run installs workspace dependencies, creates
`.loop-admin/control-plane.db`, builds the production application, and starts
one API/UI server. Open <http://127.0.0.1:8787>.

A fresh operational database contains the required workspace settings and one
reusable `General development` loop definition. It contains zero fabricated
runs, agents, events, approvals, or audit entries. Create the first real run in
the UI or CLI.

No Docker, Rancher, external database, or cloud account is required. The server
binds to loopback by default.

Optional sample data is explicit and isolated:

```bash
npm run admin -- --demo
```

Demo mode uses `.loop-admin/demo.db`. Its identity is persisted in SQLite and
reported as `dataMode: "demo"` by `/api/session`; restarting that database
cannot make it appear operational. Sample runs are read-only `snapshot`
records, and their events and evidence use snapshot provenance.

## Commands

```bash
npm run admin:dev        # API with watch mode + Vite
npm run admin:build      # production API and static frontend
npm run admin:start      # serve the production build on :8787
npm run admin:typecheck  # shared contracts, API, and frontend
npm run admin:test       # contract, API, and component tests
npm run admin:test:e2e   # Playwright desktop/mobile journeys
npm run admin:cli -- --help
npm run admin:run -- --run <id> --stage <id> -- npm test
```

`npm run admin` is the normal end-user command. It builds and serves the static
UI and API from one process on port 8787. `admin:dev` is the developer-only
watch mode: Vite runs on 5173 and proxies the API on 8787.

Startup options are cross-platform and do not require editing environment
files:

```bash
npm run admin -- --port 9000
npm run admin -- --db ./local-data/control-plane.db
npm run admin -- --demo
npm run admin -- --help
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOOP_ADMIN_HOST` | `127.0.0.1` | API bind host |
| `LOOP_ADMIN_PORT` | `8787` | API and production UI port |
| `LOOP_ADMIN_DB` | `.loop-admin/control-plane.db` | SQLite database path, or `:memory:` in tests |
| `LOOP_ADMIN_DEMO` | `0` | Set to `1` to opt into persistent snapshot demo data |
| `LOOP_ADMIN_TOKEN` | unset | Bearer token required when the API binds beyond loopback |

Without an explicit `LOOP_ADMIN_DB`, demo mode uses `.loop-admin/demo.db` and
normal mode uses `.loop-admin/control-plane.db`. Passing `--demo` or setting
`LOOP_ADMIN_DEMO=1` against a database already marked operational is rejected.
This prevents sample rows from entering real execution history.

The launcher recognizes legacy databases containing the exact former sample
runs (`run-webhook`, `run-release`, and `run-deps`), marks them persistently as
demo, preserves the file, and starts a clean `.loop-admin/operational.db`
instead. An explicit `--db` path is always respected.

The default server listens only on `127.0.0.1`. A non-loopback
`LOOP_ADMIN_HOST` is rejected unless `LOOP_ADMIN_TOKEN` is set:

```bash
LOOP_ADMIN_HOST=0.0.0.0 LOOP_ADMIN_TOKEN='replace-with-a-long-random-token' npm run admin

LOOP_ADMIN_URL=http://192.168.1.20:8787 \
LOOP_ADMIN_TOKEN='replace-with-a-long-random-token' \
npm run admin:cli -- health
```

The CLI and command runner send `LOOP_ADMIN_TOKEN` as a Bearer token. This is
the supported API-client mode for a non-loopback bind; the browser UI is not a
remote token-entry client.

Workspace Global Pause prevents new run creation, start, and resume. It does
not discard telemetry from work that was already running. An open circuit
breaker is stricter: new attempts, stage progress, checker verdicts, and
approval requests stop until an audited override and run resume; heartbeat and
in-flight terminal observations remain recordable.

## Telemetry contract

Runners report public, observable events through the API. The Admin does not
request or display hidden chain-of-thought. Useful event categories include:

- goal and requirement checkpoints;
- tool invocation and exit result;
- stdout/stderr chunks after secret redaction;
- file, diff, test, screenshot, and artifact evidence;
- maker attempt and independent checker verdict;
- approval request and decision;
- budget, retry, and circuit-breaker observations;
- final verification and persisted state.

See [the control-plane architecture](../../docs/admin-control-plane.md) for the
state domains, security rules, and delivery gates.

## Structured runtime facts

Use `POST /api/runs/:runId/runtime-facts` when telemetry must update live
control-plane state. Each fact has a caller-generated `id`. Replaying the same
ID and payload is idempotent; reusing it with different content returns `409`.
Facts and their materialized row, event, and audit entry commit atomically.

Supported fact types are:

| Type | Materialized state |
| --- | --- |
| `agent.heartbeat` | Registers or refreshes one immutable agent/run/session identity |
| `attempt.started` | Creates a maker attempt in an active maker stage, with immutable retry feedback lineage |
| `worktree.recorded` | Creates or CAS-updates a worktree with `expectedVersion` |
| `attempt.artifact` | CAS-binds the attempt's current SHA-256 digest |
| `artifact.recorded` | Records a digest-bound artifact |
| `verification.recorded` | Records a digest-bound deterministic command result |
| `requirement.evidence` | Records evidence for one current signed requirement |
| `attempt.finished` | Closes a failed, no-op, or cancelled maker attempt |
| `approval.requested` | Opens a human gate after an independent checker approval |

SHA-256 values are 64 lowercase hexadecimal characters. Agents must heartbeat
at least every five minutes; otherwise they appear as `stale` and cannot submit
facts or checker verdicts until a fresh heartbeat arrives. Agent IDs represent
runtime instances and must be globally unique. Successful maker completion is
decided by the existing independent checker verdict endpoint, not by
`attempt.finished`.

After a checker rejection, the next `attempt.started` fact must name the
immediately previous `previousAttemptId`, its immutable `feedbackReviewId`, and
the exact checker review `feedbackSummary`. Failure retries without a checker
review still require the previous attempt and a feedback summary. The previous
attempt, digest, review, and event history are never rewritten.

This example creates and starts a real run, then registers a maker heartbeat:

```bash
RUN_ID="$(npm run --silent admin:cli -- create \
  --goal 'Implement searchable run history' \
  --acceptance 'Searching by run ID returns the matching persisted run' \
  --project 'My application' \
  --repo "$PWD" \
  --runtime codex | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => console.log(JSON.parse(s).id))')"

npm run admin:cli -- action --run "$RUN_ID" --action start

cat > /tmp/loop-maker-heartbeat.json <<'JSON'
{
  "id": "fact-maker-heartbeat-001",
  "type": "agent.heartbeat",
  "agentId": "maker-local-001",
  "sessionId": "maker-session-local-001",
  "name": "Local maker",
  "role": "maker",
  "runtime": "codex",
  "model": "configured by runner",
  "status": "running",
  "currentAction": "Reading repository constraints"
}
JSON

npm run admin:cli -- fact --run "$RUN_ID" --file /tmp/loop-maker-heartbeat.json
npm run admin:cli -- show --run "$RUN_ID"
```

The `show` response contains the stage and requirement IDs needed by later
facts. The remaining control operations are also available through the CLI:

```bash
npm run admin:cli -- stage \
  --run "$RUN_ID" --stage <maker-stage-id> --status active

npm run admin:cli -- verdict \
  --run "$RUN_ID" --file checker-verdict.json

npm run admin:cli -- approval \
  --approval <approval-id> --decision approved \
  --reason "Reviewed current digest and evidence" --version 1

npm run admin:cli -- transition \
  --run "$RUN_ID" --status succeeded --expected running
```

`checker-verdict.json` uses the checker contract: `attemptId`, independent
`checkerAgentId` and `checkerSessionId`, `verdict`, `summary`,
`artifactDigest`, and one digest-bound `requirementResults` entry per current
requirement. Requesting the human gate itself is an `approval.requested`
runtime fact; the `approval` command records the human decision with optimistic
version checking. `transition` still passes through the server completion
guard, so it cannot force an unsupported success.

## Connect any local loop

Create a run and send observable events from shell scripts, Codex hooks, Claude
hooks, CI, or a custom runner without installing another SDK:

```bash
npm run admin:cli -- create \
  --goal "Implement searchable run history" \
  --acceptance "Searching by run ID returns the matching persisted run" \
  --project "My application" \
  --repo "$PWD" \
  --runtime codex

npm run admin:cli -- event \
  --run <run-id> \
  --type tool.completed \
  --message "npm test exited 0" \
  --payload '{"command":"npm test","exitCode":0}'
```

Low-level `event` calls remain useful for logs and tool progress. Use structured
facts for state that must participate in attempts, evidence, digest checks,
approvals, or completion guards.

Every CLI-created managed run must start with signed acceptance requirements.
Use `--acceptance TEXT` for one requirement derived from the goal, as above, or
pass `--requirements FILE` with a non-empty JSON array:

```json
[
  {
    "title": "Search persisted runs",
    "description": "Operators can find prior work without scanning every run.",
    "acceptanceCriteria": "A query returns matching persisted run IDs and titles."
  }
]
```

The CLI rejects missing, empty, or ambiguous requirement input before sending a
request. Use exactly one of `--acceptance` and `--requirements`.

Event bodies cannot choose their persisted actor; the API replaces it with the
authenticated identity, redacts correlation IDs, and writes an `event.ingest`
audit entry in the same transaction. Long histories are available from
`GET /api/runs/:id/events/page?after=<sequence>&limit=<n>`. SSE accepts either
`Last-Event-ID` or `?after=<sequence>`; run detail embeds only the latest 500
events to keep long-running views bounded.

The CLI uses `LOOP_ADMIN_URL` when the API is not running on the default local
port and attaches `LOOP_ADMIN_TOKEN` when configured. Mutation attribution is
derived from the authenticated server identity; caller-supplied actor headers
or event-body actor values are never trusted.

To stream a real command's start, stdout, stderr, exit code, and duration into a
run while preserving normal terminal output:

```bash
npm run admin:run -- \
  --run <run-id> \
  --stage <stage-id> \
  --attempt <attempt-id> \
  -- npm test
```

The wrapper returns the command's original exit code. Telemetry delivery errors
are reported separately and never turn a passing command into a false failure.
