import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { ControlTag, Empty, ErrorState, Loading, Party, RiskBadge, SyntheticTag } from "../components/common";
import { useInspector } from "../components/Inspector";
import { fmtAmount, fmtTime, useAsync } from "../util";

type Filters = {
  q: string;
  account_id: string;
  from: string;
  to: string;
  min_amount: string;
  max_amount: string;
  channel: string;
  risk_band: string;
  synthetic_only: boolean;
};

const EMPTY: Filters = { q: "", account_id: "", from: "", to: "", min_amount: "", max_amount: "", channel: "", risk_band: "", synthetic_only: false };
type SortKey = "timestamp" | "amount" | "score" | "transaction_id";

export default function TransactionsPage() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<SortKey>("timestamp");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const { openTransaction, openAccount } = useInspector();

  const list = useAsync(
    () =>
      api.transactions({
        ...filters,
        account_id: filters.account_id.trim().toUpperCase() || undefined,
        synthetic_only: filters.synthetic_only || undefined,
        sort,
        order,
        page,
        page_size: pageSize,
      }),
    [filters, sort, order, page],
  );

  function apply(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setFilters(draft);
  }

  function toggleSort(key: SortKey) {
    if (sort === key) setOrder(order === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setOrder("desc");
    }
    setPage(1);
  }

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / pageSize)) : 1;
  const sortHeader = (key: SortKey, label: string, cls = "") => (
    <th scope="col" className={cls} aria-sort={sort === key ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button className="th-button" onClick={() => toggleSort(key)}>
        {label} {sort === key ? (order === "asc" ? "↑" : "↓") : ""}
      </button>
    </th>
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <p className="muted">Every monitored transfer with its rule-based priority score.</p>
        </div>
      </div>
      <form className="card filters" onSubmit={apply} aria-label="Transaction filters" data-tour="tx-filters">
        <label><span className="label">Search</span><input value={draft.q} onChange={set("q")} placeholder="Name, ID, reference, remarks" maxLength={64} /></label>
        <label><span className="label">Account ID</span><input value={draft.account_id} onChange={set("account_id")} placeholder="AC-101" /></label>
        <label><span className="label">From</span><input type="date" value={draft.from} onChange={set("from")} /></label>
        <label><span className="label">To</span><input type="date" value={draft.to} onChange={set("to")} /></label>
        <label><span className="label">Min amount</span><input type="number" min={0} value={draft.min_amount} onChange={set("min_amount")} /></label>
        <label><span className="label">Max amount</span><input type="number" min={0} value={draft.max_amount} onChange={set("max_amount")} /></label>
        <label>
          <span className="label">Channel</span>
          <select value={draft.channel} onChange={set("channel")}>
            <option value="">Any</option>
            {["UPI", "IMPS", "NEFT", "CARD", "WALLET"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>
          <span className="label">Priority</span>
          <select value={draft.risk_band} onChange={set("risk_band")}>
            <option value="">Any</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft.synthetic_only} onChange={(e) => setDraft({ ...draft, synthetic_only: e.target.checked })} />
          Simulated only
        </label>
        <div className="row">
          <button className="btn btn-primary" type="submit">Apply filters</button>
          <button className="btn btn-ghost" type="button" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); setPage(1); }}>Clear</button>
        </div>
      </form>

      {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading label="Loading transactions" /> : null}
      {list.data ? (
        <section className="card card-flush">
          <div className="card-head">
            <h2>{list.data.total.toLocaleString()} transfers</h2>
            {list.loading ? <span className="spinner" aria-label="Refreshing" /> : null}
          </div>
          {list.data.items.length === 0 ? (
            <div style={{ padding: "0 18px 18px" }}><Empty>No transfers match these filters.</Empty></div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    {sortHeader("timestamp", "Time")}
                    <th scope="col">From</th>
                    <th scope="col">To</th>
                    {sortHeader("amount", "Amount", "num")}
                    <th scope="col">Channel</th>
                    {sortHeader("transaction_id", "Reference")}
                    {sortHeader("score", "Priority")}
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((t) => (
                    <tr key={t.transaction_id}>
                      <td className="small tnum" style={{ whiteSpace: "nowrap" }}>{fmtTime(t.timestamp)}</td>
                      <td><Party name={t.source_name} id={t.source_account} onClick={() => openAccount(t.source_account)} /></td>
                      <td><Party name={t.destination_name} id={t.destination_account} onClick={() => openAccount(t.destination_account)} /></td>
                      <td className="num" style={{ fontWeight: 650 }}>{fmtAmount(t.amount, t.currency)}</td>
                      <td><span className="chip" style={{ marginLeft: 0 }}>{t.channel}</span></td>
                      <td>
                        <button className="link-button mono" onClick={() => openTransaction(t.transaction_id)}>{t.transaction_id}</button>
                        {t.is_synthetic_added ? <SyntheticTag /> : null}
                        <ControlTag status={t.control_status} />
                        <div className="muted small mono">{t.reference ?? ""}</div>
                      </td>
                      <td><RiskBadge band={t.risk_band} score={t.score} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav className="pager" aria-label="Pagination">
            <span>Page {page} of {totalPages}</span>
            <span className="row-center">
              <button className="btn btn-small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="btn btn-small" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
            </span>
          </nav>
        </section>
      ) : null}
    </div>
  );
}
