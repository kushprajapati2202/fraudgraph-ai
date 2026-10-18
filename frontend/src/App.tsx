import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { api, type AiStatus } from "./api/client";
import { AiStatusPill } from "./components/AiStatus";
import GlobalSearch from "./components/GlobalSearch";
import { IconAudit, IconCases, IconChevron, IconCog, IconMoon, IconNetwork, IconOverview, IconPlay, IconSimulator, IconSun, IconTarget, IconTransactions } from "./components/icons";
import { InspectorProvider } from "./components/Inspector";
import { TourProvider, useTour } from "./components/Tour";
import { AiStatusContext, HealthContext } from "./health";
import AuditPage from "./pages/Audit";
import CaseDetailPage from "./pages/CaseDetail";
import CasesPage from "./pages/Cases";
import DashboardPage from "./pages/Dashboard";
import NetworkPage from "./pages/Network";
import RedTeamPage from "./pages/RedTeam";
import SettingsPage from "./pages/Settings";
import TransactionsPage from "./pages/Transactions";
import WhatIfPage from "./pages/WhatIf";
import { initials, usePrefs } from "./prefs";
import { errorMessage, useAsync, usePageTitle } from "./util";

const NAV = [
  { to: "/", label: "Overview", end: true, icon: IconOverview },
  { to: "/cases", label: "Cases", icon: IconCases },
  { to: "/transactions", label: "Transactions", icon: IconTransactions },
  { to: "/network", label: "Network", icon: IconNetwork },
  { to: "/simulator", label: "Simulator", icon: IconSimulator },
  { to: "/red-team", label: "Red team", icon: IconTarget },
  { to: "/audit", label: "Audit", icon: IconAudit },
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
    <button className="btn btn-small tour-btn" onClick={start} title="Guided tour of the product" aria-label="Start guided tour">
      <IconPlay size={13} /> <span className="tour-btn-label">Tour</span>
    </button>
  );
}

/** New page: start at the top. Same page with a #section: let the browser scroll to the anchor. */
function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/** Remount the case page per case, so nothing from the previous case (data, path selection, open forms) carries over. */
function CaseRoute() {
  const { caseId = "" } = useParams();
  return <CaseDetailPage key={caseId} />;
}

function NotFound() {
  usePageTitle("Page not found");
  return (
    <div className="state state-empty not-found">
      <div>
        <div className="eyebrow">404</div>
        <h1>This page does not exist</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          The link may be out of date, or the case may have been rebuilt by a newer analysis.
        </p>
        <div className="row-center" style={{ justifyContent: "center", marginTop: 16 }}>
          <Link to="/" className="btn btn-primary">
            Back to overview
          </Link>
          <Link to="/cases" className="btn">
            Open cases
          </Link>
        </div>
      </div>
    </div>
  );
}

const SIDEBAR_KEY = "fraudgraph.sidebarCollapsed";

/** Sidebar collapsed to an icon rail; remembered per browser (storage failures fall back to expanded). */
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1");
      } catch {
        /* storage unavailable: preference lasts for this page only */
      }
      return !c;
    });
  }, []);
  return { collapsed, toggle };
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
  const sidebar = useSidebarCollapsed();
  const tip = (label: string) => (sidebar.collapsed ? label : undefined);
  return (
    <HealthContext.Provider value={health}>
      <AiStatusContext.Provider value={ai}>
        <InspectorProvider>
          <TourProvider>
            <ScrollToTop />
            <a className="skip-link" href="#main">
              Skip to content
            </a>
            <div className={sidebar.collapsed ? "app-shell side-collapsed" : "app-shell"}>
              <aside className="sidebar">
                <Link to="/" className="brand" style={{ textDecoration: "none" }} title={tip("FraudGraph AI")}>
                  <span className="brand-mark">
                    <IconNetwork size={19} />
                  </span>
                  <span className="side-label">
                    <span className="brand-name">FraudGraph AI</span>
                    <span className="brand-tag">Connected fraud investigation</span>
                  </span>
                </Link>
                <div className="side-section">Workspace</div>
                <nav className="side-nav" aria-label="Main">
                  {NAV.map((n) => (
                    <NavLink key={n.to} to={n.to} end={n.end} title={tip(n.label)} className={({ isActive }) => (isActive ? "side-link active" : "side-link")}>
                      <n.icon /> <span className="side-label">{n.label}</span>
                    </NavLink>
                  ))}
                </nav>
                <div className="side-section">Administration</div>
                <nav className="side-nav" aria-label="Administration">
                  <NavLink to="/settings" title={tip("Settings")} className={({ isActive }) => (isActive ? "side-link active" : "side-link")}>
                    <IconCog /> <span className="side-label">Settings</span>
                  </NavLink>
                </nav>
                <div className="side-foot">
                  <div className="env-badge" data-tour="env" title="This workspace runs on a synthetic dataset. No real customer data is loaded and no real payment is created, blocked or changed.">
                    <span className="env-dot" aria-hidden="true" />
                    <span className="side-label">
                      <strong>Sandbox environment</strong>
                      Synthetic data &middot; {health?.dataset_version ?? "..."}
                    </span>
                  </div>
                  <div className="side-version">
                    v{health?.app_version ?? "-"} &middot; {health?.rule_version ?? "-"}
                  </div>
                </div>
              </aside>
              {/* Sits on the sidebar's edge and appears on hover; outside the aside so its scroll area does not clip it. */}
              <button
                type="button"
                className="side-toggle"
                onClick={sidebar.toggle}
                aria-expanded={!sidebar.collapsed}
                aria-label={sidebar.collapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={sidebar.collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <IconChevron size={14} />
              </button>

              <div className="main-col">
                <header className="topbar">
                  <GlobalSearch />
                  <div className="topbar-tools">
                    <AiStatusPill />
                    <TourButton />
                    <ThemeToggle />
                    <Link to="/settings" className="user-chip" title="Profile and settings">
                      <span className="avatar avatar-sm">{initials(analystName)}</span>
                      <span className="user-chip-name">{analystName}</span>
                    </Link>
                  </div>
                </header>
                <main id="main" className="container">
                  <Routes>
                    <Route path="/" element={<DashboardPage />} />
                    <Route path="/cases" element={<CasesPage />} />
                    <Route path="/cases/:caseId" element={<CaseRoute />} />
                    <Route path="/transactions" element={<TransactionsPage />} />
                    <Route path="/network" element={<NetworkPage />} />
                    <Route path="/simulator" element={<WhatIfPage />} />
                    <Route path="/red-team" element={<RedTeamPage />} />
                    <Route path="/what-if" element={<Navigate to="/simulator" replace />} />
                    <Route path="/audit" element={<AuditPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="*" element={<NotFound />} />
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
