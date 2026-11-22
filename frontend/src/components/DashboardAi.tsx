import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DayExplanationResult, type Insight } from "../api/client";
import { useAiStatus } from "../health";
import { fmtDay, fmtTime, plural, useAsync } from "../util";
import { Busy, CaseLinks, SourceNote, useRun } from "./ai";
import { ErrorState, Loading, RiskBadge } from "./common";
import { IconSparkle } from "./icons";

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
  const autoRefreshed = useRef(false);

  async function ask() {
    if (await run(() => api.makeBriefing())) {
      data.reload();
      ai.recheck();
    }
  }

  // A briefing written before the latest changes would contradict the panels around it, so rewrite it once.
  useEffect(() => {
    if (current?.stale && current.response.source === "GEMINI" && ai.status?.state === "CONNECTED" && !busy && !autoRefreshed.current) {
      autoRefreshed.current = true;
      void ask();
    }
  });

  return (
    <section className="card ai-card briefing" aria-labelledby="briefing-heading" data-tour="dash-briefing">
      <AiHead id="briefing-heading" title="Threat briefing" chip="AI · advisory" />
      {data.loading && !current ? <Loading label="Preparing briefing" /> : null}
      {data.error && !current ? <ErrorState message={data.error} onRetry={data.reload} /> : null}
      {current?.response.result ? (
        <div className="stack-sm" aria-live="polite">
          {current.stale ? (
            <div className="callout callout-warn small" role="status">
              {busy ? "The queue changed after this briefing was written. Updating it now..." : "The queue changed after this briefing was written. Refresh it for current numbers."}
            </div>
          ) : null}
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
            <span className="source-note">
              Last updated {fmtTime(current.created_at)} UTC
              {current.stale ? <span className="chip chip-warn">data changed since</span> : null}
            </span>
            <div className="inline">
              {busy ? <span className="spinner" role="status" aria-label="Updating briefing" /> : null}
              <button className="btn btn-small btn-primary" onClick={ask} disabled={busy}>
                <IconSparkle size={14} /> {busy ? "Updating..." : current.response.source === "GEMINI" ? "Refresh" : "Write with Gemini"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {busy && !current?.response.result ? <Busy label="Gemini is reading the queue..." /> : null}
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
            <span className="source-note">
              Last updated {fmtTime(current!.created_at)} UTC
              {current!.stale ? <span className="chip chip-warn">data changed since</span> : null}
            </span>
            <div className="inline">
              {busy ? <span className="spinner" role="status" aria-label="Updating patterns" /> : null}
              <button className="btn btn-small btn-primary" onClick={async () => { if (await run(() => api.makePatterns())) data.reload(); }} disabled={busy}>
                <IconSparkle size={14} /> {busy ? "Updating..." : current!.response.source === "GEMINI" ? "Refresh" : "Analyse with Gemini"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {busy && !r ? <Busy label="Embedding case behaviour and naming patterns..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
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
