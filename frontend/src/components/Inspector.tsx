import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type AccountInfo, type Evidence } from "../api/client";
import { fmtAmount, fmtTime, useAsync } from "../util";
import { AccountControlTags, Avatar, ControlTag, ErrorState, Loading, Party, RiskBadge, StatusChip, SyntheticTag } from "./common";

type Target = { kind: "evidence"; item: Evidence } | { kind: "transaction"; id: string } | { kind: "account"; id: string };

interface InspectorApi {
  openEvidence: (item: Evidence) => void;
  openTransaction: (id: string) => void;
  openAccount: (id: string) => void;
}

const noop = () => undefined;
const InspectorContext = createContext<InspectorApi>({ openEvidence: noop, openTransaction: noop, openAccount: noop });

export const useInspector = () => useContext(InspectorContext);

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Target[]>([]);
  const openEvidence = useCallback((item: Evidence) => setStack((s) => [...s, { kind: "evidence", item }]), []);
  const openTransaction = useCallback((id: string) => setStack((s) => [...s, { kind: "transaction", id }]), []);
  const openAccount = useCallback((id: string) => setStack((s) => [...s, { kind: "account", id }]), []);
  const close = useCallback(() => setStack([]), []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const current = stack[stack.length - 1];

  return (
    <InspectorContext.Provider value={{ openEvidence, openTransaction, openAccount }}>
      {children}
      {current ? <Drawer target={current} canGoBack={stack.length > 1} onBack={back} onClose={close} /> : null}
    </InspectorContext.Provider>
  );
}

function Drawer({ target, canGoBack, onBack, onClose }: { target: Target; canGoBack: boolean; onBack: () => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  const title = target.kind === "evidence" ? `Evidence ${target.item.evidence_id}` : target.kind === "transaction" ? `Transaction ${target.id}` : `Account ${target.id}`;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          {canGoBack ? (
            <button className="btn btn-small btn-ghost" onClick={onBack} aria-label="Back to previous item">
              &larr; Back
            </button>
          ) : null}
          <h2>{title}</h2>
          <button ref={closeRef} className="btn btn-small btn-ghost" onClick={onClose} aria-label="Close panel">
            Close
          </button>
        </header>
        <div className="drawer-body" onClick={(e) => (e.target as HTMLElement).closest("a") && onClose()}>
          {target.kind === "evidence" ? <EvidenceView item={target.item} /> : target.kind === "transaction" ? <TransactionView id={target.id} /> : <AccountView id={target.id} />}
        </div>
      </aside>
    </div>
  );
}

function TxButton({ id }: { id: string }) {
  const { openTransaction } = useInspector();
  return (
    <button className="chip chip-button mono" onClick={() => openTransaction(id)}>
      {id}
    </button>
  );
}

function EvidenceView({ item }: { item: Evidence }) {
  const p = item.payload;
  const { openAccount } = useInspector();
  return (
    <div className="stack">
      <dl className="kv">
        <dt>Evidence ID</dt>
        <dd className="mono">{item.evidence_id}</dd>
        <dt>Type</dt>
        <dd>{item.source_type.replace("_", " ").toLowerCase()}</dd>
        <dt>Source record</dt>
        <dd className="mono">{item.source_id}</dd>
        <dt>Timestamp</dt>
        <dd>{fmtTime(item.timestamp)}</dd>
      </dl>
      <p className="evidence-desc">{item.description}</p>

      {item.source_type === "RULE_FINDING" ? (
        <div className="stack-sm">
          <dl className="kv">
            <dt>Rule</dt>
            <dd>
              {p.label} <span className="mono muted">({p.code})</span>
              {p.context_only ? <span className="chip chip-context">context only</span> : null}
            </dd>
            <dt>Contribution</dt>
            <dd>
              +{p.contribution} of max {p.weight} (normalized value {p.value})
            </dd>
            <dt>Parameters</dt>
            <dd className="mono small">{JSON.stringify(p.params)}</dd>
          </dl>
          <div>
            <h4>Supporting transactions</h4>
            <div className="chip-row">
              {(p.supporting_tx_ids as string[]).map((t) => (
                <TxButton key={t} id={t} />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {item.source_type === "GRAPH_PATH" ? (
        <div className="stack-sm">
          <p className="path-line">
            {(p.accounts as string[]).map((a, i) => (
              <span key={`${a}-${i}`}>
                {i > 0 ? <span aria-hidden="true"> &rarr; </span> : null}
                <button className="link-button mono" onClick={() => openAccount(a)}>
                  {a}
                </button>
              </span>
            ))}
          </p>
          <p className="muted">
            {fmtTime(p.start)} to {fmtTime(p.end)} ({p.duration_minutes} minutes)
          </p>
          <div className="chip-row">
            {(p.transaction_ids as string[]).map((t) => (
              <TxButton key={t} id={t} />
            ))}
          </div>
        </div>
      ) : null}

      {item.source_type === "BASELINE" ? (
        <dl className="kv">
          <dt>Account</dt>
          <dd>
            <button className="link-button mono" onClick={() => openAccount(p.account_id)}>
              {p.account_id}
            </button>
          </dd>
          <dt>Prior payments</dt>
          <dd>{p.prior_outgoing_count}</dd>
          <dt>Median amount</dt>
          <dd>{p.available ? fmtAmount(p.median_amount) : "unknown (no baseline)"}</dd>
          <dt>90th percentile</dt>
          <dd>{p.available ? fmtAmount(p.p90_amount) : "unknown (no baseline)"}</dd>
          <dt>As of</dt>
          <dd>{fmtTime(p.as_of)}</dd>
        </dl>
      ) : null}

      {item.source_type === "TRANSACTION" ? <TransactionView id={item.source_id} /> : null}
    </div>
  );
}

function kyc(tier: string | null | undefined): string {
  return tier === "FULL_KYC" ? "Full KYC" : tier === "MIN_KYC" ? "Minimum KYC" : "unknown";
}

function AccountLine({ info, id }: { info: AccountInfo | undefined; id: string }) {
  const { openAccount } = useInspector();
  return (
    <div>
      <Party name={info?.holder_name} id={id} type={info?.account_type} onClick={() => openAccount(id)} />
      <div className="muted small">
        {(info?.account_type ?? "unknown").toLowerCase()} &middot; {info?.city ?? "unknown"} &middot; opened {info?.created_at ?? "unknown"} &middot; {kyc(info?.kyc_tier)}
      </div>
    </div>
  );
}

export function TransactionView({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(() => api.transaction(id), [id]);
  const { openTransaction } = useInspector();
  if (loading && !data) return <Loading label="Loading transaction" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  const t = data.transaction;
  const a = data.assessment;
  return (
    <div className="stack">
      <div>
        <div className="eyebrow">Amount</div>
        <div className="kpi-value">
          {fmtAmount(t.amount, t.currency)} {t.is_synthetic_added ? <SyntheticTag /> : null}
          <ControlTag status={data.control?.status} />
        </div>
        <div className="muted small">
          {fmtTime(t.timestamp)} &middot; {t.channel || "unknown channel"} &middot; ref <span className="mono">{t.reference || "unknown"}</span>
        </div>
      </div>
      {data.control ? (
        <div className={`callout ${data.control.status === "HELD" ? "callout-warn" : "callout-info"}`}>
          {data.control.status === "FLAGGED" ? (
            <>
              Flagged for review because <span className="mono">{data.control.account_id}</span> is under enhanced monitoring.
            </>
          ) : (
            <>
              Stopped on {fmtTime(data.control.created_at)} UTC because <span className="mono">{data.control.account_id}</span> is on hold.{" "}
              {data.control.status === "HELD"
                ? "The money has not moved. An analyst must release or reject it."
                : `${data.control.status === "RELEASED" ? "Released" : "Rejected"} by ${data.control.resolved_by} on ${fmtTime(data.control.resolved_at)} UTC: ${data.control.resolution_note}`}
            </>
          )}{" "}
          <Link to={`/cases/${data.control.case_id}`}>Open case</Link>
        </div>
      ) : null}
      <dl className="kv">
        <dt>From</dt>
        <dd>
          <AccountLine info={data.accounts[t.source_account]} id={t.source_account} />
        </dd>
        <dt>To</dt>
        <dd>
          <AccountLine info={data.accounts[t.destination_account]} id={t.destination_account} />
        </dd>
        <dt>Transaction ID</dt>
        <dd className="mono">{t.transaction_id}</dd>
        <dt>Device</dt>
        <dd className="mono">{t.device_id || "unknown"}</dd>
        <dt>Remarks</dt>
        <dd>{t.description ? <q className="untrusted" title="Free text entered by the payer; treated as untrusted data">{t.description}</q> : "none"}</dd>
      </dl>

      {a ? (
        <div className="stack-sm">
          <h3 className="section-title">
            Rule assessment <RiskBadge band={a.risk_band} score={a.score} />
          </h3>
          <p className="muted small">
            Rules {a.rule_version}, {a.time_window_minutes} min window, run {a.analysis_id}. The score ranks review priority; it is not a probability.
          </p>
          {a.signals.length === 0 ? <p className="muted">No signals fired.</p> : null}
          <ul className="signal-list">
            {a.signals.map((s) => (
              <li key={s.code}>
                <strong>{s.label}</strong> <span className="muted">+{s.contribution}/{s.weight}</span>
                {s.context_only ? <span className="chip chip-context">context only</span> : null}
                <div>{s.explanation}</div>
                <div className="chip-row" style={{ marginTop: 6 }}>
                  {s.supporting_tx_ids
                    .filter((x) => x !== t.transaction_id)
                    .map((x) => (
                      <button key={x} className="chip chip-button mono" onClick={() => openTransaction(x)}>
                        {x}
                      </button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
          {a.uncertainties.length ? (
            <div className="callout callout-info">
              <strong>Uncertainty</strong>
              <ul>
                {a.uncertainties.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="muted">Not yet analysed. Run analysis to score this transaction.</p>
      )}

      {data.cases.length ? (
        <div>
          <h4>Linked cases</h4>
          <ul className="plain">
            {data.cases.map((c) => (
              <li key={c.case_id}>
                <RiskBadge band={c.risk_band} score={c.risk_score} /> <Link to={`/cases/${c.case_id}`}>{c.title}</Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function AccountView({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(() => api.account(id), [id]);
  const { openTransaction, openAccount } = useInspector();
  if (loading && !data) return <Loading label="Loading account" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  const a = data.account;
  const s = data.summary;
  return (
    <div className="stack">
      <div className="profile-head">
        <Avatar name={a.holder_name} type={a.account_type} size="lg" />
        <div>
          <h3 style={{ fontSize: "1.1rem", margin: 0 }}>{a.holder_name || "Unknown holder"}</h3>
          <div className="muted small">
            <span className="mono">{a.account_id}</span> &middot; {a.account_type.toLowerCase()} &middot; {a.city ?? "unknown"}
          </div>
          <div style={{ marginTop: 4 }}>
            <AccountControlTags controls={data.controls} />
          </div>
        </div>
      </div>
      {data.controls.map((c) => (
        <div key={c.action_id} className="callout callout-warn">
          <strong>{c.label}</strong> applied by {c.actor_label} on {fmtTime(c.created_at)} UTC
          {c.expires_at ? `, until ${fmtTime(c.expires_at)} UTC` : ""}. <Link to={`/cases/${c.case_id}`}>Open case</Link>
        </div>
      ))}
      <dl className="kv">
        <dt>Account number</dt>
        <dd className="mono">{a.account_number ? `XXXX XXXX ${a.account_number.slice(-4)}` : "unknown"}</dd>
        <dt>Branch</dt>
        <dd className="mono">{a.branch_code ?? "unknown"}</dd>
        <dt>Opened</dt>
        <dd>{a.created_at}</dd>
        <dt>KYC</dt>
        <dd>{kyc(a.kyc_tier)}</dd>
        <dt>Devices seen</dt>
        <dd className="mono">{s.devices.length ? s.devices.join(", ") : "unknown"}</dd>
        <dt>Highest score</dt>
        <dd>{s.max_score ?? "not scored"}</dd>
      </dl>
      <div className="mini-stats">
        <div className="mini-stat">
          <span className="small muted">Money out</span>
          <strong>{fmtAmount(s.outgoing_total)}</strong>
          <span className="small muted">{s.outgoing_count} transfers</span>
        </div>
        <div className="mini-stat">
          <span className="small muted">Money in</span>
          <strong>{fmtAmount(s.incoming_total)}</strong>
          <span className="small muted">{s.incoming_count} transfers</span>
        </div>
      </div>
      <p className="muted small">
        Active {fmtTime(s.first_activity)} to {fmtTime(s.last_activity)}. <Link to={`/network?account=${a.account_id}`}>View in network</Link>
      </p>

      {data.cases.length ? (
        <div>
          <h4>Cases involving this account</h4>
          <ul className="plain">
            {data.cases.map((c) => (
              <li key={c.case_id}>
                <RiskBadge band={c.risk_band} score={c.risk_score} /> <Link to={`/cases/${c.case_id}`}>{c.title}</Link> <StatusChip status={c.status} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.counterparties.length ? (
        <div>
          <h4>Top counterparties</h4>
          <table className="table compact">
            <tbody>
              {data.counterparties.map((c) => (
                <tr key={c.account_id}>
                  <td>
                    <Party name={c.holder_name} id={c.account_id} onClick={() => openAccount(c.account_id)} />
                  </td>
                  <td className="num small">{c.transfers} transfers</td>
                  <td className="num">{fmtAmount(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div>
        <h4>Recent transfers</h4>
        <table className="table compact">
          <tbody>
            {data.recent_transactions.map((t) => {
              const outgoing = t.source_account === a.account_id;
              return (
                <tr key={t.transaction_id}>
                  <td>
                    <button className="link-button mono" onClick={() => openTransaction(t.transaction_id)}>
                      {t.transaction_id}
                    </button>
                    <ControlTag status={t.control_status} />
                    <div className="small muted">{fmtTime(t.timestamp)}</div>
                  </td>
                  <td className="small">
                    {outgoing ? "to" : "from"} {(outgoing ? t.destination_name : t.source_name) ?? (outgoing ? t.destination_account : t.source_account)}
                  </td>
                  <td className="num">
                    {outgoing ? "−" : "+"}
                    {fmtAmount(t.amount, t.currency)}
                  </td>
                  <td>
                    <RiskBadge band={t.risk_band} score={t.score} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
