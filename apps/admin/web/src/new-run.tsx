import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CirclePlay, Plus, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useGlobalPauseState, useSessionAccess } from "./access";
import { apiMutation } from "./api";
import { Callout, Modal } from "./components";
import type { LoopDefinition } from "./types";

const defaultStages = [
  { key: "trigger", name: "Trigger", role: "system" },
  { key: "intake", name: "Intake & requirements", role: "triage" },
  { key: "state", name: "Load state & constraints", role: "system" },
  { key: "budget", name: "Budget guard", role: "system" },
  { key: "worktree", name: "Isolated worktree", role: "system" },
  { key: "maker", name: "Maker implementation", role: "maker" },
  { key: "verify", name: "Deterministic verification", role: "system" },
  { key: "checker", name: "Independent checker", role: "checker" },
  { key: "human", name: "Human gate", role: "human" },
  { key: "apply", name: "Apply or deliver", role: "system" },
  { key: "final-verify", name: "Final verification", role: "checker" },
  { key: "persist", name: "Persist state", role: "system" },
] as const;

export function NewRunButton({ loops, disabled = false, disabledReason }: { loops: LoopDefinition[]; disabled?: boolean; disabledReason?: string }) {
  const [open, setOpen] = useState(false);
  const [requirements, setRequirements] = useState([0]);
  const [loopId, setLoopId] = useState("");
  const [automationLevel, setAutomationLevel] = useState<LoopDefinition["automationLevel"]>("L2");
  const [risk, setRisk] = useState<LoopDefinition["risk"]>("medium");
  const formId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const access = useSessionAccess();
  const globalPause = useGlobalPauseState();
  const enabledLoops = loops.filter((loop) => loop.enabled);
  const mutation = useMutation({
    mutationFn: (body: unknown) => apiMutation<{ id: string }>("/runs", body),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["api", "/runs"] }),
        queryClient.invalidateQueries({ queryKey: ["api", "/overview"] }),
      ]);
      setOpen(false);
      navigate(`/runs/${run.id}`);
    },
  });

  const selectTemplate = (id: string) => {
    const loop = enabledLoops.find((item) => item.id === id);
    if (!loop) return;
    setLoopId(loop.id);
    setAutomationLevel(loop.automationLevel);
    setRisk(loop.risk);
  };

  const openDialog = () => {
    const loop = enabledLoops[0];
    if (!loop) return;
    mutation.reset();
    setRequirements([0]);
    selectTemplate(loop.id);
    setOpen(true);
  };

  const closeDialog = () => {
    mutation.reset();
    setOpen(false);
  };

  const unavailableReason = disabled ? disabledReason ?? "Connect the local API to create a real run"
    : !enabledLoops.length ? "No enabled loop template is available"
    : !access.ready ? "Waiting for the local session"
    : !access.canOperate ? "Operator role required to create a run"
    : !globalPause.ready ? "Waiting for workspace dispatch state"
    : globalPause.paused ? "Resume workspace dispatch before creating a run"
    : undefined;
  const unavailable = Boolean(unavailableReason);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate({
      loopId: data.get("loopId"), projectName: data.get("projectName"), repositoryPath: data.get("repositoryPath") || null, runtime: data.get("runtime"), model: data.get("model"), goal: data.get("goal"), automationLevel: data.get("automationLevel"), risk: data.get("risk"), sourceMode: "managed",
      stages: defaultStages,
      requirements: requirements.map((id) => ({ title: data.get(`requirementTitle-${id}`), description: data.get(`requirementDescription-${id}`), acceptanceCriteria: data.get(`acceptanceCriteria-${id}`) })),
      budget: { tokenLimit: Number(data.get("tokenLimit")), costLimitUsd: Number(data.get("costLimitUsd")), iterationLimit: Number(data.get("iterationLimit")), warningPercent: Number(data.get("warningPercent")) },
    });
  };

  return <>
    <button className="button button-primary" disabled={unavailable} title={unavailableReason ?? "Create a queued run"} onClick={openDialog}><Plus size={16} /> New run</button>
    <Modal open={open} onClose={closeDialog} title="Create a queued loop run" description="This creates the execution contract and tracking record. It does not launch an agent process.">
      <form className="form" onSubmit={submit} id={formId}>
        <label className="field"><span>Project name</span><input name="projectName" required maxLength={200} placeholder="Atlas Console" /></label>
        <label className="field"><span>Repository path</span><input name="repositoryPath" placeholder="/Users/me/Code/project" /></label>
        <label className="field field-wide"><span>Objective</span><textarea name="goal" required minLength={8} rows={4} autoFocus placeholder="Describe the outcome and the evidence that will prove it..." /><small>Use an observable outcome. Verification requirements are attached to the run.</small></label>
        <label className="field field-wide"><span>Loop template</span><select name="loopId" required value={loopId} onChange={(event) => selectTemplate(event.target.value)}>{enabledLoops.map((loop) => <option key={loop.id} value={loop.id}>{loop.name} · {loop.policyVersion}</option>)}</select></label>
        <label className="field"><span>Automation</span><select name="automationLevel" value={automationLevel} onChange={(event) => setAutomationLevel(event.target.value as LoopDefinition["automationLevel"])}><option value="L1">L1 · Report only</option><option value="L2">L2 · Approval gated</option><option value="L3">L3 · Autonomous</option></select></label>
        <label className="field"><span>Risk</span><select name="risk" value={risk} onChange={(event) => setRisk(event.target.value as LoopDefinition["risk"])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label className="field"><span>Agent runtime</span><select name="runtime" defaultValue="Codex CLI"><option>Codex CLI</option><option>Claude Code</option><option>OpenHands</option><option>Gemini CLI</option><option>Generic command</option></select></label>
        <label className="field"><span>Model</span><input name="model" required defaultValue="configured default" placeholder="gpt-5.2-codex" /></label>
        <fieldset className="field-group field-wide requirement-builder"><legend>Acceptance requirements</legend>
          <div className="requirement-builder-head"><p>Completion is blocked until every current requirement has bound evidence.</p><button className="button button-secondary" type="button" onClick={() => setRequirements((current) => [...current, Math.max(...current) + 1])}><Plus size={15} /> Add requirement</button></div>
          {requirements.map((id, index) => <div className="requirement-editor" key={id}><div className="requirement-editor-title"><strong>Requirement {index + 1}</strong>{requirements.length > 1 && <button type="button" className="icon-button" title="Remove requirement" aria-label={`Remove requirement ${index + 1}`} onClick={() => setRequirements((current) => current.filter((item) => item !== id))}><Trash2 size={15} /></button>}</div><label className="field"><span>Title</span><input name={`requirementTitle-${id}`} required maxLength={500} placeholder="Resume interrupted work safely" /></label><label className="field"><span>Description</span><textarea name={`requirementDescription-${id}`} required rows={2} placeholder="Describe the behavior and its boundaries." /></label><label className="field"><span>Acceptance criteria</span><textarea name={`acceptanceCriteria-${id}`} required rows={3} placeholder="Given..., when..., then... Include the evidence that must be observed." /></label></div>)}
        </fieldset>
        <fieldset className="field-group field-wide"><legend>Run budget</legend><div className="form-grid form-grid-4">
          <label className="field"><span>Token limit</span><input name="tokenLimit" type="number" min="1000" step="1000" defaultValue="120000" required /></label>
          <label className="field"><span>Cost limit (USD)</span><input name="costLimitUsd" type="number" min="0" step="0.5" defaultValue="25" required /></label>
          <label className="field"><span>Iterations</span><input name="iterationLimit" type="number" min="1" max="100" defaultValue="8" required /></label>
          <label className="field"><span>Warn at</span><div className="input-suffix"><input name="warningPercent" type="number" min="1" max="99" defaultValue="80" required /><span>%</span></div></label>
        </div></fieldset>
        <Callout tone="info" title="Runner launch stays explicit">After creation, attach Codex, Claude, or any local command from the queued run page. Maker and checker sessions remain separately observable.</Callout>
        {mutation.error && <div className="form-error" role="alert">{mutation.error.message}</div>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeDialog}>Cancel</button><button className="button button-primary" disabled={mutation.isPending}><CirclePlay size={16} />{mutation.isPending ? "Creating…" : "Create queued run"}</button></div>
      </form>
    </Modal>
  </>;
}
