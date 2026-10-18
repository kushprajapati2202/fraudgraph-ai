import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { BigQueryAskResult, CloudStatus, Insight, SecondReader, StreamEvent } from "../api/client";
import { Busy, SourceNote, Unavailable, useRun } from "./ai";
import { HBars } from "./charts";
import { ControlTag, Empty, ErrorState, Loading, RiskBadge } from "./common";
import { IconSparkle } from "./icons";
import { fmtTime, useAsync } from "../util";

// ---- Which Google Cloud services this deployment has (fetched once per page load) ----

let cloudPromise: Promise<CloudStatus> | null = null;

export function useCloud(): CloudStatus | null {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  useEffect(() => {
    cloudPromise ??= api.cloudStatus().catch(() => ({ project: null, services: [] }));
    let live = true;
    cloudPromise.then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);
  return status;
}

export function cloudOn(status: CloudStatus | null, key: string): boolean {
  return !!status?.services.find((s) => s.key === key)?.enabled;
}

function AiTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id}>
      <span className="ai-mark">
        <IconSparkle size={17} />
      </span>{" "}
      {children}
    </h2>
  );
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);

// ---- Case page: BigQuery ML second view ----

const ML_CHIP = {
  AGREE: { label: "ML agrees", cls: "opinion-agree" },
  MODEL_HIGHER: { label: "ML rates higher", cls: "opinion-differ" },
  RULES_HIGHER: { label: "ML rates lower", cls: "opinion-differ" },
};

/** Header chip: does the BigQuery ML model agree with the rules? Hidden until the model has scored the case. */
export function CaseMlChip({ caseId }: { caseId: string }) {
  const { data } = useAsync(() => api.caseMl(caseId), [caseId]);
  if (!data?.enabled || !data.top || !data.agreement) return null;
  const chip = ML_CHIP[data.agreement];
  return (
    <a
      href="#sec-ml"
      className={`chip opinion ${chip.cls}`}
      style={{ textDecoration: "none" }}
      title={`BigQuery ML likelihood ${pct(data.top.probability)} for ${data.top.transaction_id}, rule score ${data.case_rule_score}. Trained on synthetic labels; a second view, not a finding.`}
    >
      <span aria-hidden="true">{"◆"}</span> {chip.label} · p={data.top.probability.toFixed(2)}
    </a>
  );
}

export function CaseMlCard({ caseId }: { caseId: string }) {
  const { data, error, loading, reload } = useAsync(() => api.caseMl(caseId), [caseId]);
  if (!data?.enabled && !loading && !error) return null;
  const top = data?.top;
  const agreement = {
    AGREE: { text: "Model agrees with the rules", cls: "opinion-agree" },
    MODEL_HIGHER: { text: "Model rates this higher than the rules", cls: "opinion-differ" },
    RULES_HIGHER: { text: "Model rates this lower than the rules", cls: "opinion-differ" },
  };
  return (
    <section className="card ai-card" aria-labelledby="ml-heading" id="sec-ml">
      <div className="card-head">
        <div>
          <h2 id="ml-heading">Second view from BigQuery ML</h2>
          <div className="card-sub">A boosted-tree model trained on behaviour, independent of the rule weights. Trained on synthetic labels, so its confidence is optimistic.</div>
        </div>
        <span className="chip">BigQuery ML</span>
      </div>
      {loading && !data ? <Loading label="Loading model scores" /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && !top ? <Empty>The model has not scored these transfers yet. Train it from Settings › Google Cloud.</Empty> : null}
      {data && top ? (
        <>
          <div className="row" style={{ gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div className="kpi-value tnum">{pct(top.probability)}</div>
              <div className="small muted">model likelihood for {top.transaction_id}, the highest in this case</div>
            </div>
            {data.agreement ? <span className={`chip opinion ${agreement[data.agreement].cls}`}>{agreement[data.agreement].text}</span> : null}
          </div>
          <h3 className="section-title" style={{ marginTop: 12 }}>What drove the model (ML.EXPLAIN_PREDICT)</h3>
          <HBars
            unit=""
            format={(v) => v.toFixed(2)}
            items={top.top_features.map((f) => ({ key: f.feature, label: f.label, value: Math.abs(f.attribution), note: f.attribution >= 0 ? "raises" : "lowers" }))}
          />
          <details style={{ marginTop: 10 }}>
            <summary className="small" style={{ cursor: "pointer", color: "var(--muted)", fontWeight: 600 }}>
              Every transfer in the case ({data.transfers.length})
            </summary>
            <table className="table small" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>Transfer</th>
                  <th className="num">Rule score</th>
                  <th className="num">Model</th>
                </tr>
              </thead>
              <tbody>
                {data.transfers.map((t) => (
                  <tr key={t.transaction_id}>
                    <td className="mono">{t.transaction_id}</td>
                    <td className="num tnum">{t.rule_score ?? "–"}</td>
                    <td className="num tnum">{pct(t.probability)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <p className="muted small" style={{ marginTop: 8 }}>
            The rule score stays the basis for priority. The model was trained on labelled synthetic scenarios, so it shows a second
            perspective, not a measured real-world accuracy.
          </p>
        </>
      ) : null}
    </section>
  );
}

// ---- Case page: policy guidance from Vertex AI Search ----

export function PolicyCard({ caseId }: { caseId: string }) {
  const cloud = useCloud();
  const enabled = cloudOn(cloud, "vertex_search");
  const stored = useAsync(() => (enabled ? api.casePolicy(caseId) : Promise.resolve(null)), [caseId, enabled]);
  const [rec, setRec] = useState<Insight<import("../api/client").PolicyResult> | null>(null);
  const { busy, error, run } = useRun();
  if (!enabled) return null;
  const current = rec ?? stored.data;
  const result = current?.response.result;
  return (
    <section className="card ai-card" aria-labelledby="policy-heading" id="sec-policy">
      <div className="card-head">
        <div>
          <AiTitle id="policy-heading">What our policy says</AiTitle>
          <div className="card-sub">Passages retrieved with Vertex AI Search; every step cites the passage it comes from</div>
        </div>
        <button className="btn btn-small btn-ai" disabled={busy} onClick={() => run(() => api.makeCasePolicy(caseId)).then((r) => r && setRec(r))}>
          {current ? "Ask again" : "Find policy guidance"}
        </button>
      </div>
      {busy ? <Busy label="Searching the policy library" /> : null}
      {error ? <ErrorState message={error} /> : null}
      {current ? <Unavailable rec={current} what="Policy search" /> : null}
      {!current && !busy ? <Empty>Search the financial-crime policy library for what this pattern requires next.</Empty> : null}
      {result ? (
        <>
          <p style={{ marginBottom: 8 }}>{result.summary}</p>
          {result.steps.length ? (
            <ol className="step-list">
              {result.steps.map((s, i) => (
                <li key={i}>
                  {s.step}{" "}
                  <span className="citations">
                    {s.citations.map((c) => (
                      <a key={c} href={`#${caseId}-${c}`} className="citation">
                        {c}
                      </a>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          <h3 className="section-title" style={{ marginTop: 12 }}>Retrieved passages</h3>
          <ul className="precedent-list">
            {result.passages.map((p) => (
              <li key={p.id} id={`${caseId}-${p.id}`}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{p.title}</strong>
                  <span className="chip mono">{p.id}</span>
                </div>
                <p className="small" style={{ marginTop: 4 }}>{p.text}</p>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 8 }}>
            <SourceNote rec={current!} />
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---- Overview: Ask BigQuery (Gemini writes the query, code gates it; the query itself is never shown) ----

const BQ_EXAMPLES = [
  "Total amount and transfer count by channel for flagged transfers",
  "Daily count of high-priority transfers in September",
  "Which receiving accounts got money from the most distinct senders?",
  "How much money is currently held by controls, per case?",
];

/** `embedded` renders the panel without its own card, for use inside another card (the overview's "For you" card). */
export function AskBigQueryCard({ embedded = false }: { embedded?: boolean }) {
  const cloud = useCloud();
  const [question, setQuestion] = useState("");
  const [rec, setRec] = useState<Insight<BigQueryAskResult> | null>(null);
  const { busy, error, run } = useRun();
  if (!cloudOn(cloud, "bigquery")) return null;
  const ask = (q: string) => {
    setQuestion(q);
    run(() => api.askBigQuery(q)).then((r) => r && setRec(r));
  };
  const r = rec?.response.result;
  const chartItems =
    r && r.chart !== "TABLE"
      ? r.rows.slice(0, 15).map((row, i) => ({ key: String(i), label: String(row[r.x_column]), value: Number(row[r.y_column]) || 0 }))
      : [];
  const Wrap = embedded ? "div" : "section";
  return (
    <Wrap className={embedded ? "bq-embedded" : "card ai-card"} aria-labelledby={embedded ? undefined : "bq-heading"} id="sec-bigquery">
      {embedded ? (
        <p className="muted small" style={{ marginTop: 0 }}>Answers come straight from the analytics data. Every query is read-only and checked before it runs.</p>
      ) : (
        <div className="card-head">
          <div>
            <AiTitle id="bq-heading">Ask BigQuery</AiTitle>
            <div className="card-sub">Answers come straight from the analytics data. Every query is read-only and checked before it runs</div>
          </div>
          <span className="chip">BigQuery</span>
        </div>
      )}
      <form
        className="row"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length >= 3) ask(question.trim());
        }}
      >
        <input className="input" style={{ flex: 1 }} value={question} maxLength={300} placeholder="Ask anything about transfers, cases, accounts or controls" onChange={(e) => setQuestion(e.target.value)} aria-label="Question for BigQuery" />
        <button className="btn btn-ai" disabled={busy || question.trim().length < 3}>
          Ask
        </button>
      </form>
      <div className="chip-row" style={{ marginTop: 8 }}>
        {BQ_EXAMPLES.map((q) => (
          <button key={q} className="chip chip-button" disabled={busy} onClick={() => ask(q)}>
            {q}
          </button>
        ))}
      </div>
      {busy ? <Busy label="Looking up the answer" /> : null}
      {error ? <ErrorState message={error} /> : null}
      {rec ? <Unavailable rec={rec} what="Gemini" /> : null}
      {r ? (
        <div style={{ marginTop: 12 }}>
          <p>
            <strong>{r.answer}</strong>
          </p>
          <p className="small muted">{r.interpretation}</p>
          {chartItems.length ? (
            <div style={{ marginTop: 8 }}>
              <HBars unit="" items={chartItems} format={(v) => v.toLocaleString("en-IN")} />
            </div>
          ) : null}
          {r.rows.length ? (
            <div className="table-wrap" style={{ marginTop: 8, maxHeight: 280, overflow: "auto" }}>
              <table className="table small">
                <thead>
                  <tr>
                    {r.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.rows.slice(0, 50).map((row, i) => (
                    <tr key={i}>
                      {r.columns.map((c) => (
                        <td key={c} className={typeof row[c] === "number" ? "num tnum" : undefined}>
                          {cell(c, row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No rows matched.</Empty>
          )}
          <details style={{ marginTop: 10 }}>
            <summary className="small" style={{ cursor: "pointer", color: "var(--muted)", fontWeight: 600 }}>
              Safety checks
            </summary>
            <ul className="small muted">
              <li>Read-only: the query can only look at the analytics data, never change it.</li>
              <li>
                Cost checked before running: {(r.bytes_billed / 1024).toFixed(0)} KB processed (limit 200 MB).
              </li>
              {r.repairs ? <li>The first attempt did not pass the checks and was rewritten automatically.</li> : null}
              <li>Answer: {r.answer_source === "GEMINI" ? "written by Gemini; every number was checked against the rows" : "plain summary (Gemini's text did not pass the number check)"}.</li>
            </ul>
          </details>
          <div style={{ marginTop: 6 }}>
            <SourceNote rec={rec!} />
          </div>
        </div>
      ) : null}
    </Wrap>
  );
}

function cell(column: string, value: any) {
  if (value === null || value === undefined) return "–";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string" && /^CASE-[A-Z0-9]{6}$/.test(value)) return <Link to={`/cases/${value}`}>{value}</Link>;
  if (typeof value === "number") return column.match(/amount|total|sum|inr/i) ? `₹${Math.round(value).toLocaleString("en-IN")}` : value.toLocaleString("en-IN");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---- Documents: Document AI second reader ----

const AGREE_LABEL: Record<string, { text: string; cls: string }> = {
  AGREE: { text: "Agree", cls: "chip-status-open" },
  DISAGREE: { text: "Disagree", cls: "chip-status-escalated" },
  ONLY_GEMINI: { text: "Gemini only", cls: "" },
  ONLY_DOCUMENT_AI: { text: "Document AI only", cls: "" },
  NEITHER: { text: "Not found", cls: "" },
};

export function SecondReaderBlock({ reader, before }: { reader: SecondReader; before?: string }) {
  if (reader.status !== "OK") {
    return <p className="small muted">Second reader (Document AI) was unavailable for this file, so only Gemini's reading was used.</p>;
  }
  return (
    <div style={{ marginTop: 10 }}>
      <h4 className="section-title">
        Cross-check with Document AI <span className="chip">{reader.agreed} agree · {reader.disagreed} disagree</span>
      </h4>
      <table className="table small">
        <thead>
          <tr>
            <th>Field</th>
            <th>Gemini</th>
            <th>Document AI</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(reader.fields ?? []).map((f) => (
            <tr key={f.field}>
              <td>{f.field}</td>
              <td>{f.gemini || "–"}</td>
              <td>{f.document_ai || "–"}</td>
              <td>
                <span className={`chip ${AGREE_LABEL[f.agreement].cls}`}>{AGREE_LABEL[f.agreement].text}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {reader.note ? (
        <div className="callout callout-warn small" style={{ marginTop: 6 }}>
          {reader.note}
          {before ? ` The verdict was lowered from ${before.replace(/_/g, " ").toLowerCase()}.` : ""}
        </div>
      ) : null}
    </div>
  );
}

// ---- Simulator: Pub/Sub event feed ----

export function StreamFeed({ refreshKey }: { refreshKey: number }) {
  const { data, error, reload } = useAsync(() => api.streamEvents(12), [refreshKey]);
  useEffect(() => {
    const t = window.setInterval(reload, 4000);
    return () => window.clearInterval(t);
  }, [reload]);
  if (!data?.enabled) return null;
  return (
    <section className="card" aria-labelledby="stream-heading">
      <div className="card-head">
        <div>
          <h2 id="stream-heading">Live event stream</h2>
          <div className="card-sub">Transfers delivered by Pub/Sub, scored and checked against controls on arrival</div>
        </div>
        <span className="chip">Pub/Sub</span>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data.events.length === 0 ? <Empty>No events yet. Send a transfer through Pub/Sub above.</Empty> : null}
      {data.events.length ? (
        <table className="table small">
          <thead>
            <tr>
              <th>Transfer</th>
              <th>Outcome</th>
              <th>Priority</th>
              <th className="num">Publish → scored</th>
              <th>Processed</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e: StreamEvent) => (
              <tr key={e.message_id}>
                <td className="mono">{e.transaction_id ?? "–"}</td>
                <td>{["HELD", "FLAGGED"].includes(e.status) ? <ControlTag status={e.status as "HELD" | "FLAGGED"} /> : <span className="chip">{e.status.toLowerCase()}</span>}</td>
                <td>{e.risk_band ? <RiskBadge band={e.risk_band} score={e.score} /> : "–"}</td>
                <td className="num tnum">{e.latency_ms !== null ? `${(e.latency_ms / 1000).toFixed(1)} s` : "–"}</td>
                <td>{fmtTime(e.processed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

// ---- Settings: Google Cloud services ----

export function CloudServicesCard() {
  const { data, error, loading, reload } = useAsync(() => api.cloudStatus(), []);
  const ml = useAsync(() => api.mlInfo(), []);
  const { busy, error: runError, run } = useRun();
  useEffect(() => {
    if (ml.data?.state !== "TRAINING") return;
    const t = window.setInterval(ml.reload, 5000);
    return () => window.clearInterval(t);
  }, [ml.data?.state, ml.reload]);
  return (
    <section className="card" aria-labelledby="cloud-heading" id="sec-cloud">
      <div className="card-head">
        <div>
          <h2 id="cloud-heading">Google Cloud</h2>
          <div className="card-sub">{data?.project ? `Project ${data.project}` : "Services this workspace runs on"}</div>
        </div>
      </div>
      {loading && !data ? <Loading label="Checking services" /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <ul className="service-list">
          {data.services.map((s) => (
            <li key={s.key} className="row" style={{ justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span>
                <strong>{s.name}</strong>
                <span className="small muted"> {s.detail ?? ""}</span>
                {s.state?.error ? <span className="small" style={{ color: "var(--high)" }}> · {String(s.state.error).slice(0, 120)}</span> : null}
                {s.state?.last_sync ? <span className="small muted"> · synced {fmtTime(s.state.last_sync)}</span> : null}
                {s.state?.last_backup ? <span className="small muted"> · saved {fmtTime(s.state.last_backup)}</span> : null}
              </span>
              <span className={`chip ${s.enabled ? "chip-status-open" : ""}`}>{s.enabled ? "Active" : "Off"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {ml.data?.enabled ? (
        <div style={{ marginTop: 14 }}>
          <h3 className="section-title">BigQuery ML model</h3>
          <p className="small">
            State: <strong>{ml.data.state.replace(/_/g, " ").toLowerCase()}</strong>
            {ml.data.trained_at ? ` · trained ${fmtTime(ml.data.trained_at)}` : ""}
            {ml.data.scored ? ` · ${ml.data.scored} transfers scored` : ""}
          </p>
          {ml.data.metrics ? (
            <p className="small tnum">
              Held-out evaluation: precision {pct(ml.data.metrics.precision)}, recall {pct(ml.data.metrics.recall)}, ROC AUC{" "}
              {ml.data.metrics.roc_auc?.toFixed(3) ?? "–"}.
              <span className="muted">
                {" "}These scores are optimistic: the synthetic scenarios are defined by the same behaviour the model learns (money moved on within
                30 minutes), so it separates them almost perfectly. Treat the model as a second opinion, not as measured accuracy.
              </span>
            </p>
          ) : null}
          {ml.data.global_explain?.length ? (
            <HBars unit="" format={(v) => v.toFixed(3)} items={ml.data.global_explain.map((f) => ({ key: f.feature, label: f.label, value: f.attribution }))} />
          ) : null}
          {ml.data.error ? <p className="small" style={{ color: "var(--high)" }}>{ml.data.error}</p> : null}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn btn-small" disabled={busy || ml.data.state === "TRAINING"} onClick={() => run(() => api.trainMl()).then(ml.reload)}>
              {ml.data.state === "TRAINED" ? "Retrain model" : "Train model"}
            </button>
            <button className="btn btn-small" disabled={busy} onClick={() => run(() => api.syncBigQuery()).then(reload)}>
              Sync BigQuery now
            </button>
          </div>
          {runError ? <ErrorState message={runError} /> : null}
        </div>
      ) : null}
    </section>
  );
}
