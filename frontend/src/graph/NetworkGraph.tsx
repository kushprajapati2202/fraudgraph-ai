import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, GraphEdge, GraphNode } from "../api/client";
import { initials, usePrefs } from "../prefs";
import { fmtAmount, fmtCompact, fmtTime, readCssVar } from "../util";

cytoscape.use(dagre);

interface Props {
  data: GraphData;
  highlightTxIds?: string[];
  /** Kept for callers; every view now uses the same left-to-right flow layout. */
  layout?: "flow" | "network";
  height?: number;
  /** Preview mode: just the canvas and its controls, without the summary strip, legend and table. */
  compact?: boolean;
  onEdgeClick?: (txId: string) => void;
  onNodeClick?: (accountId: string) => void;
}

type Band = "high" | "medium" | "low" | "none";
const BAND_ICON: Record<Band, string> = { high: "▲ ", medium: "◆ ", low: "", none: "" };

function bandOf(score: number | null | undefined): Band {
  if (score === null || score === undefined) return "none";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function shortName(name: string | null, id: string): string {
  if (!name) return id;
  return name.length > 20 ? `${name.slice(0, 19)}…` : name;
}

/** Avatar-style node face: initials on a tinted disc (or rounded square for businesses). */
function avatar(text: string, fill: string, ink: string, square: boolean): string {
  const shape = square ? `<rect x="2" y="2" width="60" height="60" rx="16" fill="${fill}"/>` : `<circle cx="32" cy="32" r="30" fill="${fill}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${shape}` +
    `<text x="32" y="40" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="${ink}">${text}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
  hint: string;
}

export default function NetworkGraph({ data, highlightTxIds = [], height = 480, compact = false, onEdgeClick, onNodeClick }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const handlers = useRef({ onEdgeClick, onNodeClick });
  handlers.current = { onEdgeClick, onNodeClick };
  const { resolvedTheme } = usePrefs();
  const [showContext, setShowContext] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [step, setStep] = useState<number | null>(null); // replay position (index into ordered transfers)

  const nodeById = useMemo(() => new Map<string, GraphNode>(data.nodes.map((n) => [n.id, n])), [data]);
  const nameOf = useCallback((id: string) => nodeById.get(id)?.holder_name ?? id, [nodeById]);
  const hasContext = useMemo(() => data.edges.some((e) => !e.in_focus), [data]);

  // Transfers shown, in time order. The position in this list is the step number printed on each arrow.
  // When a view has no flagged subset (an account's own activity), every transfer is treated as the subject.
  const anyFocus = useMemo(() => data.edges.some((e) => e.in_focus), [data]);
  const edges = useMemo<GraphEdge[]>(
    () =>
      data.edges
        .map((e) => (anyFocus ? e : { ...e, in_focus: true }))
        .filter((e) => e.in_focus || showContext)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)),
    [data, showContext, anyFocus],
  );
  const ordered = useMemo(() => edges.filter((e) => e.in_focus), [edges]);
  const stepOf = useMemo(() => new Map(ordered.map((e, i) => [e.id, i + 1])), [ordered]);

  const roles = useMemo(() => {
    const src = new Set(ordered.map((e) => e.source));
    const dst = new Set(ordered.map((e) => e.target));
    const all = new Set([...src, ...dst]);
    const origins = [...all].filter((a) => !dst.has(a));
    const ends = [...all].filter((a) => !src.has(a));
    return { origins, ends, relays: all.size - origins.length - ends.length, total: ordered.reduce((s, e) => s + (origins.includes(e.source) ? e.amount : 0), 0) };
  }, [ordered]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const c = {
      high: readCssVar("--high", "#ff6b6b"),
      medium: readCssVar("--medium", "#ffb454"),
      low: readCssVar("--low", "#3ddc97"),
      none: readCssVar("--muted", "#7d8b9a"),
      face: readCssVar("--surface-3", "#1c2430"),
      ink: readCssVar("--text", "#e6edf3"),
    };
    const ids = new Set<string>();
    const flow = new Map<string, number>();
    edges.forEach((e) => {
      ids.add(e.source);
      ids.add(e.target);
      flow.set(e.source, (flow.get(e.source) ?? 0) + e.amount);
      flow.set(e.target, (flow.get(e.target) ?? 0) + e.amount);
    });
    const maxFlow = Math.max(1, ...flow.values());
    const maxAmount = Math.max(1, ...edges.map((e) => e.amount));
    const nodes: ElementDefinition[] = data.nodes
      .filter((n) => ids.has(n.id))
      .map((n) => {
        const band = bandOf(n.max_score);
        const business = n.account_type === "BUSINESS" || n.account_type === "MERCHANT";
        return {
          data: {
            id: n.id,
            label: `${BAND_ICON[band]}${shortName(n.holder_name, n.id)}\n${n.id}`,
            band,
            focus: n.in_focus || !anyFocus ? "yes" : "no",
            square: business ? "yes" : "no",
            size: Math.round(38 + 30 * Math.sqrt((flow.get(n.id) ?? 0) / maxFlow)),
            avatar: avatar(initials(n.holder_name || n.id.slice(3)), c.face, c.ink, business),
          },
        };
      });
    const links: ElementDefinition[] = edges.map((e) => {
      const n = stepOf.get(e.id);
      return {
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.in_focus ? `${n}  ${fmtCompact(e.amount)}` : fmtCompact(e.amount),
          band: bandOf(e.score),
          focus: e.in_focus ? "yes" : "no",
          synthetic: e.is_synthetic_added ? "yes" : "no",
          w: Number((1.6 + 5.4 * Math.sqrt(e.amount / maxAmount)).toFixed(2)),
        },
      };
    });
    return [...nodes, ...links];
    // resolvedTheme: node faces are drawn with theme colours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, edges, stepOf, anyFocus, resolvedTheme]);

  useEffect(() => {
    if (!container.current) return undefined;
    const c = {
      high: readCssVar("--high", "#ff6b6b"),
      medium: readCssVar("--medium", "#ffb454"),
      low: readCssVar("--low", "#3ddc97"),
      none: readCssVar("--muted", "#7d8b9a"),
      text: readCssVar("--text", "#e6edf3"),
      muted: readCssVar("--muted", "#7d8b9a"),
      surface: readCssVar("--surface", "#0d1117"),
      border: readCssVar("--border-strong", "#2c3848"),
      accent: readCssVar("--accent", "#2dd4ff"),
      synthetic: readCssVar("--synthetic", "#c4a1ff"),
    };
    const cy = cytoscape({
      container: container.current,
      elements,
      wheelSensitivity: 0.2,
      minZoom: 0.25,
      maxZoom: 2.5,
      style: [
        {
          selector: "node",
          style: {
            width: "data(size)",
            height: "data(size)",
            shape: "ellipse",
            "background-color": c.surface,
            "background-image": "data(avatar)",
            "background-fit": "cover",
            "border-width": 3,
            "border-color": c.border,
            label: "data(label)",
            "font-family": "Inter, system-ui, sans-serif",
            "font-size": 11,
            "font-weight": 600,
            "text-wrap": "wrap",
            "line-height": 1.3,
            color: c.text,
            "text-valign": "bottom",
            "text-margin-y": 7,
            "text-background-color": c.surface,
            "text-background-opacity": 0.85,
            "text-background-shape": "roundrectangle",
            "text-background-padding": "3px",
            "transition-property": "opacity, border-width, border-color",
            "transition-duration": 180,
          },
        },
        { selector: 'node[square = "yes"]', style: { shape: "round-rectangle" } },
        { selector: 'node[band = "high"]', style: { "border-color": c.high, "border-width": 4 } },
        { selector: 'node[band = "medium"]', style: { "border-color": c.medium } },
        { selector: 'node[band = "low"]', style: { "border-color": c.low } },
        { selector: 'node[focus = "no"]', style: { opacity: 0.55, "border-style": "dashed" } },
        {
          selector: "edge",
          style: {
            width: "data(w)",
            "curve-style": "bezier",
            "control-point-step-size": 46,
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.1,
            "line-color": c.none,
            "target-arrow-color": c.none,
            "line-cap": "round",
            label: "data(label)",
            "font-family": "Inter, system-ui, sans-serif",
            "font-size": 10,
            "font-weight": 700,
            color: c.text,
            "text-background-color": c.surface,
            "text-background-opacity": 1,
            "text-background-shape": "roundrectangle",
            "text-background-padding": "4px",
            "text-border-width": 1,
            "text-border-color": c.border,
            "text-border-opacity": 1,
            "transition-property": "opacity, line-color, target-arrow-color",
            "transition-duration": 180,
          },
        },
        // Flagged transfers: dashes that march from payer to payee, so direction is visible at a glance.
        { selector: 'edge[focus = "yes"]', style: { "line-style": "dashed", "line-dash-pattern": [10, 6] } },
        { selector: 'edge[focus = "yes"][band = "high"]', style: { "line-color": c.high, "target-arrow-color": c.high } },
        { selector: 'edge[focus = "yes"][band = "medium"]', style: { "line-color": c.medium, "target-arrow-color": c.medium } },
        { selector: 'edge[focus = "yes"][band = "low"]', style: { "line-color": c.low, "target-arrow-color": c.low } },
        { selector: 'edge[focus = "no"]', style: { width: 1.2, opacity: 0.45, "line-style": "dotted", "font-weight": 400, color: c.muted, "text-border-width": 0 } },
        { selector: 'edge[synthetic = "yes"]', style: { "line-color": c.synthetic, "target-arrow-color": c.synthetic } },
        { selector: ".path", style: { "line-color": c.accent, "target-arrow-color": c.accent, "line-style": "solid", "z-index": 10 } },
        { selector: "node.path", style: { "border-color": c.accent, "border-width": 5 } },
        { selector: ".faded", style: { opacity: 0.12 } },
        { selector: "node.hover", style: { "border-width": 6 } },
        { selector: "edge.hover", style: { "line-style": "solid" } },
      ],
      layout: (compact
        ? { name: "dagre", rankDir: "LR", nodeSep: 34, rankSep: 170, edgeSep: 12, padding: 18, fit: true }
        : { name: "dagre", rankDir: "LR", nodeSep: 46, rankSep: 150, edgeSep: 26, padding: 34, fit: true }) as cytoscape.LayoutOptions,
    });

    // The layout stacks unconnected groups in one tall column. Repack them into rows that match the canvas
    // shape, largest first, so several cases share the space and stay readable.
    const groups = cy.elements().components();
    if (groups.length > 1) {
      const gap = 70;
      const boxes = groups.map((g) => ({ g, bb: g.boundingBox({ includeLabels: true }) })).sort((a, b) => b.bb.h - a.bb.h);
      const area = boxes.reduce((s, b) => s + (b.bb.w + gap) * (b.bb.h + gap), 0);
      const aspect = Math.max(1, cy.width() / Math.max(1, cy.height()));
      const rowWidth = Math.max(Math.sqrt(area * aspect), ...boxes.map((b) => b.bb.w));
      let x = 0;
      let y = 0;
      let rowHeight = 0;
      boxes.forEach(({ g, bb }) => {
        if (x > 0 && x + bb.w > rowWidth) {
          x = 0;
          y += rowHeight + gap;
          rowHeight = 0;
        }
        const dx = x - bb.x1;
        const dy = y - bb.y1;
        g.nodes().positions((n) => ({ x: n.position("x") + dx, y: n.position("y") + dy }));
        x += bb.w + gap;
        rowHeight = Math.max(rowHeight, bb.h);
      });
      cy.fit(undefined, 34);
    }

    const show = (evt: cytoscape.EventObject, build: () => Omit<Tip, "x" | "y">) => {
      const p = evt.renderedPosition ?? evt.target.renderedPosition();
      evt.target.addClass("hover");
      setTip({ x: p.x, y: p.y, ...build() });
    };
    cy.on("mouseover", "node", (evt) =>
      show(evt, () => {
        const n = nodeById.get(evt.target.id());
        const inbound = edges.filter((e) => e.target === evt.target.id());
        const outbound = edges.filter((e) => e.source === evt.target.id());
        return {
          title: n?.holder_name ?? evt.target.id(),
          lines: [
            `${evt.target.id()} · ${(n?.account_type ?? "account").toLowerCase()}${n?.city ? ` · ${n.city}` : ""}`,
            `Opened ${n?.created_at ?? "unknown"}${n?.kyc_tier === "MIN_KYC" ? " · minimum KYC" : ""}`,
            `In: ${inbound.length} (${fmtAmount(inbound.reduce((s, e) => s + e.amount, 0))})  Out: ${outbound.length} (${fmtAmount(outbound.reduce((s, e) => s + e.amount, 0))})`,
          ],
          hint: "Click for the account profile",
        };
      }),
    );
    cy.on("mouseover", "edge", (evt) =>
      show(evt, () => {
        const e = edges.find((x) => x.id === evt.target.id());
        if (!e) return { title: evt.target.id(), lines: [], hint: "" };
        const n = stepOf.get(e.id);
        return {
          title: `${n ? `Step ${n} · ` : ""}${fmtAmount(e.amount, e.currency)}`,
          lines: [`${nameOf(e.source)} → ${nameOf(e.target)}`, `${fmtTime(e.timestamp)} · ${e.channel ?? ""} · ${e.id}`, e.score !== null ? `Priority score ${e.score}` : "Not scored"],
          hint: "Click for the transfer record",
        };
      }),
    );
    cy.on("mouseout", "node, edge", (evt) => {
      evt.target.removeClass("hover");
      setTip(null);
    });
    cy.on("pan zoom", () => setTip(null));
    cy.on("tap", "edge", (evt) => handlers.current.onEdgeClick?.(evt.target.id()));
    cy.on("tap", "node", (evt) => handlers.current.onNodeClick?.(evt.target.id()));
    cyRef.current = cy;

    // Marching dashes on flagged transfers (skipped when the user prefers reduced motion).
    let frame = 0;
    let offset = 0;
    let last = 0;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const tick = (t: number) => {
      if (t - last > 45) {
        last = t;
        offset = (offset - 1.2) % 160;
        cy.edges('[focus = "yes"]').style("line-dash-offset", offset);
      }
      frame = requestAnimationFrame(tick);
    };
    if (!reduce) frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements, edges, nodeById, nameOf, stepOf, compact]);

  // Path highlight and step-by-step replay share one "lit / faded" treatment.
  const replayIds = useMemo(() => (step === null ? [] : ordered.slice(0, step + 1).map((e) => e.id)), [step, ordered]);
  const lit = step !== null ? replayIds : highlightTxIds;
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("path faded");
    if (!lit.length) return;
    const on = cy.edges().filter((e) => lit.includes(e.id()));
    const keep = on.union(on.connectedNodes());
    cy.elements().difference(keep).addClass("faded");
    if (step === null) keep.addClass("path");
  }, [lit, step, elements]);

  useEffect(() => {
    if (step === null) return undefined;
    if (step >= ordered.length - 1) {
      const done = window.setTimeout(() => setStep(null), 2600);
      return () => window.clearTimeout(done);
    }
    const next = window.setTimeout(() => setStep(step + 1), 1100);
    return () => window.clearTimeout(next);
  }, [step, ordered.length]);

  useEffect(() => setStep(null), [data, showContext]);

  const zoom = (factor: number) => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const current = step !== null ? ordered[step] : null;

  return (
    <div className="graph-wrap">
      {ordered.length > 0 && !compact ? (
        <div className="flow-strip" aria-label="Flow summary">
          <div className="flow-stage">
            <span className="flow-count">{roles.origins.length}</span>
            <span className="flow-label">{roles.origins.length === 1 ? "origin" : "origins"}</span>
            <span className="flow-names">{roles.origins.slice(0, 2).map(nameOf).join(", ")}{roles.origins.length > 2 ? ` +${roles.origins.length - 2}` : ""}</span>
          </div>
          <span className="flow-arrow" aria-hidden="true">{"→"}</span>
          <div className="flow-stage">
            <span className="flow-count">{roles.relays}</span>
            <span className="flow-label">pass-through {roles.relays === 1 ? "account" : "accounts"}</span>
            <span className="flow-names">{ordered.length} transfers in total</span>
          </div>
          <span className="flow-arrow" aria-hidden="true">{"→"}</span>
          <div className="flow-stage">
            <span className="flow-count">{roles.ends.length}</span>
            <span className="flow-label">final {roles.ends.length === 1 ? "recipient" : "recipients"}</span>
            <span className="flow-names">{roles.ends.slice(0, 2).map(nameOf).join(", ")}{roles.ends.length > 2 ? ` +${roles.ends.length - 2}` : ""}</span>
          </div>
          <div className="flow-total">
            <span className="flow-label">sent by origin</span>
            <span className="flow-count">{fmtCompact(roles.total)}</span>
          </div>
        </div>
      ) : null}

      <div className="graph-stage">
        <div
          ref={container}
          className="graph-canvas"
          style={{ height }}
          role="img"
          aria-label={`Money-flow graph, left to right: ${data.nodes.length} accounts and ${edges.length} transfers, numbered in time order. A table of the same transfers follows.`}
        />
        <div className="graph-tools" role="group" aria-label="Graph controls">
          {ordered.length > 1 ? (
            <button className="btn btn-small btn-primary" onClick={() => setStep(step === null ? 0 : null)}>
              {step === null ? "▶ Play flow" : "■ Stop"}
            </button>
          ) : null}
          <button className="btn btn-small" onClick={() => zoom(1.25)} aria-label="Zoom in">+</button>
          <button className="btn btn-small" onClick={() => zoom(0.8)} aria-label="Zoom out">{"−"}</button>
          <button className="btn btn-small" onClick={() => cyRef.current?.fit(undefined, 34)}>Fit</button>
        </div>
        {current ? (
          <div className="graph-caption" role="status" aria-live="polite">
            <span className="caption-step">Step {step! + 1} of {ordered.length}</span>
            <strong>{nameOf(current.source)}</strong> paid <strong>{nameOf(current.target)}</strong> {fmtAmount(current.amount, current.currency)}
            <span className="muted"> at {fmtTime(current.timestamp).slice(11)}</span>
          </div>
        ) : null}
        {tip ? (
          <div className="graph-tip" style={{ left: tip.x, top: tip.y }}>
            <strong>{tip.title}</strong>
            {tip.lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
            {tip.hint ? <em>{tip.hint}</em> : null}
          </div>
        ) : null}
      </div>

      {compact ? null : (
      <>
      <div className="graph-foot">
        <div className="graph-legend" aria-label="Graph legend">
          <span><i className="lg-ring lg-high" aria-hidden="true" />{"▲"} High priority</span>
          <span><i className="lg-ring lg-medium" aria-hidden="true" />{"◆"} Medium</span>
          <span><i className="lg-ring lg-low" aria-hidden="true" />Low</span>
          <span><i className="lg-flow" aria-hidden="true" />Flagged transfer, numbered in time order</span>
          <span><i className="lg-thick" aria-hidden="true" />Thicker = larger amount</span>
          <span><i className="lg-square" aria-hidden="true" />Business</span>
        </div>
        {hasContext && data.edges.some((e) => e.in_focus) ? (
          <label className="checkbox small">
            <input type="checkbox" checked={showContext} onChange={(e) => setShowContext(e.target.checked)} />
            Show surrounding activity
          </label>
        ) : null}
      </div>

      <details className="graph-list">
        <summary>Transfers as a table ({edges.length})</summary>
        <div className="table-scroll">
          <table className="table compact">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col" className="num">Amount</th>
                <th scope="col">Time</th>
                <th scope="col">Transfer</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((e) => (
                <tr key={e.id} className={lit.includes(e.id) ? "row-highlight" : undefined}>
                  <td className="tnum">{stepOf.get(e.id) ?? "–"}</td>
                  <td>
                    <button className="link-button" onClick={() => onNodeClick?.(e.source)}>{nameOf(e.source)}</button>
                    <div className="muted small mono">{e.source}</div>
                  </td>
                  <td>
                    <button className="link-button" onClick={() => onNodeClick?.(e.target)}>{nameOf(e.target)}</button>
                    <div className="muted small mono">{e.target}</div>
                  </td>
                  <td className="num">{fmtAmount(e.amount, e.currency)}</td>
                  <td className="small tnum">{fmtTime(e.timestamp)}</td>
                  <td>
                    <button className="link-button mono" onClick={() => onEdgeClick?.(e.id)}>{e.id}</button>
                    {e.in_focus ? "" : <span className="muted small"> context</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      </>
      )}
    </div>
  );
}
