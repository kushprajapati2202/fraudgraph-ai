import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SearchResults } from "../api/client";
import { fmtAmount, fmtTime } from "../util";
import { Avatar, RiskBadge } from "./common";
import { IconSearch } from "./icons";
import { useInspector } from "./Inspector";

/** Search cases, accounts (name, ID, account number) and transactions (ID, reference). Ctrl/Cmd+K focuses it. */
export default function GlobalSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const navigate = useNavigate();
  const { openAccount, openTransaction } = useInspector();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return undefined;
    }
    const id = ++seq.current;
    setBusy(true);
    const timer = window.setTimeout(() => {
      api
        .search(term)
        .then((r) => {
          if (id === seq.current) setResults(r);
        })
        .catch(() => {
          if (id === seq.current) setResults({ query: term, cases: [], accounts: [], transactions: [] });
        })
        .finally(() => {
          if (id === seq.current) setBusy(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [q]);

  const pick = (fn: () => void) => {
    setOpen(false);
    setQ("");
    fn();
  };
  const empty = results && !results.cases.length && !results.accounts.length && !results.transactions.length;

  return (
    <div className="search" ref={boxRef} role="search">
      <label className="search-input">
        <IconSearch size={16} />
        <span className="visually-hidden">Search cases, accounts and transactions</span>
        <input
          ref={inputRef}
          value={q}
          placeholder="Search cases, accounts, references..."
          maxLength={64}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
          aria-expanded={open && !!results}
          aria-controls="search-results"
        />
        {busy ? <span className="spinner" aria-hidden="true" /> : <span className="kbd">Ctrl K</span>}
      </label>
      {open && results ? (
        <div className="search-results" id="search-results">
          {empty ? <div className="state">No matches for &ldquo;{results.query}&rdquo;.</div> : null}
          {results.cases.length ? <div className="search-group">Cases</div> : null}
          {results.cases.map((c) => (
            <button key={c.case_id} className="search-item" onClick={() => pick(() => navigate(`/cases/${c.case_id}`))}>
              <RiskBadge band={c.risk_band} score={c.risk_score} />
              <span className="grow">{c.title}</span>
              <span className="mono muted small">{c.case_id}</span>
            </button>
          ))}
          {results.accounts.length ? <div className="search-group">Accounts</div> : null}
          {results.accounts.map((a) => (
            <button key={a.account_id} className="search-item" onClick={() => pick(() => openAccount(a.account_id))}>
              <Avatar name={a.holder_name} type={a.account_type} size="sm" />
              <span className="grow">{a.holder_name ?? a.account_id}</span>
              <span className="mono muted small">
                {a.account_id} &middot; {a.city}
              </span>
            </button>
          ))}
          {results.transactions.length ? <div className="search-group">Transactions</div> : null}
          {results.transactions.map((t) => (
            <button key={t.transaction_id} className="search-item" onClick={() => pick(() => openTransaction(t.transaction_id))}>
              <span className="mono">{t.transaction_id}</span>
              <span className="grow muted small">
                ref {t.reference} &middot; {fmtTime(t.timestamp)}
              </span>
              <strong className="tnum">{fmtAmount(t.amount, t.currency)}</strong>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
