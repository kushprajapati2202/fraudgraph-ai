import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconExpand } from "./icons";

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The evidence drawer (Inspector) can open on top of a modal; while it is open it owns Esc and Tab. */
const drawerOpen = () => document.body.classList.contains("drawer-open");

/**
 * Centred dialog for reading long content. Esc or the backdrop closes it, focus stays inside while open
 * and returns to the button that opened it.
 */
export function Modal({ title, subtitle, onClose, children, footer }: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.body.classList.add("modal-open");
    closeRef.current?.focus();
    return () => {
      document.body.classList.remove("modal-open");
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (drawerOpen()) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Rendered on <body> so no card styling (transforms, filters) can clip it to the card.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={panelRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="modal-title">{title}</h2>
            {subtitle ? <div className="card-sub">{subtitle}</div> : null}
          </div>
          <button ref={closeRef} className="btn btn-small btn-ghost" onClick={onClose} aria-label="Close" title="Close (Esc)">
            Close
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Short notice in the corner of the screen that hides itself after `duration` ms (hover keeps it open). */
export function Toast({ tone, title, children, action, onClose, duration = 10000 }: {
  tone: "ok" | "warn";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  onClose: () => void;
  duration?: number;
}) {
  const timer = useRef<number>();
  const start = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(onClose, duration);
  };
  useEffect(() => {
    start();
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  return createPortal(
    <div className={`toast toast-${tone}`} role={tone === "warn" ? "alert" : "status"} aria-live="polite"
      onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={start}>
      <span className="toast-icon" aria-hidden="true">{tone === "ok" ? "✓" : "!"}</span>
      <div className="toast-text">
        <strong>{title}</strong>
        {children ? <div className="small">{children}</div> : null}
        {action ? <div className="toast-actions">{action}</div> : null}
      </div>
      <button className="toast-close" onClick={onClose} aria-label="Dismiss notification">&times;</button>
    </div>,
    document.body,
  );
}

/** Small square button with the "expand" icon; opens content in the full-view pop-up. */
export function ExpandButton({ onClick, label = "Open full view" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={label} title={label}>
      <IconExpand size={16} />
    </button>
  );
}
