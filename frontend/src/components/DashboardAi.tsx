import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type AskResult, type DayExplanationResult, type Insight } from "../api/client";
import { useAiStatus } from "../health";
import { caseHeadline, fmtAmount, fmtCompact, fmtDay, fmtTime, plural, useAsync } from "../util";
import { Busy, CaseLinks, SourceNote, useRun } from "./ai";
import { ErrorState, Loading, RiskBadge, StatusChip } from "./common";
import { IconSparkle } from "./icons";
import { useInspector } from "./Inspector";

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

/** Start-of-shift briefing: what changed, what matters, and the next three things to do. */
export function BriefingCard({ refreshKey }: { refreshKey: number }) {
  const data = useAsync(() => api.briefing(), [refreshKey]);
  const { busy, error, run } = useRun();
  const ai = useAiStatus();
  const current = data.data;

  async function ask() {
    if (await run(() => api.makeBriefing())) {
      data.reload();
      ai.recheck();
    }
  }

  return (
    <section className="card ai-card briefing" aria-labelledby="briefing-heading" data-tour="dash-briefing">
      <AiHead id="briefing-heading" title="Shift briefing" chip="AI · advisory" />
      {data.loading && !current ? <Loading label="Preparing briefing" /> : null}
      {data.error && !current ? <ErrorState message={data.error} onRetry={data.reload} /> : null}
      {current?.response.result ? (
        <div className="stack-sm" aria-live="polite">
          <p className="briefing-headline">{current.response.result.headline}</p>
          <p className="ai-summary">{current.response.result.summary}</p>
          {current.response.result.highlights.length ? (
            <details>
              <summary className="section-title" style={{ cursor: "pointer" }}>Highlights ({current.response.result.highlights.length})</summary>
              <ul className="ai-list" style={{ marginTop: 6 }}>
                {current.response.result.highlights.map((h, i) => (
                  <li key={i}>
                    {h.text} <CaseLinks ids={h.case_ids} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {current.response.result.next_actions.length ? (
            <>
              <h3 className="section-title">Do next</h3>
              <ol className="next-actions">
                {current.response.result.next_actions.map((a, i) => (
                  <li key={a.case_id + i}>
                    <Link to={`/cases/${a.case_id}`} className="next-action">
                      <span className="next-num">{i + 1}</span>
                      <span>
                        <strong>{a.action}</strong>
                        <span className="muted small"> &middot; {a.case_id}</span>
                        <span className="small" style={{ display: "block" }}>{a.reason}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          <div className="row-center ai-foot">
            <SourceNote rec={current} />
            <button className="btn btn-small btn-primary" onClick={ask} disabled={busy}>
              <IconSparkle size={14} /> {busy ? "Writing..." : current.response.source === "GEMINI" ? "Refresh" : "Write with Gemini"}
            </button>
          </div>
        </div>
      ) : null}
      {busy ? <Busy label="Gemini is reading the queue..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
    </section>
  );
}

/** Active cases grouped into typologies by behaviour, shared accounts and shared devices. */
export function PatternsCard({ refreshKey }: { refreshKey: number }) {
  const data = useAsync(() => api.patterns(), [refreshKey]);
  const [showAll, setShowAll] = useState(false);
  const { busy, error, run } = useRun();
  const current = data.data;
  const r = current?.response.result;

  return (
    <section className="card ai-card" aria-labelledby="patterns-heading" data-tour="dash-patterns">
      <AiHead id="patterns-heading" title="Emerging patterns" chip="Embeddings + Gemini" />
      {data.loading && !current ? <Loading label="Grouping cases" /> : null}
      {data.error && !current ? <ErrorState message={data.error} onRetry={data.reload} /> : null}
      {r ? (
        <div className="stack-sm" aria-live="polite">
          <p className="muted small">{r.overview}</p>
          <ul className="pattern-list pattern-grid">
            {r.patterns.slice(0, showAll ? undefined : 4).map((p) => (
              <li key={p.pattern_id} className="pattern">
                <div className="pattern-head">
                  <strong>{p.name}</strong>
                  <RiskBadge band={p.highest_band} />
                </div>
                <p className="small">{p.summary}</p>
                <div className="chip-row">
                  <span className="chip">{plural(p.size, "case")}</span>
                  <span className="chip">{p.amount_text}</span>
                  <span className="chip">{plural(p.accounts, "account")}</span>
                  {p.shared_accounts.length ? <span className="chip chip-warn">shared {p.shared_accounts.join(", ")}</span> : null}
                  {p.shared_devices.length ? <span className="chip chip-warn">shared device</span> : null}
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  Watch for: {p.watch_for}
                </div>
                <CaseLinks ids={p.case_ids} />
              </li>
            ))}
          </ul>
          {r.patterns.length > 4 ? (
            <button className="link-button small" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show ${r.patterns.length - 4} more pattern${r.patterns.length - 4 === 1 ? "" : "s"}`}
            </button>
          ) : null}
          <div className="row-center ai-foot">
            <span className="muted small">
              {r.method === "GEMINI_EMBEDDINGS" ? "Grouped by Gemini embeddings and shared signals." : "Grouped by shared signals, accounts and devices."}
            </span>
            <SourceNote rec={current!} />
            <button className="btn btn-small btn-primary" onClick={async () => { if (await run(() => api.makePatterns())) data.reload(); }} disabled={busy}>
              <IconSparkle size={14} /> {busy ? "Analysing..." : current!.response.source === "GEMINI" ? "Refresh" : "Analyse with Gemini"}
            </button>
          </div>
        </div>
      ) : null}
      {busy ? <Busy label="Embedding case behaviour and naming patterns..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
    </section>
  );
}

const EXAMPLES = [
  "IMPS transfers above 1 lakh to new accounts",
  "Which accounts received money with rapid onward movement?",
  "High priority open cases",
  "Flagged transfers in the last week",
];

function AskTable({ r }: { r: AskResult }) {
  const { openTransaction, openAccount } = useInspector();
  if (!r.rows.length) return <p className="muted small">Nothing matches. Try a wider range or fewer filters.</p>;
  if (r.plan.target === "CASES") {
    return (
      <table className="table compact">
        <thead>
          <tr><th scope="col">Case</th><th scope="col">Status</th><th scope="col" className="num">Amount</th><th scope="col">Priority</th></tr>
        </thead>
        <tbody>
          {r.rows.map((c) => (
            <tr key={c.case_id}>
              <td><Link to={`/cases/${c.case_id}`}>{caseHeadline(c.title)}</Link> <span className="mono small muted">{c.case_id}</span></td>
              <td><StatusChip status={c.status} /></td>
              <td className="num tnum">{fmtAmount(c.total_amount)}</td>
              <td><RiskBadge band={c.risk_band} score={c.risk_score} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (r.plan.target === "ACCOUNTS") {
    return (
      <table className="table compact">
        <thead>
          <tr><th scope="col">Account</th><th scope="col" className="num">Matching transfers</th><th scope="col" className="num">Amount</th><th scope="col">Highest score</th></tr>
        </thead>
        <tbody>
          {r.rows.map((a) => (
            <tr key={a.account_id}>
              <td>
                <button className="link-button" onClick={() => openAccount(a.account_id)}>{a.holder_name ?? a.account_id}</button>{" "}
                <span className="mono small muted">{a.account_id}</span>
              </td>
              <td className="num tnum">{a.transfers}</td>
              <td className="num tnum">{fmtAmount(a.amount)}</td>
              <td><RiskBadge band={a.max_score >= 60 ? "HIGH" : a.max_score >= 30 ? "MEDIUM" : "LOW"} score={a.max_score} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="table compact">
      <thead>
        <tr><th scope="col">Time (UTC)</th><th scope="col">From &rarr; To</th><th scope="col" className="num">Amount</th><th scope="col">Priority</th></tr>
      </thead>
      <tbody>
        {r.rows.map((t) => (
          <tr key={t.transaction_id}>
            <td className="small nowrap">
              <button className="link-button mono small" onClick={() => openTransaction(t.transaction_id)}>{t.transaction_id}</button>
              <div className="muted">{fmtTime(t.timestamp)}</div>
            </td>
            <td>
              {t.source_name ?? t.source_account} <span className="muted">&rarr;</span> {t.destination_name ?? t.destination_account}
              <div className="muted small">{t.channel}</div>
            </td>
            <td className="num tnum">{fmtAmount(t.amount, t.currency)}</td>
            <td><RiskBadge band={t.risk_band} score={t.score} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Plain-language questions. Gemini maps the question to a fixed filter plan; the server runs the query itself. */
export function AskPortfolio() {
  const [q, setQ] = useState("");
  const [rec, setRec] = useState<Insight<AskResult> | null>(null);
  const { busy, error, run } = useRun();

  async function submit(e?: FormEvent, text?: string) {
    e?.preventDefault();
    const question = (text ?? q).trim();
    if (question.length < 3) return;
    setQ(question);
    const r = await run(() => api.askPortfolio(question));
    if (r) setRec(r);
  }
  const r = rec?.response.result;

  return (
    <section className="card ai-card ask-hero" aria-labelledby="ask-heading" data-tour="dash-ask">
      <h2 id="ask-heading" className="visually-hidden">Ask the portfolio</h2>
      <form className="ask-bar" onSubmit={submit} role="search">
        <span className="ai-mark"><IconSparkle size={18} /></span>
        <label className="grow">
          <span className="visually-hidden">Question about transfers, cases or accounts</span>
          <input type="text" value={q} maxLength={300} placeholder="Ask the portfolio, e.g. which accounts received over 2 lakh from newly opened accounts?" onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="chip chip-ai ask-badge" title="Gemini never sees the records. It turns the question into a fixed set of filters; the server checks them and runs the query.">
          Gemini &rarr; safe filters
        </span>
        <button className="btn btn-primary" type="submit" disabled={busy || q.trim().length < 3}>
          {busy ? "Asking..." : "Ask"}
        </button>
      </form>
      <div className="ask-meta">
        <div className="chip-row">
          <span className="muted small">Try:</span>
          {EXAMPLES.map((x) => (
            <button key={x} className="chip chip-button" onClick={() => submit(undefined, x)} disabled={busy}>
              {x}
            </button>
          ))}
        </div>
      </div>
      {busy ? <Busy label="Planning the query..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {r && rec ? (
        <div className="stack-sm" style={{ marginTop: 10 }} aria-live="polite">
          <div className="ask-interpretation">
            <strong>{r.interpretation}</strong>
            <div className="muted small">
              Filters applied: {r.plan_summary} &middot; {r.total.toLocaleString()} {r.plan.target.toLowerCase()} match
              {r.plan.target !== "CASES" ? <> &middot; {fmtCompact(r.total_amount)}</> : null}
              {r.total > r.rows.length ? <> &middot; showing {r.rows.length}</> : null}
            </div>
          </div>
          {r.unsupported ? <div className="callout callout-info small">Not covered by the filters: {r.unsupported}</div> : null}
          <div className="table-scroll">
            <AskTable r={r} />
          </div>
          <SourceNote rec={rec} />
        </div>
      ) : null}
    </section>
  );
}

/** Explanation of one day on the activity chart, against a typical day. */
export function DayExplain({ day }: { day: string | null }) {
  const [refresh, setRefresh] = useState(0);
  const data = useAsync<Insight<DayExplanationResult> | null>(() => (day ? api.explainDay(day, refresh > 0) : Promise.resolve(null)), [day, refresh]);
  if (!day) {
    return (
      <p className="muted small day-hint">
        <IconSparkle size={13} /> Click a day on the chart to have Gemini explain what drove it.
      </p>
    );
  }
  const rec = data.data;
  const r = rec?.response.result;
  return (
    <div className="day-explain" aria-live="polite">
      <div className="row-center" style={{ justifyContent: "space-between" }}>
        <h3 className="section-title" style={{ margin: 0 }}>
          <span className="ai-mark"><IconSparkle size={15} /></span> {fmtDay(day)}
        </h3>
        {rec ? (
          <button className="btn btn-small" onClick={() => setRefresh((n) => n + 1)} disabled={data.loading}>
            Re-explain
          </button>
        ) : null}
      </div>
      {data.loading ? <Busy label="Comparing with a typical day..." /> : null}
      {data.error ? <div className="callout callout-error" role="alert">{data.error}</div> : null}
      {r && !data.loading ? (
        <>
          <p style={{ fontWeight: 600, margin: "6px 0 2px" }}>{r.headline}</p>
          <p className="small">{r.explanation}</p>
          {r.drivers.length ? (
            <ul className="ai-list">
              {r.drivers.map((d, i) => (
                <li key={i}>
                  {d.text} <CaseLinks ids={d.case_ids} />
                </li>
              ))}
            </ul>
          ) : null}
          <SourceNote rec={rec!} />
        </>
      ) : null}
    </div>
  );
}
