import { useCallback, useMemo, useState } from "react";
import { api, type AIRecord, type ApprovedAction, type CaseDetail, type CaseReport, type ControlledTransfer, type Evidence } from "../api/client";
import { ControlTag } from "./common";
import { useAiStatus } from "../health";
import { usePrefs } from "../prefs";
import { caseHeadline, errorMessage, fmtAmount, fmtDuration, fmtTime } from "../util";
import { IconSparkle } from "./icons";
import { useInspector } from "./Inspector";
import { Citations } from "./InvestigatorPanel";
import { ExpandButton, Modal, Toast } from "./Modal";

interface Props {
  detail: CaseDetail;
  onChanged: () => void;
}

const key = (code: string, target: string | null) => `${code}|${target ?? ""}`;
const inEffect = (a: ApprovedAction) => a.status === "ACTIVE" || a.status === "OPEN";

/** Builds a self-contained Markdown case file: facts, rule findings, AI draft (if any), decisions and approved actions. */
function buildMarkdown(d: CaseDetail, labelOf: (code: string) => string, nameOf: (id: string | null) => string): string {
  const c = d.case;
  const r = d.latest_report?.response.status === "OK" ? d.latest_report.response.result : undefined;
  const L: string[] = [];
  L.push(`# Case file ${c.case_id}: ${caseHeadline(c.title)}`, "");
  L.push(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from FraudGraph AI (sandbox environment, synthetic data).`, "");
  L.push("## Summary", "");
  L.push(`- Priority score: ${c.risk_score}/100 (${c.risk_band}), rules ${c.rule_version}. The score ranks review priority; it is not a probability of fraud.`);
  L.push(`- Status: ${c.status}`);
  L.push(`- Amount moved: ${fmtAmount(c.total_amount)} across ${c.transaction_ids.length} transfers and ${c.accounts.length} accounts`);
  L.push(`- Period: ${fmtTime(c.first_activity)} to ${fmtTime(c.last_activity)} (${fmtDuration(c.first_activity, c.last_activity)})`, "");
  L.push("## Rule findings", "", "| Signal | Contribution | Transfers | Type |", "|---|---|---|---|");
  d.signal_summary.forEach((s) => L.push(`| ${s.label} | +${s.max_contribution} of ${s.weight} | ${s.transactions} | ${s.context_only ? "context only" : "risk signal"} |`));
  L.push("", "## Transfers", "", "| Time | ID | From | To | Amount | Score |", "|---|---|---|---|---|---|");
  d.transactions.forEach((t) =>
    L.push(`| ${fmtTime(t.timestamp)} | ${t.transaction_id} | ${t.source_name ?? ""} (${t.source_account}) | ${t.destination_name ?? ""} (${t.destination_account}) | ${fmtAmount(t.amount, t.currency)} | ${t.score ?? "-"} |`),
  );
  if (d.uncertainties.length) {
    L.push("", "## Known uncertainty", "");
    d.uncertainties.forEach((u) => L.push(`- ${u}`));
  }
  if (r) {
    const resp = d.latest_report!.response;
    L.push("", "## AI-drafted escalation report (advisory)", "");
    L.push(`_Drafted by ${resp.model} (${resp.prompt_version}) on ${fmtTime(d.latest_report!.created_at)} UTC. ${resp.validation?.valid_citations ?? 0} citations verified against case evidence; ${resp.validation?.removed_ids.length ?? 0} invalid references removed. Requires human review._`, "");
    L.push(`**${r.headline}**`, "", r.executive_summary, "");
    L.push("### Accounts and roles", "");
    r.subject_accounts.forEach((a) => L.push(`- ${a.account_id}: ${a.role} [${a.evidence_ids.join(", ")}]`));
    L.push("", "### Chronology", "");
    r.chronology.forEach((e) => L.push(`- ${e.timestamp}: ${e.event} [${e.evidence_ids.join(", ")}]`));
    L.push("", "### Indicators", "");
    r.suspicious_indicators.forEach((i) => L.push(`- ${i.text} [${i.evidence_ids.join(", ")}]`));
    L.push("", "### Mitigating factors", "");
    r.mitigating_factors.forEach((m) => L.push(`- ${m}`));
    L.push("", "### Information gaps", "");
    r.information_gaps.forEach((g) => L.push(`- ${g}`));
    L.push("", "### Recommended actions (not executed)", "");
    r.recommended_actions.forEach((a) => L.push(`- ${labelOf(a.action_code)}${a.target_account ? ` for ${a.target_account}` : ""}: ${a.rationale} [${a.evidence_ids.join(", ")}]`));
  }
  L.push("", "## Human decisions", "");
  if (!d.decisions.length) L.push("- None recorded.");
  d.decisions.forEach((x) => L.push(`- ${fmtTime(x.created_at)} UTC, ${x.actor_label}: ${x.decision}. Rationale: ${x.rationale}`));
  L.push("", "## Approved mitigation actions", "");
  if (!d.actions.length) L.push("- None approved.");
  d.actions.forEach((a) =>
    L.push(
      `- ${fmtTime(a.created_at)} UTC, ${a.actor_label}: ${labelOf(a.action_code)}${a.target_account ? ` for ${nameOf(a.target_account)} (${a.target_account})` : ""} (suggested by ${a.source.toLowerCase()})${a.note ? `. Note: ${a.note}` : ""}. Status: ${actionStatusText(a)}`,
    ),
  );
  L.push("", "## Transfers stopped or flagged by controls", "");
  if (!d.controlled_transfers.length) L.push("- None.");
  d.controlled_transfers.forEach((t) =>
    L.push(
      `- ${fmtTime(t.created_at)} UTC, ${t.transaction_id}: ${fmtAmount(t.amount, t.currency)} from ${t.source_account} to ${t.destination_account}, ${t.status}${t.resolved_by ? ` by ${t.resolved_by} on ${fmtTime(t.resolved_at)} UTC. Reason: ${t.resolution_note}` : ""}`,
    ),
  );
  L.push("", "---", "AI output is advisory. Approved actions take effect inside this sandbox workspace only; nothing is sent to an external banking system.");
  return L.join("\n");
}

function actionStatusText(a: ApprovedAction): string {
  if (a.status === "ACTIVE") return `in force${a.expires_at ? ` until ${fmtTime(a.expires_at)} UTC` : ""}`;
  if (a.status === "OPEN") return `task open with ${a.queue}, due ${fmtTime(a.due_at)} UTC`;
  if (!a.closed_by) return "recorded";
  return `${a.status === "LIFTED" ? "lifted" : "completed"} by ${a.closed_by} on ${fmtTime(a.closed_at)} UTC. Outcome: ${a.outcome}`;
}

/** Inline "give a reason, then confirm" step used before lifting a control, completing a task or resolving a held transfer. */
function ReasonForm({ prompt, confirmLabel, busy, onConfirm, onCancel }: { prompt: string; confirmLabel: string; busy: boolean; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="row-center"
      style={{ marginTop: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 5) onConfirm(reason.trim());
      }}
    >
      <input className="grow" autoFocus required minLength={5} maxLength={500} value={reason} placeholder={prompt} aria-label={prompt} onChange={(e) => setReason(e.target.value)} />
      <button className="btn btn-small btn-primary" type="submit" disabled={busy || reason.trim().length < 5}>
        {busy ? "Saving..." : confirmLabel}
      </button>
      <button className="btn btn-small btn-ghost" type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </form>
  );
}

/** Where an approved action stands, with the step that closes it: lift a control or complete a task. */
function ActionState({ action, caseId, onChanged }: { action: ApprovedAction; caseId: string; onChanged: () => void }) {
  const { analystName } = usePrefs();
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const control = action.kind === "CONTROL";

  async function close(outcome: string) {
    setBusy(true);
    setError(null);
    try {
      await api.closeAction(caseId, action.action_id, { outcome, actor_label: analystName });
      setClosing(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (action.status !== "ACTIVE" && action.status !== "OPEN") {
    return (
      <div className="small ok-text" style={{ marginTop: 6 }}>
        {"✓"}{" "}
        {action.closed_by
          ? `${action.status === "LIFTED" ? "Lifted" : "Completed"} by ${action.closed_by} · ${fmtTime(action.closed_at)} UTC: ${action.outcome}`
          : `Recorded by ${action.actor_label} · ${fmtTime(action.created_at)} UTC`}
      </div>
    );
  }
  return (
    <div className="small" style={{ marginTop: 6 }}>
      <span className={`chip ${control ? "chip-status-escalated" : "chip-warn"}`} style={{ marginLeft: 0, fontWeight: 700 }}>
        {control ? "In force" : "Task open"}
      </span>{" "}
      {control
        ? `Applied by ${action.actor_label} · ${fmtTime(action.created_at)} UTC${action.expires_at ? ` · until ${fmtTime(action.expires_at)} UTC` : ""}`
        : `${action.queue} · due ${fmtTime(action.due_at)} UTC · approved by ${action.actor_label}`}
      {action.note ? <div style={{ marginTop: 4 }}>{action.note}</div> : null}
      {closing ? (
        <ReasonForm
          prompt={control ? "Why is this control being lifted?" : "What was the outcome?"}
          confirmLabel={control ? "Lift control" : "Complete task"}
          busy={busy}
          onConfirm={close}
          onCancel={() => setClosing(false)}
        />
      ) : (
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-small" onClick={() => setClosing(true)}>
            {control ? "Lift control" : "Mark complete"}
          </button>
        </div>
      )}
      {error ? <div className="callout callout-error" role="alert" style={{ marginTop: 8 }}>{error}</div> : null}
    </div>
  );
}

/** A transfer a control stopped or flagged. A held one waits here for the analyst to release or reject it. */
function ControlledTransferItem({ transfer: t, caseId, onChanged }: { transfer: ControlledTransfer; caseId: string; onChanged: () => void }) {
  const { analystName } = usePrefs();
  const { openTransaction } = useInspector();
  const [resolution, setResolution] = useState<"RELEASE" | "REJECT" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(note: string) {
    if (!resolution) return;
    setBusy(true);
    setError(null);
    try {
      await api.resolveHeldTransfer(caseId, t.transaction_id, { resolution, note, actor_label: analystName });
      setResolution(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="action-item">
      <div className="action-main" style={{ flex: 1 }}>
        <div className="action-title">
          {fmtAmount(t.amount, t.currency)} <ControlTag status={t.status} />
        </div>
        <div className="small" style={{ marginTop: 4 }}>
          {t.source_name ?? t.source_account} &rarr; {t.destination_name ?? t.destination_account} &middot;{" "}
          <button className="link-button mono small" onClick={() => openTransaction(t.transaction_id)}>
            {t.transaction_id}
          </button>
        </div>
        <div className="muted small" style={{ marginTop: 2 }}>
          {t.status === "FLAGGED" ? "Flagged" : "Stopped"} {fmtTime(t.created_at)} UTC &middot; <span className="mono id">{t.account_id}</span>{" "}
          {t.control === "HOLD_FOR_REVIEW" ? "is on hold" : "is under enhanced monitoring"}
        </div>
        {t.resolved_by ? (
          <div className="small" style={{ marginTop: 4 }}>
            {t.status === "RELEASED" ? "Released" : "Rejected"} by {t.resolved_by} &middot; {fmtTime(t.resolved_at)} UTC: {t.resolution_note}
          </div>
        ) : null}
        {t.status === "HELD" ? (
          resolution ? (
            <ReasonForm
              prompt={resolution === "RELEASE" ? "Why is it safe to release?" : "Why is it being rejected?"}
              confirmLabel={resolution === "RELEASE" ? "Release transfer" : "Reject transfer"}
              busy={busy}
              onConfirm={resolve}
              onCancel={() => setResolution(null)}
            />
          ) : (
            <div className="row-center" style={{ marginTop: 8 }}>
              <button className="btn btn-small" onClick={() => setResolution("RELEASE")}>
                Release
              </button>
              <button className="btn btn-small" onClick={() => setResolution("REJECT")}>
                Reject
              </button>
            </div>
          )
        ) : null}
        {error ? <div className="callout callout-error" role="alert" style={{ marginTop: 8 }}>{error}</div> : null}
      </div>
    </li>
  );
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function useLookups(detail: CaseDetail) {
  return useMemo(() => {
    const labels = new Map(detail.action_catalog.map((a) => [a.code, a.label]));
    return {
      labelOf: (code: string) => labels.get(code) ?? code,
      nameOf: (id: string | null) => (id ? (detail.accounts[id]?.holder_name ?? id) : ""),
      byId: new Map<string, Evidence>(detail.evidence.map((e) => [e.evidence_id, e])),
    };
  }, [detail]);
}

/** The report itself; shown in the card and in the full-view pop-up (where every section starts open). */
function ReportDetails({ r, resp, detail, allOpen = false }: {
  r: CaseReport;
  resp: AIRecord<CaseReport>["response"];
  detail: CaseDetail;
  allOpen?: boolean;
}) {
  const { nameOf, byId } = useLookups(detail);
  const { openAccount } = useInspector();
  return (
    <>
      <h3 style={{ fontSize: "1rem", margin: 0 }}>{r.headline}</h3>
      <p className="ai-summary">{r.executive_summary}</p>

      <details open>
        <summary className="section-title" style={{ cursor: "pointer" }}>Accounts and roles ({r.subject_accounts.length})</summary>
        <ul className="ai-list" style={{ marginTop: 6 }}>
          {r.subject_accounts.map((a) => (
            <li key={a.account_id}>
              <button className="link-button" onClick={() => openAccount(a.account_id)}>
                {nameOf(a.account_id)}
              </button>{" "}
              <span className="mono muted small">{a.account_id}</span>: {a.role} <Citations ids={a.evidence_ids} byId={byId} />
            </li>
          ))}
        </ul>
      </details>
      <details open>
        <summary className="section-title" style={{ cursor: "pointer" }}>Chronology ({r.chronology.length})</summary>
        <ol className="ai-list" style={{ marginTop: 6 }}>
          {r.chronology.map((e, i) => (
            <li key={i}>
              <span className="mono small muted">{e.timestamp.replace("T", " ").slice(0, 16)}</span> {e.event} <Citations ids={e.evidence_ids} byId={byId} />
            </li>
          ))}
        </ol>
      </details>
      <details open={allOpen}>
        <summary className="section-title" style={{ cursor: "pointer" }}>Indicators, mitigating factors and gaps</summary>
        <h4 style={{ marginTop: 8 }}>Indicators</h4>
        <ul className="ai-list">
          {r.suspicious_indicators.map((x, i) => (
            <li key={i}>
              {x.text} <Citations ids={x.evidence_ids} byId={byId} />
            </li>
          ))}
        </ul>
        <h4 style={{ marginTop: 8 }}>Mitigating factors</h4>
        <ul className="ai-list">{r.mitigating_factors.map((x, i) => <li key={i}>{x}</li>)}</ul>
        <h4 style={{ marginTop: 8 }}>Information gaps</h4>
        <ul className="ai-list">{r.information_gaps.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </details>
      {resp?.validation?.unsupported_claims.length ? (
        <div className="callout callout-warn">
          {resp.validation.unsupported_claims.length} statement(s) had no valid evidence and were left out of the report.
        </div>
      ) : null}
    </>
  );
}

/** AI-drafted internal escalation report with verified citations, plus a downloadable case file. */
export function ReportPanel({ detail, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { labelOf, nameOf } = useLookups(detail);
  const ai = useAiStatus();
  const caseId = detail.case.case_id;
  const [fullView, setFullView] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; title: string; text: string } | null>(null);
  const closeFullView = useCallback(() => setFullView(false), []);
  const closeNotice = useCallback(() => setNotice(null), []);
  // The record just returned, so "View report" works before the case page has finished reloading.
  const [fresh, setFresh] = useState<{ caseId: string; record: AIRecord<CaseReport> } | null>(null);
  const saved = detail.latest_report;
  const record = fresh && fresh.caseId === caseId && fresh.record.investigation_id > (saved?.investigation_id ?? 0) ? fresh.record : saved;
  const resp = record?.response;
  const r = resp?.status === "OK" ? resp.result : undefined;

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      const drafted = await api.draftReport(caseId);
      setFresh({ caseId, record: drafted });
      onChanged();
      setNotice(drafted.response.status === "OK"
        ? { tone: "ok", title: "Your escalation report is ready", text: "Gemini has finished drafting the report for this case." }
        : { tone: "warn", title: "Gemini couldn't draft the report",
            text: drafted.response.message ?? "The case file download and the playbook actions still work." });
      ai.recheck();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ai-card" aria-labelledby="report-heading" data-tour="case-report">
      <div className="card-head">
        <h2 id="report-heading">
          <span className="ai-mark">
            <IconSparkle size={17} />
          </span>{" "}
          Escalation report
        </h2>
        <div className="card-tools">
          <span className="chip chip-ai">AI draft &middot; needs review</span>
          {r ? <ExpandButton onClick={() => setFullView(true)} label="Open report in full view" /> : null}
        </div>
      </div>
      <p className="muted small">
        Gemini drafts an internal report for compliance from this case's evidence: roles, chronology, indicators, mitigating factors and gaps. Every citation is
        verified, and accounts or actions outside this case are removed.
      </p>
      <div className="row-center" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" onClick={draft} disabled={busy}>
          {busy ? "Drafting..." : r ? "Redraft report" : "Draft report with Gemini"}
        </button>
        <button className="btn" onClick={() => download(`${detail.case.case_id}-case-file.md`, buildMarkdown(detail, labelOf, nameOf))}>
          Download case file
        </button>
      </div>
      {busy ? (
        <div className="state state-loading" role="status">
          <span className="spinner" aria-hidden="true" /> Drafting from verified evidence...
        </div>
      ) : null}
      {error ? <div className="callout callout-error" role="alert" style={{ marginTop: 10 }}>{error}</div> : null}
      {resp && resp.status === "UNAVAILABLE" ? (
        <div className="callout callout-warn" role="status" style={{ marginTop: 10 }}>
          <strong>Report draft unavailable ({(resp.reason ?? "error").replace(/_/g, " ").toLowerCase()}).</strong> {resp.message} The case file download and the
          playbook actions below still work.
        </div>
      ) : null}

      {r ? (
        <div className="stack-sm" style={{ marginTop: 14 }} aria-live="polite">
          <div className="muted small">
            {resp?.model} &middot; {resp?.prompt_version} &middot; {fmtTime(record?.created_at)} UTC &middot; {resp?.validation?.valid_citations ?? 0} citations verified
            {resp?.validation && (resp.validation.removed_ids.length > 0 || (resp.validation.removed_accounts?.length ?? 0) > 0)
              ? ` · ${resp.validation.removed_ids.length + (resp.validation.removed_accounts?.length ?? 0)} invalid reference(s) removed`
              : ""}
          </div>
          <ReportDetails r={r} resp={resp!} detail={detail} />
        </div>
      ) : null}

      {fullView && r ? (
        <Modal
          title={<><span className="ai-mark" aria-hidden="true"><IconSparkle size={17} /></span> Escalation report</>}
          subtitle={<>{caseId} &middot; {resp?.model} &middot; {fmtTime(record?.created_at)} UTC &middot; {resp?.validation?.valid_citations ?? 0} citations verified</>}
          onClose={closeFullView}
          footer={
            <div className="row-center" style={{ width: "100%", justifyContent: "space-between" }}>
              <span className="chip chip-ai">AI draft &middot; needs review</span>
              <button className="btn btn-small" onClick={() => download(`${caseId}-case-file.md`, buildMarkdown(detail, labelOf, nameOf))}>
                Download case file
              </button>
            </div>
          }
        >
          <div className="stack-sm">
            <ReportDetails r={r} resp={resp!} detail={detail} allOpen />
          </div>
        </Modal>
      ) : null}

      {notice ? (
        <Toast
          tone={notice.tone}
          title={notice.title}
          onClose={closeNotice}
          action={notice.tone === "ok" ? (
            <button className="btn btn-small btn-primary" onClick={() => { setNotice(null); setFullView(true); }}>
              View report
            </button>
          ) : null}
        >
          {notice.text}
        </Toast>
      ) : null}
    </section>
  );
}

/**
 * Recommended mitigation actions (rule playbook + AI draft). Nothing takes effect until an analyst approves it;
 * once approved, a control is enforced on new transfers and a follow-up is tracked as a task until it is closed.
 */
export function ActionsPanel({ detail, onChanged }: Props) {
  const { analystName } = usePrefs();
  const { labelOf, nameOf, byId } = useLookups(detail);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");

  // Latest approval per action and account; one still in effect wins over an earlier one that was closed.
  const approved = useMemo(() => {
    const map = new Map<string, ApprovedAction>();
    detail.actions.forEach((a) => {
      const k = key(a.action_code, a.target_account);
      const prev = map.get(k);
      if (!prev || !inEffect(prev) || inEffect(a)) map.set(k, a);
    });
    return map;
  }, [detail.actions]);
  const aiActions = detail.latest_report?.response.status === "OK" ? (detail.latest_report.response.result?.recommended_actions ?? []) : [];

  // Merge playbook and AI recommendations; the same action on the same account is shown once with both sources.
  const merged = useMemo(() => {
    const rows = new Map<string, { code: string; target: string | null; rationales: { source: "PLAYBOOK" | "AI"; text: string; evidence: string[] }[] }>();
    detail.suggested_actions.forEach((s) => {
      rows.set(key(s.action_code, s.target_account), { code: s.action_code, target: s.target_account, rationales: [{ source: "PLAYBOOK", text: s.rationale, evidence: [] }] });
    });
    aiActions.forEach((a) => {
      const k = key(a.action_code, a.target_account);
      const row = rows.get(k) ?? { code: a.action_code, target: a.target_account, rationales: [] };
      row.rationales.push({ source: "AI", text: a.rationale, evidence: a.evidence_ids });
      rows.set(k, row);
    });
    return [...rows.values()];
  }, [detail.suggested_actions, aiActions]);

  async function approve(actionCode: string, targetAccount: string | null, source: "PLAYBOOK" | "AI" | "ANALYST", actionNote?: string) {
    const k = key(actionCode, targetAccount);
    setBusyKey(k);
    setError(null);
    try {
      await api.approveAction(detail.case.case_id, { action_code: actionCode, target_account: targetAccount, source, note: actionNote || undefined, actor_label: analystName });
      onChanged();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  const custom = detail.action_catalog.find((a) => a.code === code);
  const extraApproved = [...approved.values()].filter((a) => !merged.some((m) => key(m.code, m.target) === key(a.action_code, a.target_account)));
  const caseId = detail.case.case_id;
  const held = detail.controlled_transfers.filter((t) => t.status === "HELD");
  const heldAmount = held.reduce((sum, t) => sum + t.amount, 0);

  return (
    <section className="card" aria-labelledby="actions-heading" data-tour="case-actions">
      <div className="card-head">
        <div>
          <h2 id="actions-heading">Mitigation actions</h2>
          <div className="card-sub">Recommended by the rule playbook and the AI draft. Nothing takes effect until you approve it.</div>
        </div>
        <span className="chip" style={{ marginLeft: 0 }}>{detail.actions.filter(inEffect).length} in effect</span>
      </div>
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {detail.controlled_transfers.length ? (
        <div style={{ marginBottom: 14 }}>
          <h3 className="section-title">Transfers stopped by your controls</h3>
          {held.length ? (
            <div className="callout callout-warn" role="status" style={{ marginBottom: 10 }}>
              <strong>
                {fmtAmount(heldAmount)} held in {held.length} {held.length === 1 ? "transfer" : "transfers"}.
              </strong>{" "}
              The money has not moved. Release or reject each one.
            </div>
          ) : null}
          <ul className="action-list">
            {detail.controlled_transfers.map((t) => (
              <ControlledTransferItem key={t.transaction_id} transfer={t} caseId={caseId} onChanged={onChanged} />
            ))}
          </ul>
          <h3 className="section-title" style={{ marginTop: 14 }}>Actions</h3>
        </div>
      ) : null}
      <ul className="action-list">
        {merged.map((m) => {
          const k = key(m.code, m.target);
          const done = approved.get(k);
          const source = m.rationales.some((x) => x.source === "AI") ? "AI" : "PLAYBOOK";
          return (
            <li key={k} className={`action-item ${done && done.status !== "LIFTED" ? "action-done" : ""}`}>
              <div className="action-main">
                <div className="action-title">
                  {labelOf(m.code)}
                  {m.target ? (
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {" "}
                      for {nameOf(m.target)} <span className="mono small id">{m.target}</span>
                    </span>
                  ) : null}
                </div>
                {m.rationales.map((x, i) => (
                  <div key={i} className="small" style={{ marginTop: 4 }}>
                    <span className={`chip ${x.source === "AI" ? "chip-ai" : ""}`} style={{ marginLeft: 0 }}>{x.source === "AI" ? "AI draft" : "Playbook"}</span> {x.text}{" "}
                    <Citations ids={x.evidence} byId={byId} />
                  </div>
                ))}
                {done ? <ActionState key={done.action_id} action={done} caseId={caseId} onChanged={onChanged} /> : null}
              </div>
              {done && done.status !== "LIFTED" ? null : (
                <button className="btn btn-small" onClick={() => approve(m.code, m.target, source)} disabled={busyKey !== null}>
                  {busyKey === k ? "Approving..." : done ? "Apply again" : "Approve"}
                </button>
              )}
            </li>
          );
        })}
        {extraApproved.map((a) => (
          <li key={a.action_id} className={`action-item ${a.status !== "LIFTED" ? "action-done" : ""}`}>
            <div className="action-main">
              <div className="action-title">
                {labelOf(a.action_code)}
                {a.target_account ? (
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {" "}
                    for {nameOf(a.target_account)} <span className="mono small id">{a.target_account}</span>
                  </span>
                ) : null}
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                <span className={`chip ${a.source === "AI" ? "chip-ai" : ""}`} style={{ marginLeft: 0 }}>
                  {a.source === "AI" ? "AI draft" : a.source === "PLAYBOOK" ? "Playbook" : "Added by analyst"}
                </span>
              </div>
              <ActionState key={a.action_id} action={a} caseId={caseId} onChanged={onChanged} />
            </div>
          </li>
        ))}
      </ul>

      <details style={{ marginTop: 12 }}>
        <summary className="small" style={{ cursor: "pointer", fontWeight: 600, color: "var(--muted)" }}>Add a different action</summary>
        <form
          className="stack-sm"
          style={{ marginTop: 10 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!code) return;
            if (await approve(code, custom?.needs_target ? target || null : null, "ANALYST", note.trim())) {
              setCode("");
              setTarget("");
              setNote("");
            }
          }}
        >
          <label>
            <span className="label">Action</span>
            <select value={code} onChange={(e) => setCode(e.target.value)} required>
              <option value="">Choose an action</option>
              {detail.action_catalog.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          {custom ? (
            <p className="muted small">
              {custom.description} <strong>On approval:</strong> {custom.effect}
            </p>
          ) : null}
          {custom?.needs_target ? (
            <label>
              <span className="label">Account</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)} required>
                <option value="">Choose an account in this case</option>
                {detail.case.accounts.map((id) => (
                  <option key={id} value={id}>
                    {nameOf(id)} ({id})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span className="label">Note (optional)</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busyKey !== null || !code}>
            Approve action
          </button>
        </form>
      </details>
      <p className="muted small" style={{ marginTop: 12 }}>
        Approved actions take effect in this workspace under your name: a hold stops new transfers on the account until you release or reject them, monitoring
        flags them, and follow-ups stay open as tasks until completed. Nothing is sent to an external banking system.
      </p>
    </section>
  );
}
