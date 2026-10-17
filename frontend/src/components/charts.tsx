import { useState } from "react";
import type { RiskBand } from "../api/client";
import { fmtAmount, fmtDay } from "../util";

export interface DayPoint {
  day: string;
  transactions: number;
  volume: number;
  flagged: number;
  flagged_amount: number;
}

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 5 ? 5 : n <= 7.5 ? 7.5 : 10) * pow;
}

/**
 * Daily transfers as stacked bars on one axis (transfers per day): the flagged portion sits on the baseline in the
 * strong tone, other transfers above it in the soft tone. Hover or focus a day for exact values.
 */
export function ActivityChart({ data, selected, onSelect, height = 470 }: { data: DayPoint[]; selected?: string | null; onSelect?: (day: string) => void; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = height;
  const pad = { l: 34, r: 8, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...data.map((d) => d.transactions)));
  const step = iw / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(14, step - 3));
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  const h = hover !== null ? data[hover] : null;

  if (!data.length) return <p className="muted">No activity to chart yet.</p>;
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Transfers per day over ${data.length} days; flagged transfers highlighted. Use the table below for exact values.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text className="chart-axis" x={pad.l - 6} y={y(t) + 3} textAnchor="end">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * step + (step - bw) / 2;
          const flaggedH = (d.flagged / max) * ih;
          const otherH = ((d.transactions - d.flagged) / max) * ih;
          const gap = d.flagged > 0 && otherH > 0 ? 2 : 0;
          return (
            <g key={d.day}>
              {hover === i || selected === d.day ? <rect className={selected === d.day ? "chart-hover chart-selected" : "chart-hover"} x={pad.l + i * step} y={pad.t} width={step} height={ih} /> : null}
              {otherH > 0 ? <rect className="chart-bar-bg" x={x} y={y(d.transactions)} width={bw} height={Math.max(0, otherH - gap)} rx={2} /> : null}
              {d.flagged > 0 ? <rect className="chart-bar" x={x} y={y(d.flagged)} width={bw} height={Math.max(2, flaggedH)} rx={2} /> : null}
              {i % labelEvery === 0 ? (
                <text className="chart-axis" x={pad.l + i * step + step / 2} y={H - 6} textAnchor="middle">
                  {fmtDay(d.day)}
                </text>
              ) : null}
              <rect
                className="chart-hit"
                x={pad.l + i * step}
                y={pad.t}
                width={step}
                height={ih}
                tabIndex={0}
                aria-label={`${fmtDay(d.day)}: ${d.transactions} transfers, ${d.flagged} flagged${onSelect ? ". Press Enter to explain this day" : ""}`}
                role={onSelect ? "button" : undefined}
                style={onSelect ? { cursor: "pointer" } : undefined}
                onClick={() => onSelect?.(d.day)}
                onKeyDown={(e) => {
                  if (onSelect && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelect(d.day);
                  }
                }}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {h && hover !== null ? (
        <div className="chart-tip" style={{ left: `${((pad.l + hover * step + step / 2) / W) * 100}%`, top: `${(y(h.transactions) / H) * 100}%` }}>
          <strong>{fmtDay(h.day)}</strong>
          {h.transactions} transfers &middot; {fmtAmount(h.volume)}
          <br />
          {h.flagged} flagged{h.flagged ? ` · ${fmtAmount(h.flagged_amount)}` : ""}
        </div>
      ) : null}
      <div className="chart-legend">
        <span>
          <span className="legend-key" style={{ background: "var(--chart-1)" }} />
          Flagged for review
        </span>
        <span>
          <span className="legend-key" style={{ background: "var(--chart-1-soft)" }} />
          Other transfers
        </span>
      </div>
      <details className="graph-list">
        <summary>Days with flagged transfers (table)</summary>
        <table className="table compact">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Transfers</th>
              <th scope="col">Flagged</th>
              <th scope="col">Flagged amount</th>
            </tr>
          </thead>
          <tbody>
            {data
              .filter((d) => d.flagged > 0)
              .map((d) => (
                <tr key={d.day}>
                  <td>{fmtDay(d.day)}</td>
                  <td className="tnum">{d.transactions}</td>
                  <td className="tnum">{d.flagged}</td>
                  <td className="tnum">{fmtAmount(d.flagged_amount)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Single-series horizontal bars with the value printed beside each label. */
export function HBars({ items, unit, format }: { items: { key: string; label: string; value: number; note?: string }[]; unit: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="muted small">Nothing to show yet.</p>;
  return (
    <ul className="hbar-list">
      {items.map((i) => (
        <li key={i.key} className="hbar-row" title={`${i.label}: ${i.value} ${unit}`}>
          <span>
            {i.label}
            {i.note ? <span className="muted small"> {i.note}</span> : null}
          </span>
          <strong className="tnum">{format ? format(i.value) : i.value}</strong>
          <span className="hbar-track" aria-hidden="true">
            <span className="hbar-fill" style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

const BAND_META: { band: RiskBand; label: string; icon: string }[] = [
  { band: "HIGH", label: "High", icon: "▲" },
  { band: "MEDIUM", label: "Medium", icon: "◆" },
  { band: "LOW", label: "Low", icon: "●" },
];

/** Part-to-whole bar for cases by priority band; counts and labels are always visible. */
export function BandMix({ counts }: { counts: Record<RiskBand, number> }) {
  const total = BAND_META.reduce((s, b) => s + (counts[b.band] ?? 0), 0);
  return (
    <div>
      <div className="mixbar" role="img" aria-label={BAND_META.map((b) => `${b.label} ${counts[b.band] ?? 0}`).join(", ")}>
        {total === 0
          ? null
          : BAND_META.filter((b) => (counts[b.band] ?? 0) > 0).map((b) => (
              <span key={b.band} className={`fill-${b.band.toLowerCase()}`} style={{ width: `${((counts[b.band] ?? 0) / total) * 100}%` }} title={`${b.label}: ${counts[b.band]}`} />
            ))}
      </div>
      <div className="mix-legend">
        {BAND_META.map((b) => (
          <div key={b.band} className="mix-item">
            <strong>{counts[b.band] ?? 0}</strong>
            <span className="small muted">
              <span className={`legend-${b.band.toLowerCase()}`} aria-hidden="true">
                {b.icon}
              </span>{" "}
              {b.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
