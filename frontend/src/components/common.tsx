import type { ReactNode } from "react";
import type { AccountControl, CaseStatus, ControlStatus, RiskBand } from "../api/client";
import { initials } from "../prefs";

const BAND_ICON: Record<RiskBand, string> = { HIGH: "▲", MEDIUM: "◆", LOW: "●" };
const BAND_LABEL: Record<RiskBand, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

export function RiskBadge({ band, score }: { band: RiskBand | null | undefined; score?: number | null }) {
  if (!band) return <span className="badge badge-none">Not scored</span>;
  return (
    <span className={`badge badge-${band.toLowerCase()}`} title={`${BAND_LABEL[band]} review priority (rule-based score, not a probability)`}>
      <span aria-hidden="true">{BAND_ICON[band]}</span> {BAND_LABEL[band].toUpperCase()}
      {score !== undefined && score !== null ? <span className="badge-score">{score}</span> : null}
    </span>
  );
}

/** Circular priority score (0-100). The band is also given as text, so colour is never the only cue. */
export function ScoreRing({ score, band, size = 56 }: { score: number; band: RiskBand; size?: number }) {
  const stroke = Math.max(4, Math.round(size / 10));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="ring" style={{ width: size, height: size }} role="img" aria-label={`Priority score ${score} of 100, ${BAND_LABEL[band]}`}>
      <svg width={size} height={size}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className={`ring-${band.toLowerCase()}`}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(Math.min(100, Math.max(0, score)) / 100) * c} ${c}`}
        />
      </svg>
      <span className="ring-label" style={{ fontSize: size * 0.3 }}>
        <span>
          {score}
          {size >= 64 ? <small>{BAND_LABEL[band].toUpperCase()}</small> : null}
        </span>
      </span>
    </span>
  );
}

const STATUS_LABEL: Record<CaseStatus, string> = {
  OPEN: "Open",
  ESCALATED: "Escalated",
  DISMISSED: "Dismissed",
  NEEDS_EVIDENCE: "Needs evidence",
};

export function StatusChip({ status }: { status: CaseStatus }) {
  return <span className={`chip chip-status-${status.toLowerCase()}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Avatar({ name, type, size }: { name: string | null | undefined; type?: string | null; size?: "sm" | "lg" }) {
  const kind = type === "BUSINESS" ? " avatar-business" : type === "MERCHANT" ? " avatar-merchant" : "";
  return (
    <span className={`avatar${size ? ` avatar-${size}` : ""}${kind}`} aria-hidden="true">
      {initials(name || "?")}
    </span>
  );
}

/** Account holder name with the internal account reference underneath. */
export function Party({ name, id, type, onClick }: { name?: string | null; id: string; type?: string | null; onClick?: () => void }) {
  const body = (
    <>
      <Avatar name={name || id} type={type} size="sm" />
      <span className="party-text">
        <span className="party-name">{name || "Unknown holder"}</span>
        <span className="party-id mono">{id}</span>
      </span>
    </>
  );
  return onClick ? (
    <button className="link-button party" onClick={onClick} title={`Open account ${id}`} style={{ color: "inherit", fontWeight: "inherit" }}>
      {body}
    </button>
  ) : (
    <span className="party">{body}</span>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}...
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <strong>Something went wrong.</strong> {message}
      {onRetry ? (
        <button className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

export function SyntheticTag() {
  return (
    <span className="chip chip-synthetic" title="Transfer added in the simulator; not part of the monitored feed">
      SIMULATED
    </span>
  );
}

const CONTROL_TAG: Record<ControlStatus, { text: string; cls: string; title: string }> = {
  HELD: { text: "ON HOLD", cls: "chip-status-escalated", title: "Stopped by an account hold. Waiting for an analyst to release or reject it." },
  REJECTED: { text: "REJECTED", cls: "chip-status-dismissed", title: "Stopped by an account hold and rejected by an analyst. The money did not move." },
  RELEASED: { text: "RELEASED", cls: "chip-status-open", title: "Stopped by an account hold, then released by an analyst." },
  FLAGGED: { text: "MONITORED", cls: "chip-warn", title: "Flagged for review because an account is under enhanced monitoring." },
};

/** What a mitigation control did to a transfer. Renders nothing for transfers no control touched. */
export function ControlTag({ status }: { status: ControlStatus | null | undefined }) {
  if (!status) return null;
  const t = CONTROL_TAG[status];
  return (
    <span className={`chip ${t.cls}`} style={{ fontWeight: 700 }} title={t.title}>
      {t.text}
    </span>
  );
}

/** Controls currently in force on an account (hold, enhanced monitoring). */
export function AccountControlTags({ controls }: { controls: AccountControl[] | undefined }) {
  if (!controls?.length) return null;
  const codes = [...new Set(controls.map((c) => c.action_code))];
  return (
    <>
      {codes.map((code) => (
        <span key={code} className={`chip ${code === "HOLD_FOR_REVIEW" ? "chip-status-escalated" : "chip-warn"}`} style={{ marginLeft: 0, fontWeight: 700 }}>
          {code === "HOLD_FOR_REVIEW" ? "On hold" : "Enhanced monitoring"}
        </span>
      ))}
    </>
  );
}
