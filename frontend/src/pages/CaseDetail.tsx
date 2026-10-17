import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { AccountControlTags, Avatar, ControlTag, ErrorState, Loading, RiskBadge, ScoreRing, StatusChip, SyntheticTag } from "../components/common";
import { Busy, SecondOpinion, SourceNote, useRun } from "../components/ai";
import { CounterfactualCard, StrDraftCard } from "../components/CaseAssist";
import { DecisionPanel } from "../components/DecisionPanel";
import DocumentPanel from "../components/Documents";
import EvidenceList from "../components/EvidenceList";
import { useInspector } from "../components/Inspector";
import InvestigatorPanel from "../components/InvestigatorPanel";
import { ActionsPanel, ReportPanel } from "../components/Mitigation";
import SimilarCases from "../components/SimilarCases";
import { CaseMlCard, CaseMlChip, PolicyCard } from "../components/Cloud";
import NetworkGraph from "../graph/NetworkGraph";
import { IconClock, IconSparkle } from "../components/icons";
import { useHealth } from "../health";
import { caseHeadline, fmtAmount, fmtDuration, fmtTime, useAsync, usePageTitle } from "../util";

export default function CaseDetailPage() {
  const { caseId = "" } = useParams();
  const detail = useAsync(() => api.case(caseId), [caseId]);
  const graph = useAsync(() => api.graph({ case_id: caseId }), [caseId]);
  const health = useHealth();
  const { openTransaction, openEvidence, openAccount } = useInspector();
  const [pathId, setPathId] = useState<string>("");
  const [playToken, setPlayToken] = useState(0);
  const narrating = useRun();

  const paths = graph.data?.paths ?? [];
  const highlight = useMemo(() => paths.find((p) => p.evidence_id === pathId)?.transaction_ids ?? [], [paths, pathId]);
  const evidenceById = useMemo(() => new Map((detail.data?.evidence ?? []).map((e) => [e.evidence_id, e])), [detail.data]);
  const narration = detail.data?.ai_extras.NARRATION;
  const captions = useMemo(
    () => Object.fromEntries((narration?.response.result?.steps ?? []).map((s) => [s.transaction_id, s.caption])),
    [narration],
  );
  usePageTitle(detail.data ? `${caseId} · ${caseHeadline(detail.data.case.title)}` : caseId);

  if (detail.loading && !detail.data) return <Loading label="Loading case" />;
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  const d = detail.data!;
  const c = d.case;
  const refresh = () => detail.reload();
  const firstTs = c.first_activity;
  const narrated = narration?.response.result;

  async function narrate() {
    if (await narrating.run(() => api.narrate(c.case_id))) {
      await detail.reload();
      setPlayToken((n) => n + 1);
    }
  }

  return (
    <div className="stack">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/cases">Cases</Link> <span aria-hidden="true">/</span> <span className="mono">{c.case_id}</span>
      </nav>

      <header className="card case-hero" data-tour="case-header">
        <ScoreRing score={c.risk_score} band={c.risk_band} size={84} />
        <div className="case-hero-main">
          <h1>{caseHeadline(c.title)}</h1>
          <p style={{ marginTop: 2 }}>
            Originating from{" "}
            {c.origin_account ? (
              <button className="link-button" onClick={() => openAccount(c.origin_account!)}>
                {c.origin_name ?? c.origin_account}
              </button>
            ) : (
              "an unknown account"
            )}
          </p>
          <p className="muted small" style={{ marginTop: 4 }}>
            <span className="mono id">{c.case_id}</span> &middot; {c.rule_version} &middot; analysis {c.analysis_id}
            {!c.active ? " · no longer flagged by the latest analysis" : ""}
          </p>
          <nav className="subnav" aria-label="Sections" style={{ marginTop: 10 }}>
            <a href="#sec-graph">Graph</a>
            <a href="#sec-accounts">Accounts</a>
            <a href="#sec-signals">Signals</a>
            <a href="#sec-drivers">Score drivers</a>
            <a href="#sec-similar">Similar cases</a>
            <a href="#sec-timeline">Timeline</a>
            <a href="#sec-evidence">Evidence</a>
            <a href="#sec-str">Regulatory report</a>
          </nav>
        </div>
        <div className="case-hero-side">
          <Link to={`/audit?case_id=${encodeURIComponent(c.case_id)}`} className="btn btn-small" data-tour="case-audit" title="Open this case's full audit trail">
            <IconClock size={14} /> View history ({d.audit_events.length})
          </Link>
          <StatusChip status={c.status} />
          <SecondOpinion rule={c.risk_band} ai={d.latest_investigation?.response.result?.review_priority} />
          <CaseMlChip caseId={c.case_id} />
          <p className="small muted">The score ranks review priority. It is not a probability of fraud or a finding against anyone.</p>
        </div>
      </header>

      <div className="stats">
        <div className="stat"><span className="stat-label">Amount moved</span><span className="stat-value">{fmtAmount(c.total_amount)}</span></div>
        <div className="stat"><span className="stat-label">Accounts</span><span className="stat-value">{c.accounts.length}</span></div>
        <div className="stat"><span className="stat-label">Transfers</span><span className="stat-value">{c.transaction_ids.length}</span></div>
        <div className="stat"><span className="stat-label">Time span</span><span className="stat-value">{fmtDuration(c.first_activity, c.last_activity)}</span></div>
        <div className="stat"><span className="stat-label">First activity</span><span className="stat-value">{fmtTime(firstTs)}</span></div>
      </div>

      {/* The money-flow graph is the centrepiece of the case: full width, above everything else. */}
          <section className="card graph-hero" aria-labelledby="graph-heading" data-tour="case-graph" id="sec-graph">
            <div className="card-head">
              <div>
                <h2 id="graph-heading">Money flow</h2>
                <div className="card-sub">Each arrow is one transfer. Click an arrow for the record, or an account for its profile.</div>
              </div>
              <div className="row-center">
              <button className="btn btn-small btn-ai" onClick={narrate} disabled={narrating.busy} title="Gemini writes a caption for each step, then the flow replays">
                <IconSparkle size={14} /> {narrating.busy ? "Narrating..." : narrated ? "Replay narrated flow" : "Narrate flow"}
              </button>
              {paths.length ? (
                <label className="inline">
                  <span className="label" style={{ margin: 0 }}>Trace path</span>
                  <select value={pathId} onChange={(e) => setPathId(e.target.value)}>
                    <option value="">None</option>
                    {paths.map((p) => (
                      <option key={p.evidence_id} value={p.evidence_id}>
                        {p.evidence_id}: {p.accounts.length} accounts, {p.duration_minutes} min
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              </div>
            </div>
            {narrating.busy ? <Busy label="Gemini is narrating the flow..." /> : null}
            {narrating.error ? <div className="callout callout-error" role="alert">{narrating.error}</div> : null}
            {narrated && narration ? (
              <div className="narration" aria-live="polite">
                <span className="ai-mark"><IconSparkle size={15} /></span>
                <div>
                  <div>{narrated.overview}</div>
                  <div className="small muted">{narrated.takeaway}</div>
                  <SourceNote rec={narration} />
                </div>
              </div>
            ) : null}
            {graph.loading && !graph.data ? <Loading label="Loading graph" /> : null}
            {graph.error ? <ErrorState message={graph.error} onRetry={graph.reload} /> : null}
            {graph.data ? (
              <>
                <NetworkGraph data={graph.data} highlightTxIds={highlight} height={520} onEdgeClick={openTransaction} onNodeClick={openAccount} captions={captions} playToken={playToken} />
                {pathId && evidenceById.get(pathId) ? (
                  <button className="link-button small" onClick={() => openEvidence(evidenceById.get(pathId)!)}>
                    Open {pathId} as evidence
                  </button>
                ) : null}
              </>
            ) : null}
          </section>

      <div className="case-grid">
        <div className="stack">
          <section className="card" aria-labelledby="accounts-heading" id="sec-accounts">
            <div className="card-head">
              <h2 id="accounts-heading">Accounts involved ({c.accounts.length})</h2>
            </div>
            <ul className="acct-list">
              {c.accounts.map((id) => {
                const a = d.accounts[id];
                const days = a && firstTs ? Math.round((new Date(firstTs).getTime() - new Date(a.created_at).getTime()) / 86400000) : null;
                return (
                  <li key={id}>
                    <button className="acct-card" onClick={() => openAccount(id)}>
                      <Avatar name={a?.holder_name ?? id} type={a?.account_type} />
                      <span className="acct-text">
                        <span className="party-name">{a?.holder_name ?? "Unknown holder"}</span>
                        <span className="party-id">
                          <span className="mono id">{id}</span> &middot; {a?.city ?? "unknown"}
                        </span>
                        {d.account_controls[id]?.length || (days !== null && days >= 0 && days <= 30) ? (
                          <span className="chip-row">
                            <AccountControlTags controls={d.account_controls[id]} />
                            {days !== null && days >= 0 && days <= 30 ? (
                              <span className="chip chip-warn" title="Account opened shortly before this activity">
                                opened {days === 0 ? "the same day" : `${days} ${days === 1 ? "day" : "days"} earlier`}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card card-flush" aria-labelledby="signals-heading" data-tour="case-signals" id="sec-signals">
            <div className="card-head">
              <div>
                <h2 id="signals-heading">Why this was flagged</h2>
                <div className="card-sub">Each rule's largest contribution to a transfer's score</div>
              </div>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Signal</th>
                    <th scope="col">Contribution</th>
                    <th scope="col">Transfers</th>
                    <th scope="col">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {d.signal_summary.map((s) => (
                    <tr key={s.code}>
                      <td style={{ fontWeight: 600 }}>{s.label}</td>
                      <td>
                        <span className="meter" aria-hidden="true">
                          <span style={{ width: `${(s.max_contribution / s.weight) * 100}%` }} />
                        </span>{" "}
                        <span className="tnum">+{s.max_contribution} of {s.weight}</span>
                      </td>
                      <td className="tnum">{s.transactions}</td>
                      <td>{s.context_only ? <span className="chip chip-context" style={{ marginLeft: 0 }}>context only</span> : <span className="chip" style={{ marginLeft: 0 }}>risk signal</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.uncertainties.length ? (
              <div style={{ padding: 18 }}>
                <div className="callout callout-info">
                  <strong>What we don't know</strong>
                  <ul>
                    {d.uncertainties.slice(0, 3).map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                  {d.uncertainties.length > 3 ? (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: "pointer", fontWeight: 600 }}>{d.uncertainties.length - 3} more</summary>
                      <ul>
                        {d.uncertainties.slice(3).map((u) => (
                          <li key={u}>{u}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          <CounterfactualCard detail={d} onChanged={refresh} />

          <SimilarCases caseId={c.case_id} catalog={d.action_catalog} />
          <PolicyCard caseId={c.case_id} />
          <CaseMlCard caseId={c.case_id} />

          <section className="card card-flush" aria-labelledby="timeline-heading" id="sec-timeline">
            <div className="card-head">
              <h2 id="timeline-heading">Transfer timeline</h2>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">From &rarr; To</th>
                    <th scope="col" className="num">Amount &middot; priority</th>
                    <th scope="col">Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {d.transactions.map((t) => (
                    <tr key={t.transaction_id}>
                      <td className="small nowrap">
                        <span className="tnum">{fmtTime(t.timestamp).slice(5)}</span>
                        <div>
                          <button className="link-button mono small" onClick={() => openTransaction(t.transaction_id)}>
                            {t.transaction_id}
                          </button>
                          {t.is_synthetic_added ? <SyntheticTag /> : null}
                          <ControlTag status={t.control_status} />
                        </div>
                      </td>
                      <td style={{ minWidth: 200 }}>
                        <button className="link-button" style={{ color: "inherit" }} onClick={() => openAccount(t.source_account)}>
                          {t.source_name ?? t.source_account}
                        </button>
                        <span className="muted" aria-hidden="true"> &rarr; </span>
                        <button className="link-button" style={{ color: "inherit" }} onClick={() => openAccount(t.destination_account)}>
                          {t.destination_name ?? t.destination_account}
                        </button>
                        <div className="muted small mono">
                          {t.source_account} &rarr; {t.destination_account} &middot; {t.channel}
                        </div>
                      </td>
                      <td className="num">
                        <span className="amount-cell">
                          <strong>{fmtAmount(t.amount, t.currency)}</strong>
                          <RiskBadge band={t.risk_band} score={t.score} />
                        </span>
                      </td>
                      <td>
                        <div className="chip-row">
                          {t.signals.map((s) => {
                            const ev = evidenceById.get(`EV-SIG-${t.transaction_id}-${s.code}`);
                            return (
                              <button key={s.code} className={`chip chip-button signal-chip ${s.context_only ? "chip-context" : ""}`} onClick={() => ev && openEvidence(ev)} title={s.explanation}>
                                {s.label} +{s.contribution}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div id="sec-evidence">
            <EvidenceList evidence={d.evidence} />
          </div>

          <StrDraftCard detail={d} onChanged={refresh} />
        </div>

        <div className="stack">
          <InvestigatorPanel
            caseId={c.case_id}
            evidence={d.evidence}
            latest={d.latest_investigation}
            chats={d.chat_history}
            geminiConfigured={health?.gemini_configured ?? null}
            ruleBand={c.risk_band}
            translation={d.ai_extras.TRANSLATION}
            onChanged={refresh}
          />
          <DocumentPanel detail={d} onChanged={refresh} />
          <ActionsPanel detail={d} onChanged={refresh} />
          <DecisionPanel caseId={c.case_id} status={c.status} decisions={d.decisions} onSaved={refresh} />
          <ReportPanel detail={d} onChanged={refresh} />
        </div>
      </div>
    </div>
  );
}
