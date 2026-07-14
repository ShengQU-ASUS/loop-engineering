export interface StageTemplate {
  key: string;
  name: string;
  role: "system" | "triage" | "maker" | "checker" | "human";
  description: string;
}

export const DEFAULT_DEVELOPMENT_STAGES: readonly StageTemplate[] = [
  { key: "trigger", name: "Trigger", role: "system", description: "Capture the immutable objective and actor." },
  { key: "intake", name: "Intake", role: "triage", description: "Resolve scope, repository, constraints, and risk." },
  { key: "requirements", name: "Requirements", role: "triage", description: "Create versioned acceptance criteria and hashes." },
  { key: "plan", name: "Plan", role: "triage", description: "Publish an observable execution plan." },
  { key: "budget_guard", name: "Budget guard", role: "system", description: "Check token, time, cost, and iteration limits." },
  { key: "worktree", name: "Worktree", role: "system", description: "Create an isolated change surface." },
  { key: "make", name: "Make", role: "maker", description: "Implement one bounded attempt." },
  { key: "verify", name: "Deterministic verify", role: "system", description: "Run tests, checks, and artifact validation." },
  { key: "check", name: "Independent checker", role: "checker", description: "Judge every requirement against evidence." },
  { key: "approve", name: "Human gate", role: "human", description: "Approve scoped high-risk or externally visible actions." },
  { key: "apply", name: "Apply", role: "system", description: "Apply the approved change or open a review surface." },
  { key: "final_verify", name: "Final verify", role: "checker", description: "Re-run acceptance checks on the final artifact." },
  { key: "persist", name: "Persist state", role: "system", description: "Record outcome, evidence, cost, and next action." },
] as const;

export const DEFAULT_BUDGET = {
  tokenLimit: 200_000,
  costLimitUsd: 30,
  iterationLimit: 5,
  warningPercent: 80,
} as const;

export function deriveFreshness(
  lastEventAt: string | null,
  sourceMode: "managed" | "snapshot",
  now = Date.now(),
): "live" | "delayed" | "stale" | "unknown" {
  if (!lastEventAt) return "unknown";
  const age = now - Date.parse(lastEventAt);
  if (!Number.isFinite(age) || age < 0) return "unknown";
  if (sourceMode === "snapshot") return age <= 5 * 60_000 ? "delayed" : "stale";
  if (age <= 60_000) return "live";
  if (age <= 5 * 60_000) return "delayed";
  return "stale";
}

export function budgetPercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.round((used / limit) * 100));
}
