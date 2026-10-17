import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SearchResults } from "../api/client";
import { fmtAmount, fmtTime } from "../util";
import { Avatar, RiskBadge } from "./common";
import { IconSearch } from "./icons";
import { useInspector } from "./Inspector";

interface Item {
  key: string;
  group: string;
  run: () => void;
  body: ReactNode;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Search cases, accounts (name, ID, account number) and transactions (ID, reference). Ctrl/Cmd+K focuses it. */
export default function GlobalSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
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
    const id = ++seq.current; // any in-flight request for an older query is now stale
    if (term.length < 2) {
      setResults(null);
      setBusy(false);
      return undefined;
    }
    setBusy(true);
    const timer = window.setTimeout(() => {
      api
        .search(term)
        .then((r) => {
          if (id === seq.current) {
            setResults(r);
            setActive(0);
          }
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
    inputRef.current?.blur();
    fn();
  };

  const items = useMemo<Item[]>(() => {
    if (!results) return [];
    return [
      ...results.cases.map((c) => ({
        key: `c-${c.case_id}`,
        group: "Cases",
        run: () => navigate(`/cases/${c.case_id}`),
        body: (
          <>
            <RiskBadge band={c.risk_band} score={c.risk_score} />
            <span className="grow">{c.title}</span>
            <span className="mono muted small id">{c.case_id}</span>
          </>
        ),
      })),
      ...results.accounts.map((a) => ({
        key: `a-${a.account_id}`,
        group: "Accounts",
        run: () => openAccount(a.account_id),
        body: (
          <>
            <Avatar name={a.holder_name} type={a.account_type} size="sm" />
            <span className="grow">{a.holder_name ?? a.account_id}</span>
            <span className="mono muted small id">
              {a.account_id}
              {a.city ? ` · ${a.city}` : ""}
            </span>
          </>
        ),
      })),
      ...results.transactions.map((t) => ({
        key: `t-${t.transaction_id}`,
        group: "Transactions",
        run: () => openTransaction(t.transaction_id),
        body: (
          <>
            <span className="mono id">{t.transaction_id}</span>
            <span className="grow muted small">
              {t.reference ? `ref ${t.reference} · ` : ""}
              {fmtTime(t.timestamp)}
            </span>
            <strong className="tnum">{fmtAmount(t.amount, t.currency)}</strong>
          </>
        ),
      })),
    ];
  }, [results, navigate, openAccount, openTransaction]);

  const showList = open && results !== null;
  const optionId = (i: number) => `search-opt-${i}`;

  return (
    <div className="search" ref={boxRef} role="search">
      <label className="search-input">
        <IconSearch size={16} />
        <span className="visually-hidden">Search cases, accounts and transactions</span>
        <input
          ref={inputRef}
          type="search"
          value={q}
          placeholder="Search cases, accounts, references..."
          maxLength={64}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls="search-results"
          aria-activedescendant={showList && items.length ? optionId(active) : undefined}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
            } else if (e.key === "ArrowDown" && items.length) {
              e.preventDefault();
              setOpen(true);
              setActive((i) => (i + 1) % items.length);
            } else if (e.key === "ArrowUp" && items.length) {
              e.preventDefault();
              setActive((i) => (i - 1 + items.length) % items.length);
            } else if (e.key === "Enter" && showList && items[active]) {
              e.preventDefault();
              pick(items[active].run);
            }
          }}
        />
        {busy ? <span className="spinner" aria-hidden="true" /> : <span className="kbd">{isMac ? "⌘ K" : "Ctrl K"}</span>}
      </label>
      {showList ? (
        <div className="search-results" id="search-results" role="listbox" aria-label="Search results">
          {items.length === 0 ? <div className="state">No matches for &ldquo;{results.query}&rdquo;.</div> : null}
          {items.map((it, i) => (
            <div key={it.key}>
              {i === 0 || items[i - 1].group !== it.group ? (
                <div className="search-group" role="presentation">
                  {it.group}
                </div>
              ) : null}
              <button
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className="search-item"
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(it.run)}
              >
                {it.body}
              </button>
            </div>
          ))}
          {items.length ? (
            <div className="search-hint muted small" aria-hidden="true">
              <span className="kbd">↑</span> <span className="kbd">↓</span> to move &middot; <span className="kbd">Enter</span> to open &middot;{" "}
              <span className="kbd">Esc</span> to close
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
