import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { AiStatusCard } from "../components/AiStatus";
import { ErrorState, Loading } from "../components/common";
import { useHealth } from "../health";
import { usePrefs, type Theme } from "../prefs";
import { errorMessage, fmtTime, useAsync, usePageTitle } from "../util";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsPage() {
  const health = useHealth();
  const prefs = usePrefs();
  const dash = useAsync(() => api.dashboard(), []);
  const rules = useAsync(() => api.rules(), []);
  const scen = useAsync(() => api.scenarios(), []);
  const [name, setName] = useState(prefs.analystName);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [nameSaved, setNameSaved] = useState(false);
  usePageTitle("Settings");

  async function restore() {
    if (!window.confirm("Restore the baseline dataset?\n\nThis removes simulated transfers, cases, AI summaries and analyst decisions, then reloads the original data and re-runs analysis.")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.reset();
      const run = await api.runAnalysis({});
      setNotice(`Baseline restored: ${r.transactions.toLocaleString()} transfers, ${r.accounts} accounts, ${run.active_cases} cases rebuilt.`);
      dash.reload();
      scen.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Workspace profile, AI connection, data environment and detection rules.</p>
        </div>
      </div>

      <div className="settings-grid">
        <section className="card" aria-labelledby="profile-heading">
          <div className="card-head">
            <h2 id="profile-heading">Profile and appearance</h2>
          </div>
          <div className="setting-row">
            <div>
              <strong>Analyst name</strong>
              <div className="muted small">Shown in the top bar and recorded with every decision you make.</div>
            </div>
            <form
              className="row-center"
              onSubmit={(e) => {
                e.preventDefault();
                prefs.setAnalystName(name);
                setNameSaved(true);
              }}
            >
              <label>
                <span className="visually-hidden">Analyst name</span>
                <input
                  value={name}
                  maxLength={60}
                  placeholder="Your name"
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameSaved(false);
                  }}
                  style={{ width: 200 }}
                />
              </label>
              <button className="btn" type="submit" disabled={!name.trim() || name.trim() === prefs.analystName}>
                Save
              </button>
              {nameSaved ? (
                <span className="saved-hint" role="status">
                  ✓ Saved
                </span>
              ) : null}
            </form>
          </div>
          <div className="setting-row">
            <div>
              <strong>Theme</strong>
              <div className="muted small">Follows your device by default.</div>
            </div>
            <div className="segmented" role="group" aria-label="Theme" style={{ margin: 0 }}>
              {THEMES.map((t) => (
                <button key={t.value} className={prefs.theme === t.value ? "active" : ""} aria-pressed={prefs.theme === t.value} onClick={() => prefs.setTheme(t.value)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <AiStatusCard />

        <section className="card" aria-labelledby="data-heading" data-tour="settings-data">
          <div className="card-head">
            <h2 id="data-heading">Data environment</h2>
            <span className="chip chip-warn">Sandbox</span>
          </div>
          <p className="muted small">
            This workspace runs on a synthetic dataset of fictional accounts and transfers. No real customer data is loaded and no real payment can be created,
            blocked or changed from here.
          </p>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Dataset</dt>
            <dd className="mono">{health?.dataset_version ?? "-"}</dd>
            <dt>Transfers</dt>
            <dd>{dash.data ? dash.data.totals.transactions.toLocaleString() : "-"}{dash.data?.totals.synthetic_added ? ` (${dash.data.totals.synthetic_added} simulated)` : ""}</dd>
            <dt>Accounts</dt>
            <dd>{dash.data?.totals.accounts ?? "-"}</dd>
            <dt>Last restored</dt>
            <dd>{dash.data?.reset_at ? `${fmtTime(dash.data.reset_at)} UTC` : "-"}</dd>
            <dt>Last analysis</dt>
            <dd>{dash.data?.last_analysis ? `${dash.data.last_analysis.analysis_id} · ${fmtTime(dash.data.last_analysis.created_at)} UTC` : "-"}</dd>
          </dl>
          {notice ? <div className="callout callout-ok" role="status" style={{ marginTop: 12 }}>{notice}</div> : null}
          {error ? <div className="callout callout-error" role="alert" style={{ marginTop: 12 }}>{error}</div> : null}
          <div className="setting-row" style={{ marginTop: 12 }}>
            <div>
              <strong>Restore baseline dataset</strong>
              <div className="muted small">Clears simulated transfers, cases and decisions, then rebuilds from the original data.</div>
            </div>
            <button className="btn btn-danger" onClick={restore} disabled={busy}>
              {busy ? "Restoring..." : "Restore baseline"}
            </button>
          </div>
        </section>

        <section className="card card-flush" aria-labelledby="rules-heading">
          <div className="card-head">
            <div>
              <h2 id="rules-heading">Detection rules</h2>
              <div className="card-sub">
                {rules.data ? `${rules.data.rule_version} · a transfer joins a case at ${rules.data.case_min_score} points or more` : "Loading..."}
              </div>
            </div>
          </div>
          {rules.error ? <div style={{ padding: 18 }}><ErrorState message={rules.error} onRetry={rules.reload} /></div> : null}
          {rules.data ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Rule</th>
                    <th scope="col" className="num">Max points</th>
                    <th scope="col">Fires when</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.data.rules.map((r) => (
                    <tr key={r.code}>
                      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{r.code.replace(/_/g, " ").toLowerCase().replace(/^./, (ch) => ch.toUpperCase())}</td>
                      <td className="num">{r.weight}</td>
                      <td className="small">{r.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="muted small" style={{ padding: "12px 18px 16px" }}>{rules.data?.note}</p>
        </section>
      </div>

      <section className="card card-flush" aria-labelledby="eval-heading">
        <div className="card-head">
          <div>
            <h2 id="eval-heading">Detection quality: labeled test scenarios</h2>
            <div className="card-sub">
              Known patterns seeded in the sandbox dataset to measure the rules. Labels are never shown to the rule engine or to Gemini.
            </div>
          </div>
        </div>
        {scen.loading && !scen.data ? <Loading label="Loading scenarios" /> : null}
        {scen.error ? <div style={{ padding: 18 }}><ErrorState message={scen.error} onRetry={scen.reload} /></div> : null}
        {scen.data ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Scenario</th>
                  <th scope="col">Expected</th>
                  <th scope="col" className="num">Transfers</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {scen.data.scenarios.map((s) => (
                  <tr key={s.scenario_id}>
                    <td>
                      <strong>{s.title}</strong>
                      <div className="muted small">{s.description}</div>
                    </td>
                    <td>
                      <span className={`chip ${s.label === "SUSPICIOUS" ? "chip-warn" : ""}`} style={{ marginLeft: 0 }}>
                        {s.label === "SUSPICIOUS" ? "Suspicious" : "Legitimate"}
                      </span>
                    </td>
                    <td className="num">{s.transaction_ids.length}</td>
                    <td>
                      {s.case_ids.length ? (
                        <span className="case-links">
                          {s.case_ids.map((c) => (
                            <button key={c} className="link-button mono id" onClick={() => navigate(`/cases/${c}`)}>
                              {c}
                            </button>
                          ))}
                        </span>
                      ) : (
                        <span className="muted">Not flagged</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
