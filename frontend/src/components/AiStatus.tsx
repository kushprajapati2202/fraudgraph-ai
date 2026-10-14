import type { AiState } from "../api/client";
import { useAiStatus } from "../health";
import { fmtTime } from "../util";

const VIEW: Record<AiState, { tone: string; icon: string; short: string; title: string }> = {
  CONNECTED: { tone: "ok", icon: "✓", short: "AI connected", title: "Gemini is connected" },
  DEGRADED: { tone: "warn", icon: "◐", short: "AI busy", title: "Key valid, Gemini busy" },
  INVALID_KEY: { tone: "bad", icon: "✕", short: "AI key rejected", title: "Gemini rejected the API key" },
  UNREACHABLE: { tone: "bad", icon: "✕", short: "AI unreachable", title: "Gemini could not be reached" },
  NOT_CONFIGURED: { tone: "off", icon: "○", short: "AI not configured", title: "Gemini is not configured" },
};

const HELP: Record<AiState, string> = {
  CONNECTED: "Investigations and follow-up questions will use Gemini.",
  DEGRADED: "Nothing is wrong with your setup. Google's models are busy or slow right now; the app tries each configured model in turn and falls back to rule findings if none answers.",
  INVALID_KEY: "Fix GEMINI_API_KEY in .env (no quotes or spaces; create one at aistudio.google.com/apikey), then restart the server.",
  UNREACHABLE: "The server could not reach Google's API. Check the network or proxy, then re-check.",
  NOT_CONFIGURED: "Add GEMINI_API_KEY to .env and restart the server. Everything except AI explanations works without it.",
};

/** Compact pill for the top bar. */
export function AiStatusPill() {
  const { status, checking, recheck } = useAiStatus();
  if (!status) {
    return (
      <span className="ai-pill ai-pill-off" data-tour="ai-status" role="status">
        <span className="spinner" aria-hidden="true" /> Checking AI...
      </span>
    );
  }
  const v = VIEW[status.state];
  return (
    <button
      className={`ai-pill ai-pill-${v.tone}`}
      data-tour="ai-status"
      onClick={() => recheck(true)}
      disabled={checking}
      title={`${v.title}. ${status.message} Click to re-check.`}
    >
      {checking ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">{v.icon}</span>} {v.short}
      {status.active_model ? <span className="ai-pill-model"> &middot; {status.active_model}</span> : null}
    </button>
  );
}

/** Full explanation card for the dashboard. */
export function AiStatusCard() {
  const { status, checking, error, recheck } = useAiStatus();
  const v = status ? VIEW[status.state] : null;
  return (
    <section className={`card ai-status-card ai-status-${v?.tone ?? "off"}`} aria-labelledby="ai-status-heading" data-tour="ai-status-card">
      <div className="card-head">
        <h2 id="ai-status-heading">
          <span className={`ai-dot ai-dot-${v?.tone ?? "off"}`} aria-hidden="true">
            {v?.icon ?? "…"}
          </span>{" "}
          {status ? v!.title : "Checking Gemini connection..."}
        </h2>
        <button className="btn btn-small" onClick={() => recheck(true)} disabled={checking}>
          {checking ? "Checking..." : "Re-check now"}
        </button>
      </div>
      {error ? <p className="muted">Could not load AI status: {error}</p> : null}
      {status ? (
        <div className="stack-sm">
          <p>{status.message}</p>
          <p className="muted small">{HELP[status.state]}</p>
          <dl className="kv ai-kv">
            <dt>API key</dt>
            <dd>
              {status.key_valid === true ? "✓ accepted by Google" : status.key_valid === false ? "✕ rejected" : status.configured ? "could not be verified" : "not set"}
              {status.key_format_ok === false ? " (format looks wrong: check for quotes or spaces)" : ""}
            </dd>
            <dt>Platform</dt>
            <dd>{status.backend ?? "Gemini API"}</dd>
            <dt>Model in use</dt>
            <dd className="mono">{status.active_model ?? "none responding"}</dd>
            <dt>Model order</dt>
            <dd className="mono small">{status.model_chain.join(" → ")}</dd>
            <dt>Last checked</dt>
            <dd>{status.checked_at ? `${fmtTime(status.checked_at)} UTC${status.cached ? " (cached)" : ""}` : "never"}</dd>
          </dl>
          {status.attempts.length ? (
            <details>
              <summary className="small">Model check details</summary>
              <ul className="plain small">
                {status.attempts.map((a) => (
                  <li key={a.model}>
                    <span className="mono">{a.model}</span>: {a.ok ? "✓ responded" : a.category.replace(/_/g, " ").toLowerCase()} in {a.seconds}s
                    {a.detail ? <span className="muted"> &mdash; {a.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
