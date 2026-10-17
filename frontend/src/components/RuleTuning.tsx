import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAiStatus } from "../health";
import { useAsync } from "../util";
import { Busy, SourceNote, useRun } from "./ai";
import { ErrorState, Loading } from "./common";
import { IconSparkle } from "./icons";

function Delta({ before, after, unit }: { before: number; after: number; unit: string }) {
  const d = after - before;
  return (
    <span className="tnum">
      {before} &rarr; <strong>{after}</strong> {unit}{" "}
      <span className={d < 0 ? "cf-down" : d > 0 ? "cf-up" : "cf-flat"}>{d === 0 ? "±0" : d > 0 ? `+${d}` : d}</span>
    </span>
  );
}

/** Threshold suggestions from analyst outcomes, each simulated on the current data. Nothing is applied. */
export default function RuleTuningCard() {
  const data = useAsync(() => api.ruleTuning(), []);
  const { busy, error, run } = useRun();
  const ai = useAiStatus();
  const rec = data.data;
  const r = rec?.response.result;

  return (
    <section className="card ai-card" aria-labelledby="tuning-heading">
      <div className="card-head">
        <div>
          <h2 id="tuning-heading">
            <span className="ai-mark"><IconSparkle size={17} /></span> Rule tuning suggestions
          </h2>
          <div className="card-sub">Learned from analyst decisions, simulated before you see them, never applied automatically</div>
        </div>
        <span className="chip chip-ai">AI · simulated</span>
      </div>
      {data.loading && !rec ? <Loading label="Simulating thresholds" /> : null}
      {data.error && !rec ? <ErrorState message={data.error} onRetry={data.reload} /> : null}
      {r && rec ? (
        <div className="stack-sm" aria-live="polite">
          <p className="ai-summary">{r.summary}</p>
          {r.suggestions.length === 0 ? <p className="muted small">No change is suggested for the current data.</p> : null}
          <ul className="tuning-list">
            {r.suggestions.map((s) => (
              <li key={s.parameter} className="tuning">
                <div className="tuning-head">
                  <strong>{s.rule_label}</strong>
                  <span className="mono small">
                    {s.parameter}: {s.current_value} &rarr; <strong>{s.proposed_value}</strong>
                  </span>
                </div>
                <div className="small muted">{s.meaning}.</div>
                <p className="small" style={{ margin: "6px 0" }}>{s.rationale}</p>
                <div className="tuning-impact small">
                  <span>Flagged transfers: <Delta before={s.impact.flagged_before} after={s.impact.flagged_after} unit="" /></span>
                  <span>Cases: <Delta before={s.impact.cases_before} after={s.impact.cases_after} unit="" /></span>
                  {s.impact.dismissed_cases_cleared.length ? <span className="ok-text">{s.impact.dismissed_cases_cleared.length} dismissed case(s) would no longer alert</span> : null}
                  {s.impact.escalated_cases_lost.length ? (
                    <span className="bad-text">
                      Would miss escalated: {s.impact.escalated_cases_lost.map((id) => <Link key={id} to={`/cases/${id}`} className="mono">{id} </Link>)}
                    </span>
                  ) : null}
                  {s.impact.open_cases_cleared.length ? <span className="muted">{s.impact.open_cases_cleared.length} open case(s) would drop out of the queue</span> : null}
                </div>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Based on {r.decided_cases} analyst decision{r.decided_cases === 1 ? "" : "s"}. {r.note}
          </p>
          <div className="row-center ai-foot">
            <SourceNote rec={rec} />
            <button className="btn btn-small btn-primary" disabled={busy} onClick={async () => { if (await run(() => api.makeRuleTuning())) { data.reload(); ai.recheck(); } }}>
              <IconSparkle size={14} /> {busy ? "Simulating..." : "Suggest with Gemini"}
            </button>
          </div>
        </div>
      ) : null}
      {busy ? <Busy label="Gemini is proposing changes; each one is simulated on the data..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
    </section>
  );
}
