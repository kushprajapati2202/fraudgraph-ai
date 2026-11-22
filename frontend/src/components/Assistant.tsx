import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type AskResult,
  type AssistantMessage,
  type AssistantResult,
  type AssistantSession,
  type CaseDetail,
  type Evidence,
  type Insight,
} from "../api/client";
import { usePrefs } from "../prefs";
import { caseHeadline, errorMessage, fmtAmount, fmtTime, useAsync } from "../util";
import { Busy, Unavailable } from "./ai";
import { BigQueryAnswer, cloudOn, useCloud } from "./Cloud";
import { ErrorState, RiskBadge, StatusChip } from "./common";
import {
  IconBolt,
  IconCases,
  IconChat,
  IconClose,
  IconExpand,
  IconFlow,
  IconInfo,
  IconMenu,
  IconNetwork,
  IconPanel,
  IconPlus,
  IconSearch,
  IconSend,
  IconSparkle,
  IconTarget,
  IconTransactions,
  IconTrash,
} from "./icons";
import { useInspector } from "./Inspector";

/**
 * The workspace assistant. It lives in a side panel that opens from the top bar on every page (and in the overview
 * card); both show the same conversation. Chats are kept on the server; the browser only remembers which chat is open
 * and whether the panel was open. On a case page the case is attached as context: questions about it are answered from
 * its evidence, and "/" lists the mitigation actions for it, which take effect only after the analyst approves them.
 */

const CURRENT_KEY = "fg-assistant-chat";
const PANEL_KEY = "fg-assistant-panel";

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: works for this page only */
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Chat state

export interface Chat {
  sessionId: string | null;
  session: AssistantSession | null;
  messages: AssistantMessage[];
  pending: string | null;
  error: string | null;
  loading: boolean;
  /** Bumped after every change to the chat list (new chat, new message, delete), so lists can reload. */
  version: number;
  ask: (question: string, caseId?: string | null) => Promise<void>;
  open: (sessionId: string) => void;
  newChat: () => void;
  remove: (sessionId: string) => Promise<void>;
}

function useChat(): Chat {
  const [sessionId, setSessionId] = useState<string | null>(() => readKey(CURRENT_KEY));
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const skipLoad = useRef<string | null>(null);

  useEffect(() => {
    writeKey(CURRENT_KEY, sessionId);
    setError(null);
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      return;
    }
    if (skipLoad.current === sessionId) return; // just created by ask(): already have its messages
    let live = true;
    setLoading(true);
    api
      .assistantSession(sessionId)
      .then((r) => {
        if (!live) return;
        setSession(r.session);
        setMessages(r.messages);
      })
      .catch(() => live && setSessionId(null)) // deleted or reset: start fresh
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId]);

  const ask = useCallback(
    async (question: string, caseId: string | null = null) => {
      setPending(question);
      setError(null);
      try {
        const r = await api.assistantAsk(question, sessionId, caseId);
        skipLoad.current = r.session.session_id;
        setSession(r.session);
        setMessages((m) => (sessionId === r.session.session_id ? [...m, r.message] : [r.message]));
        setSessionId(r.session.session_id);
        setVersion((v) => v + 1);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setPending(null);
      }
    },
    [sessionId],
  );

  const open = useCallback((id: string) => {
    skipLoad.current = null;
    setSessionId(id);
  }, []);

  const newChat = useCallback(() => {
    skipLoad.current = null;
    setSessionId(null);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await api.deleteAssistantSession(id);
      if (id === sessionId) setSessionId(null);
      setVersion((v) => v + 1);
    },
    [sessionId],
  );

  return { sessionId, session, messages, pending, error, loading, version, ask, open, newChat, remove };
}

// ---------------------------------------------------------------------------------------------------------------
// Provider: one chat and one panel for the whole app

export interface PageContext {
  caseId: string;
  title: string;
}

type PanelView = "chat" | "history";

interface AssistantApi {
  chat: Chat;
  open: boolean;
  view: PanelView;
  expanded: boolean;
  show: (view?: PanelView) => void;
  hide: () => void;
  toggle: () => void;
  setView: (view: PanelView) => void;
  setExpanded: (expanded: boolean) => void;
  /** The case open on the current page, if any. */
  context: PageContext | null;
  setContext: (ctx: PageContext | null) => void;
  /** Bumped after the assistant changes a case (an approved action), so the case page reloads. */
  caseChanges: number;
  notifyCaseChanged: () => void;
}

const AssistantContext = createContext<AssistantApi | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const [open, setOpen] = useState(() => readKey(PANEL_KEY) === "open");
  const [view, setView] = useState<PanelView>("chat");
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<PageContext | null>(null);
  const [caseChanges, setCaseChanges] = useState(0);

  useEffect(() => writeKey(PANEL_KEY, open ? "open" : null), [open]);
  // The page makes room for the docked panel on wide screens (see .assist-open in styles.css).
  useEffect(() => {
    document.body.classList.toggle("assist-open", open);
    document.body.classList.toggle("assist-wide", open && expanded);
  }, [open, expanded]);

  const show = useCallback((v: PanelView = "chat") => {
    setView(v);
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => {
    setView("chat");
    setOpen((o) => !o);
  }, []);
  const notifyCaseChanged = useCallback(() => setCaseChanges((n) => n + 1), []);

  const value = useMemo<AssistantApi>(
    () => ({ chat, open, view, expanded, show, hide, toggle, setView, setExpanded, context, setContext, caseChanges, notifyCaseChanged }),
    [chat, open, view, expanded, show, hide, toggle, context, caseChanges, notifyCaseChanged],
  );
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantApi {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
}

/**
 * Attaches the open case to the assistant while the page is mounted, and calls `onChanged` after the assistant
 * applies an action to it (so the page shows the new state).
 */
export function useAssistantCase(caseId: string, title: string | null, onChanged: () => void) {
  const { setContext, caseChanges } = useAssistant();
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const first = useRef(caseChanges);

  useEffect(() => {
    if (!title) return;
    setContext({ caseId, title });
    return () => setContext(null);
  }, [caseId, title, setContext]);

  useEffect(() => {
    if (caseChanges !== first.current) changed.current();
  }, [caseChanges]);
}

// ---------------------------------------------------------------------------------------------------------------
// Answers

function AskTable({ r }: { r: AskResult }) {
  const { openTransaction, openAccount } = useInspector();
  if (!r.rows.length) return <p className="muted small">Nothing matches. Try a wider range or fewer filters.</p>;
  if (r.plan.target === "CASES") {
    return (
      <table className="table compact">
        <thead>
          <tr><th scope="col">Case</th><th scope="col">Status</th><th scope="col" className="num">Amount</th><th scope="col">Priority</th></tr>
        </thead>
        <tbody>
          {r.rows.map((c) => (
            <tr key={c.case_id}>
              <td><Link to={`/cases/${c.case_id}`}>{caseHeadline(c.title)}</Link> <span className="mono small muted">{c.case_id}</span></td>
              <td><StatusChip status={c.status} /></td>
              <td className="num tnum">{fmtAmount(c.total_amount)}</td>
              <td><RiskBadge band={c.risk_band} score={c.risk_score} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (r.plan.target === "ACCOUNTS") {
    return (
      <table className="table compact">
        <thead>
          <tr><th scope="col">Account</th><th scope="col" className="num">Matching transfers</th><th scope="col" className="num">Amount</th><th scope="col">Highest score</th></tr>
        </thead>
        <tbody>
          {r.rows.map((a) => (
            <tr key={a.account_id}>
              <td>
                <button className="link-button" onClick={() => openAccount(a.account_id)}>{a.holder_name ?? a.account_id}</button>{" "}
                <span className="mono small muted">{a.account_id}</span>
              </td>
              <td className="num tnum">{a.transfers}</td>
              <td className="num tnum">{fmtAmount(a.amount)}</td>
              <td><RiskBadge band={a.max_score >= 60 ? "HIGH" : a.max_score >= 30 ? "MEDIUM" : "LOW"} score={a.max_score} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="table compact">
      <thead>
        <tr><th scope="col">Time (UTC)</th><th scope="col">From &rarr; To</th><th scope="col" className="num">Amount</th><th scope="col">Priority</th></tr>
      </thead>
      <tbody>
        {r.rows.map((t) => (
          <tr key={t.transaction_id}>
            <td className="small nowrap">
              <button className="link-button mono small" onClick={() => openTransaction(t.transaction_id)}>{t.transaction_id}</button>
              <div className="muted">{fmtTime(t.timestamp)}</div>
            </td>
            <td>
              {t.source_name ?? t.source_account} <span className="muted">&rarr;</span> {t.destination_name ?? t.destination_account}
              <div className="muted small">{t.channel}</div>
            </td>
            <td className="num tnum">{fmtAmount(t.amount, t.currency)}</td>
            <td><RiskBadge band={t.risk_band} score={t.score} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const MODE_LABEL: Record<AssistantResult["mode"], string> = {
  LOOKUP: "Workspace records",
  ANALYTICS: "BigQuery analytics",
  HELP: "Assistant",
  CASE: "Case evidence",
};

const MODE_TIP: Record<AssistantResult["mode"], string> = {
  LOOKUP: "Gemini never sees the records. It turns the question into a fixed set of filters; the server checks them and runs the query.",
  ANALYTICS: "Gemini wrote a read-only query. It passed a safety check, a dry run and a cost cap before it ran; numbers in the answer were checked against the rows.",
  HELP: "A fixed reply. Nothing was generated.",
  CASE: "Answered only from this case's evidence package. Every cited evidence ID was checked; IDs that were not supplied were removed.",
};

const CITATIONS_SHOWN = 4;

function AssistantAnswer({ rec, evidence }: { rec: Insight<AssistantResult> | null; evidence?: Map<string, Evidence> }) {
  const { openEvidence } = useInspector();
  const [allCitations, setAllCitations] = useState(false);
  const r = rec?.response.result;
  if (!rec) return <div className="callout callout-warn small">This answer is no longer available.</div>;
  if (!r) return <Unavailable rec={rec} what="The assistant" />;
  const l = r.lookup;
  return (
    <div className="assistant-answer stack-sm">
      {r.standalone_question.toLowerCase() !== r.question.toLowerCase() ? (
        <span className="muted small">Understood as: &ldquo;{r.standalone_question}&rdquo;</span>
      ) : null}
      <p className="assistant-reply">{r.reply}</p>
      {r.note ? <div className="callout callout-info small">{r.note}</div> : null}
      {r.case ? (
        <div className="row-center small" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className="muted">
            <Link to={`/cases/${r.case.case_id}`} className="mono">{r.case.case_id}</Link>
            {r.case.evidence_ids.length
              ? ` · ${r.case.evidence_ids.length} evidence ${r.case.evidence_ids.length === 1 ? "item" : "items"} cited:`
              : " · No evidence cited. Treat this answer as unconfirmed."}
          </span>
          {(allCitations ? r.case.evidence_ids : r.case.evidence_ids.slice(0, CITATIONS_SHOWN)).map((id) => {
            const ev = evidence?.get(id);
            return ev ? (
              <button key={id} className="citation" onClick={() => openEvidence(ev)} title="Open this evidence">
                {id}
              </button>
            ) : (
              <span key={id} className="citation">{id}</span>
            );
          })}
          {r.case.evidence_ids.length > CITATIONS_SHOWN ? (
            <button className="link-button small" onClick={() => setAllCitations((v) => !v)}>
              {allCitations ? "Show fewer" : `+${r.case.evidence_ids.length - CITATIONS_SHOWN} more`}
            </button>
          ) : null}
        </div>
      ) : null}
      {l ? (
        <>
          <div className="muted small">
            Filters applied: {l.plan_summary}
            {l.total > l.rows.length ? <> &middot; showing {l.rows.length} of {l.total.toLocaleString()}</> : null}
          </div>
          {l.unsupported ? <div className="callout callout-info small">Not covered by the filters: {l.unsupported}</div> : null}
          {l.rows.length ? (
            <div className="table-scroll">
              <AskTable r={l} />
            </div>
          ) : null}
        </>
      ) : null}
      {r.analytics ? (
        <>
          <p className="small muted" style={{ margin: 0 }}>{r.analytics.interpretation}</p>
          <BigQueryAnswer r={r.analytics} />
        </>
      ) : null}
      {r.mode !== "HELP" ? <span className="chip chip-ai chat-source" title={MODE_TIP[r.mode]}>{MODE_LABEL[r.mode]}</span> : null}
    </div>
  );
}

function AssistantAvatar() {
  return (
    <span className="chat-avatar" aria-hidden="true">
      <IconSparkle size={16} />
    </span>
  );
}

function Typing({ label }: { label: string }) {
  return (
    <div className="chat-row chat-row-ai" role="status">
      <AssistantAvatar />
      <div className="chat-typing">
        <span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="muted small">{label}</span>
      </div>
    </div>
  );
}

/** The question-and-answer turns, plus anything extra (applied actions) after them. */
function ChatThread({ chat, evidence, extra, typingLabel = "Looking through your workspace..." }: {
  chat: Chat;
  evidence?: Map<string, Evidence>;
  extra?: ReactNode;
  typingLabel?: string;
}) {
  const threadRef = useRef<HTMLDivElement>(null);
  // Keep the newest question at the top of the thread, so its answer reads from the start (not from the table end).
  useEffect(() => {
    const thread = threadRef.current;
    const last = thread?.lastElementChild as HTMLElement | null;
    if (thread && last) thread.scrollTo({ top: last.offsetTop - 8, behavior: "smooth" });
  }, [chat.messages.length, chat.pending, extra]);

  return (
    <div className="chat-thread" aria-live="polite" ref={threadRef}>
      {chat.messages.map((m) => (
        <div key={m.message_id} className="chat-turn">
          <div className="chat-row chat-row-user">
            <div className="chat-bubble">{m.question}</div>
          </div>
          <div className="chat-row chat-row-ai">
            <AssistantAvatar />
            <div className="chat-answer">
              <AssistantAnswer rec={m.insight} evidence={evidence} />
              <span className="chat-time">{fmtTime(m.created_at).slice(11)} UTC</span>
            </div>
          </div>
        </div>
      ))}
      {chat.pending ? (
        <div className="chat-turn">
          <div className="chat-row chat-row-user">
            <div className="chat-bubble">{chat.pending}</div>
          </div>
          <Typing label={typingLabel} />
        </div>
      ) : null}
      {extra}
    </div>
  );
}

/** Grows a textarea with its text, up to a few lines. */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [ref, value]);
}

// ---------------------------------------------------------------------------------------------------------------
// Overview card

/**
 * The overview card: a question box and suggestion pills. Answers open in the side panel (same conversation), so
 * the overview stays a dashboard rather than turning into a chat.
 */
export function AssistantCard() {
  const a = useAssistant();
  const chat = a.chat;
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const analytics = cloudOn(useCloud(), "bigquery");
  const suggestions = WORKSPACE_SUGGESTIONS.filter((s) => analytics || !s.analytics);
  const busy = chat.pending !== null;
  useAutoGrow(inputRef, q);

  function submit(e?: FormEvent, text?: string) {
    e?.preventDefault();
    const question = (text ?? q).trim();
    if (question.length < 3 || busy) return;
    setQ("");
    a.show("chat");
    void chat.ask(question);
  }

  return (
    <section className="card ai-card ask-hero" aria-labelledby="ask-heading" data-tour="dash-ask">
      <div className="row-center" style={{ justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
        <h2 id="ask-heading" className="section-title" style={{ margin: 0 }}>
          <span className="ai-mark"><IconSparkle size={16} /></span> Assistant
        </h2>
        <div className="inline">
          {chat.sessionId ? (
            <button className="btn btn-small" onClick={() => a.show("chat")} title={chat.session?.title ?? "Open the current chat"}>
              <IconPanel size={14} /> Current chat
            </button>
          ) : null}
          <button className="btn btn-small" onClick={() => a.show("history")}>
            All chats
          </button>
        </div>
      </div>
      <div className="chat-dock">
        <form className="chat-composer" onSubmit={submit}>
          <label className="grow">
            <span className="visually-hidden">Ask about transfers, cases, accounts or totals. The answer opens in the side panel.</span>
            <textarea
              ref={inputRef}
              rows={1}
              value={q}
              maxLength={300}
              placeholder={analytics ? "Ask about cases, transfers, accounts or totals..." : "Ask about cases, transfers or accounts..."}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
              }}
            />
          </label>
          <button className="chat-send" type="submit" disabled={busy || q.trim().length < 3} aria-label="Ask" title="Ask (Enter). The answer opens in the side panel.">
            {busy ? <span className="spinner" aria-hidden="true" /> : <IconSend size={18} />}
          </button>
        </form>
        <div className="assist-pills ask-hero-pills" role="list" aria-label="Suggestions">
          {suggestions.map((s) => (
            <button key={s.label} role="listitem" className="assist-pill" disabled={busy} onClick={() => submit(undefined, s.question)}>
              <s.icon size={14} />
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Side panel: history

/** Groups chats by when they were last used (UTC dates, matching the timestamps shown everywhere else). */
function groupChats(items: AssistantSession[]): { label: string; items: AssistantSession[] }[] {
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  const today = day(0);
  const yesterday = day(1);
  const weekAgo = day(7);
  const groups: Record<string, AssistantSession[]> = { Today: [], Yesterday: [], "Previous 7 days": [], Older: [] };
  for (const s of items) {
    const d = s.updated_at.slice(0, 10);
    if (d === today) groups.Today.push(s);
    else if (d === yesterday) groups.Yesterday.push(s);
    else if (d >= weekAgo) groups["Previous 7 days"].push(s);
    else groups.Older.push(s);
  }
  return Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([label, list]) => ({ label, items: list }));
}

function HistoryView() {
  const a = useAssistant();
  const chat = a.chat;
  const list = useAsync(() => api.assistantSessions(), [chat.version]);
  const [filter, setFilter] = useState("");
  const busy = chat.pending !== null;

  const groups = useMemo(() => {
    const items = list.data?.items ?? [];
    const f = filter.trim().toLowerCase();
    return groupChats(f ? items.filter((s) => s.title.toLowerCase().includes(f)) : items);
  }, [list.data, filter]);

  return (
    <div className="assist-history">
      <div className="assist-history-head">
        <button
          className="btn btn-primary assistant-new"
          onClick={() => {
            chat.newChat();
            a.setView("chat");
          }}
          disabled={busy}
        >
          <IconPlus size={16} /> New chat
        </button>
        {list.data?.items.length ? (
          <label className="assistant-filter">
            <IconSearch size={15} />
            <span className="visually-hidden">Search chats</span>
            <input type="search" placeholder="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        ) : null}
      </div>
      <div className="assist-scroll">
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <p className="muted small assistant-side-note">Loading chats...</p>
        ) : !list.data.items.length ? (
          <div className="assistant-side-empty">
            <IconChat size={22} />
            <p className="small">No chats yet. Your conversations will appear here.</p>
          </div>
        ) : !groups.length ? (
          <p className="muted small assistant-side-note">No chats match &ldquo;{filter}&rdquo;.</p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="assistant-group">
              <div className="assistant-group-label">{g.label}</div>
              <ul className="assistant-session-list">
                {g.items.map((s) => (
                  <li key={s.session_id} className={s.session_id === chat.sessionId ? "active" : undefined}>
                    <button
                      className="assistant-session"
                      onClick={() => {
                        chat.open(s.session_id);
                        a.setView("chat");
                      }}
                      disabled={busy}
                      aria-current={s.session_id === chat.sessionId ? "true" : undefined}
                      title={s.title}
                    >
                      <span className="assistant-session-title">{s.title}</span>
                      <span className="assistant-session-meta">
                        {g.label === "Today" || g.label === "Yesterday" ? fmtTime(s.updated_at).slice(11) : fmtTime(s.updated_at).slice(0, 10)} &middot;{" "}
                        {s.messages} {s.messages === 1 ? "question" : "questions"}
                      </span>
                    </button>
                    <button
                      className="assistant-session-delete"
                      title="Delete this chat"
                      aria-label={`Delete chat: ${s.title}`}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete the chat "${s.title}"?`)) void chat.remove(s.session_id);
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Side panel: chat with context, suggestions and "/" actions

interface Suggestion {
  icon: typeof IconSparkle;
  label: string;
  /** Sent as the question; omitted for suggestions that open the action menu. */
  question?: string;
  analytics?: boolean;
  slash?: boolean;
}

const CASE_SUGGESTIONS: Suggestion[] = [
  { icon: IconCases, label: "Summarize this case", question: "Summarize this case: what happened, which accounts were involved and how much money moved?" },
  { icon: IconTarget, label: "Why was it flagged?", question: "Why was this case flagged? List the strongest signals." },
  { icon: IconFlow, label: "Where did the money end up?", question: "Where did the money in this case end up, and how fast did it move?" },
  { icon: IconBolt, label: "Take a mitigation action", slash: true },
  { icon: IconSearch, label: "What should I verify next?", question: "What should I verify next on this case, and with whom?" },
  { icon: IconChat, label: "Could this be legitimate?", question: "Is there a plausible legitimate explanation for the activity in this case?" },
];

const WORKSPACE_SUGGESTIONS: Suggestion[] = [
  { icon: IconCases, label: "High priority open cases", question: "High priority open cases" },
  { icon: IconNetwork, label: "Accounts with rapid onward movement", question: "Which accounts received money with rapid onward movement?" },
  { icon: IconTransactions, label: "IMPS transfers above 1 lakh to new accounts", question: "IMPS transfers above 1 lakh to new accounts" },
  { icon: IconFlow, label: "Flagged amount by channel", question: "Flagged amount by channel", analytics: true },
  { icon: IconTransactions, label: "Transfers from minimum-KYC accounts", question: "Transfers from minimum-KYC accounts above 50,000" },
  { icon: IconFlow, label: "Daily high-priority transfers in September", question: "Daily count of high-priority transfers in September", analytics: true },
];

/** Short names for the "/" menu. */
const ACTION_SLUG: Record<string, string> = {
  HOLD_FOR_REVIEW: "hold",
  ENHANCED_MONITORING: "monitor",
  REQUEST_CUSTOMER_VERIFICATION: "verify",
  REQUEST_SOURCE_OF_FUNDS: "source-of-funds",
  KYC_REFRESH: "kyc",
  NOTIFY_COUNTERPARTY_INSTITUTION: "notify",
  FILE_INTERNAL_SUSPICION_REPORT: "report",
};

interface ProposedAction {
  code: string;
  label: string;
  target: string | null;
  effect: string;
  rationale: string;
  kind: string;
}

interface Command {
  id: string;
  slug: string;
  label: string;
  hint: string;
  icon: typeof IconSparkle;
  action?: ProposedAction;
  run?: () => void;
}

interface ActionLog {
  id: number;
  ok: boolean;
  caseId: string;
  label: string;
  target: string | null;
  text: string;
  at: string;
}

function buildActionCommands(d: CaseDetail): Command[] {
  const inEffect = new Set(
    d.actions.filter((x) => x.status === "ACTIVE" || x.status === "OPEN").map((x) => `${x.action_code}|${x.target_account ?? ""}`),
  );
  const catalog = new Map(d.action_catalog.map((c) => [c.code, c]));
  const out: Command[] = [];
  const add = (code: string, target: string | null, rationale: string) => {
    const meta = catalog.get(code);
    const slug = ACTION_SLUG[code];
    if (!meta || !slug || inEffect.has(`${code}|${target ?? ""}`)) return;
    if (out.some((c) => c.action?.code === code && c.action.target === target)) return;
    out.push({
      id: `${code}|${target ?? ""}`,
      slug,
      label: target ? `${meta.label} · ${target}` : meta.label,
      hint: rationale || meta.description,
      icon: meta.kind === "CONTROL" ? IconTarget : IconBolt,
      action: { code, label: meta.label, target, effect: meta.effect, rationale: rationale || meta.description, kind: meta.kind },
    });
  };
  for (const s of d.suggested_actions) add(s.action_code, s.target_account, s.rationale);
  // Case-wide follow-ups are always offered (they need no target account).
  for (const c of d.action_catalog) if (!c.needs_target) add(c.code, null, "");
  return out;
}

function ChatPanelView() {
  const a = useAssistant();
  const chat = a.chat;
  const { analystName } = usePrefs();
  const analytics = cloudOn(useCloud(), "bigquery");
  const [q, setQ] = useState("");
  const [detached, setDetached] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [confirm, setConfirm] = useState<ProposedAction | null>(null);
  const [applying, setApplying] = useState(false);
  const [log, setLog] = useState<ActionLog[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = chat.pending !== null;
  useAutoGrow(inputRef, q);

  const ctx = a.context && detached !== a.context.caseId ? a.context : null;
  const detail = useAsync<CaseDetail | null>(() => (ctx ? api.case(ctx.caseId) : Promise.resolve(null)), [ctx?.caseId, a.caseChanges]);
  const caseData = ctx && detail.data?.case.case_id === ctx.caseId ? detail.data : null;
  const evidence = useMemo(() => new Map((caseData?.evidence ?? []).map((e) => [e.evidence_id, e])), [caseData]);

  // A new page context re-attaches; a new chat clears the action log.
  useEffect(() => setDetached(null), [a.context?.caseId]);
  // Switching to another chat (or starting a new one) clears the action log; the first answer of a chat does not.
  const prevSession = useRef(chat.sessionId);
  useEffect(() => {
    if (prevSession.current !== null && prevSession.current !== chat.sessionId) {
      setLog([]);
      setConfirm(null);
    }
    prevSession.current = chat.sessionId;
  }, [chat.sessionId]);

  // Focus the box when the panel opens or a chat is opened.
  useEffect(() => {
    inputRef.current?.focus();
  }, [chat.sessionId]);

  const commands = useMemo<Command[]>(() => {
    const global: Command[] = [
      { id: "new", slug: "new", label: "New chat", hint: "Start a fresh conversation", icon: IconPlus, run: () => chat.newChat() },
      { id: "history", slug: "history", label: "Chat history", hint: "Open an earlier conversation", icon: IconMenu, run: () => a.setView("history") },
      { id: "help", slug: "help", label: "What can you do?", hint: "What the assistant can answer", icon: IconInfo, run: () => void chat.ask("What can you do?") },
    ];
    return [...(caseData ? buildActionCommands(caseData) : []), ...global];
  }, [caseData, chat, a]);

  const slash = q.startsWith("/") && !menuClosed ? q.slice(1).trim().toLowerCase() : null;
  const matches = useMemo(() => {
    if (slash === null) return [];
    return commands.filter((c) => !slash || c.slug.startsWith(slash) || c.label.toLowerCase().includes(slash));
  }, [commands, slash]);
  useEffect(() => setMenuIndex(0), [slash]);

  function choose(c: Command) {
    setQ("");
    setMenuClosed(false);
    if (c.action) setConfirm(c.action);
    else c.run?.();
  }

  function submit(e?: FormEvent, text?: string) {
    e?.preventDefault();
    if (slash !== null) {
      if (matches[menuIndex]) choose(matches[menuIndex]);
      return;
    }
    const question = (text ?? q).trim();
    if (question.length < 3 || busy) return;
    setQ("");
    void chat.ask(question, ctx?.caseId ?? null);
  }

  async function approve() {
    if (!confirm || !ctx) return;
    setApplying(true);
    const at = new Date().toISOString();
    try {
      const r = await api.approveAction(ctx.caseId, {
        action_code: confirm.code,
        target_account: confirm.target,
        source: "PLAYBOOK",
        note: "Approved from the assistant panel",
        actor_label: analystName,
      });
      setLog((l) => [...l, { id: Date.now(), ok: true, caseId: ctx.caseId, label: confirm.label, target: confirm.target, text: r.effect, at }]);
      a.notifyCaseChanged();
    } catch (err) {
      setLog((l) => [...l, { id: Date.now(), ok: false, caseId: ctx.caseId, label: confirm.label, target: confirm.target, text: errorMessage(err), at }]);
    } finally {
      setApplying(false);
      setConfirm(null);
    }
  }

  const empty = !chat.messages.length && !busy && !log.length;
  const firstName = analystName.trim().split(/\s+/)[0] || "there";
  const suggestions = (ctx ? CASE_SUGGESTIONS : WORKSPACE_SUGGESTIONS).filter((s) => analytics || !s.analytics);

  const logView = log.length ? (
    <>
      {log.map((x) => (
        <div key={x.id} className={x.ok ? "assist-log assist-log-ok" : "assist-log assist-log-error"} role="status">
          <span className="assist-log-icon" aria-hidden="true">{x.ok ? <IconBolt size={14} /> : <IconInfo size={14} />}</span>
          <div className="assist-log-body">
            <strong>
              {x.ok ? "Applied" : "Not applied"}: {x.label}
              {x.target ? <span className="mono"> · {x.target}</span> : null}
            </strong>
            <span className="small">{x.text}</span>
            <span className="muted small">
              {fmtTime(x.at).slice(11)} UTC &middot; <Link to={`/cases/${x.caseId}#actions-heading`}>View on {x.caseId}</Link>
            </span>
          </div>
        </div>
      ))}
    </>
  ) : null;

  return (
    <div className="assist-chat">
      <div className="assist-scroll">
        {chat.loading ? <Busy label="Opening the chat..." /> : null}
        {empty && !chat.loading ? (
          <div className="assist-welcome">
            <span className="assist-welcome-mark" aria-hidden="true">
              <IconSparkle size={30} />
            </span>
            <h2>How can I help, {firstName}?</h2>
            <p className="muted">
              {ctx ? <>Ask anything about {ctx.caseId}, or type <span className="kbd">/</span> to act on it.</> : "Ask about cases, transfers, accounts and trends across the workspace."}
            </p>
          </div>
        ) : null}
        {!empty ? <ChatThread chat={chat} evidence={evidence} extra={logView} typingLabel={ctx ? `Reading ${ctx.caseId}...` : undefined} /> : null}
      </div>

      <div className="assist-dock">
        {chat.error ? <div className="callout callout-error small" role="alert">{chat.error}</div> : null}

        {confirm && ctx ? (
          <div className="assist-confirm" role="dialog" aria-label={`Approve ${confirm.label}`}>
            <div className="assist-confirm-head">
              <IconBolt size={15} />
              <strong>
                {confirm.label}
                {confirm.target ? <span className="mono"> · {confirm.target}</span> : null}
              </strong>
            </div>
            <p className="small" style={{ margin: 0 }}>{confirm.rationale}</p>
            <p className="small muted" style={{ margin: 0 }}>
              <strong>Effect:</strong> {confirm.effect}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              Applies to {ctx.caseId} in this workspace and is recorded in the audit trail as approved by {analystName}.
            </p>
            <div className="row-center" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-small" onClick={() => setConfirm(null)} disabled={applying}>
                Cancel
              </button>
              <button className="btn btn-small btn-primary" onClick={() => void approve()} disabled={applying}>
                {applying ? <span className="spinner" aria-hidden="true" /> : null} Approve and apply
              </button>
            </div>
          </div>
        ) : null}

        {!confirm && suggestions.length ? (
          <div className="assist-pills" role="list" aria-label="Suggestions">
            {suggestions.map((s) => (
              <button
                key={s.label}
                role="listitem"
                className="assist-pill"
                disabled={busy || (s.slash && !caseData)}
                onClick={() => {
                  if (s.slash) {
                    setQ("/");
                    setMenuClosed(false);
                    inputRef.current?.focus();
                  } else if (s.question) submit(undefined, s.question);
                }}
              >
                <s.icon size={14} />
                {s.label}
              </button>
            ))}
          </div>
        ) : null}

        {a.context ? (
          <div className="assist-context">
            <span className="muted small">Context:</span>
            {ctx ? (
              <span className="assist-context-chip" title={`${ctx.caseId} · ${ctx.title}`}>
                <IconCases size={13} />
                <span className="assist-context-text">
                  <span className="mono">{ctx.caseId}</span>: {ctx.title}
                </span>
                <button aria-label="Remove the case from the context" title="Remove from context" onClick={() => setDetached(ctx.caseId)}>
                  <IconClose size={13} />
                </button>
              </span>
            ) : (
              <button className="assist-context-add" onClick={() => setDetached(null)}>
                <IconPlus size={13} /> Add {a.context.caseId}
              </button>
            )}
          </div>
        ) : null}

        <form className="assist-composer" onSubmit={submit}>
          {slash !== null ? (
            <div className="assist-menu" role="listbox" aria-label="Actions">
              {caseData ? <div className="assist-menu-label">Actions for {ctx?.caseId}</div> : null}
              {!matches.length ? <div className="assist-menu-empty muted small">No action matches &ldquo;/{slash}&rdquo;.</div> : null}
              {matches.map((c, i) => (
                <button
                  type="button"
                  key={c.id}
                  role="option"
                  aria-selected={i === menuIndex}
                  className={i === menuIndex ? "assist-menu-item active" : "assist-menu-item"}
                  onMouseEnter={() => setMenuIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(c)}
                >
                  <span className="assist-menu-icon"><c.icon size={14} /></span>
                  <span className="assist-menu-text">
                    <span>
                      <span className="mono assist-menu-slug">/{c.slug}</span> {c.label}
                    </span>
                    <span className="muted small">{c.hint}</span>
                  </span>
                </button>
              ))}
              {!caseData ? <div className="assist-menu-empty muted small">Open a case to approve mitigation actions from here.</div> : null}
            </div>
          ) : null}
          <label>
            <span className="visually-hidden">Ask, or type / for actions</span>
            <textarea
              ref={inputRef}
              rows={2}
              value={q}
              maxLength={300}
              placeholder={ctx ? `Ask about ${ctx.caseId}, or type / for actions` : "Ask about cases, transfers or accounts, or type / for actions"}
              onChange={(e) => {
                setQ(e.target.value);
                if (!e.target.value.startsWith("/")) setMenuClosed(false);
              }}
              onKeyDown={(e) => {
                if (slash !== null && matches.length) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMenuIndex((i) => (i + 1) % matches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
                    return;
                  }
                }
                if (e.key === "Escape" && slash !== null) {
                  e.preventDefault();
                  setMenuClosed(true);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
              }}
            />
          </label>
          <div className="assist-composer-foot">
            <button
              type="button"
              className="assist-tool"
              onClick={() => {
                setQ("/");
                setMenuClosed(false);
                inputRef.current?.focus();
              }}
              title="Actions"
              aria-label="Show actions"
            >
              <IconBolt size={15} />
            </button>
            <span className="grow" aria-hidden="true" />
            <button className="chat-send" type="submit" disabled={busy || (slash === null && q.trim().length < 3)} aria-label="Send" title="Send (Enter)">
              {busy ? <span className="spinner" aria-hidden="true" /> : <IconSend size={16} />}
            </button>
          </div>
        </form>
        <p className="assist-foot">
          <IconInfo size={12} /> Uses AI. Check results before acting.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Side panel

export function AssistantPanel() {
  const a = useAssistant();
  const chat = a.chat;

  // Ctrl+J (or Cmd+J) opens and closes the panel; Escape closes it when focus is inside.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        a.toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a]);

  if (!a.open) return null;
  const title = a.view === "history" ? "Chats" : chat.session?.title ?? "New chat";

  return (
    <aside
      id="assistant-panel"
      className="assist-panel"
      aria-label="FraudGraph AI assistant"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !(e.target as HTMLElement).closest(".assist-composer")) a.hide();
      }}
    >
      <header className="assist-head">
        <button
          className="assist-icon"
          onClick={() => a.setView(a.view === "history" ? "chat" : "history")}
          aria-label={a.view === "history" ? "Back to the chat" : "Chat history"}
          aria-pressed={a.view === "history"}
          title={a.view === "history" ? "Back to the chat" : "Chat history"}
        >
          <IconMenu size={17} />
        </button>
        <span className="assist-brand-mark" aria-hidden="true"><IconSparkle size={14} /></span>
        <div className="assist-title">
          <strong>FraudGraph AI</strong>
          <span className="muted small" title={title}>{title}</span>
        </div>
        <button
          className="assist-icon"
          onClick={() => {
            chat.newChat();
            a.setView("chat");
          }}
          disabled={chat.pending !== null || (!chat.sessionId && a.view === "chat")}
          aria-label="New chat"
          title="New chat"
        >
          <IconPlus size={17} />
        </button>
        <button
          className="assist-icon assist-expand"
          onClick={() => a.setExpanded(!a.expanded)}
          aria-label={a.expanded ? "Narrow the panel" : "Widen the panel"}
          aria-pressed={a.expanded}
          title={a.expanded ? "Narrow the panel" : "Widen the panel"}
        >
          <IconExpand size={16} />
        </button>
        <button className="assist-icon" onClick={a.hide} aria-label="Close the assistant" title="Close (Ctrl+J)">
          <IconClose size={17} />
        </button>
      </header>
      {a.view === "history" ? <HistoryView /> : <ChatPanelView />}
    </aside>
  );
}
