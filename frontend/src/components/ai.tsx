import { useState } from "react";
import { Link } from "react-router-dom";
import type { Insight, RiskBand } from "../api/client";
import { errorMessage, fmtTime } from "../util";

const BAND_ORDER: Record<RiskBand, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function reasonText(reason: string | null | undefined): string {
  return (reason ?? "error").replace(/_/g, " ").toLowerCase();
}

/** Where a result came from: Gemini (model, time) or the rule-based fallback (and why). */
export function SourceNote({ rec }: { rec: Insight<unknown> }) {
  const r = rec.response;
  const when = rec.insight_id ? ` · ${fmtTime(rec.created_at)} UTC` : "";
  const stale = rec.stale ? <span className="chip chip-warn">data changed since</span> : null;
  if (r.source === "GEMINI") {
    return (
      <span className="source-note">
        <span className="chip chip-ai">Gemini</span> {r.model}
        {when} {stale}
      </span>
    );
  }
  return (
    <span className="source-note">
      <span className="chip">Rule-based</span>
      {r.fallback_reason ? ` Gemini unavailable (${reasonText(r.fallback_reason)}), so this was computed by rules` : " Computed by rules. Ask Gemini for a written version"}
      {when} {stale}
    </span>
  );
}

export function CaseLinks({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <span className="citations">
      {ids.map((id) => (
        <Link key={id} to={`/cases/${id}`} className="citation">
          {id}
        </Link>
      ))}
    </span>
  );
}

/** Rule priority vs. the latest Gemini review priority: agrees, rates higher or rates lower. */
export function SecondOpinion({ rule, ai, compact = false }: { rule: RiskBand; ai: RiskBand | null | undefined; compact?: boolean }) {
  if (!ai) return null;
  const diff = BAND_ORDER[ai] - BAND_ORDER[rule];
  const label = diff === 0 ? "AI agrees" : diff > 0 ? "AI rates higher" : "AI rates lower";
  const tone = diff === 0 ? "opinion-agree" : "opinion-differ";
  return (
    <span className={`chip opinion ${tone}`} title={`Rules: ${rule.toLowerCase()} priority. Gemini review priority: ${ai.toLowerCase()}. Advisory only.`}>
      <span aria-hidden="true">{"✦"}</span> {compact ? label : `${label} (${ai.toLowerCase()})`}
    </span>
  );
}

export function opinionDiff(rule: RiskBand, ai: RiskBand): number {
  return BAND_ORDER[ai] - BAND_ORDER[rule];
}

/** Busy/error state around one async action. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function Busy({ label }: { label: string }) {
  return (
    <div className="state state-loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function Unavailable({ rec, what }: { rec: Insight<unknown>; what: string }) {
  if (rec.response.status !== "UNAVAILABLE") return null;
  return (
    <div className="callout callout-warn" role="status">
      <strong>
        {what} unavailable ({reasonText(rec.response.reason)}).
      </strong>{" "}
      {rec.response.message}
    </div>
  );
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("Clipboard unavailable"));
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
