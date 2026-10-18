import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { api, type AIRecord, type ChatResult, type Evidence, type Insight, type InvestigationResult, type RiskBand, type TranslationResult } from "../api/client";
import { useAiStatus } from "../health";
import { errorMessage, fmtTime } from "../util";
import { RiskBadge } from "./common";
import { SecondOpinionNote, TranslatePanel } from "./CaseAssist";
import { useInspector } from "./Inspector";
import { ExpandButton, Modal, Toast } from "./Modal";

interface Props {
  caseId: string;
  evidence: Evidence[];
  latest: AIRecord<InvestigationResult> | null;
  chats: AIRecord<ChatResult>[];
  geminiConfigured: boolean | null;
  ruleBand: RiskBand;
  translation?: Insight<TranslationResult>;
  onChanged: () => void;
}

export function Citations({ ids, byId }: { ids: string[]; byId: Map<string, Evidence> }) {
  const { openEvidence } = useInspector();
  if (!ids.length) return null;
  return (
    <span className="citations">
      {ids.map((id) => {
        const item = byId.get(id);
        return item ? (
          <button key={id} className="citation" onClick={() => openEvidence(item)} title={item.description}>
            {id}
          </button>
        ) : (
          <span key={id} className="citation citation-invalid" title="Not in this case's evidence">
            {id} (invalid)
          </span>
        );
      })}
    </span>
  );
}

/** The investigation result itself; shown in the side panel and in the full-view pop-up. */
function InvestigationDetails({ result, validation, byId, extra }: {
  result: InvestigationResult;
  validation: AIRecord<InvestigationResult>["response"]["validation"];
  byId: Map<string, Evidence>;
  /** Extra blocks shown under the priority line (second opinion, translation). */
  extra?: ReactNode;
}) {
  return (
    <>
      <p className="ai-summary">{result.case_summary}</p>
      <div className="row small">
        <span>AI review priority recommendation:</span> <RiskBadge band={result.review_priority} />
        <span className="muted">(not a decision)</span>
      </div>
      {extra}

      {validation && (validation.removed_ids.length > 0 || validation.unsupported_claims.length > 0) ? (
        <div className="callout callout-warn" role="status">
          <strong>Citation validation:</strong>{" "}
          {validation.removed_ids.length > 0 ? (
            <>
              removed {validation.removed_ids.length} reference(s) to evidence that does not exist in this case (
              <span className="mono">{validation.removed_ids.join(", ")}</span>).{" "}
            </>
          ) : null}
          {validation.unsupported_claims.length > 0 ? (
            <>
              {validation.unsupported_claims.length} claim(s) had no valid evidence and are listed separately below, not as facts.
            </>
          ) : null}
        </div>
      ) : (
        <p className="small ok-text">
          {"✓"} All {validation?.valid_citations ?? 0} citations resolve to evidence in this case.
        </p>
      )}

      <div>
        <h3 className="section-title">Observed facts</h3>
        <ul className="ai-list">
          {result.observed_facts.map((f, i) => (
            <li key={i}>
              {f.statement} <Citations ids={f.evidence_ids} byId={byId} />
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="section-title">Risk indicators</h3>
        <ul className="ai-list">
          {result.risk_indicators.map((r, i) => (
            <li key={i}>
              <strong>{r.indicator}.</strong> {r.reasoning} <Citations ids={r.evidence_ids} byId={byId} />
            </li>
          ))}
        </ul>
      </div>
      <div className="two-col">
        <div>
          <h3 className="section-title">Alternative explanations</h3>
          <ul className="ai-list">
            {result.alternative_explanations.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="section-title">Uncertainties</h3>
          <ul className="ai-list">
            {result.uncertainties.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        <h3 className="section-title">Recommended review steps</h3>
        <ol className="ai-list">
          {result.recommended_next_steps.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      </div>
      {validation && validation.unsupported_claims.length > 0 ? (
        <div>
          <h3 className="section-title">Unsupported claims (no valid evidence; not shown as fact)</h3>
          <ul className="ai-list unsupported">
            {validation.unsupported_claims.map((c, i) => (
              <li key={i}>
                <span className="chip chip-warn">unsupported</span> {c.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export default function InvestigatorPanel({ caseId, evidence, latest: saved, chats, geminiConfigured, ruleBand, translation, onChanged }: Props) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [fullView, setFullView] = useState(false);
  // The record just returned, so "View results" works before the case page has finished reloading.
  const [fresh, setFresh] = useState<{ caseId: string; record: AIRecord<InvestigationResult> } | null>(null);
  const latest = fresh && fresh.caseId === caseId && fresh.record.investigation_id > (saved?.investigation_id ?? 0) ? fresh.record : saved;
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; title: string; text: string } | null>(null);
  const closeFullView = useCallback(() => setFullView(false), []);
  const closeNotice = useCallback(() => setNotice(null), []);
  const byId = new Map(evidence.map((e) => [e.evidence_id, e]));
  const ai = useAiStatus();
  const aiNote =
    ai.status?.state === "CONNECTED"
      ? ` Connected (${ai.status.active_model}).`
      : ai.status?.state === "DEGRADED"
        ? " Gemini is busy right now; the request may take longer or fall back."
        : ai.status && ai.status.state !== "NOT_CONFIGURED"
          ? ` ${ai.status.message}`
          : "";

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const record = await api.investigate(caseId, question.trim() || undefined);
      setFresh({ caseId, record });
      onChanged();
      setNotice(record.response.status === "OK"
        ? { tone: "ok", title: "Your investigation is ready", text: "Gemini has finished reviewing this case." }
        : { tone: "warn", title: "Gemini couldn't finish the investigation",
            text: record.response.message ?? "The rule findings and evidence on this page are still available." });
      ai.recheck(); // refresh the AI indicator (server-side cached)
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setChatBusy(true);
    setError(null);
    try {
      await api.chat(caseId, message.trim());
      setMessage("");
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChatBusy(false);
    }
  }

  const resp = latest?.response;
  const result = resp?.status === "OK" ? resp.result : undefined;
  const validation = resp?.validation;

  return (
    <section className="card ai-card" aria-labelledby="ai-heading" data-tour="case-ai">
      <div className="card-head">
        <h2 id="ai-heading">
          <span className="ai-mark" aria-hidden="true">
            {"✦"}
          </span>{" "}
          Gemini investigation
        </h2>
        <div className="card-tools">
          <span className="chip chip-ai">AI-generated &middot; advisory only</span>
          {result ? <ExpandButton onClick={() => setFullView(true)} label="Open investigation in full view" /> : null}
        </div>
      </div>
      <p className="muted small">
        Gemini sees only this case's evidence package. Every citation is checked against the allowed evidence IDs before it is shown.
        {geminiConfigured === false ? " Gemini is not configured on this deployment; the fallback state will be shown." : aiNote}
      </p>
      <div className="row">
        <label className="grow">
          <span className="label">Optional focus question</span>
          <input
            type="text"
            value={question}
            maxLength={500}
            placeholder="e.g. What are the strongest indicators and what is uncertain?"
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? "Investigating..." : latest ? "Re-run investigation" : "Investigate with Gemini"}
        </button>
      </div>
      {error ? (
        <div className="callout callout-error" role="alert">
          {error}
        </div>
      ) : null}
      {busy ? (
        <div className="state state-loading" role="status">
          <span className="spinner" aria-hidden="true" /> Asking Gemini (deterministic findings remain available)...
        </div>
      ) : null}

      {resp && resp.status === "UNAVAILABLE" ? (
        <div className="callout callout-warn" role="status">
          <strong>AI explanation unavailable ({(resp.reason ?? "error").replace(/_/g, " ").toLowerCase()}).</strong> {resp.message}
          {resp.detail ? <div className="small muted">Provider said: {resp.detail}</div> : null}
          <div className="small">Rule signals, the graph and all evidence on this page are unaffected.</div>
          <div>
            <button className="btn btn-small" onClick={run} disabled={busy}>
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="stack ai-result" aria-live="polite">
          {latest?.stale && !busy ? (
            <div className="callout callout-warn row-center" role="status" style={{ justifyContent: "space-between", gap: 8 }}>
              <span><strong>The case changed after this was written.</strong> Counts and amounts below may be out of date.</span>
              <button className="btn btn-small" onClick={run} disabled={busy}>
                Update
              </button>
            </div>
          ) : null}
          <div className="ai-meta muted small">
            {resp?.model} &middot; {resp?.prompt_version} &middot; {fmtTime(latest?.created_at)}
            {latest?.question ? <> &middot; focus: &ldquo;{latest.question}&rdquo;</> : null}
          </div>
          <InvestigationDetails
            result={result}
            validation={validation}
            byId={byId}
            extra={<>
              <SecondOpinionNote band={ruleBand} result={result} />
              <TranslatePanel caseId={caseId} record={translation} investigation={result} />
            </>}
          />
        </div>
      ) : null}

      <div className="chat">
        <h3 className="section-title">Follow-up questions</h3>
        {chats.length === 0 ? <p className="muted small">Ask about this case; answers are limited to its evidence.</p> : null}
        <ul className="chat-list">
          {chats.map((c) => (
            <li key={c.investigation_id}>
              <div className="chat-q">
                <span className="chip">You</span> {c.question}
              </div>
              <div className="chat-a">
                <span className="chip chip-ai">AI</span>{" "}
                {c.response.status === "OK" && c.response.result ? (
                  <>
                    {c.response.result.answer} <Citations ids={c.response.result.evidence_ids} byId={byId} />
                    {!c.response.result.grounded ? <span className="chip chip-warn">no valid citation</span> : null}
                  </>
                ) : (
                  <span className="muted">Unavailable ({c.response.reason}). {c.response.message}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
        <form className="row" onSubmit={ask}>
          <label className="grow">
            <span className="visually-hidden">Follow-up question</span>
            <input
              type="text"
              value={message}
              maxLength={500}
              placeholder="e.g. Which transfer moved funds fastest?"
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <button className="btn" type="submit" disabled={chatBusy || !message.trim()}>
            {chatBusy ? "Asking..." : "Ask"}
          </button>
        </form>
      </div>

      {fullView && result ? (
        <Modal
          title={<><span className="ai-mark" aria-hidden="true">{"✦"}</span> Gemini investigation</>}
          subtitle={<>{caseId} &middot; {resp?.model} &middot; {fmtTime(latest?.created_at)} UTC{latest?.question ? <> &middot; focus: &ldquo;{latest.question}&rdquo;</> : null}</>}
          onClose={closeFullView}
          footer={<span className="chip chip-ai">AI-generated &middot; advisory only</span>}
        >
          <div className="stack ai-result">
            <InvestigationDetails result={result} validation={validation} byId={byId} extra={<SecondOpinionNote band={ruleBand} result={result} />} />
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
              View results
            </button>
          ) : null}
        >
          {notice.text}
        </Toast>
      ) : null}
    </section>
  );
}
