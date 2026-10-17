import { useEffect, useMemo, useState } from "react";
import {
  api,
  type CaseDetail,
  type ContactScriptResult,
  type Evidence,
  type Insight,
  type InvestigationResult,
  type LanguageCode,
  type StrDraftResult,
} from "../api/client";
import { useAiStatus } from "../health";
import { fmtAmount, fmtTime } from "../util";
import { Busy, copyText, downloadText, opinionDiff, SourceNote, Unavailable, useRun } from "./ai";
import { RiskBadge } from "./common";
import { IconSparkle } from "./icons";
import { useInspector } from "./Inspector";
import { Citations } from "./InvestigatorPanel";

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

function AiHead({ id, title, chip }: { id: string; title: string; chip: string }) {
  return (
    <div className="card-head">
      <h2 id={id}>
        <span className="ai-mark">
          <IconSparkle size={17} />
        </span>{" "}
        {title}
      </h2>
      <span className="chip chip-ai">{chip}</span>
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

function scriptText(s: ContactScriptResult): string {
  return [
    `Opening: ${s.opening}`,
    "Questions:",
    ...s.verification_questions.map((q, i) => `${i + 1}. ${q}`),
    `If the customer confirms: ${s.if_confirmed}`,
    `If the customer does not recognise the transfers: ${s.if_not_recognised}`,
    `Closing: ${s.closing}`,
    `SMS: ${s.sms_text}`,
  ].join("\n");
}

/** Wording for the customer verification call or SMS. Filtered in code for secrets and tipping-off. */
export function ContactScriptCard({ detail, onChanged }: { detail: CaseDetail; onChanged: () => void }) {
  const rec = detail.ai_extras.CONTACT_SCRIPT;
  const [account, setAccount] = useState(rec?.request.account_id ?? detail.suggested_contact_account ?? detail.case.accounts[0]);
  const [channel, setChannel] = useState<string>(rec?.request.channel ?? "CALL");
  const [lang, setLang] = useState<LanguageCode>((rec?.request.language as LanguageCode) ?? "en");
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useRun();
  const ai = useAiStatus();
  const s = rec?.response.result;
  const removed = rec?.response.validation?.removed_sentences?.length ?? 0;
  const verification = detail.actions.find((a) => a.action_code === "REQUEST_CUSTOMER_VERIFICATION" && a.status === "OPEN" && a.target_account === account);

  return (
    <section className="card ai-card" aria-labelledby="script-heading" data-tour="case-script">
      <AiHead id="script-heading" title="Customer contact script" chip="AI draft · safety-filtered" />
      <p className="muted small">
        Wording for confirming the transfers with the account holder through a verified channel. Requests for OTPs or PINs, links, and anything that could tip the customer off are
        removed in code. Nothing is sent from here.
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="grow">
          <span className="label">Account holder</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            {detail.case.accounts.map((id) => (
              <option key={id} value={id}>{detail.accounts[id]?.holder_name ?? id} ({id})</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Channel</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="CALL">Phone call</option>
            <option value="SMS">SMS</option>
            <option value="EMAIL">Email</option>
          </select>
        </label>
        <label>
          <span className="label">Language</span>
          <select value={lang} onChange={(e) => setLang(e.target.value as LanguageCode)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
      </div>
      {verification ? <p className="small ok-text">Linked to the open verification task for this account.</p> : null}
      <button
        className="btn btn-primary"
        style={{ marginTop: 8 }}
        disabled={busy}
        onClick={async () => {
          if (await run(() => api.contactScript(detail.case.case_id, { account_id: account, channel, language: lang }))) {
            onChanged();
            ai.recheck();
          }
        }}
      >
        <IconSparkle size={14} /> {busy ? "Drafting..." : "Draft script"}
      </button>
      {busy ? <Busy label="Drafting and safety-checking the script..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {s && rec ? (
        <div className="script stack-sm" style={{ marginTop: 12 }} lang={s.language} aria-live="polite">
          <div className="muted small">
            For {detail.accounts[s.account_id]?.holder_name ?? s.account_id} &middot; {s.channel.toLowerCase()} &middot; {LANGUAGES.find((l) => l.code === s.language)?.label}
            {s.requested_language !== s.language ? " (template; the requested language needs Gemini)" : ""}
          </div>
          <div className="script-block"><span className="script-label">Opening</span>{s.opening}</div>
          <div className="script-block">
            <span className="script-label">Questions</span>
            <ol className="ai-list">{s.verification_questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
          </div>
          <div className="two-col">
            <div className="script-block"><span className="script-label">If they confirm</span>{s.if_confirmed}</div>
            <div className="script-block"><span className="script-label">If they do not recognise it</span>{s.if_not_recognised}</div>
          </div>
          <div className="script-block"><span className="script-label">Closing</span>{s.closing}</div>
          <div className="script-block script-sms"><span className="script-label">SMS ({s.sms_text.length} chars)</span>{s.sms_text}</div>
          <div className="callout callout-info small">
            <strong>Before you call</strong>
            <ul>{s.compliance_notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
          {removed ? <p className="small muted">The safety filter removed {removed} sentence{removed === 1 ? "" : "s"} from the draft.</p> : null}
          <div className="row-center">
            <button className="btn btn-small" onClick={() => copyText(scriptText(s)).then(() => setCopied(true)).catch(() => setCopied(false))}>
              {copied ? "Copied" : "Copy script"}
            </button>
            <SourceNote rec={rec} />
          </div>
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

/** STR-style draft for the compliance officer: record fields from the database, narrative drafted by Gemini. */
export function StrDraftCard({ detail, onChanged }: { detail: CaseDetail; onChanged: () => void }) {
  const rec = detail.ai_extras.STR_DRAFT;
  const { busy, error, run } = useRun();
  const ai = useAiStatus();
  const byId = useMemo(() => new Map<string, Evidence>(detail.evidence.map((e) => [e.evidence_id, e])), [detail.evidence]);
  const nameOf = (id: string) => detail.accounts[id]?.holder_name ?? id;
  const s = rec?.response.result;
  const unsupported = rec?.response.validation?.unsupported_claims?.length ?? 0;

  return (
    <section className="card ai-card" aria-labelledby="str-heading" data-tour="case-str">
      <AiHead id="str-heading" title="Regulatory report (STR draft)" chip="AI draft · compliance review" />
      <p className="muted small">
        A suspicious transaction report draft for the compliance officer. Subjects, transactions and actions come straight from the records; Gemini drafts the grounds and sequence,
        each with verified citations. It is not filed anywhere from here.
      </p>
      <div className="row-center" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => api.strDraft(detail.case.case_id))) { onChanged(); ai.recheck(); } }}>
          <IconSparkle size={14} /> {busy ? "Drafting..." : s ? "Redraft" : "Draft STR"}
        </button>
        {s ? (
          <button className="btn" onClick={() => downloadText(`${s.report_reference}.md`, strMarkdown(s, nameOf))}>
            Download draft
          </button>
        ) : null}
      </div>
      {busy ? <Busy label="Drafting from verified evidence..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {s && rec ? (
        <div className="stack-sm" style={{ marginTop: 12 }} aria-live="polite">
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
          <details>
            <summary className="section-title" style={{ cursor: "pointer" }}>Sequence of events ({s.sequence_of_events.length})</summary>
            <ol className="ai-list" style={{ marginTop: 6 }}>
              {s.sequence_of_events.map((g, i) => <li key={i}>{g.text} <Citations ids={g.evidence_ids} byId={byId} /></li>)}
            </ol>
          </details>
          <details>
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
          {unsupported ? <div className="callout callout-warn small">{unsupported} statement(s) had no valid evidence and were left out.</div> : null}
          <p className="small muted">{s.draft_note}</p>
          <SourceNote rec={rec} />
        </div>
      ) : null}
    </section>
  );
}
