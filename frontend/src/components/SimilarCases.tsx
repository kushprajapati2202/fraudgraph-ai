import { api, type ActionCatalogItem, type SimilarMatch } from "../api/client";
import { useAsync } from "../util";
import { ErrorState, Loading } from "./common";
import { IconSparkle } from "./icons";

const OUTCOME: Record<string, { cls: string; icon: string }> = {
  CONFIRMED_FRAUD: { cls: "badge-high", icon: "▲" },
  LEGITIMATE: { cls: "badge-low", icon: "●" },
  INCONCLUSIVE: { cls: "badge-none", icon: "◆" },
};

function Match({ m, labelOf, counter }: { m: SimilarMatch; labelOf: (code: string) => string; counter?: boolean }) {
  const o = OUTCOME[m.outcome] ?? OUTCOME.INCONCLUSIVE;
  return (
    <li className={`precedent ${counter ? "precedent-counter" : ""}`}>
      <div className="precedent-head">
        <div style={{ minWidth: 0 }}>
          <div className="action-title">{m.title}</div>
          <div className="small muted mono">
            {m.archive_id} &middot; resolved in {m.days_to_resolve} {m.days_to_resolve === 1 ? "day" : "days"}
          </div>
        </div>
        <span className={`badge ${o.cls}`}>
          <span aria-hidden="true">{o.icon}</span> {m.outcome_label}
        </span>
      </div>
      <div className="strength" title="Relative match strength within the archive, not a probability">
        <span className="hbar-track" aria-hidden="true">
          <span className="hbar-fill" style={{ width: `${Math.round(m.similarity * 100)}%` }} />
        </span>
        <span className="small tnum">{Math.round(m.similarity * 100)}% match</span>
      </div>
      <p className="small" style={{ marginTop: 6 }}>{m.pattern}</p>
      <p className="small" style={{ marginTop: 6 }}>
        <strong>How it was resolved:</strong> {m.resolution}
      </p>
      <div className="chip-row" style={{ marginTop: 8 }}>
        {m.actions_taken.map((a) => (
          <span key={a} className="chip">
            {labelOf(a)}
          </span>
        ))}
      </div>
      {m.shared_signals.length ? (
        <div className="small muted" style={{ marginTop: 6 }}>
          Signals in common: {m.shared_signals.map((s) => s.label).join(", ")}
        </div>
      ) : null}
    </li>
  );
}

/** Resolved cases with a similar pattern, found with Gemini embeddings (falls back to rule-signal overlap). */
export default function SimilarCases({ caseId, catalog }: { caseId: string; catalog: ActionCatalogItem[] }) {
  const { data, error, loading, reload } = useAsync(() => api.similarCases(caseId), [caseId]);
  const labels = new Map(catalog.map((a) => [a.code, a.label]));
  const labelOf = (code: string) => labels.get(code) ?? code;

  return (
    <section className="card ai-card" aria-labelledby="similar-heading" data-tour="case-similar" id="sec-similar">
      <div className="card-head">
        <div>
          <h2 id="similar-heading">
            <span className="ai-mark">
              <IconSparkle size={17} />
            </span>{" "}
            Similar resolved cases
          </h2>
          <div className="card-sub">How comparable patterns ended, and what was done about them</div>
        </div>
        {data ? <span className="chip chip-ai">{data.method === "GEMINI_EMBEDDINGS" ? "Gemini embeddings" : "Signal overlap"}</span> : null}
      </div>
      {loading && !data ? <Loading label="Finding similar cases" /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <>
          {data.method !== "GEMINI_EMBEDDINGS" ? (
            <div className="callout callout-warn small" style={{ marginBottom: 10 }}>
              Embeddings are unavailable ({(data.fallback_reason ?? "error").replace(/_/g, " ").toLowerCase()}), so matches are ranked by shared rule signals only.{" "}
              <button className="link-button" onClick={reload}>
                Try again
              </button>
            </div>
          ) : null}
          <ul className="precedent-list">
            {data.matches.map((m) => (
              <Match key={m.archive_id} m={m} labelOf={labelOf} />
            ))}
          </ul>
          {data.counter_example ? (
            <>
              <h3 className="section-title" style={{ marginTop: 14 }}>Closest case that ended differently</h3>
              <ul className="precedent-list">
                <Match m={data.counter_example} labelOf={labelOf} counter />
              </ul>
            </>
          ) : null}
          <details style={{ marginTop: 12 }}>
            <summary className="small" style={{ cursor: "pointer", color: "var(--muted)", fontWeight: 600 }}>How matching works</summary>
            <p className="small muted" style={{ marginTop: 6 }}>
              This case is described in plain language without names or account numbers: &ldquo;{data.case_description}&rdquo;
            </p>
            <p className="small muted" style={{ marginTop: 6 }}>
              Scoring: {data.scoring}. Compared with {data.archive_size} archived cases{data.model ? ` using ${data.model}` : ""}.
            </p>
          </details>
          <p className="muted small" style={{ marginTop: 10 }}>{data.note}</p>
        </>
      ) : null}
    </section>
  );
}
