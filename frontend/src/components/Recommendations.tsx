import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type RecommendationKind } from "../api/client";
import { usePrefs } from "../prefs";
import { useAsync } from "../util";
import { Empty, ErrorState, RiskBadge } from "./common";
import { IconCases, IconChevron, IconClock, IconLock, IconRefresh, IconSparkle } from "./icons";

const KIND: Record<RecommendationKind, { icon: ReactNode; tone: string; label: string }> = {
  OVERDUE_TASK: { icon: <IconClock size={16} />, tone: "tone-high", label: "Overdue task" },
  TASK_DUE_SOON: { icon: <IconClock size={16} />, tone: "tone-medium", label: "Task due soon" },
  HELD_TRANSFERS: { icon: <IconLock size={16} />, tone: "tone-medium", label: "Held transfers" },
  FOLLOW_UP: { icon: <IconRefresh size={16} />, tone: "", label: "Follow up" },
  SIMILAR_TO_ESCALATED: { icon: <IconSparkle size={16} />, tone: "", label: "Similar case" },
  HIGH_RISK_UNREVIEWED: { icon: <IconCases size={16} />, tone: "tone-high", label: "Not reviewed" },
};

/**
 * "Recommended for you": up to five next steps for the analyst named in Settings, most urgent first.
 * Rule-based on the server; the placeholder name gets a team-wide list instead. `refreshKey` reloads it.
 */
export default function RecommendationsCard({ refreshKey }: { refreshKey: number }) {
  const { analystName } = usePrefs();
  const recs = useAsync(() => api.recommendations(analystName), [analystName, refreshKey]);
  const r = recs.data;
  const first = analystName.trim().split(/\s+/)[0];

  return (
    <section className="card card-flush" aria-labelledby="recs-heading" data-tour="dash-recs">
      <div className="card-head">
        <div>
          <h2 id="recs-heading">{r?.personalized ? `Recommended for you, ${first}` : "Recommended next steps"}</h2>
          <div className="card-sub">
            {r?.personalized ? "Based on your tasks, holds and decisions. Most urgent first." : "For the whole team. Most urgent first."}
          </div>
        </div>
        {r && !r.personalized ? (
          <Link to="/settings" className="btn btn-small">
            Set your name
          </Link>
        ) : null}
      </div>
      {recs.error ? (
        <div style={{ padding: "0 18px 18px" }}>
          <ErrorState message={recs.error} onRetry={recs.reload} />
        </div>
      ) : !r ? (
        <p className="muted" style={{ padding: "0 18px 18px" }}>Loading recommendations...</p>
      ) : r.items.length === 0 ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Empty>You're all caught up. Nothing needs your attention right now.</Empty>
        </div>
      ) : (
        <>
          <ul className="queue">
            {r.items.map((item) => {
              const k = KIND[item.kind];
              return (
                <li key={`${item.kind}-${item.case_id}`}>
                  <Link to={`/cases/${item.case_id}`} className="queue-item rec-item">
                    <span className={`rec-icon ${k.tone}`} title={k.label} aria-hidden="true">{k.icon}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="visually-hidden">{k.label}: </span>
                      <span className="queue-title" style={{ display: "block" }}>{item.title}</span>
                      <span className="queue-meta">{item.reason}</span>
                    </span>
                    <span className="rec-badge"><RiskBadge band={item.risk_band} score={item.risk_score} /></span>
                    <span className="queue-chevron"><IconChevron size={16} /></span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {!r.personalized ? (
            <p className="muted small" style={{ padding: "10px 18px 14px", margin: 0, borderTop: "1px solid var(--border)" }}>
              Set your name in Settings to see your own tasks, holds and follow-ups here.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
