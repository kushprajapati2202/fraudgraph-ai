import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";

interface Step {
  /** Route to show. `{case}` is replaced by a demo case ID. */
  route: string;
  /** CSS selector of the element to spotlight; omit for a centered message. */
  target?: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    route: "/",
    title: "Welcome to FraudGraph AI",
    body: "A two-minute walkthrough. FraudGraph AI helps an analyst see how transfers connect, understand why they were flagged, and record an accountable decision.",
  },
  {
    route: "/",
    target: '[data-tour="env"]',
    title: "Your environment",
    body: "This workspace runs in a sandbox on synthetic data. No real customer data is loaded and no real payment can be created, blocked or changed from here.",
  },
  {
    route: "/",
    target: ".search",
    title: "Find anything",
    body: "Search by case, account holder name, account ID, or a transfer reference. Press Ctrl+K from any page to jump here.",
  },
  {
    route: "/",
    target: '[data-tour="ai-status"]',
    title: "Is the AI connected?",
    body: "Green means Gemini is answering. Amber means your key is valid but Google's models are busy. Red means the key or network needs attention. Click to re-check. Everything else works either way.",
  },
  {
    route: "/",
    target: '[data-tour="dash-stats"]',
    title: "Where things stand",
    body: "Open cases, the amount under review, how many transfers were flagged, and how many decisions analysts have recorded.",
  },
  {
    route: "/",
    target: '[data-tour="dash-actions"]',
    title: "Run analysis",
    body: "Scores every transfer with the transparent rules and rebuilds the cases. The linking window controls how close in time transfers must be to join the same case.",
  },
  {
    route: "/",
    target: '[data-tour="dash-cases"]',
    title: "Your review queue",
    body: "Open cases first, highest priority on top. The ring shows the 0-100 priority score, with the amount moved and how many accounts are involved. Click a case to investigate.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-header"]',
    title: "A case at a glance",
    body: "The priority score, the rule version that produced it, and the review status. A high score means review first. It is not a finding of fraud.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-graph"]',
    title: "See the connection",
    body: "Accounts are nodes and each transfer is an arrow labeled with amount and time. Use Trace path to follow a chain of transfers. Click an arrow for the record or an account for its profile.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-signals"]',
    title: "Understand the risk",
    body: "Every rule that fired, with the points it contributed. Context-only signals such as a shared device are marked, and missing information is listed under What we don't know.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-similar"]',
    title: "Learn from similar cases",
    body: "Gemini embeddings find resolved cases with a similar pattern and show how each ended and what was done. If the closest matches all ended the same way, the nearest case with a different outcome is shown too, so you always see a counter-example.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-evidence"]',
    title: "Evidence with stable IDs",
    body: "Each path, rule finding, transfer and baseline has an evidence ID. Click any item to open the source record. These are the only things the AI may cite.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-ai"]',
    title: "Ask Gemini",
    body: "Gemini summarises this case from its evidence only: facts, indicators, alternative explanations and uncertainty. Every citation is verified, and clicking one opens the evidence. If Gemini is unavailable, the rule findings stay intact.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-documents"]',
    title: "Check supporting documents",
    body: "Upload an invoice or receipt that explains a transfer. Gemini reads it, and fixed rules compare amount, date, parties and bank reference with the record. A legitimate payment can be cleared in seconds, and a mismatch is obvious.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-actions"]',
    title: "Mitigate, with a human in control",
    body: "Proportionate actions are recommended by the rule playbook and by the AI draft, such as holding transfers for review or verifying with the customer. Nothing takes effect until an analyst approves it. Once approved, a hold stops new transfers on the account until an analyst releases or rejects them, and follow-ups are tracked as tasks. Every step is logged under the analyst's name.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-decision"]',
    title: "Act with accountability",
    body: "Only a person records the outcome: escalate, request more evidence, or dismiss, always with a written rationale under their name.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-report"]',
    title: "Escalation report in one click",
    body: "Gemini drafts the internal report for compliance: roles, chronology, indicators, mitigating factors and gaps, with verified citations. Download the full case file to hand over.",
  },
  {
    route: "/cases/{case}",
    target: '[data-tour="case-audit"]',
    title: "Audit history",
    body: "Every analysis run, AI response and human decision is logged in order, with separate markers for System, AI and Human.",
  },
  {
    route: "/transactions",
    target: '[data-tour="tx-filters"]',
    title: "Explore transactions",
    body: "Filter every monitored transfer by name, account, date, amount, channel or priority. Click a party to open the account profile, or a reference to see the transfer.",
  },
  {
    route: "/network",
    target: '[data-tour="network"]',
    title: "The flagged network",
    body: "All medium and high priority transfers in one graph. Click an account to focus on its activity.",
  },
  {
    route: "/simulator",
    target: '[data-tour="whatif-form"]',
    title: "Simulate a transfer",
    body: "Test how the rules react to a hypothetical transfer. It is scored live, clearly tagged as simulated, and you see exactly which cases and signals changed.",
  },
  {
    route: "/settings",
    target: '[data-tour="settings-data"]',
    title: "Administration",
    body: "Settings holds your profile and theme, the AI connection details, the detection rules, and the option to restore the baseline dataset.",
  },
  {
    route: "/",
    title: "You are ready",
    body: "Start with the review queue, trace a path, ask Gemini, then record your decision. Restart this tour any time from the Tour button.",
  },
];

const SEEN_KEY = "fraudgraph.tourSeen";

interface TourApi {
  start: () => void;
  active: boolean;
}
const TourContext = createContext<TourApi>({ start: () => undefined, active: false });
export const useTour = () => useContext(TourContext);

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // storage unavailable: do not auto-start on every load
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [index, setIndex] = useState<number | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  const navigate = useNavigate();

  // Steps that need a case are skipped when no case exists (e.g. right after a reset).
  const steps = useMemo(() => (caseId ? STEPS : STEPS.filter((s) => !s.route.includes("{case}"))), [caseId]);

  const start = useCallback(async () => {
    let id: string | null = null;
    try {
      const scen = await api.scenarios();
      id = scen.scenarios.find((s) => s.scenario_id === "layered-transfer-01")?.case_ids[0] ?? null;
      if (!id) id = (await api.cases({})).items[0]?.case_id ?? null;
    } catch {
      id = null;
    }
    setCaseId(id);
    setIndex(0);
  }, []);

  const close = useCallback(() => {
    markSeen();
    setIndex(null);
    navigate("/");
  }, [navigate]);

  useEffect(() => {
    // Auto-start once for new visitors; never under browser automation (tests, screenshots).
    if (!readSeen() && !navigator.webdriver) {
      const t = window.setTimeout(() => void start(), 800);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [start]);

  return (
    <TourContext.Provider value={{ start: () => void start(), active: index !== null }}>
      {children}
      {index !== null ? (
        <TourOverlay
          step={steps[Math.min(index, steps.length - 1)]}
          index={Math.min(index, steps.length - 1)}
          total={steps.length}
          caseId={caseId}
          onNext={() => (index >= steps.length - 1 ? close() : setIndex(index + 1))}
          onBack={() => setIndex(Math.max(0, index - 1))}
          onClose={close}
        />
      ) : null}
    </TourContext.Provider>
  );
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function TourOverlay({ step, index, total, caseId, onNext, onBack, onClose }: {
  step: Step;
  index: number;
  total: number;
  caseId: string | null;
  onNext: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [rect, setRect] = useState<Rect | null>(null);
  const [searching, setSearching] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  const route = step.route.replace("{case}", caseId ?? "");

  // Navigate to the step's page, then find and scroll to the target.
  useEffect(() => {
    if (location.pathname !== route) navigate(route);
  }, [route, location.pathname, navigate]);

  useEffect(() => {
    setRect(null);
    if (!step.target || location.pathname !== route) return undefined;
    setSearching(true);
    let tries = 0;
    let cancelled = false;
    const measure = (el: Element) => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const timer = window.setInterval(() => {
      const el = document.querySelector(step.target!);
      tries += 1;
      if (el) {
        window.clearInterval(timer);
        el.scrollIntoView({ block: "center", behavior: "auto" });
        // measure after the scroll has been applied
        window.requestAnimationFrame(() => {
          if (!cancelled) {
            measure(el);
            setSearching(false);
          }
        });
      } else if (tries > 40) {
        window.clearInterval(timer);
        setSearching(false);
      }
    }, 100);
    const onMove = () => {
      const el = document.querySelector(step.target!);
      if (el) measure(el);
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [step, route, location.pathname]);

  // Place the popover below the target if it fits, otherwise above; clamp to the viewport.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!rect) {
      setPopPos({ top: Math.max(12, (vh - ph) / 2), left: Math.max(12, (vw - pw) / 2) });
      return;
    }
    const gap = 12;
    let top = rect.top + rect.height + gap;
    if (top + ph > vh - 12) top = rect.top - ph - gap;
    if (top < 12) top = Math.max(12, vh - ph - 12); // target taller than the viewport: pin to the bottom
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.min(Math.max(12, left), vw - pw - 12);
    setPopPos({ top, left });
  }, [rect, step, searching]);

  useEffect(() => {
    popRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "ArrowLeft") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNext, onBack, index]);

  const pad = 6;
  const last = index === total - 1;
  return (
    <div className="tour-layer">
      {rect ? (
        <div
          className="tour-spotlight"
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
          aria-hidden="true"
        />
      ) : (
        <div className="tour-dim" aria-hidden="true" />
      )}
      <div
        ref={popRef}
        className="tour-pop"
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        style={{ top: popPos?.top ?? -9999, left: popPos?.left ?? -9999 }}
      >
        <div className="tour-progress" aria-hidden="true">
          <span style={{ width: `${((index + 1) / total) * 100}%` }} />
        </div>
        <div className="tour-count">
          Step {index + 1} of {total}
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button className="btn btn-small btn-ghost" onClick={onClose}>
            {last ? "Close" : "Skip tour"}
          </button>
          <span className="tour-spacer" />
          <button className="btn btn-small" onClick={onBack} disabled={index === 0}>
            Back
          </button>
          <button className="btn btn-small btn-primary" onClick={onNext}>
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
