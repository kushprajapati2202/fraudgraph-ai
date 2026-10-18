import { Link } from "react-router-dom";
import { api, type RedTeamAttack } from "../api/client";
import { Busy, SourceNote, useRun } from "../components/ai";
import { ErrorState, Loading, RiskBadge } from "../components/common";
import { IconSparkle } from "../components/icons";
import { useAiStatus } from "../health";
import { fmtAmount, useAsync, usePageTitle } from "../util";

function minutes(m: number): string {
  return m >= 120 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)} h` : `${m} min`;
}

function AttackCard({ a, threshold }: { a: RedTeamAttack; threshold: number }) {
  return (
    <article className={`card rt-card ${a.caught ? "rt-caught" : "rt-evaded"}`} aria-label={`${a.name}: ${a.caught ? "caught" : "evaded"}`}>
      <div className="rt-head">
        <div>
          <span className={`rt-verdict ${a.caught ? "good" : "bad"}`}>{a.caught ? "Caught" : "Evaded the rules"}</span>
          <h2 style={{ margin: "2px 0 0" }}>{a.name}</h2>
        </div>
        <RiskBadge band={a.band} score={a.max_score} />
      </div>
      {a.idea ? <p className="small" style={{ margin: 0 }}>{a.idea}</p> : null}
      <p className="small muted" style={{ margin: 0 }}>
        {a.amount_text} through {a.accounts} accounts in {a.transfers} transfers over {minutes(a.duration_minutes)}. Highest score {a.max_score}
        {a.caught ? `, ${a.flagged} transfer${a.flagged === 1 ? "" : "s"} would open a case.` : `, below the case threshold of ${threshold}.`}
      </p>
      <dl className="rt-params small">
        <dt>Feeders into the mule</dt>
        <dd>{a.feeders} × {fmtAmount(a.amount_each)}</dd>
        <dt>Feeder spacing</dt>
        <dd>{minutes(a.feeder_gap_minutes)}</dd>
        <dt>Hops after the mule</dt>
        <dd>{a.layers}, split {a.split} way{a.split === 1 ? "" : "s"}</dd>
        <dt>Wait at each hop</dt>
        <dd>{minutes(a.hop_gap_minutes)}, moving {Math.round(a.onward_share * 100)}%</dd>
      </dl>
      <div className="small">
        <span className="muted">Rules that fired: </span>
        {a.signals.length ? a.signals.map((s) => <span key={s.code} className="chip" style={{ marginRight: 4 }}>{s.label}</span>) : <span className="muted">none</span>}
      </div>
      {a.fix ? (
        <div className="rt-fix small">
          <strong>Smallest fix found:</strong> {a.fix.label} {a.fix.current_value} &rarr; <strong>{a.fix.proposed_value}</strong> {a.fix.unit === "share" ? "" : a.fix.unit}.
          <div>
            The pattern would then score {a.fix.score_after} ({a.fix.band_after.toLowerCase()}). On the existing history it adds{" "}
            <strong>{a.fix.new_alerts}</strong> alert{a.fix.new_alerts === 1 ? "" : "s"}
            {a.fix.new_alerts ? `, ${a.fix.new_alerts_on_suspicious} of them on labelled suspicious transfers` : ""}.
          </div>
        </div>
      ) : !a.caught ? (
        <div className="rt-fix small">No single rule change in the tested set catches this pattern. It needs a new rule.</div>
      ) : null}
    </article>
  );
}

/** Gemini designs patterns meant to slip under the rules; the real engine scores them and fixes are simulated. */
export default function RedTeamPage() {
  usePageTitle("Red team");
  const data = useAsync(() => api.redTeam(), []);
  const { busy, error, run } = useRun();
  const ai = useAiStatus();
  const rec = data.data;
  const r = rec?.response.result;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Red team</h1>
          <p className="muted">
            Gemini plays the fraudster and designs money-mule patterns meant to stay under the rules. The real rule engine scores each one
            next to the live history, and for every pattern that gets through it simulates the smallest rule change that would catch it.
          </p>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => api.makeRedTeam())) { data.reload(); ai.recheck(); } }}>
          <IconSparkle size={14} /> {busy ? "Attacking..." : "Run a new attack with Gemini"}
        </button>
      </div>
      {busy ? <Busy label="Gemini is designing patterns; the engine scores each one and searches for fixes..." /> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
      {data.loading && !rec ? <Loading label="Scoring patterns" /> : null}
      {data.error && !rec ? <ErrorState message={data.error} onRetry={data.reload} /> : null}
      {r && rec ? (
        <>
          <section className="card" aria-live="polite">
            <div className="row-center" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
              <div>
                <div className="kpi-value tnum" style={{ color: r.evaded ? "var(--high)" : "var(--low)" }}>
                  {r.evaded} of {r.tested}
                </div>
                <div className="small muted">patterns evaded the current rules ({r.history_transfers.toLocaleString("en-IN")} transfers of history)</div>
              </div>
              <p className="ai-summary" style={{ maxWidth: 560, margin: 0 }}>{r.summary}</p>
            </div>
            <div className="row-center ai-foot">
              <SourceNote rec={rec} />
            </div>
          </section>
          <div className="rt-grid">
            {r.attacks.map((a, i) => <AttackCard key={i} a={a} threshold={r.case_threshold_score} />)}
          </div>
          <p className="muted small">
            {r.note} Rules change only through a reviewed rule-version release; compare with the{" "}
            <Link to="/settings">rule tuning suggestions</Link> in Settings. Gemini only chooses numbers within fixed bounds; the transfers are
            built and scored by code.
          </p>
        </>
      ) : null}
    </div>
  );
}
