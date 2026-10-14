import { useRef, useState, type FormEvent } from "react";
import { api, type CaseDetail, type DocumentRecord } from "../api/client";
import { useAiStatus } from "../health";
import { usePrefs } from "../prefs";
import { errorMessage, fmtAmount, fmtTime } from "../util";
import { IconSparkle } from "./icons";

const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

const VERDICT: Record<string, { label: string; tone: string; icon: string; help: string }> = {
  SUPPORTS: { label: "Supports the transfer", tone: "ok", icon: "✓", help: "Amount, parties and date agree with the record." },
  PARTIALLY_SUPPORTS: { label: "Partly supports", tone: "warn", icon: "◐", help: "Some fields could not be confirmed. Review before relying on it." },
  DOES_NOT_SUPPORT: { label: "Does not support", tone: "bad", icon: "✕", help: "Key fields disagree with the transfer record." },
  UNREADABLE: { label: "Unreadable", tone: "off", icon: "?", help: "The document could not be read. Ask for a clearer copy." },
};

const RESULT: Record<string, { icon: string; cls: string; label: string }> = {
  MATCH: { icon: "✓", cls: "check-match", label: "Match" },
  PARTIAL: { icon: "◐", cls: "check-partial", label: "Close" },
  MISMATCH: { icon: "✕", cls: "check-mismatch", label: "Mismatch" },
  NOT_FOUND: { icon: "–", cls: "check-none", label: "Not found" },
};

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function DocumentResult({ doc }: { doc: DocumentRecord }) {
  const r = doc.response;
  if (r.status !== "OK" || !r.extraction) {
    return (
      <li className="doc-item">
        <div className="doc-head">
          <strong>{doc.filename}</strong>
          <span className="chip chip-warn">not analysed</span>
        </div>
        <div className="small muted">
          {r.message} ({(r.reason ?? "error").replace(/_/g, " ").toLowerCase()}). Upload it again to retry.
        </div>
      </li>
    );
  }
  const v = VERDICT[doc.verdict ?? "PARTIALLY_SUPPORTS"];
  const e = r.extraction;
  return (
    <li className="doc-item">
      <div className="doc-head">
        <strong>{doc.filename}</strong>
        <span className={`ai-pill ai-pill-${v.tone}`} style={{ cursor: "default" }}>
          <span aria-hidden="true">{v.icon}</span> {v.label}
        </span>
      </div>
      <div className="small muted">
        {e.document_type || "Document"} &middot; checked against <span className="mono">{doc.transaction_id}</span> &middot; {r.model} &middot; {fmtTime(doc.created_at)} UTC
        &middot; {doc.actor_label}
      </div>
      <p className="small" style={{ marginTop: 6 }}>{v.help}</p>
      <table className="table compact" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">On the document</th>
            <th scope="col">On record</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {(r.checks ?? []).map((c) => {
            const res = RESULT[c.result] ?? RESULT.NOT_FOUND;
            return (
              <tr key={c.check} title={c.note}>
                <td style={{ fontWeight: 600 }}>{c.check}</td>
                <td>{c.document || <span className="muted">not legible</span>}</td>
                <td className="muted">{c.record}</td>
                <td className={res.cls} style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                  <span aria-hidden="true">{res.icon}</span> {res.label}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {e.purpose ? <div className="small" style={{ marginTop: 6 }}><span className="muted">Stated purpose:</span> {e.purpose}</div> : null}
      {e.tamper_indicators.length ? (
        <div className="callout callout-warn small" style={{ marginTop: 8 }}>
          <strong>Visible anomalies noted by the AI:</strong>
          <ul>{e.tamper_indicators.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      ) : null}
      <div className="small muted mono" style={{ marginTop: 6 }} title="SHA-256 of the uploaded file. The file itself is not stored.">
        sha256 {doc.sha256.slice(0, 16)}&hellip; &middot; {(doc.size_bytes / 1024).toFixed(0)} KB &middot; file not stored
      </div>
    </li>
  );
}

/** Upload a supporting document; Gemini reads it and the backend compares it with the selected transfer. */
export default function DocumentPanel({ detail, onChanged }: { detail: CaseDetail; onChanged: () => void }) {
  const { analystName } = usePrefs();
  const ai = useAiStatus();
  const fileRef = useRef<HTMLInputElement>(null);
  const largest = [...detail.transactions].sort((a, b) => b.amount - a.amount)[0];
  const [txId, setTxId] = useState(largest?.transaction_id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose a file first.");
    if (!ACCEPT.includes(file.type)) return setError("Use a PNG, JPEG, WebP or PDF file.");
    if (file.size > MAX_BYTES) return setError("The file is larger than 4 MB.");
    setBusy(true);
    setError(null);
    try {
      const data = await readBase64(file);
      await api.verifyDocument(detail.case.case_id, { filename: file.name, mime_type: file.type, data_base64: data, transaction_id: txId, actor_label: analystName });
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onChanged();
      ai.recheck();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ai-card" aria-labelledby="docs-heading" data-tour="case-documents">
      <div className="card-head">
        <h2 id="docs-heading">
          <span className="ai-mark">
            <IconSparkle size={17} />
          </span>{" "}
          Supporting documents
        </h2>
        <span className="chip chip-ai">Gemini vision</span>
      </div>
      <p className="muted small">
        Upload an invoice, receipt or agreement that explains a transfer. Gemini reads the document; the comparison with the transfer record is done by fixed
        rules, so the result is repeatable. A match supports the stated purpose. It does not prove the document is genuine.
      </p>
      <form className="stack-sm" onSubmit={submit} style={{ marginTop: 10 }}>
        <label>
          <span className="label">Transfer to check against</span>
          <select value={txId} onChange={(e) => setTxId(e.target.value)} required>
            {detail.transactions.map((t) => (
              <option key={t.transaction_id} value={t.transaction_id}>
                {t.transaction_id} &middot; {fmtAmount(t.amount, t.currency)} &middot; {t.source_name ?? t.source_account} to {t.destination_name ?? t.destination_account}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Document (PNG, JPEG, WebP or PDF, up to 4 MB)</span>
          <input ref={fileRef} type="file" accept={ACCEPT.join(",")} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {error ? <div className="callout callout-error" role="alert">{error}</div> : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !file}>
          {busy ? "Reading document..." : "Verify document"}
        </button>
      </form>
      {busy ? (
        <div className="state state-loading" role="status">
          <span className="spinner" aria-hidden="true" /> Gemini is reading the document...
        </div>
      ) : null}
      {detail.documents.length ? (
        <ul className="doc-list" aria-live="polite">
          {detail.documents.map((d) => (
            <DocumentResult key={d.document_id} doc={d} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
