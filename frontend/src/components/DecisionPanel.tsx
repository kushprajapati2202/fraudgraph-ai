import { useState, type FormEvent, type ReactNode } from "react";
import { api, type AuditEvent, type CaseStatus, type DecisionRecord, type DecisionValue } from "../api/client";
import { usePrefs } from "../prefs";
import { errorMessage, fmtAmount, fmtTime } from "../util";
import { StatusChip } from "./common";
import { IconRefresh, IconSparkle, IconUser } from "./icons";

const OPTIONS: { value: DecisionValue; label: string; help: string }[] = [
  { value: "ESCALATE_FOR_REVIEW", label: "Escalate for review", help: "Send to a senior reviewer with your rationale." },
  { value: "REQUEST_MORE_EVIDENCE", label: "Request more evidence", help: "Evidence is insufficient to decide." },
  { value: "DISMISS_ALERT", label: "Dismiss alert", help: "Activity appears explained. The case stays in the audit history." },
];

const DECISION_LABEL: Record<DecisionValue, string> = {
  ESCALATE_FOR_REVIEW: "Escalated for review",
  DISMISS_ALERT: "Dismissed alert",
  REQUEST_MORE_EVIDENCE: "Requested more evidence",
};

interface Props {
  caseId: string;
  status: CaseStatus;
  decisions: DecisionRecord[];
  onSaved: () => void;
}

export function DecisionPanel({ caseId, status, decisions, onSaved }: Props) {
  const [decision, setDecision] = useState<DecisionValue | "">("");
  const [rationale, setRationale] = useState("");
  const { analystName } = usePrefs();
  const [actor, setActor] = useState(analystName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!decision) return setError("Choose a decision.");
    if (rationale.trim().length < 5) return setError("Write a rationale of at least 5 characters.");
    setBusy(true);
    setError(null);
    try {
      const res = await api.decide(caseId, { decision, rationale: rationale.trim(), actor_label: actor.trim() || undefined });
      setSaved(`Saved at ${fmtTime(res.decision.created_at)} UTC.`);
      setRationale("");
      setDecision("");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="decision-heading" data-tour="case-decision">
      <div className="card-head">
        <h2 id="decision-heading" className="inline">
          <IconUser size={17} /> Analyst decision
        </h2>
        <StatusChip status={status} />
      </div>
      <p className="muted small">Only a human records the case disposition. AI output and risk scores are inputs, not decisions.</p>
      <form onSubmit={submit} className="stack-sm">
        <fieldset className="radio-group">
          <legend className="label">Decision</legend>
          {OPTIONS.map((o) => (
            <label key={o.value} className={`radio-card ${decision === o.value ? "selected" : ""}`}>
              <input type="radio" name="decision" value={o.value} checked={decision === o.value} onChange={() => setDecision(o.value)} />
              <span>
                <strong>{o.label}</strong>
                <span className="muted small radio-help">{o.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          <span className="label">Rationale (required)</span>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={3}
            maxLength={2000}
            required
            placeholder="What evidence did you rely on? What is still uncertain?"
          />
        </label>
        <label>
          <span className="label">Recorded by</span>
          <input type="text" value={actor} maxLength={60} onChange={(e) => setActor(e.target.value)} />
        </label>
        {error ? (
          <div className="callout callout-error" role="alert">
            {error}
          </div>
        ) : null}
        {saved ? (
          <div className="callout callout-ok" role="status">
            Decision recorded. {saved}
          </div>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving..." : "Record decision"}
        </button>
      </form>
      {decisions.length ? (
        <div>
          <h3 className="section-title">Decision history</h3>
          <ul className="plain decision-list">
            {[...decisions].reverse().map((d) => (
              <li key={d.decision_id}>
                <strong>{DECISION_LABEL[d.decision]}</strong> by {d.actor_label} &middot; <span className="muted">{fmtTime(d.created_at)} UTC</span>
                <div className="small">&ldquo;{d.rationale}&rdquo;</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// Same markers as the overview's activity feed.
export const ACTOR: Record<AuditEvent["actor_type"], { icon: ReactNode; label: string }> = {
  SYSTEM: { icon: <IconRefresh size={14} />, label: "System" },
  AI: { icon: <IconSparkle size={14} />, label: "AI (advisory)" },
  HUMAN: { icon: <IconUser size={14} />, label: "Analyst" },
};

export function describe(e: AuditEvent): string {
  const p = e.event_payload;
  switch (e.event_type) {
    case "CASE_CREATED":
      return `Case created by analysis ${p.analysis_id} (score ${p.risk_score}, rules ${p.rule_version}).`;
    case "CASE_UPDATED":
      return `Analysis ${p.analysis_id} updated the case: score ${p.score_before} → ${p.score_after}${
        p.added_transaction_ids?.length ? `, added ${p.added_transaction_ids.join(", ")}` : ""
      }.`;
    case "CASE_NO_LONGER_FLAGGED":
      return `Analysis ${p.analysis_id} no longer flags this case (kept for audit).`;
    case "AI_DOCUMENT_CHECK":
      return p.status === "OK"
        ? `Document "${p.filename}" read by Gemini and compared with ${p.transaction_id}: ${String(p.verdict).replace(/_/g, " ").toLowerCase()} (uploaded by ${p.uploaded_by}; file not stored).`
        : `Document "${p.filename}" could not be analysed (${String(p.reason).replace(/_/g, " ").toLowerCase()}).`;
    case "MITIGATION_ACTION_APPROVED":
      return `${p.actor_label} approved "${p.label}"${p.target_account ? ` for ${p.target_account}` : ""} (suggested by ${String(p.recommended_by).toLowerCase()}). ${
        p.effect ?? ""
      } Applied in this workspace only.`;
    case "MITIGATION_ACTION_CLOSED":
      return `${p.actor_label} ${p.status === "LIFTED" ? "lifted" : "completed"} "${p.label}"${p.target_account ? ` for ${p.target_account}` : ""}: “${p.outcome}”`;
    case "TRANSFER_HELD":
      return `Transfer ${p.transaction_id} (${fmtAmount(p.amount)}, ${p.source_account} → ${p.destination_account}) was held because ${p.account_id} is on hold.`;
    case "TRANSFER_FLAGGED":
      return `Transfer ${p.transaction_id} (${fmtAmount(p.amount)}, ${p.source_account} → ${p.destination_account}) was flagged because ${p.account_id} is under enhanced monitoring.`;
    case "HELD_TRANSFER_RESOLVED":
      return `${p.actor_label} ${p.status === "RELEASED" ? "released" : "rejected"} held transfer ${p.transaction_id} (${fmtAmount(p.amount)}): “${p.note}”`;
    case "AI_INVESTIGATION":
    case "AI_CHAT":
    case "AI_REPORT":
      return `${e.event_type === "AI_CHAT" ? "Follow-up answer" : e.event_type === "AI_REPORT" ? "Escalation report draft" : "Investigation summary"}: ${p.status}${p.reason ? ` (${p.reason})` : ""}, model ${
        p.model ?? "-"
      }, ${p.prompt_version}${p.removed_evidence_ids?.length ? `, ${p.removed_evidence_ids.length} invalid citation(s) removed` : ""}.`;
    case "ANALYST_DECISION":
      return `${p.actor_label} recorded ${p.decision} (status ${p.status_before} → ${p.status_after}): “${p.rationale}”`;
    // Workspace-level events (shown on the Audit page).
    case "ANALYSIS_RUN":
      return `Analysis ${p.analysis_id} scored ${p.transactions_analyzed} transfers with rules ${p.rule_version}; ${p.active_cases} active cases.`;
    case "DEMO_RESET":
      return `Dataset ${p.dataset_version} loaded (${p.transactions} transfers).`;
    case "SYNTHETIC_TX_ADDED":
      return `Simulated transfer ${p.transaction_id} added${p.created_accounts?.length ? `, new accounts ${p.created_accounts.join(", ")}` : ""}.`;
    default:
      if (e.event_type.startsWith("AI_")) {
        const what = e.event_type.slice(3).replace(/_/g, " ").toLowerCase();
        const by = p.source === "GEMINI" ? "Gemini" : p.source === "RULES" ? "rules" : null;
        return `AI ${what}: ${p.status ?? "-"}${by ? ` (${by})` : ""}${p.reason ? `, ${String(p.reason).replace(/_/g, " ").toLowerCase()}` : ""}.`;
      }
      return e.event_type;
  }
}
