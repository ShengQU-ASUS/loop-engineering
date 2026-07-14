import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DATABASE_PATH = resolve(process.cwd(), ".loop-admin/control-plane.db");

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS loops (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        automation_level TEXT NOT NULL CHECK (automation_level IN ('L1','L2','L3')),
        owner TEXT NOT NULL,
        schedule TEXT,
        risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
        readiness_score INTEGER NOT NULL CHECK (readiness_score BETWEEN 0 AND 100),
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        last_run_at TEXT,
        next_run_at TEXT,
        policy_version TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL REFERENCES loops(id),
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','paused','blocked','capped','succeeded','failed','timed_out','cancelled')),
        automation_level TEXT NOT NULL CHECK (automation_level IN ('L1','L2','L3')),
        risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
        current_stage_id TEXT,
        waiting_reason TEXT,
        blocked_owner TEXT,
        unblock_condition TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        last_event_at TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        source_mode TEXT NOT NULL CHECK (source_mode IN ('managed','snapshot')),
        token_limit INTEGER NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        cost_limit_usd REAL NOT NULL,
        cost_used_usd REAL NOT NULL DEFAULT 0,
        iteration_limit INTEGER NOT NULL,
        iterations_used INTEGER NOT NULL DEFAULT 0,
        warning_percent INTEGER NOT NULL,
        breaker_status TEXT NOT NULL DEFAULT 'closed' CHECK (breaker_status IN ('closed','warning','open','overridden')),
        same_error_count INTEGER NOT NULL DEFAULT 0,
        same_error_limit INTEGER NOT NULL DEFAULT 3,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_failure_limit INTEGER NOT NULL DEFAULT 5,
        breaker_trigger TEXT,
        error_signature TEXT,
        breaker_opened_at TEXT,
        breaker_overridden_by TEXT,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;

      CREATE TABLE IF NOT EXISTS stages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system','triage','maker','checker','human')),
        status TEXT NOT NULL CHECK (status IN ('pending','active','waiting','passed','rejected','failed','skipped','blocked')),
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        waiting_reason TEXT,
        skip_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(run_id, position),
        UNIQUE(run_id, key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL REFERENCES stages(id),
        number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','success','failure','noop','rejected','escalated','cancelled')),
        maker_agent_id TEXT NOT NULL,
        maker_session_id TEXT NOT NULL,
        checker_agent_id TEXT,
        checker_session_id TEXT,
        checker_status TEXT NOT NULL CHECK (checker_status IN ('pending','running','approve','reject','escalate_human','error')),
        checker_summary TEXT,
        artifact_digest TEXT,
        worktree_path TEXT,
        branch TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(run_id, stage_id, number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','passed','failed','skipped')),
        exit_code INTEGER,
        duration_ms INTEGER,
        evidence_digest TEXT,
        output_preview TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','pass','fail','missing')),
        content_hash TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        checker_summary TEXT,
        created_at TEXT NOT NULL,
        superseded_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        requirement_id TEXT REFERENCES requirements(id),
        attempt_id TEXT REFERENCES attempts(id),
        kind TEXT NOT NULL CHECK (kind IN ('command','test','diff','artifact','screenshot','review','other')),
        status TEXT NOT NULL CHECK (status IN ('running','pass','fail','missing')),
        summary TEXT NOT NULL,
        command TEXT,
        exit_code INTEGER,
        raw_log_ref TEXT,
        artifact_digest TEXT,
        producer TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('runtime','agent_reported','derived','snapshot','human')),
        created_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        checker_agent_id TEXT NOT NULL,
        checker_session_id TEXT NOT NULL,
        artifact_digest TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('approve','reject','escalate_human')),
        summary TEXT NOT NULL,
        requirement_results_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL REFERENCES stages(id),
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','revoked')),
        requested_action TEXT NOT NULL,
        target TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
        evidence_digest TEXT NOT NULL,
        maker_summary TEXT NOT NULL,
        checker_verdict TEXT NOT NULL CHECK (checker_verdict IN ('pending','running','approve','reject','escalate_human','error')),
        checker_summary TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        decision_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('triage','maker','checker','system')),
        runtime TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting','running','waiting','finished','error','stale')),
        current_run_id TEXT REFERENCES runs(id),
        current_action TEXT,
        last_heartbeat_at TEXT,
        session_id TEXT,
        worktree_path TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES attempts(id),
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        commit_hash TEXT,
        dirty INTEGER NOT NULL CHECK (dirty IN (0,1)),
        status TEXT NOT NULL CHECK (status IN ('active','rejected','escalated','merged','stale')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES attempts(id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('diff','report','log','dataset','workbook','other')),
        uri TEXT NOT NULL,
        digest TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        producer TEXT NOT NULL,
        verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified','verified','invalid','missing')),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','internal','restricted'))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        row_number INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        stage_id TEXT REFERENCES stages(id),
        attempt_id TEXT REFERENCES attempts(id),
        type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('debug','info','warning','error','critical')),
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('runtime','agent_reported','derived','snapshot','human')),
        actor TEXT NOT NULL,
        correlation_id TEXT,
        artifact_digest TEXT,
        redacted INTEGER NOT NULL CHECK (redacted IN (0,1)),
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_log (
        row_number INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT REFERENCES runs(id),
        actor TEXT NOT NULL,
        actor_role TEXT NOT NULL CHECK (actor_role IN ('viewer','operator','admin')),
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        reason TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stages_run_position ON stages(run_id, position);
      CREATE INDEX IF NOT EXISTS idx_attempts_run_number ON attempts(run_id, number DESC);
      CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_status_requested ON approvals(status, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE runs ADD COLUMN project_name TEXT NOT NULL DEFAULT 'Local project';
      ALTER TABLE runs ADD COLUMN repository_path TEXT;
      ALTER TABLE runs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'generic';
      ALTER TABLE runs ADD COLUMN model TEXT NOT NULL DEFAULT 'configured default';
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE worktrees ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE runtime_facts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
        accepted_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_runtime_facts_run_accepted ON runtime_facts(run_id, accepted_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE attempts ADD COLUMN previous_attempt_id TEXT REFERENCES attempts(id);
      ALTER TABLE attempts ADD COLUMN feedback_review_id TEXT REFERENCES reviews(id);
      ALTER TABLE attempts ADD COLUMN feedback_summary TEXT;
    `,
  },
] as const;

export function openDatabase(path = process.env.LOOP_ADMIN_DB ?? DEFAULT_DATABASE_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;`);

  const current = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
  for (const migration of MIGRATIONS) {
    if (migration.version <= current.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
