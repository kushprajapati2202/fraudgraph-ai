import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type AnalysisRun, type TransactionDetail } from "../api/client";
import { ControlTag, ErrorState, RiskBadge } from "../components/common";
import { useInspector } from "../components/Inspector";
import { errorMessage, useAsync, usePageTitle } from "../util";

interface Form {
  source_account: string;
  destination_account: string;
  amount: string;
  timestamp: string;
  channel: string;
  device_id: string;
  description: string;
}

const EMPTY: Form = { source_account: "", destination_account: "", amount: "", timestamp: "", channel: "IMPS", device_id: "", description: "" };

export default function WhatIfPage() {
  const scen = useAsync(() => api.scenarios(), []);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<TransactionDetail | null>(null);
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const { openTransaction } = useInspector();
  usePageTitle("Simulator");

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  function applySuggestion() {
    const s = scen.data?.suggested_what_if;
    if (!s) return;
    setForm({
      source_account: s.source_account,
      destination_account: s.destination_account,
      amount: String(s.amount),
      timestamp: s.timestamp.slice(0, 16),
      channel: s.channel,
      device_id: "",
      description: s.description,
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setAdded(null);
    setRun(null);
    try {
      const body: Record<string, unknown> = {
        source_account: form.source_account.trim().toUpperCase(),
        destination_account: form.destination_account.trim().toUpperCase(),
        amount: Number(form.amount),
        channel: form.channel,
      };
      if (form.timestamp) body.timestamp = form.timestamp.length === 16 ? `${form.timestamp}:00` : form.timestamp;
      if (form.device_id.trim()) body.device_id = form.device_id.trim().toUpperCase();
      if (form.description.trim()) body.description = form.description.trim();
      const created = await api.addSyntheticTransaction(body);
      setAdded(created);
      const analysis = await api.runAnalysis({});
      setRun(analysis);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const diff = run?.diff;
  const newTx = added?.transaction.transaction_id;
  const newTxChange = diff?.changed_transactions.find((c) => c.transaction_id === newTx);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Simulator</h1>
          <p className="muted">
            Test how the detection rules and your approved controls respond to a hypothetical transfer. The simulated transfer is scored live with the same rules,
            and it is held if either account is on hold. It never creates or changes a real payment, and a new transfer by itself does not prove fraud.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <form className="card stack-sm" onSubmit={submit} aria-label="Simulated transfer" data-tour="whatif-form">
          <div className="card-head">
            <h2>Simulated transfer</h2>
            {scen.data?.suggested_what_if ? (
              <button type="button" className="btn btn-small" onClick={applySuggestion}>
                Use suggested transfer
              </button>
            ) : null}
          </div>
          {scen.data?.suggested_what_if ? <p className="muted small">Suggestion: {scen.data.suggested_what_if.label}.</p> : null}
          {scen.error ? <ErrorState message={scen.error} onRetry={scen.reload} /> : null}
          <div className="form-grid">
            <label>
              <span className="label">Source account</span>
              <input required value={form.source_account} onChange={set("source_account")} placeholder="AC-101" pattern="[Aa][Cc]-\d{3,4}" title="Account ID such as AC-101" />
            </label>
            <label>
              <span className="label">Destination account</span>
              <input required value={form.destination_account} onChange={set("destination_account")} placeholder="AC-901" pattern="[Aa][Cc]-\d{3,4}" title="Account ID such as AC-901" />
              <span className="field-help">AC-900 to AC-999 act as a brand-new beneficiary.</span>
            </label>
            <label>
              <span className="label">Amount (₹)</span>
              <input required type="number" inputMode="decimal" min={1} max={10000000} step="0.01" placeholder="e.g. 56000" value={form.amount} onChange={set("amount")} />
            </label>
            <label>
              <span className="label">Timestamp</span>
              <input type="datetime-local" value={form.timestamp} onChange={set("timestamp")} />
              <span className="field-help">Leave empty to place it 5 minutes after the latest transfer.</span>
            </label>
            <label>
              <span className="label">Channel</span>
              <select value={form.channel} onChange={set("channel")}>
                {["UPI", "IMPS", "NEFT", "CARD", "WALLET"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label><span className="label">Device ID (optional)</span><input value={form.device_id} onChange={set("device_id")} placeholder="DEV-6602" /></label>
          </div>
          <label><span className="label">Remarks (optional)</span><input value={form.description} maxLength={300} onChange={set("description")} /></label>
          {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Simulating..." : "Simulate and re-run analysis"}
          </button>
        </form>

        <section className="card" aria-live="polite" aria-labelledby="result-heading">
          <div className="card-head"><h2 id="result-heading">What changed</h2></div>
          {!run && !busy && !added ? (
            <ol className="empty-steps">
              <li>
                <span className="step-num">1</span>
                <span>Describe a transfer on the left, or use the suggested one.</span>
              </li>
              <li>
                <span className="step-num">2</span>
                <span>It is scored with the live rules. If an account is on hold, the transfer is stopped before it moves.</span>
              </li>
              <li>
                <span className="step-num">3</span>
                <span>Analysis re-runs and this panel shows which cases and signals changed, before and after.</span>
              </li>
            </ol>
          ) : null}
          {busy ? (
            <div className="state state-loading" role="status">
              <span className="spinner" aria-hidden="true" /> {added ? "Re-running analysis..." : "Adding the simulated transfer..."}
            </div>
          ) : null}
          {added ? (
            <p>
              Added{" "}
              <button className="link-button mono" onClick={() => openTransaction(added.transaction.transaction_id)}>
                {added.transaction.transaction_id}
              </button>{" "}
              <span className="chip chip-synthetic">SIMULATED</span>
              <ControlTag status={added.control?.status} />
            </p>
          ) : null}
          {added?.control ? (
            <div className={`callout ${added.control.status === "HELD" ? "callout-warn" : "callout-info"}`} role="status" style={{ marginBottom: 10 }}>
              {added.control.status === "HELD" ? (
                <>
                  <strong>Transfer held. The money did not move.</strong> <span className="mono">{added.control.account_id}</span> is on hold, so this transfer is
                  waiting for an analyst to release or reject it.
                </>
              ) : (
                <>
                  <strong>Transfer flagged.</strong> <span className="mono">{added.control.account_id}</span> is under enhanced monitoring, so this transfer was
                  sent for review whatever its score.
                </>
              )}{" "}
              <Link to={`/cases/${added.control.case_id}`}>Open case {added.control.case_id}</Link>
            </div>
          ) : null}
          {run && diff ? (
            <div className="stack-sm">
              <p className="small muted">Analysis {run.analysis_id} ({run.rule_version}) re-scored {run.transactions_analyzed} transactions.</p>
              {newTxChange ? (
                <p>
                  New transfer scored <RiskBadge band={newTxChange.band_after} score={newTxChange.score_after} /> with signals:{" "}
                  {newTxChange.added_signals.length ? newTxChange.added_signals.join(", ") : "none"}.
                </p>
              ) : null}
              <h3 className="section-title">Cases</h3>
              {diff.new_cases.length === 0 && diff.updated_cases.length === 0 && diff.deactivated_cases.length === 0 ? (
                <p className="muted">No case changed.</p>
              ) : null}
              <ul className="plain">
                {diff.new_cases.map((c) => (
                  <li key={c.case_id}>
                    <span className="chip">new</span> <Link to={`/cases/${c.case_id}`} className="id">{c.case_id}</Link> <RiskBadge band={c.risk_band} score={c.risk_score} /> {c.title}
                  </li>
                ))}
                {diff.updated_cases.map((c) => (
                  <li key={c.case_id}>
                    <span className="chip">updated</span> <Link to={`/cases/${c.case_id}`} className="id">{c.case_id}</Link> score {c.score_before} &rarr; {c.score_after}
                    {c.added_transaction_ids.length ? <> &middot; added {c.added_transaction_ids.join(", ")}</> : null}
                  </li>
                ))}
                {diff.deactivated_cases.map((id) => (
                  <li key={id}><span className="chip">no longer flagged</span> {id}</li>
                ))}
              </ul>
              <h3 className="section-title">Transactions whose signals changed ({diff.changed_transactions_total})</h3>
              <div className="table-scroll">
                <table className="table compact">
                  <thead>
                    <tr><th scope="col">Transaction</th><th scope="col">Score</th><th scope="col">Added signals</th><th scope="col">Removed signals</th></tr>
                  </thead>
                  <tbody>
                    {diff.changed_transactions.map((c) => (
                      <tr key={c.transaction_id}>
                        <td><button className="link-button mono" onClick={() => openTransaction(c.transaction_id)}>{c.transaction_id}</button></td>
                        <td>{c.score_before ?? "new"} &rarr; {c.score_after}</td>
                        <td className="small">{c.added_signals.join(", ") || "-"}</td>
                        <td className="small">{c.removed_signals.join(", ") || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
