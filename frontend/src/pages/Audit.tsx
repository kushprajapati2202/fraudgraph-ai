import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Empty, ErrorState, Loading } from "../components/common";
import { ACTOR, describe } from "../components/DecisionPanel";
import { caseHeadline, fmtTime, plural, useAsync, usePageTitle } from "../util";

/** Filter value for events not tied to a case; matches the backend. */
const WORKSPACE = "WORKSPACE";

export default function AuditPage() {
  // The case filter lives in the URL (?case_id=...), so "View history" on a case page lands here pre-filtered.
  const [params, setParams] = useSearchParams();
  const caseId = params.get("case_id") ?? "";
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const resultsRef = useRef<HTMLElement>(null);
  const log = useAsync(() => api.audit({ case_id: caseId || undefined, page, page_size: pageSize }), [caseId, page]);
  usePageTitle("Audit");
  const totalPages = log.data ? Math.max(1, Math.ceil(log.data.total / pageSize)) : 1;
  const pick = (value: string) => {
    setParams(value ? { case_id: value } : {}, { replace: true });
    setPage(1);
  };
  const filtered = caseId && caseId !== WORKSPACE ? log.data?.cases.find((c) => c.case_id === caseId) : undefined;
  const goTo = (p: number) => {
    setPage(p);
    resultsRef.current?.scrollIntoView({ block: "start" });
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Audit</h1>
          <p className="muted">Every system, AI and analyst event recorded in this workspace, newest first.</p>
        </div>
        {caseId && caseId !== WORKSPACE ? (
          <Link to={`/cases/${encodeURIComponent(caseId)}`} className="btn btn-small">
            Back to {filtered?.title ? caseHeadline(filtered.title) : caseId}
          </Link>
        ) : null}
      </div>

      <section className="card card-flush" ref={resultsRef} aria-labelledby="audit-log-heading">
        <div className="card-head" style={{ gap: 12 }}>
          <h2 id="audit-log-heading">
            Audit trail{log.data ? <span className="muted small" style={{ fontWeight: 400 }}> &middot; {plural(log.data.total, "event")}</span> : null}
          </h2>
          <label className="inline">
            <span className="visually-hidden">Case</span>
            <select value={caseId} onChange={(e) => pick(e.target.value)} aria-label="Filter by case" style={{ maxWidth: 360 }}>
              <option value="">All cases</option>
              {log.data?.workspace_events ? <option value={WORKSPACE}>Workspace events (no case) ({log.data.workspace_events})</option> : null}
              {log.data?.cases.map((c) => (
                <option key={c.case_id} value={c.case_id}>
                  {c.title ? caseHeadline(c.title) : "Case"} &middot; {c.case_id} ({c.events})
                </option>
              ))}
            </select>
          </label>
        </div>

        {log.error ? <div style={{ padding: 18 }}><ErrorState message={log.error} onRetry={log.reload} /></div> : null}
        {log.loading && !log.data ? <Loading label="Loading audit trail" /> : null}
        {log.data ? (
          <>
            {log.data.items.length === 0 ? (
              <div style={{ padding: "0 18px 18px" }}>
                {caseId ? (
                  <Empty>
                    No audit events for this filter.{" "}
                    <button className="btn btn-small" onClick={() => pick("")}>
                      Show all cases
                    </button>
                  </Empty>
                ) : (
                  <Empty>No audit events yet.</Empty>
                )}
              </div>
            ) : (
              <ul className="feed" style={{ padding: "0 18px" }}>
                {log.data.items.map((e) => (
                  <li key={e.event_id} className={`feed-${e.actor_type.toLowerCase()}`}>
                    <span className="feed-icon" aria-hidden="true">
                      {ACTOR[e.actor_type].icon}
                    </span>
                    <div>
                      <div>
                        {e.case_id ? (
                          <>
                            <Link to={`/cases/${e.case_id}`} style={{ fontWeight: 600 }}>
                              {e.title ? caseHeadline(e.title) : "Case"}
                            </Link>{" "}
                            <span className="mono small id muted">{e.case_id}</span>
                          </>
                        ) : (
                          <strong>Workspace</strong>
                        )}
                      </div>
                      <div>{describe(e)}</div>
                      <div className="muted small">
                        {ACTOR[e.actor_type].label} &middot; {fmtTime(e.created_at)} UTC
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <nav className="pager" aria-label="Pagination">
              <span className="tnum">
                {log.data.total
                  ? `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, log.data.total).toLocaleString()} of ${log.data.total.toLocaleString()}`
                  : "No results"}{" "}
                &middot; page {page} of {totalPages}
              </span>
              <span className="row-center">
                <button className="btn btn-small" disabled={page <= 1 || log.loading} onClick={() => goTo(page - 1)}>Previous</button>
                <button className="btn btn-small" disabled={page >= totalPages || log.loading} onClick={() => goTo(page + 1)}>Next</button>
              </span>
            </nav>
          </>
        ) : null}
      </section>
    </div>
  );
}
