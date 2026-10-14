import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Empty, ErrorState, Loading, ScoreRing, StatusChip } from "../components/common";
import { IconSearch } from "../components/icons";
import { caseHeadline, fmtAmount, fmtDuration, fmtTime, plural, useAsync } from "../util";

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "OPEN", label: "Open" },
  { value: "ESCALATED", label: "Escalated" },
  { value: "NEEDS_EVIDENCE", label: "Needs evidence" },
  { value: "DISMISSED", label: "Dismissed" },
];

export default function CasesPage() {
  const [band, setBand] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const navigate = useNavigate();
  const list = useAsync(() => api.cases({ risk_band: band || undefined, status: status || undefined, search: applied || undefined }), [band, status, applied]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Cases</h1>
          <p className="muted">Groups of flagged transfers that share accounts within the linking window.</p>
        </div>
      </div>

      <section className="card card-flush" data-tour="cases-table">
        <div className="card-head" style={{ gap: 12 }}>
          <div className="segmented" role="group" aria-label="Filter by status" style={{ margin: 0 }}>
            {STATUS_TABS.map((t) => (
              <button key={t.value} className={status === t.value ? "active" : ""} aria-pressed={status === t.value} onClick={() => setStatus(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
          <form
            className="row-center"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(search.trim());
            }}
          >
            <label className="inline">
              <span className="visually-hidden">Priority</span>
              <select value={band} onChange={(e) => setBand(e.target.value)} aria-label="Filter by priority">
                <option value="">Any priority</option>
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
              </select>
            </label>
            <label className="search-input" style={{ minWidth: 240 }}>
              <IconSearch size={15} />
              <span className="visually-hidden">Search cases</span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Case, account or transaction ID" maxLength={64} />
            </label>
            <button className="btn" type="submit">
              Search
            </button>
          </form>
        </div>

        {list.error ? <div style={{ padding: 18 }}><ErrorState message={list.error} onRetry={list.reload} /></div> : null}
        {list.loading && !list.data ? <Loading label="Loading cases" /> : null}
        {list.data ? (
          list.data.items.length === 0 ? (
            <div style={{ padding: "0 18px 18px" }}>
              <Empty>No cases match these filters.</Empty>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Priority</th>
                    <th scope="col">Case</th>
                    <th scope="col" className="num">Amount moved</th>
                    <th scope="col">Signals</th>
                    <th scope="col">Span</th>
                    <th scope="col">Status</th>
                    <th scope="col">First activity</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((c) => (
                    <tr key={c.case_id} className="row-link" onClick={() => navigate(`/cases/${c.case_id}`)}>
                      <td>
                        <ScoreRing score={c.risk_score} band={c.risk_band} size={42} />
                      </td>
                      <td>
                        <Link to={`/cases/${c.case_id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>
                          {caseHeadline(c.title)}
                        </Link>
                        <div className="muted small">
                          from {c.origin_name ?? "unknown origin"} &middot; <span className="mono">{c.case_id}</span>
                        </div>
                      </td>
                      <td className="num" style={{ fontWeight: 650 }}>
                        {fmtAmount(c.total_amount)}
                        <div className="muted small" style={{ fontWeight: 400 }}>
                          {plural(c.account_count, "account")} &middot; {plural(c.transaction_count, "transfer")}
                        </div>
                      </td>
                      <td>
                        <div className="chip-row">
                          {c.signal_codes.slice(0, 3).map((s) => (
                            <span key={s} className="chip">
                              {s.replace(/_/g, " ").toLowerCase()}
                            </span>
                          ))}
                          {c.signal_codes.length > 3 ? <span className="chip">+{c.signal_codes.length - 3}</span> : null}
                        </div>
                      </td>
                      <td className="small">{fmtDuration(c.first_activity, c.last_activity)}</td>
                      <td>
                        <StatusChip status={c.status} />
                      </td>
                      <td className="small">{fmtTime(c.first_activity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>
    </div>
  );
}
