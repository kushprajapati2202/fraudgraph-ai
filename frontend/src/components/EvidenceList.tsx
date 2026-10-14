import { useMemo, useState } from "react";
import type { Evidence } from "../api/client";
import { useInspector } from "./Inspector";

const TYPES: { key: Evidence["source_type"] | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "GRAPH_PATH", label: "Paths" },
  { key: "RULE_FINDING", label: "Rule findings" },
  { key: "TRANSACTION", label: "Transactions" },
  { key: "BASELINE", label: "Baselines" },
];

export default function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  const [filter, setFilter] = useState<(typeof TYPES)[number]["key"]>("ALL");
  const { openEvidence } = useInspector();
  const shown = useMemo(() => (filter === "ALL" ? evidence : evidence.filter((e) => e.source_type === filter)), [evidence, filter]);

  return (
    <section className="card" aria-labelledby="evidence-heading" data-tour="case-evidence">
      <div className="card-head">
        <h2 id="evidence-heading">Evidence ({evidence.length})</h2>
      </div>
      <div className="segmented" role="group" aria-label="Filter evidence by type">
        {TYPES.map((t) => (
          <button key={t.key} className={filter === t.key ? "active" : ""} aria-pressed={filter === t.key} onClick={() => setFilter(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <ul className="evidence-list">
        {shown.map((e) => (
          <li key={e.evidence_id}>
            <button className="evidence-item" onClick={() => openEvidence(e)}>
              <span className={`ev-type ev-${e.source_type.toLowerCase()}`}>{e.source_type.replace("_", " ")}</span>
              <span className="mono ev-id">{e.evidence_id}</span>
              <span className="ev-desc">{e.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
