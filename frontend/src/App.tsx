import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, type AiStatus } from "./api/client";
import { AiStatusPill } from "./components/AiStatus";
import GlobalSearch from "./components/GlobalSearch";
import { IconCases, IconCog, IconMoon, IconNetwork, IconOverview, IconPlay, IconSimulator, IconSun, IconTransactions } from "./components/icons";
import { InspectorProvider } from "./components/Inspector";
import { TourProvider, useTour } from "./components/Tour";
import { AiStatusContext, HealthContext } from "./health";
import CaseDetailPage from "./pages/CaseDetail";
import CasesPage from "./pages/Cases";
import DashboardPage from "./pages/Dashboard";
import NetworkPage from "./pages/Network";
import SettingsPage from "./pages/Settings";
import TransactionsPage from "./pages/Transactions";
import WhatIfPage from "./pages/WhatIf";
import { initials, usePrefs } from "./prefs";
import { errorMessage, useAsync } from "./util";

const NAV = [
  { to: "/", label: "Overview", end: true, icon: IconOverview },
  { to: "/cases", label: "Cases", icon: IconCases },
  { to: "/transactions", label: "Transactions", icon: IconTransactions },
  { to: "/network", label: "Network", icon: IconNetwork },
  { to: "/simulator", label: "Simulator", icon: IconSimulator },
];

function useAiStatusState() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const recheck = useCallback((force = false) => {
    const id = ++seq.current;
    setChecking(true);
    api
      .aiStatus(force)
      .then((s) => {
        if (id === seq.current) {
          setStatus(s);
          setError(null);
        }
      })
      .catch((e) => {
        if (id === seq.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (id === seq.current) setChecking(false);
      });
  }, []);

  // Check on load, then every 3 minutes (the server caches results, so this is cheap).
  useEffect(() => {
    recheck();
    const timer = window.setInterval(() => recheck(), 180_000);
    return () => window.clearInterval(timer);
  }, [recheck]);

  return { status, checking, error, recheck };
}

function TourButton() {
  const { start } = useTour();
  return (
    <button className="btn btn-small" onClick={start} title="Guided tour of the product">
      <IconPlay size={13} /> Tour
    </button>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = usePrefs();
  const next = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <button className="icon-btn" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      {resolvedTheme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}

export default function App() {
  const { data: health } = useAsync(() => api.health(), []);
  const ai = useAiStatusState();
  const { analystName } = usePrefs();
  return (
    <HealthContext.Provider value={health}>
      <AiStatusContext.Provider value={ai}>
        <InspectorProvider>
          <TourProvider>
            <a className="skip-link" href="#main">
              Skip to content
            </a>
            <div className="app-shell">
              <aside className="sidebar">
                <Link to="/" className="brand" style={{ textDecoration: "none" }}>
                  <span className="brand-mark">
                    <IconNetwork size={19} />
                  </span>
                  <span>
                    <span className="brand-name">FraudGraph AI</span>
                    <span className="brand-tag">Connected fraud investigation</span>
                  </span>
                </Link>
                <div className="side-section">Workspace</div>
                <nav className="side-nav" aria-label="Main">
                  {NAV.map((n) => (
                    <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "side-link active" : "side-link")}>
                      <n.icon /> {n.label}
                    </NavLink>
                  ))}
                </nav>
                <div className="side-section">Administration</div>
                <nav className="side-nav" aria-label="Administration">
                  <NavLink to="/settings" className={({ isActive }) => (isActive ? "side-link active" : "side-link")}>
                    <IconCog /> Settings
                  </NavLink>
                </nav>
                <div className="side-foot">
                  <div className="env-badge" data-tour="env" title="This workspace runs on a synthetic dataset. No real customer data is loaded and no real payment is created, blocked or changed.">
                    <span className="env-dot" aria-hidden="true" />
                    <span>
                      <strong>Sandbox environment</strong>
                      Synthetic data &middot; {health?.dataset_version ?? "..."}
                    </span>
                  </div>
                  <div className="side-version">
                    v{health?.app_version ?? "-"} &middot; {health?.rule_version ?? "-"}
                  </div>
                </div>
              </aside>

              <div className="main-col">
                <header className="topbar">
                  <GlobalSearch />
                  <div className="topbar-tools">
                    <AiStatusPill />
                    <TourButton />
                    <ThemeToggle />
                    <Link to="/settings" className="user-chip" title="Profile and settings">
                      <span className="avatar avatar-sm">{initials(analystName)}</span>
                      <span>{analystName}</span>
                    </Link>
                  </div>
                </header>
                <main id="main" className="container">
                  <Routes>
                    <Route path="/" element={<DashboardPage />} />
                    <Route path="/cases" element={<CasesPage />} />
                    <Route path="/cases/:caseId" element={<CaseDetailPage />} />
                    <Route path="/transactions" element={<TransactionsPage />} />
                    <Route path="/network" element={<NetworkPage />} />
                    <Route path="/simulator" element={<WhatIfPage />} />
                    <Route path="/what-if" element={<Navigate to="/simulator" replace />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="*" element={<div className="state state-empty">Page not found. <Link to="/">Back to overview</Link></div>} />
                  </Routes>
                </main>
                <footer className="footer">
                  FraudGraph AI assists human review. Scores rank priority and are not findings of fraud; AI output is advisory. This workspace uses synthetic
                  data.
                </footer>
              </div>
            </div>
          </TourProvider>
        </InspectorProvider>
      </AiStatusContext.Provider>
    </HealthContext.Provider>
  );
}
