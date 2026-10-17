import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type AuditEvent } from "../api/client";
import { SecondOpinion } from "../components/ai";
import { ActivityChart, BandMix, HBars } from "../components/charts";
import { AskPortfolio, BriefingCard, DayExplain, PatternsCard } from "../components/DashboardAi";
import { Empty, ErrorState, Loading, ScoreRing, StatusChip } from "../components/common";
import RecommendationsCard from "../components/Recommendations";
import { AskBigQueryCard } from "../components/Cloud";
import { IconCases, IconChevron, IconFlow, IconLock, IconRefresh, IconSparkle, IconTransactions, IconUser } from "../components/icons";
import { usePrefs } from "../prefs";
import { caseHeadline, errorMessage, fmtAmount, fmtCompact, fmtTime, plural, useAsync, usePageTitle } from "../util";

function greeting(name: string): string {
  const h = new Date().getHours();
  const hello = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const first = name.trim().split(/\s+/)[0];
  // "Analyst" is the placeholder until a name is set in Settings; don't greet the placeholder.
  return first && first !== "Analyst" ? `${hello}, ${first}` : hello;
}

type FeedEvent = AuditEvent & { title: string | null };

/** Consecutive identical entries (e.g. repeated retries that failed the same way) are shown once with a count. */
function collapseRepeats(events: FeedEvent[]): { event: FeedEvent; count: number }[] {
  const out: { event: FeedEvent; count: number }[] = [];
  events.forEach((e) => {
    const prev = out[out.length - 1];
    if (prev && prev.event.case_id === e.case_id && prev.event.actor_type === e.actor_type && activityText(prev.event) === activityText(e)) prev.count += 1;
    else out.push({ event: e, count: 1 });
  });
  return out;
}

const DECISION_TEXT: Record<string, string> = {
  ESCALATE_FOR_REVIEW: "escalated",
  DISMISS_ALERT: "dismissed",
  REQUEST_MORE_EVIDENCE: "requested more evidence on",
};

function activityText(e: FeedEvent): string {
  const p = e.event_payload;
  switch (e.event_type) {
    case "ANALYST_DECISION":
      return `${p.actor_label} ${DECISION_TEXT[p.decision] ?? "updated"} a case`;
    case "AI_INVESTIGATION":
      return p.status === "OK" ? "Gemini produced an investigation summary" : `Gemini investigation unavailable (${String(p.reason).replace(/_/g, " ").toLowerCase()})`;
    case "AI_CHAT":
      return p.status === "OK" ? "Gemini answered a follow-up question" : "Gemini follow-up unavailable";
    case "AI_REPORT":
      return p.status === "OK" ? "Gemini drafted an escalation report" : "Escalation report draft unavailable";
    case "AI_BRIEFING":
      return p.source === "GEMINI" ? "Gemini wrote the shift briefing" : "Shift briefing refreshed (rule-based)";
    case "AI_PATTERNS":
      return `${p.source === "GEMINI" ? "Gemini" : "Rules"} grouped active cases into ${p.patterns} pattern${p.patterns === 1 ? "" : "s"}`;
    case "AI_NARRATION":
      return p.source === "GEMINI" ? "Gemini narrated the money flow" : "Money flow narrated (rule-based)";
    case "AI_COUNTERFACTUAL":
      return "Score drivers analysed (what the priority rests on)";
    case "AI_CONTACT_SCRIPT":
      return `Customer contact script drafted for ${p.account_id}`;
    case "AI_STR_DRAFT":
      return p.source === "GEMINI" ? "Gemini drafted an STR for compliance" : "STR draft prepared (rule-based)";
    case "AI_TRANSLATION":
      return p.status === "OK" ? `Investigation summary translated (${p.language})` : "Translation unavailable";
    case "AI_RULE_TUNING":
      return `${p.suggestions} rule-tuning suggestion${p.suggestions === 1 ? "" : "s"} simulated (not applied)`;
    case "MITIGATION_ACTION_APPROVED":
      return `${p.actor_label} approved: ${p.label}`;
    case "MITIGATION_ACTION_CLOSED":
      return `${p.actor_label} ${p.status === "LIFTED" ? "lifted" : "completed"}: ${p.label}`;
    case "TRANSFER_HELD":
      return `Transfer ${p.transaction_id} held (${fmtAmount(p.amount)}): ${p.account_id} is on hold`;
    case "TRANSFER_FLAGGED":
      return `Transfer ${p.transaction_id} flagged: ${p.account_id} is under enhanced monitoring`;
    case "HELD_TRANSFER_RESOLVED":
      return `${p.actor_label} ${p.status === "RELEASED" ? "released" : "rejected"} held transfer ${p.transaction_id}`;
    case "ANALYSIS_RUN":
      return `Analysis ${p.analysis_id} scored ${p.transactions_analyzed} transfers`;
    case "SYNTHETIC_TX_ADDED":
      return `Simulated transfer ${p.transaction_id} added`;
    case "CASE_UPDATED":
      return `Case score changed ${p.score_before} → ${p.score_after}`;
    default:
      return e.event_type;
  }
}

export default function DashboardPage() {
  const dash = useAsync(() => api.dashboard(), []);
  const { analystName } = usePrefs();
  const [windowMin, setWindowMin] = useState(60);
  const [day, setDay] = useState<string | null>(null);
  const [aiKey, setAiKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [recsKey, setRecsKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  usePageTitle("Overview");

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.runAnalysis({ time_window_minutes: windowMin });
      setNotice(`Analysis ${r.analysis_id} complete: ${r.transactions_analyzed.toLocaleString()} transfers scored, ${r.active_cases} active cases.`);
      dash.reload();
      setAiKey((k) => k + 1);
      setRecsKey((k) => k + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (dash.loading && !dash.data) return <Loading label="Loading overview" />;
  if (dash.error) return <ErrorState message={dash.error} onRetry={dash.reload} />;
  const d = dash.data!;
  const t = d.totals;
  const m = d.mitigation;
  const flagRate = t.transactions ? (t.flagged_transactions / t.transactions) * 100 : 0;


  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{greeting(analystName)}</h1>
          <p className="muted">
            {t.open_cases > 0 ? (
              <>
                <strong style={{ color: "var(--text)" }}>{t.open_cases} open {t.open_cases === 1 ? "case needs" : "cases need"} review</strong>
                {d.cases_by_band.HIGH ? `, ${d.cases_by_band.HIGH} at high priority` : ""}.
              </>
            ) : t.cases > 0 ? (
              "All active cases have a recorded decision."
            ) : (
              "No cases yet. Run analysis to score transfers and build cases."
            )}
            {d.last_analysis ? ` Last analysis ${fmtTime(d.last_analysis.created_at)} UTC.` : ""}
          </p>
        </div>
        <div className="row-center" data-tour="dash-actions">
          <label className="inline">
            <span className="label" style={{ margin: 0 }}>
              Linking window
            </span>
            <select value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>
              {[30, 60, 120, 240].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" onClick={run} disabled={busy}>
            <IconRefresh size={15} /> {busy ? "Analysing..." : "Run analysis"}
          </button>
        </div>
      </div>
      {notice ? <div className="callout callout-ok" role="status">{notice}</div> : null}
      {error ? <div className="callout callout-error" role="alert">{error}</div> : null}

      <AskPortfolio />
      <AskBigQueryCard />

      <div className="kpis" data-tour="dash-stats">
        <div className="kpi">
          <span className="kpi-label"><span className="kpi-icon tone-high"><IconCases size={16} /></span> Open cases</span>
          <span className="kpi-value">{t.open_cases}</span>
          <span className="kpi-foot">{t.cases} active &middot; {t.reviewed_cases} reviewed</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><span className="kpi-icon"><IconFlow size={16} /></span> Amount under review</span>
          <span className="kpi-value">{fmtCompact(t.flagged_amount)}</span>
          <span className="kpi-foot">of {fmtCompact(t.total_volume)} monitored</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><span className="kpi-icon"><IconTransactions size={16} /></span> Flagged transfers</span>
          <span className="kpi-value">{t.flagged_transactions}</span>
          <span className="kpi-foot">{flagRate.toFixed(1)}% of {t.transactions.toLocaleString()} transfers</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><span className="kpi-icon tone-low"><IconLock size={16} /></span> Funds held by controls</span>
          <span className="kpi-value">{fmtCompact(m.held.amount)}</span>
          <span className="kpi-foot">
            {plural(m.accounts_on_hold, "account")} on hold &middot; {fmtCompact(m.rejected.amount)} rejected &middot; {plural(m.tasks_open, "open task")}
          </span>
        </div>
      </div>

      <RecommendationsCard refreshKey={recsKey} />

      <div className="grid-main grid-even">
        <section className="card card-flush" aria-labelledby="queue-heading" data-tour="dash-cases">
          <div className="card-head">
            <div>
              <h2 id="queue-heading">Review queue</h2>
              <div className="card-sub">Open cases first, highest priority at the top</div>
            </div>
            <Link to="/cases" className="btn btn-small">
              All cases
            </Link>
          </div>
          {d.recent_cases.length === 0 ? (
            <div style={{ padding: "0 18px 18px" }}>
              <Empty>No cases yet. Run analysis to build the queue.</Empty>
            </div>
          ) : (
            <ul className="queue">
              {d.recent_cases.map((c) => (
                <li key={c.case_id}>
                  <Link to={`/cases/${c.case_id}`} className="queue-item">
                    <ScoreRing score={c.risk_score} band={c.risk_band} size={44} />
                    <span style={{ minWidth: 0 }}>
                      <span className="queue-title" style={{ display: "block" }}>{caseHeadline(c.title)}</span>
                      <span className="queue-meta">
                        <span>from {c.origin_name ?? "unknown origin"}</span>
                        <span>{plural(c.account_count, "account")} &middot; {plural(c.transaction_count, "transfer")}</span>
                        <span className="nowrap">{fmtTime(c.first_activity)} UTC</span>
                      </span>
                    </span>
                    <span className="queue-amount">
                      {fmtAmount(c.total_amount)}
                      <div><StatusChip status={c.status} /></div>
                      <div><SecondOpinion rule={c.risk_band} ai={c.ai_priority} compact /></div>
                    </span>
                    <span className="queue-chevron"><IconChevron size={16} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="queue-foot">
            <h3 id="mix-heading" className="section-title">Cases by priority</h3>
            <BandMix counts={d.cases_by_band} />
            <p className="muted small" style={{ marginTop: 8 }}>
              Bands come from transparent rules (Low 0-29, Medium 30-59, High 60-100). They rank review order and are not fraud probabilities.
            </p>
          </div>
        </section>
        <BriefingCard refreshKey={aiKey} />
      </div>

      <div className="grid-main grid-even">
        <section className="card" aria-labelledby="activity-heading">
          <div className="card-head">
            <div>
              <h2 id="activity-heading">Transfer activity</h2>
              <div className="card-sub">Transfers per day, with the portion flagged for review. Click a day for an AI explanation.</div>
            </div>
          </div>
          <ActivityChart data={d.activity_by_day} selected={day} onSelect={setDay} height={260} />
          <DayExplain day={day} />
        </section>
        <div className="stack">
          <section className="card" aria-labelledby="signals-heading">
            <div className="card-head">
              <div>
                <h2 id="signals-heading">Signals on flagged transfers</h2>
                <div className="card-sub">How often each rule fired</div>
              </div>
            </div>
            <HBars items={d.top_signals.map((s) => ({ key: s.code, label: s.label, value: s.count }))} unit="transfers" />
          </section>
        </div>
      </div>

      <div className="grid-main grid-even">
        <PatternsCard refreshKey={aiKey} />
        <section className="card" aria-labelledby="feed-heading">
          <div className="card-head">
            <h2 id="feed-heading">Recent activity</h2>
          </div>
          {d.recent_activity.length === 0 ? <p className="muted">No activity yet.</p> : null}
          <ul className="feed">
            {collapseRepeats(d.recent_activity).map(({ event: e, count }) => (
              <li key={e.event_id} className={`feed-${e.actor_type.toLowerCase()}`}>
                <span className="feed-icon" aria-hidden="true">
                  {e.actor_type === "AI" ? <IconSparkle size={14} /> : e.actor_type === "HUMAN" ? <IconUser size={14} /> : <IconRefresh size={14} />}
                </span>
                <div>
                  <div>
                    {activityText(e)}
                    {count > 1 ? <span className="feed-repeat" title={`${count} identical entries in a row`}>&times;{count}</span> : null}
                    {e.case_id ? (
                      <>
                        {" "}
                        <Link to={`/cases/${e.case_id}`} className="mono small id">
                          {e.case_id}
                        </Link>
                      </>
                    ) : null}
                  </div>
                  <div className="muted small">
                    {e.actor_type === "AI" ? "AI (advisory)" : e.actor_type === "HUMAN" ? "Analyst" : "System"} &middot; {fmtTime(e.created_at)} UTC
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
