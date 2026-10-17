import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  type CaseDetail,
  type Evidence,
  type GuardrailCheck,
  type GuardrailTest,
  type Insight,
  type InvestigationResult,
  type LanguageCode,
  type StrDraftResult,
} from "../api/client";
import { useAiStatus } from "../health";
import { fmtAmount, fmtTime } from "../util";
import { Busy, opinionDiff, SourceNote, Unavailable, useRun } from "./ai";
import { RiskBadge } from "./common";
import { IconSparkle } from "./icons";
import { useInspector } from "./Inspector";
import { Citations } from "./InvestigatorPanel";
import { ExpandButton, Modal } from "./Modal";
import { downloadPdf } from "../pdf";
import { usePrefs } from "../prefs";

export const LANGUAGES: { code: LanguageCode; label: string; speech: string }[] = [
  { code: "en", label: "English", speech: "en-IN" },
  { code: "hi", label: "हिन्दी Hindi", speech: "hi-IN" },
  { code: "gu", label: "ગુજરાતી Gujarati", speech: "gu-IN" },
  { code: "mr", label: "मराठी Marathi", speech: "mr-IN" },
  { code: "ta", label: "தமிழ் Tamil", speech: "ta-IN" },
  { code: "te", label: "తెలుగు Telugu", speech: "te-IN" },
  { code: "bn", label: "বাংলা Bengali", speech: "bn-IN" },
  { code: "kn", label: "ಕನ್ನಡ Kannada", speech: "kn-IN" },
];

function AiHead({ id, title, chip, children }: { id: string; title: string; chip: string; children?: ReactNode }) {
  return (
    <div className="card-head">
      <h2 id={id}>
        <span className="ai-mark">
          <IconSparkle size={17} />
        </span>{" "}
        {title}
      </h2>
      <div className="card-tools">
        <span className="chip chip-ai">{chip}</span>
        {children}
      </div>
    </div>
  );
}

// ---- Read aloud (browser speech synthesis) ----

function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, [supported]);
  function speak(text: string, lang: string): string | null {
    if (!supported) return "Read-aloud is not supported in this browser.";
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return null;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    if (voice) u.voice = voice;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
    return voice || lang.startsWith("en") ? null : "No voice for this language is installed on this device; your browser's default voice is used.";
  }
  return { speak, speaking, supported };
}

/** Second opinion: compare the rule priority with Gemini's review priority, with the reason Gemini gave. */
export function SecondOpinionNote({ band, result }: { band: CaseDetail["case"]["risk_band"]; result: InvestigationResult }) {
  const diff = opinionDiff(band, result.review_priority);
  const reason =
    diff < 0 ? result.alternative_explanations[0] : diff > 0 ? result.risk_indicators[0]?.reasoning : result.risk_indicators[0]?.indicator;
  return (
    <div className={`callout ${diff === 0 ? "callout-ok" : "callout-info"} opinion-note`} role="status">
      <strong>
        {diff === 0 ? "✦ AI agrees with the rules" : diff > 0 ? "✦ AI rates this higher than the rules" : "✦ AI rates this lower than the rules"}
      </strong>{" "}
      <span className="small">
        (rules: {band.toLowerCase()}, Gemini: {result.review_priority.toLowerCase()})
      </span>
      {reason ? <div className="small" style={{ marginTop: 4 }}>{diff < 0 ? "Possible explanation: " : "Main reason: "}{reason}</div> : null}
      <div className="small muted">A second opinion for the analyst. Neither score is a finding.</div>
    </div>
  );
}

/** Translate the latest investigation summary and read it aloud. */
export function TranslatePanel({ caseId, record, investigation }: { caseId: string; record?: Insight<any>; investigation: InvestigationResult }) {
  const [lang, setLang] = useState<LanguageCode>((record?.request.language as LanguageCode) ?? "hi");
  const [rec, setRec] = useState(record);
  const { busy, error, run } = useRun();
  const { speak, speaking, supported } = useSpeech();
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setRec(record), [record]);
  const shown = rec?.response.status === "OK" && rec.request.language === lang ? rec.response.result : null;
  const speechLang = LANGUAGES.find((l) => l.code === lang)?.speech ?? "en-IN";

  function listen() {
    const text = shown ? [shown.summary, ...shown.key_points].join(". ") : investigation.case_summary;
    setNote(speak(text, shown ? speechLang : "en-IN"));
  }

  return (
    <div className="translate">
      <div className="row-center">
        <label className="inline">
          <span className="label" style={{ margin: 0 }}>Summary in</span>
          <select value={lang} onChange={(e) => setLang(e.target.value as LanguageCode)}>
            {LANGUAGES.filter((l) => l.code !== "en").map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </label>
        <button className="btn btn-small" onClick={async () => { const r = await run(() => api.translate(caseId, lang)); if (r) setRec(r); }} disabled={busy}>
          {busy ? "Translating..." : "Translate"}
        </button>
        {supported ? (
          <button className="btn btn-small" onClick={listen} aria-pressed={speaking}>
            {speaking ? "■ Stop" : shown ? "🔊 Listen" : "🔊 Listen (English)"}
          </button>
        ) : null}
      </div>
      {busy ? <Busy label="Gemini is translating..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {note ? <p className="muted small">{note}</p> : null}
      {rec && rec.request.language === lang ? <Unavailable rec={rec} what="Translation" /> : null}
      {shown ? (
        <details className="translated" lang={lang} open>
          <summary className="section-title" style={{ cursor: "pointer" }}>{LANGUAGES.find((l) => l.code === lang)?.label}</summary>
          <p className="ai-summary">{shown.summary}</p>
          {shown.key_points.length ? <ul className="ai-list">{shown.key_points.map((k: string, i: number) => <li key={i}>{k}</li>)}</ul> : null}
          {shown.next_steps.length ? <ol className="ai-list" style={{ marginTop: 6 }}>{shown.next_steps.map((k: string, i: number) => <li key={i}>{k}</li>)}</ol> : null}
          <SourceNote rec={rec!} />
        </details>
      ) : null}
    </div>
  );
}

/** Counterfactual scoring: what the priority rests on. Scores are recomputed by the rule engine, Gemini explains. */
export function CounterfactualCard({ detail, onChanged }: { detail: CaseDetail; onChanged: () => void }) {
  const rec = detail.ai_extras.COUNTERFACTUAL;
  const { busy, error, run } = useRun();
  const { openTransaction } = useInspector();
  const r = rec?.response.result;
  const f = r?.facts;

  return (
    <section className="card ai-card" aria-labelledby="cf-heading" id="sec-drivers">
      <AiHead id="cf-heading" title="What the score rests on" chip="Rules recompute · AI explains" />
      <p className="muted small">
        The rule engine re-scores the case with each transfer removed, and with each rule turned off. It shows whether the priority hinges on one transfer or holds across the flow.
      </p>
      <div className="row-center" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" onClick={async () => { if (await run(() => api.counterfactual(detail.case.case_id))) onChanged(); }} disabled={busy}>
          <IconSparkle size={14} /> {busy ? "Re-scoring..." : r ? "Re-run" : "Analyse score drivers"}
        </button>
      </div>
      {busy ? <Busy label="Re-scoring the case without each transfer..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {r && f ? (
        <div className="stack-sm" style={{ marginTop: 12 }} aria-live="polite">
          <p className="ai-summary">{r.summary}</p>
          {r.points.length ? (
            <ul className="ai-list">
              {r.points.map((p, i) => (
                <li key={i}>
                  {p.text}{" "}
                  {p.transaction_ids.map((t) => (
                    <button key={t} className="citation" onClick={() => openTransaction(t)}>{t}</button>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="two-col">
            <div>
              <h3 className="section-title">Without one transfer</h3>
              <ul className="cf-list">
                {f.remove_one_transfer.slice(0, 5).map((x) => (
                  <li key={x.transaction_id}>
                    <button className="link-button small" onClick={() => openTransaction(x.transaction_id)}>
                      Step {x.step}: {x.from} &rarr; {x.to}
                    </button>
                    <span className="muted small"> {x.amount_text}</span>
                    <span className="cf-score">
                      <RiskBadge band={x.band_without} score={x.score_without} />
                      <span className={x.change < 0 ? "cf-down" : "cf-flat"}>{x.change < 0 ? x.change : "±0"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="section-title">With one rule off</h3>
              <ul className="cf-list">
                {f.turn_off_one_rule.map((x) => (
                  <li key={x.code}>
                    <span className="small">{x.label}{x.context_only ? <span className="chip chip-context">context</span> : null}</span>
                    <span className="cf-score">
                      <RiskBadge band={x.band_without} score={x.score_without} />
                      <span className={x.change < 0 ? "cf-down" : "cf-flat"}>{x.change < 0 ? x.change : "±0"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="muted small">
            Current score {f.current_score} ({f.current_band.toLowerCase()}). Cases below {f.queue_threshold} leave the review queue.
          </p>
          <SourceNote rec={rec!} />
        </div>
      ) : null}
    </section>
  );
}

function strMarkdown(s: StrDraftResult, nameOf: (id: string) => string): string {
  const lines = [
    `# Suspicious transaction report (draft) ${s.report_reference}`,
    "",
    `> ${s.draft_note}`,
    "",
    `**Reporting entity:** ${s.reporting_entity}  `,
    `**Period:** ${s.period.from ?? "?"} to ${s.period.to ?? "?"}  `,
    `**Total amount:** ${fmtAmount(s.total_amount)}`,
    "",
    "## Summary of suspicion",
    s.summary_of_suspicion,
    "",
    "## Subjects",
    "| Account | Holder | Type | KYC | Opened | Sent | Received |",
    "|---|---|---|---|---|---|---|",
    ...s.subjects.map((a) => `| ${a.account_id} | ${a.holder_name ?? ""} | ${a.account_type ?? ""} | ${a.kyc_tier ?? ""} | ${a.opened ?? ""} | ${fmtAmount(a.sent)} | ${fmtAmount(a.received)} |`),
    "",
    "## Transactions",
    "| Time (UTC) | Transfer | From | To | Amount | Channel | Reference |",
    "|---|---|---|---|---|---|---|",
    ...s.transactions.map((t) => `| ${t.timestamp.replace("T", " ")} | ${t.transaction_id} | ${nameOf(t.from)} (${t.from}) | ${nameOf(t.to)} (${t.to}) | ${fmtAmount(t.amount, t.currency)} | ${t.channel} | ${t.reference ?? ""} |`),
    "",
    "## Grounds of suspicion",
    ...s.grounds.map((g) => `- ${g.text} [${g.evidence_ids.join(", ")}]`),
    "",
    "## Red flags",
    ...s.red_flags.map((f) => `- ${s.red_flag_labels[f] ?? f}`),
    "",
    "## Sequence of events",
    ...s.sequence_of_events.map((e) => `- ${e.text} [${e.evidence_ids.join(", ")}]`),
    "",
    "## Action taken",
    ...(s.actions_taken.length ? s.actions_taken.map((a) => `- ${a.label}${a.target_account ? ` on ${a.target_account}` : ""} (${a.status.toLowerCase()}, approved by ${a.approved_by})`) : ["- None recorded yet."]),
    s.analyst_decision ? `- Analyst decision: ${s.analyst_decision.decision} by ${s.analyst_decision.by}: ${s.analyst_decision.rationale}` : "",
    "",
    "## Information gaps to close before filing",
    ...s.information_gaps.map((g) => `- ${g}`),
  ];
  return lines.join("\n");
}

/** The STR draft body; shown in the card and in the full-view pop-up (where every section starts open). */
function StrDetails({ s, detail, allOpen = false }: { s: StrDraftResult; detail: CaseDetail; allOpen?: boolean }) {
  const byId = useMemo(() => new Map<string, Evidence>(detail.evidence.map((e) => [e.evidence_id, e])), [detail.evidence]);
  const nameOf = (id: string) => detail.accounts[id]?.holder_name ?? id;
  return (
    <>
      <dl className="kv str-kv">
        <dt>Reference</dt><dd className="mono">{s.report_reference}</dd>
        <dt>Period</dt><dd>{fmtTime(s.period.from)} to {fmtTime(s.period.to)} UTC</dd>
        <dt>Amount</dt><dd>{fmtAmount(s.total_amount)} across {s.transactions.length} transfers, {s.subjects.length} accounts</dd>
      </dl>
      <h3 className="section-title">Summary of suspicion</h3>
      <p className="ai-summary">{s.summary_of_suspicion}</p>
      {s.red_flags.length ? (
        <div className="chip-row">
          {s.red_flags.map((f) => <span key={f} className="chip chip-warn">{s.red_flag_labels[f] ?? f}</span>)}
        </div>
      ) : null}
      <details open>
        <summary className="section-title" style={{ cursor: "pointer" }}>Grounds ({s.grounds.length})</summary>
        <ul className="ai-list" style={{ marginTop: 6 }}>
          {s.grounds.map((g, i) => <li key={i}>{g.text} <Citations ids={g.evidence_ids} byId={byId} /></li>)}
        </ul>
      </details>
      <details open={allOpen}>
        <summary className="section-title" style={{ cursor: "pointer" }}>Sequence of events ({s.sequence_of_events.length})</summary>
        <ol className="ai-list" style={{ marginTop: 6 }}>
          {s.sequence_of_events.map((g, i) => <li key={i}>{g.text} <Citations ids={g.evidence_ids} byId={byId} /></li>)}
        </ol>
      </details>
      <details open={allOpen}>
        <summary className="section-title" style={{ cursor: "pointer" }}>Subjects, actions and gaps</summary>
        <div className="table-scroll">
          <table className="table compact" style={{ marginTop: 6 }}>
            <thead><tr><th scope="col">Account</th><th scope="col">KYC</th><th scope="col">Opened</th><th scope="col" className="num">Sent</th><th scope="col" className="num">Received</th></tr></thead>
            <tbody>
              {s.subjects.map((a) => (
                <tr key={a.account_id}>
                  <td>{a.holder_name ?? a.account_id} <span className="mono small muted">{a.account_id}</span></td>
                  <td className="small">{a.kyc_tier?.replace("_", " ").toLowerCase()}</td>
                  <td className="small">{a.opened}</td>
                  <td className="num tnum">{fmtAmount(a.sent)}</td>
                  <td className="num tnum">{fmtAmount(a.received)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h4 style={{ marginTop: 8 }}>Action taken</h4>
        <ul className="ai-list">
          {s.actions_taken.length ? s.actions_taken.map((a, i) => <li key={i}>{a.label}{a.target_account ? ` on ${nameOf(a.target_account)}` : ""} ({a.status.toLowerCase()})</li>) : <li>None recorded yet.</li>}
        </ul>
        <h4 style={{ marginTop: 8 }}>Information gaps</h4>
        <ul className="ai-list">{s.information_gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
      </details>
    </>
  );
}

/** STR-style draft for the compliance officer: record fields from the database, narrative drafted by Gemini. */
export function StrDraftCard({ detail, onChanged }: { detail: CaseDetail; onChanged: () => void }) {
  const rec = detail.ai_extras.STR_DRAFT;
  const { busy, error, run } = useRun();
  const ai = useAiStatus();
  const [fullView, setFullView] = useState(false);
  const closeFullView = useCallback(() => setFullView(false), []);
  const nameOf = (id: string) => detail.accounts[id]?.holder_name ?? id;
  const s = rec?.response.result;
  const unsupported = rec?.response.validation?.unsupported_claims?.length ?? 0;
  const download = (r: StrDraftResult) => downloadPdf(`${r.report_reference}.pdf`, strMarkdown(r, nameOf), `STR draft ${r.report_reference}`);

  return (
    <section className="card ai-card" aria-labelledby="str-heading" data-tour="case-str" id="sec-str">
      <AiHead id="str-heading" title="Regulatory report (STR draft)" chip="AI draft · compliance review">
        {s ? <ExpandButton onClick={() => setFullView(true)} label="Open regulatory report in full view" /> : null}
      </AiHead>
      <p className="muted small">
        A suspicious transaction report draft for the compliance officer. Subjects, transactions and actions come straight from the records; Gemini drafts the grounds and sequence,
        each with verified citations. It is not filed anywhere from here.
      </p>
      <div className="row-center" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => api.strDraft(detail.case.case_id))) { onChanged(); ai.recheck(); } }}>
          <IconSparkle size={14} /> {busy ? "Drafting..." : s ? "Redraft" : "Draft STR"}
        </button>
        {s ? (
          <button className="btn" onClick={() => download(s)}>
            Download PDF
          </button>
        ) : null}
      </div>
      {busy ? <Busy label="Drafting from verified evidence..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {s && rec ? (
        <div className="stack-sm" style={{ marginTop: 12 }} aria-live="polite">
          <StrDetails s={s} detail={detail} />
          {unsupported ? <div className="callout callout-warn small">{unsupported} statement(s) had no valid evidence and were left out.</div> : null}
          <p className="small muted">{s.draft_note}</p>
          <SourceNote rec={rec} />
        </div>
      ) : null}

      {fullView && s && rec ? (
        <Modal
          title={<><span className="ai-mark" aria-hidden="true"><IconSparkle size={17} /></span> Regulatory report (STR draft)</>}
          subtitle={<>{detail.case.case_id} &middot; <span className="mono">{s.report_reference}</span> &middot; {fmtTime(rec.created_at)} UTC</>}
          onClose={closeFullView}
          footer={
            <div className="row-center" style={{ width: "100%", justifyContent: "space-between" }}>
              <span className="chip chip-ai">AI draft &middot; compliance review</span>
              <button className="btn btn-small" onClick={() => download(s)}>
                Download PDF
              </button>
            </div>
          }
        >
          <div className="stack-sm">
            <StrDetails s={s} detail={detail} allOpen />
            {unsupported ? <div className="callout callout-warn small">{unsupported} statement(s) had no valid evidence and were left out.</div> : null}
            <p className="small muted">{s.draft_note}</p>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
const GUARD_OUTCOME: Record<GuardrailCheck["outcome"], { label: string; color: string }> = {
  BLOCKED: { label: "✓ Blocked", color: "var(--low)" },
  CONTAINED: { label: "✓ Contained", color: "var(--low)" },
  PASSED: { label: "✓ Kept", color: "var(--low)" },
  FAILED: { label: "✗ Not stopped", color: "var(--high)" },
};

/** AI safety check: a tampered model response is run through the same checks as every real Gemini answer.
 *  Each run is recorded in the audit trail with the analyst's name, as evidence for compliance and model-risk review. */
export function GuardrailCard({ caseId, picker, onRan }: { caseId: string; picker?: ReactNode; onRan?: () => void }) {
  const [result, setResult] = useState<GuardrailTest | null>(null);
  const { busy, error, run } = useRun();
  const { analystName } = usePrefs();
  useEffect(() => setResult(null), [caseId]);
  const verify = async () => {
    const r = await run(() => api.guardrailTest(caseId, { actor_label: analystName || undefined }));
    if (r) {
      setResult(r);
      onRan?.();
    }
  };
  return (
    <section className="card ai-card" aria-labelledby="guard-heading" id="sec-guardrails">
      <AiHead id="guard-heading" title="Verify AI safety controls" chip="No model call · production checks" />
      <p className="muted small">
        Proves the assistant cannot cite evidence that does not exist, make claims without a source, or act outside a case. A deliberately
        tampered AI answer is sent through exactly the checks every real Gemini response passes, and each run is recorded in the audit trail.
      </p>
      <div className="row-center" style={{ marginTop: 8, flexWrap: "wrap" }}>
        {picker}
        <button className="btn btn-primary" onClick={verify} disabled={busy || !caseId}>
          {busy ? "Verifying..." : result ? "Run again" : "Run safety check"}
        </button>
      </div>
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {result ? (
        <div className="stack-sm" style={{ marginTop: 12 }} aria-live="polite">
          <div className={`callout ${result.all_passed ? "callout-ok" : "callout-warn"}`} role="status">
            <strong>{result.stopped} of {result.attacks} attacks stopped</strong>
            <span className="small">, and the correctly cited control claim was kept. Evidence package: {result.evidence_sent} items.</span>
          </div>
          <ul className="cf-list">
            {result.checks.map((c) => (
              <li key={c.key} style={{ display: "block" }}>
                <div className="row-center" style={{ justifyContent: "space-between", gap: 8 }}>
                  <strong className="small">{c.title}</strong>
                  <span className="small" style={{ color: GUARD_OUTCOME[c.outcome].color, fontWeight: 600 }}>{GUARD_OUTCOME[c.outcome].label}</span>
                </div>
                <div className="small muted">{c.attack}</div>
                <div className="small">{c.detail}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
